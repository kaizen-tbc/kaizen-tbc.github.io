// ============================================================
// Kaizen Guild Manager — Cloudflare Worker
// Handles Discord slash commands + Raid Helper API proxy
// ============================================================

const DISCORD_API = 'https://discord.com/api/v10';
const RH_API      = 'https://raid-helper.dev/api/v2';

// ── Entry point ──────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return corsResponse('', 204);
    }

    // ── Raid Helper proxy ── /rh/*
    if (url.pathname.startsWith('/rh/')) {
      return handleRHProxy(request, url, env);
    }

    // ── Discord interactions ── /discord
    if (url.pathname === '/discord' && request.method === 'POST') {
      return handleDiscord(request, env);
    }

    return new Response('Kaizen Worker running.', { status: 200 });
  }
};

// ── Raid Helper Proxy ────────────────────────────────────────
async function handleRHProxy(request, url, env) {
  // /rh/events/:id  → GET single event (no auth)
  // /rh/servers/:id/events → GET server events (needs RH API key)
  const rhPath = url.pathname.replace('/rh/', '');
  const rhUrl  = `${RH_API}/${rhPath}`;

  const headers = { 'Content-Type': 'application/json' };
  if (env.RH_API_KEY) headers['Authorization'] = env.RH_API_KEY;

  try {
    const res  = await fetch(rhUrl, { headers });
    const data = await res.json();
    return corsResponse(JSON.stringify(data), res.status);
  } catch (err) {
    return corsResponse(JSON.stringify({ error: err.message }), 500);
  }
}

// ── Discord Interaction Handler ──────────────────────────────
async function handleDiscord(request, env) {
  // Verify the request is genuinely from Discord
  const signature = request.headers.get('x-signature-ed25519');
  const timestamp = request.headers.get('x-signature-timestamp');
  const body      = await request.text();

  const valid = await verifyDiscordSignature(
    env.DISCORD_PUBLIC_KEY, signature, timestamp, body
  );
  if (!valid) return new Response('Invalid signature', { status: 401 });

  const interaction = JSON.parse(body);

  // Discord PING — must respond with PONG
  if (interaction.type === 1) {
    return jsonResponse({ type: 1 });
  }

  // Slash command
  if (interaction.type === 2) {
    return handleSlashCommand(interaction, env);
  }

  return jsonResponse({ type: 1 });
}

async function handleSlashCommand(interaction, env) {
  const cmd     = interaction.data.name;
  const guildId = interaction.guild_id;
  const options = Object.fromEntries(
    (interaction.data.options || []).map(o => [o.name, o.value])
  );

  switch (cmd) {
    case 'import':
      return handleImportCommand(interaction, guildId, options, env);
    case 'post-roster':
      return handlePostRosterCommand(interaction, guildId, options, env);
    case 'help':
      return jsonResponse({
        type: 4,
        data: {
          embeds: [{
            title: 'Kaizen Raid Manager',
            description: [
              '**Commands:**',
              '`/import` — Fetch the latest sign-ups from Raid Helper and import to the raid manager',
              '`/post-roster` — Post the current roster groups to this channel',
              '`/help` — Show this message',
            ].join('\n'),
            color: 0xC9A227,
          }],
          flags: 64, // ephemeral
        }
      });
    default:
      return jsonResponse({
        type: 4,
        data: { content: 'Unknown command.', flags: 64 }
      });
  }
}

// /import — fetch latest RH event and return summary
async function handleImportCommand(interaction, guildId, options, env) {
  if (!env.RH_API_KEY || !env.RH_SERVER_ID) {
    return jsonResponse({
      type: 4,
      data: {
        content: '⚠️ Raid Helper API key or Server ID not configured. Ask an admin to set these in the Cloudflare Worker environment variables.',
        flags: 64,
      }
    });
  }

  // Defer response — we'll follow up since RH fetch may take a moment
  // Send deferred first, then follow up via REST
  const channelId = options.channel || interaction.channel_id;

  // Return deferred and handle async
  const deferred = jsonResponse({ type: 5, data: { flags: 64 } });

  // Use waitUntil via ctx if available — for now return deferred
  // The raid manager UI handles the actual import; this just confirms
  return jsonResponse({
    type: 4,
    data: {
      embeds: [{
        title: '📥 Import Ready',
        description: 'Open the **Kaizen Raid Manager** and click **Import from Discord Signup** — it will auto-fetch the latest event from this channel.',
        color: 0x5865F2,
        footer: { text: 'kaizen-tbc.github.io/kaizen_raid_manager.html' }
      }],
      flags: 64,
    }
  });
}

