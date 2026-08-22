// ============================================================
// Kaizen Guild Manager — Cloudflare Worker
// Handles Discord slash commands + Raid Helper API proxy
// ============================================================

const DISCORD_API = 'https://discord.com/api/v10';
const RH_API      = 'https://raid-helper.xyz/api/v4';

// ── Entry point ──────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return corsResponse('', 204);
    }

    // ── Raid Helper proxy ── /rh/*
    if (url.pathname.startsWith('/rh/')) {
      return handleRHProxy(request, url, env);
    }

    // ── Direct roster post from raid manager ── /post-roster
    if (url.pathname === '/post-roster' && request.method === 'POST') {
      return handleDirectRosterPost(request, env);
    }

    // ── Latest Warcraft Logs report, for the raid manager's attendance
    // review UI ── /logs/latest
    if (url.pathname === '/logs/latest' && request.method === 'GET') {
      return handleLatestLogsData(request, env);
    }

    // ── Discord interactions ── /discord
    if (url.pathname === '/discord' && request.method === 'POST') {
      return handleDiscord(request, env, ctx);
    }

    return new Response('Kaizen Worker running.', { status: 200 });
  }
};

// ── Direct roster post from raid manager ─────────────────────
async function handleDirectRosterPost(request, env) {
  try {
    const { raidId, channelId, notify = true } = await request.json();

    // Fetch latest data from GitHub Pages
    const dataRes = await fetch(`https://kaizen-tbc.github.io/kaizen_data.json?v=${Date.now()}`);
    if (!dataRes.ok) throw new Error('Could not load raid data');
    const data = await dataRes.json();

    const raids  = data.raids || [];
    const roster = data.roster || [];
    const raid   = raids.find(r => r.id === raidId) || raids[0];

    if (!raid) throw new Error('Raid not found');

    const embed = buildRosterEmbed(raid, roster, data.pugs || [], notify);

    const postRes = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bot ${env.DISCORD_BOT_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ embeds: [embed] })
    });

    if (!postRes.ok) {
      const err = await postRes.json();
      throw new Error(err.message || `Discord API error ${postRes.status}`);
    }

    return corsResponse(JSON.stringify({ ok: true }), 200);
  } catch(err) {
    return corsResponse(JSON.stringify({ error: err.message }), 500);
  }
}

// ── Raid Helper Proxy ─────────────────────────────────────────
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
async function handleDiscord(request, env, ctx) {
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
    return handleSlashCommand(interaction, env, ctx);
  }

  return jsonResponse({ type: 1 });
}

async function handleSlashCommand(interaction, env, ctx) {
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
    case 'post-logs':
      return handlePostLogsCommand(interaction, guildId, options, env, ctx);
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
              '`/post-logs` — Post top parses + attendance from the latest Warcraft Logs report',
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
    const raid = raids.find(r => r.discordChannelId === channelId) || raids[0];

    if (!raid) {
      return jsonResponse({
        type: 4,
        data: { content: '⚠️ No raids configured yet. Set up raids in the raid manager.', flags: 64 }
      });
    }

    const embed = buildRosterEmbed(raid, roster, data.pugs || []);

    // Post via bot token to the configured channel
    const postChannelId = raid.discordChannelId || channelId;
    if (!postChannelId) {
      return jsonResponse({
        type: 4,
        data: { content: '⚠️ No Discord channel ID set for this raid. Add one in the raid manager under ⚙ Raid Settings.', flags: 64 }
      });
    }

    await fetch(`${DISCORD_API}/channels/${postChannelId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bot ${env.DISCORD_BOT_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ embeds: [embed] })
    });

    return jsonResponse({
      type: 4,
      data: { content: `✅ Roster posted for **${raid.name}**`, flags: 64 }
    });

  } catch (err) {
    return jsonResponse({
      type: 4,
      data: { content: `❌ Error: ${err.message}`, flags: 64 }
    });
  }
}

// ============================================================
// WARCRAFT LOGS INTEGRATION
// ============================================================
// Env vars required (Cloudflare secrets, same pattern as RH_API_KEY):
//   WCL_CLIENT_ID, WCL_CLIENT_SECRET   — from an API v2 client you create
//     at warcraftlogs.com under your account's Client Management page
//     (client_credentials flow — no redirect URI needed).
//   WCL_GUILD_ID — the numeric guild id, e.g. from
//     https://fresh.warcraftlogs.com/guild/id/816169 it's 816169. Looking
//     up by id sidesteps any case/spelling mismatch on guild name or
//     server slug entirely.
//
// NOTE: rankings/playerDetails are JSON-scalar fields in WCL's v2 schema
// (not fully-typed GraphQL), so their exact key names are the part of this
// integration most likely to need a quick follow-up tweak once tested
// against a real report — extractParticipantNames/extractTopParses are
// written defensively (try/catch, several key-name fallbacks) so a shape
// mismatch degrades to an empty list + a visible error in the Discord
// reply rather than a crash.
const WCL_TOKEN_URL = 'https://www.warcraftlogs.com/oauth/token';
const WCL_API       = 'https://www.warcraftlogs.com/api/v2/client';

async function getWCLToken(env) {
  const creds = btoa(`${env.WCL_CLIENT_ID}:${env.WCL_CLIENT_SECRET}`);
  const res = await fetch(WCL_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${creds}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`Warcraft Logs auth failed: ${res.status}`);
  const data = await res.json();
  return data.access_token;
}

async function wclQuery(env, query, variables = {}) {
  const token = await getWCLToken(env);
  const res = await fetch(WCL_API, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors.map(e => e.message).join('; '));
  return json.data;
}

// Picks the most complete report from the last ~36h. Handles two people
// both auto-uploading the same raid night — takes whichever log covers
// more of the raid rather than whichever finished uploading last.
async function findLatestGuildReport(env) {
  if (!env.WCL_GUILD_ID) throw new Error('WCL_GUILD_ID is not configured.');

  const data = await wclQuery(env, `
    query($id: Int!) {
      guildData {
        guild(id: $id) {
          reports(limit: 5) {
            data { code title startTime endTime zone { name } }
          }
        }
      }
    }
  `, {
    id: Number(env.WCL_GUILD_ID),
  });

  const reports = data?.guildData?.guild?.reports?.data || [];
  if (reports.length === 0) return null;

  const cutoff = Date.now() - 36 * 60 * 60 * 1000;
  const recent = reports.filter(r => r.endTime >= cutoff);
  const pool = recent.length ? recent : [reports[0]];
  return pool.reduce((best, r) =>
    (r.endTime - r.startTime) > (best.endTime - best.startTime) ? r : best
  , pool[0]);
}

// Fight list, rankings, and participant data for one report. Two queries:
// rankings/playerDetails need fight ID arrays as arguments, which we only
// have after the first query returns the fight list.
async function getReportFightsAndStats(env, code) {
  const fightsData = await wclQuery(env, `
    query($code: String!) {
      reportData {
        report(code: $code) {
          fights { id name encounterID kill startTime endTime }
        }
      }
    }
  `, { code });

  const fights = fightsData?.reportData?.report?.fights || [];
  const killFights = fights.filter(f => f.kill);
  const allFightIds = fights.map(f => f.id);
  const killFightIds = killFights.map(f => f.id);

  const statsData = await wclQuery(env, `
    query($code: String!, $allIds: [Int]!, $killIds: [Int]!) {
      reportData {
        report(code: $code) {
          rankings(fightIDs: $killIds)
          playerDetails(fightIDs: $allIds)
        }
      }
    }
  `, { code, allIds: allFightIds, killIds: killFightIds });

  return {
    fights,
    killFights,
    rankingsRaw: statsData?.reportData?.report?.rankings ?? null,
    playerDetailsRaw: statsData?.reportData?.report?.playerDetails ?? null,
  };
}

// playerDetails is a JSON blob shaped roughly like
// { data: { playerDetails: { dps: [...], healers: [...], tanks: [...] } } },
// each entry carrying at least a `name`. Tried a couple of likely nesting
// variants defensively since this is the part most likely to drift.
function extractParticipantNames(playerDetailsRaw) {
  try {
    const pd = playerDetailsRaw?.data?.playerDetails
      || playerDetailsRaw?.playerDetails
      || playerDetailsRaw
      || {};
    const buckets = [pd.dps, pd.healers, pd.tanks].filter(Array.isArray).flat();
    return [...new Set(buckets.map(p => p.name).filter(Boolean))];
  } catch {
    return [];
  }
}

// Only count guildies (exact character-name match against the roster) —
// log-derived attendance sidesteps the Discord-alias problem entirely
// since combat logs use real in-game character names.
function matchAttendanceToRoster(participantNames, roster) {
  const byName = new Map(roster.map(p => [p.name.toLowerCase(), p.name]));
  return [...new Set(
    participantNames.map(n => byName.get(String(n).toLowerCase())).filter(Boolean)
  )];
}

// rankings is a JSON blob — best-effort shape:
// { data: [ { name, class, spec, amount, rankPercent }, ... ] }.
// Percentile parses are conventionally computed per kill, so this only
// gets fightIDs for killed encounters (see killFightIds above).
function extractTopParses(rankingsRaw) {
  try {
    const entries = rankingsRaw?.data?.rankings
      || rankingsRaw?.rankings
      || rankingsRaw?.data
      || [];
    if (!Array.isArray(entries)) return [];
    // Keep each player's single best pull if they show up more than once
    // (multiple kills of the same boss, or entries per-fight).
    const best = new Map();
    for (const e of entries) {
      const name = e.name || e.player;
      if (!name) continue;
      const amount = e.amount ?? e.total ?? 0;
      const rankPercent = e.rankPercent ?? e.percentile ?? null;
      const existing = best.get(name);
      if (!existing || amount > existing.amount) {
        best.set(name, { name, amount, rankPercent });
      }
    }
    return [...best.values()].sort((a, b) => b.amount - a.amount);
  } catch {
    return [];
  }
}

function formatParseLines(list) {
  if (!list.length) return '—';
  return list
    .map((p, i) => `**${i + 1}.** ${p.name} — ${Math.round(p.amount).toLocaleString()}${p.rankPercent != null ? ` (${Math.round(p.rankPercent)}%)` : ''}`)
    .join('\n');
}

function buildLogSummaryEmbed(report, details, roster) {
  const participants = extractParticipantNames(details.playerDetailsRaw);
  const attendance = matchAttendanceToRoster(participants, roster);
  const topParses = extractTopParses(details.rankingsRaw);

  return {
    title: `📊 ${report.title || 'Raid Log Summary'}`,
    url: `https://www.warcraftlogs.com/reports/${report.code}`,
    description: `${details.killFights.length}/${details.fights.length} encounters killed · ${attendance.length} guildies logged`,
    fields: [
      { name: '⚔️ Top 5 Parses', value: formatParseLines(topParses.slice(0, 5)), inline: true },
      { name: '👥 Attendance', value: attendance.length ? attendance.join(', ') : '—', inline: false },
    ],
    color: 0xC9A227,
    footer: { text: 'Kaizen Raid Manager • click title for the full report' },
    timestamp: new Date().toISOString(),
  };
}