// /post-roster — post current roster from kaizen_data.json
async function handlePostRosterCommand(interaction, guildId, options, env) {
  try {
    // Fetch current raid data from GitHub Pages
    const dataUrl = `https://kaizen-tbc.github.io/kaizen_data.json?v=${Date.now()}`;
    const dataRes = await fetch(dataUrl);
    if (!dataRes.ok) throw new Error('Could not load raid data');
    const data = await dataRes.json();

    const raids  = data.raids || [];
    const roster = data.roster || [];

    // Find the raid matching this channel or use first
    const channelId = interaction.channel_id;
    const raid = raids.find(r => r.discordWebhookUrl?.includes(channelId)) || raids[0];

    if (!raid) {
      return jsonResponse({
        type: 4,
        data: { content: '⚠️ No raids configured yet. Set up raids in the raid manager.', flags: 64 }
      });
    }

    const embed = buildRosterEmbed(raid, roster, data.pugs || []);

    // Post to the webhook for this raid
    if (raid.discordWebhookUrl) {
      await fetch(raid.discordWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ embeds: [embed] })
      });
      return jsonResponse({
        type: 4,
        data: { content: `✅ Roster posted for **${raid.name}**`, flags: 64 }
      });
    }

    // No webhook — post inline
    return jsonResponse({
      type: 4,
      data: { embeds: [embed] }
    });

  } catch (err) {
    return jsonResponse({
      type: 4,
      data: { content: `❌ Error: ${err.message}`, flags: 64 }
    });
  }
}

// ── Build roster embed ───────────────────────────────────────
function buildRosterEmbed(raid, roster, pugs) {
  const CLASS_COLORS = {
    Druid: 0xFF7D0A, Hunter: 0xABD473, Mage: 0x69CCF0,
    Paladin: 0xF58CBA, Priest: 0xFFFFFF, Rogue: 0xFFF569,
    Shaman: 0x0070DE, Warlock: 0x9482C9, Warrior: 0xC79C6E,
  };
  const CLASS_EMOJI = {
    Druid: '🐾', Hunter: '🏹', Mage: '🔮', Paladin: '⚔️',
    Priest: '✚', Rogue: '🗡️', Shaman: '⚡', Warlock: '🔥', Warrior: '🛡️',
  };

  function getPlayer(id, allRoster, allPugs) {
    if (id < 0) return allPugs.find(p => p.id === id);
    return allRoster.find(p => p.id === id);
  }

  const groups = raid.groups || [];
  const fields = groups
    .map((group, g) => {
      if (!group || group.length === 0) return null;
      const members = group
        .map(id => getPlayer(id, roster, pugs))
        .filter(Boolean)
        .map(p => `${CLASS_EMOJI[p.class] || '•'} **${p.name}** — ${raid.specOverrides?.[p.id] || p.ms || p.class}`)
        .join('\n');
      return {
        name: raid.groupTitles?.[g] || `Group ${g + 1}`,
        value: members || 'Empty',
        inline: true,
      };
    })
    .filter(Boolean);

  // Role counts
  const roleCounts = { Tank: 0, Healer: 0, Melee: 0, Ranged: 0 };
  groups.flat().forEach(id => {
    const p = getPlayer(id, roster, pugs);
    if (!p) return;
    const role = raid.roleOverrides?.[p.id] || p.role;
    if (roleCounts[role] !== undefined) roleCounts[role]++;
  });

  const total = Object.values(roleCounts).reduce((a, b) => a + b, 0);

  return {
    title: `${raid.name} — ${total} Raiders`,
    description: `🛡 ${roleCounts.Tank} Tanks  ✚ ${roleCounts.Healer} Healers  ⚔️ ${roleCounts.Melee} Melee  🏹 ${roleCounts.Ranged} Ranged`,
    fields,
    color: 0xC9A227,
    footer: { text: 'Kaizen Raid Manager • kaizen-tbc.github.io' },
    timestamp: new Date().toISOString(),
  };
}

// ── Discord signature verification ───────────────────────────
async function verifyDiscordSignature(publicKey, signature, timestamp, body) {
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      hexToBytes(publicKey),
      { name: 'NODE-ED25519', namedCurve: 'NODE-ED25519' },
      false,
      ['verify']
    );
    const encoder = new TextEncoder();
    return await crypto.subtle.verify(
      'NODE-ED25519',
      key,
      hexToBytes(signature),
      encoder.encode(timestamp + body)
    );
  } catch {
    return false;
  }
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

// ── Helpers ──────────────────────────────────────────────────
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    }
  });
}

function corsResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    }
  });
}