// /post-logs — deferred, since the WCL round trips (auth + 2 queries) can
// exceed Discord's 3-second initial-response window. Respond immediately,
// then patch the real content in via ctx.waitUntil once it's ready.
async function handlePostLogsCommand(interaction, guildId, options, env, ctx) {
  if (!env.WCL_CLIENT_ID || !env.WCL_CLIENT_SECRET) {
    return jsonResponse({
      type: 4,
      data: { content: '⚠️ Warcraft Logs API credentials not configured. Ask an admin to set WCL_CLIENT_ID/WCL_CLIENT_SECRET in the Worker.', flags: 64 }
    });
  }
  ctx.waitUntil(runPostLogs(interaction, env));
  return jsonResponse({ type: 5, data: {} }); // deferred, public
}

async function runPostLogs(interaction, env) {
  const followupUrl = `${DISCORD_API}/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`;
  try {
    const report = await findLatestGuildReport(env);
    if (!report) throw new Error('No recent reports found for the guild on Warcraft Logs.');

    const details = await getReportFightsAndStats(env, report.code);

    const dataRes = await fetch(`https://kaizen-tbc.github.io/kaizen_data.json?v=${Date.now()}`);
    const guildData = dataRes.ok ? await dataRes.json() : { roster: [] };

    const embed = buildLogSummaryEmbed(report, details, guildData.roster || []);

    await fetch(followupUrl, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] }),
    });
  } catch (err) {
    await fetch(followupUrl, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: `❌ Couldn't post log summary: ${err.message}` }),
    });
  }
}

// GET /logs/latest — raw-ish log data for the raid manager's attendance
// review UI (not built yet — this is the seam it'll call into).
async function handleLatestLogsData(request, env) {
  try {
    if (!env.WCL_CLIENT_ID || !env.WCL_CLIENT_SECRET) {
      throw new Error('Warcraft Logs API credentials not configured.');
    }
    const report = await findLatestGuildReport(env);
    if (!report) throw new Error('No recent reports found for the guild.');
    const details = await getReportFightsAndStats(env, report.code);
    const participants = extractParticipantNames(details.playerDetailsRaw);
    const topParses = extractTopParses(details.rankingsRaw);

    return corsResponse(JSON.stringify({
      report,
      fights: details.fights,
      killFights: details.killFights,
      participants,
      topParses,
    }), 200);
  } catch (err) {
    return corsResponse(JSON.stringify({ error: err.message }), 500);
  }
}

// ── Build roster embed ───────────────────────────────────────
const SPEC_EMOJI = {
  // Druid
  'Balance':      '<:druid_balance:1539392826398347344>',
  'Feral':        '<:druid_feral:1539392865652842586>',
  'Restoration':  '<:druid_restoration:1539392882740437042>',
  // Hunter
  'Beastmastery': '<:hunter_beastmastery:1539392899580698634>',
  'Marksmanship': '<:hunter_marksmanship:1539392915028050010>',
  'Survival':     '<:hunter_survival:1539392930299781161>',
  // Mage
  'Arcane':       '<:mage_arcane:1539392959412445234>',
  'Fire':         '<:mage_fire:1539392977896607905>',
  'Frost':        '<:mage_frost:1539392995017756672>',
  // Paladin
  'Holy':         '<:paladin_holy:1539393014777253928>',
  'Protection':   '<:paladin_protection:1539393029100666982>',
  'Retribution':  '<:paladin_retribution:1539393045349535774>',
  // Priest
  'Discipline':   '<:priest_discipline:1539393066371121253>',
  'Shadow':       '<:priest_shadow:1539393107387219989>',
  // Rogue
  'Assassination':'<:rogue_assassination:1539393134717567027>',
  'Combat':       '<:rogue_combat:1539393158180245594>',
  'Subtlety':     '<:rogue_subtlety:1539393176643698839>',
  // Shaman
  'Elemental':    '<:shaman_elemental:1539393194201063465>',
  'Enhancement':  '<:shaman_enhancement:1539393215109796011>',
  // Warlock
  'Affliction':   '<:warlock_affliction:1539393255031054469>',
  'Demonology':   '<:warlock_demonology:1539393274224316567>',
  'Destruction':  '<:warlock_destruction:1539393293480230995>',
  // Warrior
  'Arms':         '<:warrior_arms:1539393314535768224>',
  'Fury':         '<:warrior_fury:1539393335914135672>',
  // Shared (class fallbacks)
  'priest_holy':  '<:priest_holy:1539393087334391859>',
  'shaman_restoration': '<:shaman_restoration:1539393235397513256>',
  'warrior_protection': '<:warrior_protection:1539393353362309232>',
};

// Map specs that share names across classes
const CLASS_SPEC_EMOJI = {
  'Priest-Holy':   '<:priest_holy:1539393087334391859>',
  'Druid-Restoration': '<:druid_restoration:1539392882740437042>',
  'Shaman-Restoration': '<:shaman_restoration:1539393235397513256>',
  'Paladin-Holy':  '<:paladin_holy:1539393014777253928>',
  'Warrior-Protection': '<:warrior_protection:1539393353362309232>',
  'Paladin-Protection': '<:paladin_protection:1539393029100666982>',
  'Druid-Feral':   '<:druid_feral:1539392865652842586>',
};

function getSpecEmoji(cls, spec) {
  // Try class+spec combo first for ambiguous specs
  const combo = `${cls}-${spec}`;
  if (CLASS_SPEC_EMOJI[combo]) return CLASS_SPEC_EMOJI[combo];
  // Fall back to spec name alone
  return SPEC_EMOJI[spec] || '';
}

function buildRosterEmbed(raid, roster, pugs, notify = true) {
  function getPlayer(id) {
    if (id < 0) return pugs.find(p => p.id === id);
    return roster.find(p => p.id === id);
  }

  const groups = raid.groups || [];
  const specOv = raid.specOverrides || {};
  const roleOv = raid.roleOverrides || {};

  // Role counts
  const roleCounts = { Tank: 0, Healer: 0, DPS: 0 };
  groups.flat().forEach(id => {
    const p = getPlayer(id);
    if (!p) return;
    const role = roleOv[p.id] || p.role;
    if (role === 'Tank') roleCounts.Tank++;
    else if (role === 'Healer') roleCounts.Healer++;
    else roleCounts.DPS++;
  });

  const total = roleCounts.Tank + roleCounts.Healer + roleCounts.DPS;
  const userIdMap = raid.userIdMap || {};

  // @mention line at top like Raid Helper — all raiders pinged
  const allPlayers = groups.flat().map(id => getPlayer(id)).filter(Boolean);
  const mentionLine = notify
    ? allPlayers.map(p => userIdMap[p.id] ? `<@${userIdMap[p.id]}>` : p.name).join(' ')
    : '';

  // Build group fields
  const fields = groups
    .map((group, g) => {
      if (!group || group.length === 0) return null;
      const lines = group
        .map(id => {
          const p = getPlayer(id);
          if (!p) return null;
          const spec = specOv[p.id] || p.ms || p.class;
          const icon = getSpecEmoji(p.class, spec);
          const mention = userIdMap[p.id] ? `<@${userIdMap[p.id]}>` : p.name;
          return `${icon} ${mention}`;
        })
        .filter(Boolean)
        .join('\n');

      return {
        name: `Group ${g + 1}${raid.groupTitles?.[g] ? ` — ${raid.groupTitles[g]}` : ''}`,
        value: lines || 'Empty',
        inline: true,
      };
    })
    .filter(Boolean);

  // Insert blank fields to force 2-column layout with breathing room
  const spacedFields = [];
  fields.forEach((f, i) => {
    spacedFields.push(f);
    if ((i + 1) % 2 === 0 && i < fields.length - 1) {
      spacedFields.push({ name: '​', value: '​', inline: false });
    }
  });
  if (spacedFields.length % 2 === 1) {
    spacedFields.push({ name: '​', value: '​', inline: true });
  }

  return {
    title: `${raid.name} — ${total} Raiders`,
    description: `${mentionLine ? mentionLine + '\n\n' : ''}🛡 **${roleCounts.Tank}** Tanks  |  ✚ **${roleCounts.Healer}** Healers  |  ⚔ **${roleCounts.DPS}** DPS`,
    fields: spacedFields,
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
      { name: 'Ed25519' },
      false,
      ['verify']
    );
    const encoder = new TextEncoder();
    return await crypto.subtle.verify(
      'Ed25519',
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
