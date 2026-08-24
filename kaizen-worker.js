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

    // ── Post a strat's image + assignments to Discord, clearing the
    // channel first ── /post-strat
    if (url.pathname === '/post-strat' && request.method === 'POST') {
      return handlePostStrat(request, env);
    }

    // ── Latest Warcraft Logs report, for the raid manager's attendance
    // review UI ── /logs/latest
    if (url.pathname === '/logs/latest' && request.method === 'GET') {
      return handleLatestLogsData(request, env);
    }

    // ── Recent reports list, for the Guild Logs tab's report picker ──
    if (url.pathname === '/logs/recent' && request.method === 'GET') {
      return handleRecentLogsData(request, env);
    }

    // ── Direct log-summary post from the Guild Logs tab (bypasses the
    // Discord slash command entirely) ── /post-log-summary
    if (url.pathname === '/post-log-summary' && request.method === 'POST') {
      return handleDirectLogPost(request, env);
    }

    // ── AI-generated "fallout report" (top + bottom parses, coaching tone)
    // ── /logs/fallout-report
    if (url.pathname === '/logs/fallout-report' && request.method === 'POST') {
      return handleFalloutReport(request, env);
    }

    // ── Post arbitrary pre-generated text (the fallout report) as its own
    // message, separate from the rankings post ── /post-text-message
    if (url.pathname === '/post-text-message' && request.method === 'POST') {
      return handlePostTextMessage(request, env);
    }

    // ── Fix a typo/mistake in an already-posted text message, in place -
    // ── /edit-text-message
    if (url.pathname === '/edit-text-message' && request.method === 'POST') {
      return handleEditMessage(request, env);
    }

    // ── Clear every message in a channel, so the Guild Logs channel only
    // ever shows the current week's posts ── /clear-channel
    if (url.pathname === '/clear-channel' && request.method === 'POST') {
      return handleClearChannel(request, env);
    }

    // ── Resolve a channel ID to its display name, purely so confirm
    // dialogs can show "#logs-archive" instead of a raw numeric ID ──
    // /discord/channel-name?id=X
    if (url.pathname === '/discord/channel-name' && request.method === 'GET') {
      return handleChannelName(request, env);
    }

    // ── Temporary diagnostic: introspect table()'s args (looking for an
    // ability-scoped filter) and Buffs/Casts shape for Power Infusion +
    // Innervate on a known report. Remove once resolved.
    if (url.pathname === '/logs/debug-utility' && request.method === 'GET') {
      try {
        const code = url.searchParams.get('code');
        const fightsData = await wclQuery(env, `query($code: String!) { reportData { report(code: $code) { fights { id kill } } } }`, { code });
        const fights = fightsData?.reportData?.report?.fights || [];
        const ids = fights.filter(f => f.kill).map(f => f.id);

        const data = await wclQuery(env, `
          query($code: String!, $ids: [Int]!) {
            reportData {
              report(code: $code) {
                pi: table(fightIDs: $ids, dataType: Casts, filterExpression: "ability.name=\\"Power Infusion\\"")
                innervate: table(fightIDs: $ids, dataType: Casts, filterExpression: "ability.name=\\"Innervate\\"")
              }
            }
          }
        `, { code, ids });
        return corsResponse(JSON.stringify(data?.reportData?.report ?? {}), 200);
      } catch (err) {
        return corsResponse(JSON.stringify({ error: err.message }), 500);
      }
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

    // pugs are per-raid now (not a shared top-level list) - importing one
    // raid's roster used to silently wipe every other raid's pugs, since
    // they all pointed at the same array. raid.pugs is that raid's own.
    const embed = buildRosterEmbed(raid, roster, raid.pugs || [], data.guildies || [], notify);

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

const SITE_ORIGIN = 'https://kaizen-tbc.github.io';

// Player IDs are positive for real roster members, negative for guildies
// (temp adds) and pugs (name+class/spec entered ad hoc) - same lookup the
// frontend's getPlayerById does, just re-implemented here since the Worker
// only has the raw published JSON, not the live in-page state.
function resolveStratPlayer(id, roster, guildies, pugs) {
  if (id == null) return null;
  if (id >= 0) return roster.find(p => p.id === id) || null;
  return guildies.find(p => p.id === id) || pugs.find(p => p.id === id) || null;
}

function formatStratRowSide(type, value, roster, guildies, pugs) {
  if (type === 'player') {
    const p = resolveStratPlayer(value, roster, guildies, pugs);
    return p ? p.name : '_unassigned_';
  }
  if (type === 'notes') return value || '_(no notes)_';
  return value || '';
}

// Generic across whatever sections/rows a given strat has (Tanks, Healer
// Assigns, Misdirection, Lust/Drums, Strategy Notes, or any custom ones)
// since the section/row model itself is freeform, not encounter-specific.
function formatStratSection(section, roster, guildies, pugs) {
  const lines = (section.rows || []).map(row => {
    const a = formatStratRowSide(row.typeA, row.valueA, roster, guildies, pugs);
    if (!row.typeB) return a; // notes-only row
    const b = formatStratRowSide(row.typeB, row.valueB, roster, guildies, pugs);
    if (row.arrow) return `${a} → ${b}`;
    return row.typeA === 'text' ? `**${a}:** ${b}` : `${a} — ${b}`;
  });
  return lines.join('\n') || '—';
}

// A section is "notes-style" (prose) if every row is a bare notes row -
// that reads badly squeezed into a narrow half-width inline column, so it
// always takes the full row width on its own rather than being paired.
function isNotesSection(section) {
  const rows = section.rows || [];
  return rows.length > 0 && rows.every(r => r.typeA === 'notes');
}

// Lays sections out as a loose grid instead of one long stack: two
// non-notes sections side by side per row (Discord's own inline field
// packing), any notes-style section full-width on its own row. A
// zero-width-space spacer field (full width, invisible) is what actually
// forces Discord to start a new row between groups - without one, Discord
// just packs as many inline fields as fit the available width, which isn't
// a reliable "exactly 2 per row" on its own.
function buildStratSectionFields(strat, roster, guildies, pugs) {
  const rows = [];
  let pendingPair = [];
  for (const sec of (strat.sections || [])) {
    const field = {
      name: sec.label || 'Section',
      value: formatStratSection(sec, roster, guildies, pugs).slice(0, 1024), // Discord field value cap
      inline: !isNotesSection(sec),
    };
    if (!field.inline) {
      if (pendingPair.length) { rows.push(pendingPair); pendingPair = []; }
      rows.push([field]);
    } else {
      pendingPair.push(field);
      if (pendingPair.length === 2) { rows.push(pendingPair); pendingPair = []; }
    }
  }
  if (pendingPair.length) rows.push(pendingPair); // lone leftover - fine on its own

  const fields = [];
  rows.forEach((row, i) => {
    if (i > 0) fields.push({ name: '​', value: '​', inline: false });
    fields.push(...row);
  });
  return fields;
}

function buildStratAssignsEmbed(strat, roster, guildies, pugs) {
  const fields = buildStratSectionFields(strat, roster, guildies, pugs);
  return {
    title: `📋 ${strat.name} — Assignments`,
    color: 0xC9A227,
    fields: fields.length ? fields : [{ name: 'No assignments yet', value: '—' }],
    footer: { text: 'Kaizen Raid Manager' },
    timestamp: new Date().toISOString(),
  };
}

// Tried padding this (and the assigns embed) with a description to force
// both cards toward Discord's max width and line up edge to edge -
// confirmed live it doesn't actually work once an `image` is involved
// (an embed's image apparently renders at its own footprint regardless of
// description length, unlike a pure-text embed). Reverted; not chasing
// this further; a description here wasn't adding real value on its own.
function buildStratImageEmbed(strat, imageUrl) {
  return {
    title: `🗺️ ${strat.name}`,
    color: 0xC9A227,
    image: { url: imageUrl },
    footer: { text: 'Kaizen Raid Manager' },
    timestamp: new Date().toISOString(),
  };
}

// Clears the strats channel (no archive - these are a living reference,
// not a history worth keeping), then posts the strat image and one embed
// per assignment section. Requires the strat to already be saved/
// published: the image needs a real public URL, and the assignments need
// to be readable from the same published JSON the roster-post flow already
// relies on - no new file-upload path through the bot needed.
async function handlePostStrat(request, env) {
  try {
    const { stratId, channelId } = await request.json();
    if (!channelId) throw new Error('No channel ID provided.');
    if (stratId == null) throw new Error('No strat selected.');

    const dataRes = await fetch(`${SITE_ORIGIN}/kaizen_data.json?v=${Date.now()}`);
    if (!dataRes.ok) throw new Error('Could not load raid data.');
    const data = await dataRes.json();

    const strat = (data.strats || []).find(s => s.id === stratId);
    if (!strat) throw new Error("Strat not found — make sure it's been saved to GitHub first.");
    if (!strat.image || strat.image.startsWith('data:')) {
      throw new Error("This strat's image isn't saved yet (still a local upload) — Save to GitHub first so it has a public URL.");
    }
    const imageUrl = strat.image.startsWith('http') ? strat.image : `${SITE_ORIGIN}/${strat.image}`;

    await clearChannelMessages(env, channelId, null);

    const headers = { 'Authorization': `Bot ${env.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' };
    const postEmbed = async (embed) => {
      const res = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
        method: 'POST', headers, body: JSON.stringify({ embeds: [embed] }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || `Post failed: ${res.status}`);
      }
      // A small gap between sequential posts respects Discord's per-channel
      // rate limit on a raid-sized batch of section messages.
      await new Promise(r => setTimeout(r, 350));
    };

    await postEmbed(buildStratImageEmbed(strat, imageUrl));
    // Back to one combined post - separate embeds per section read badly
    // too (each one a full-width card just for 2-3 lines). Sections lay
    // out as a grid within this single embed instead (see
    // buildStratSectionFields): paired side by side where that makes
    // sense, full-width for prose sections.
    // pugs are per-raid now, not a shared top-level list (see
    // handleDirectRosterPost) - a strat assign slot isn't tied to any one
    // raid tab though, so a pug assigned to a strat could come from any of
    // them. Union across all raids (deduped by id) preserves that lookup.
    const allPugs = [];
    const seenPugIds = new Set();
    for (const r of (data.raids || [])) {
      for (const p of (r.pugs || [])) {
        if (!seenPugIds.has(p.id)) { seenPugIds.add(p.id); allPugs.push(p); }
      }
    }
    await postEmbed(buildStratAssignsEmbed(strat, data.roster || [], data.guildies || [], allPugs));

    return corsResponse(JSON.stringify({ ok: true }), 200);
  } catch (err) {
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

    const embed = buildRosterEmbed(raid, roster, raid.pugs || [], data.guildies || []);

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
// (not fully-typed GraphQL). Confirmed live shape: rankings is one entry per
// killed fight, each with roles.{tanks,healers,dps}.characters[] carrying
// amount + rankPercent (see extractRoleParses). extractParticipantNames/
// extractRoleParses still wrapped in try/catch in case that shape drifts.
const WCL_TOKEN_URL = 'https://www.warcraftlogs.com/oauth/token';
const WCL_API       = 'https://www.warcraftlogs.com/api/v2/client';

// Every wclQuery call used to fetch a brand new OAuth token first - meaning
// each "one" WCL API call was actually two physical requests hitting
// warcraftlogs.com. Caching the token (it's normally valid ~1hr) roughly
// halves real request volume against WCL for free, on top of whatever the
// report/table caching below saves. env.WCL_CACHE is optional here on
// purpose - a KV outage degrades to "re-authenticate every time" (today's
// behavior), never a hard failure.
async function getWCLToken(env) {
  const cacheKey = 'wcl_token';
  if (env.WCL_CACHE) {
    const cached = await env.WCL_CACHE.get(cacheKey).catch(() => null);
    if (cached) return cached;
  }
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
  if (env.WCL_CACHE && data.access_token) {
    // Refresh a bit early (60s margin) rather than risk using a token that
    // expires mid-request. expires_in is seconds; KV's minimum TTL is 60s.
    const ttl = Math.max(60, (data.expires_in || 3600) - 60);
    await env.WCL_CACHE.put(cacheKey, data.access_token, { expirationTtl: ttl }).catch(() => {});
  }
  return data.access_token;
}

async function wclQuery(env, query, variables = {}, _retrying = false) {
  const token = await getWCLToken(env);
  const res = await fetch(WCL_API, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  // A cached token that's expired early or been revoked looks like a 401 -
  // clear it and retry once with a freshly-authenticated token rather than
  // surfacing a confusing auth error for what's really a stale cache entry.
  if (res.status === 401 && !_retrying) {
    if (env.WCL_CACHE) await env.WCL_CACHE.delete('wcl_token').catch(() => {});
    return wclQuery(env, query, variables, true);
  }
  const json = await res.json().catch(() => null);
  // WCL's API gateway can reject a request before it ever reaches GraphQL
  // (e.g. HTTP 429 "Too many requests from this IP address" - an IP-level
  // throttle, distinct from the per-hour points budget checked below). That
  // comes back as {status, error} with no `errors[]` array, so without this
  // check it silently looks like an empty/missing result instead of the
  // real cause.
  if (!res.ok) {
    throw new Error(`Warcraft Logs API error (${res.status}): ${json?.error || json?.message || 'request failed'}`);
  }
  if (json?.errors?.length) throw new Error(json.errors.map(e => e.message).join('; '));
  return json?.data;
}

// WCL's client_credentials tier is capped (3,600 points/hour as of this
// writing). Going over budget doesn't always surface as a GraphQL error —
// sometimes fields just resolve to null/empty with no `errors` array, which
// looks identical to "this report genuinely doesn't exist." Call this
// whenever a lookup unexpectedly comes back empty, so the real cause shows
// up in the error message instead of a misleading "not found".
async function getWCLRateLimit(env) {
  try {
    const data = await wclQuery(env, `{ rateLimitData { limitPerHour pointsSpentThisHour pointsResetIn } }`);
    return data?.rateLimitData || null;
  } catch {
    return null;
  }
}

function rateLimitSuffix(rl) {
  if (!rl) return '';
  const remaining = rl.limitPerHour - rl.pointsSpentThisHour;
  if (remaining > rl.limitPerHour * 0.1) return '';
  const mins = Math.ceil((rl.pointsResetIn || 0) / 60);
  return ` (Warcraft Logs rate limit: ${rl.pointsSpentThisHour}/${rl.limitPerHour} points used this hour, resets in ~${mins}m — this is likely the real cause.)`;
}

// reports lives on the top-level reportData container, filtered by guildID
// - NOT nested under guildData.guild (confirmed live: querying it that way
// errors with "Cannot query field 'reports' on type 'Guild'").
async function listRecentGuildReports(env, limit = 10) {
  if (!env.WCL_GUILD_ID) throw new Error('WCL_GUILD_ID is not configured.');

  const data = await wclQuery(env, `
    query($id: Int!, $limit: Int!) {
      reportData {
        reports(guildID: $id, limit: $limit) {
          data { code title startTime endTime zone { name } }
        }
      }
    }
  `, {
    id: Number(env.WCL_GUILD_ID),
    limit,
  });

  return data?.reportData?.reports?.data || [];
}

// Picks the most complete report from the last ~36h. Handles two people
// both auto-uploading the same raid night — takes whichever log covers
// more of the raid rather than whichever finished uploading last.
async function findLatestGuildReport(env) {
  const reports = await listRecentGuildReports(env, 5);
  if (reports.length === 0) return null;

  const cutoff = Date.now() - 36 * 60 * 60 * 1000;
  const recent = reports.filter(r => r.endTime >= cutoff);
  const pool = recent.length ? recent : [reports[0]];
  return pool.reduce((best, r) =>
    (r.endTime - r.startTime) > (best.endTime - best.startTime) ? r : best
  , pool[0]);
}

// A WCL report is immutable once it's up - parses are locked, the fights
// that happened happened. So once we've paid for this 5-request round trip
// once, there's no reason to ever pay it again for the same code: preview,
// re-preview while tweaking the fallout-report prompt, and Post-to-Discord
// (which used to silently refetch this exact same data a second time) all
// now share one cache entry. No TTL - "immutable" means never expires.
// Only a genuinely successful fetch is cached; a not-found/error result
// isn't, so a typo'd code or a report still uploading doesn't get stuck.
async function getReportFightsAndStats(env, code) {
  const cacheKey = `report:${code}`;
  if (env.WCL_CACHE) {
    const cached = await env.WCL_CACHE.get(cacheKey, 'json').catch(() => null);
    if (cached) return cached;
  }
  const result = await fetchReportFightsAndStats(env, code);
  if (env.WCL_CACHE && result.report?.title) {
    await env.WCL_CACHE.put(cacheKey, JSON.stringify(result)).catch(() => {});
  }
  return result;
}

// Fight list, rankings, and participant data for one report. Two queries:
// rankings/playerDetails need fight ID arrays as arguments, which we only
// have after the first query returns the fight list.
async function fetchReportFightsAndStats(env, code) {
  const fightsData = await wclQuery(env, `
    query($code: String!) {
      reportData {
        report(code: $code) {
          title
          startTime
          endTime
          fights { id name encounterID kill startTime endTime }
        }
      }
    }
  `, { code });

  const reportInfo = fightsData?.reportData?.report;
  const fights = reportInfo?.fights || [];
  const killFights = fights.filter(f => f.kill);
  const allFightIds = fights.map(f => f.id);
  const killFightIds = killFights.map(f => f.id);

  // playerMetric must be explicit and role-matched - confirmed live against
  // a WCL CSV export (Fathom-Lord Karathress healing table, exact numbers):
  // omitting it entirely returns percentiles for a different, undocumented
  // default metric - a healer showing 90th/97th percentile in our old
  // output whose real HPS percentile, straight from her own exported log,
  // was 60. (An earlier attempt at this fix added `compare: Parses`,
  // reasoning the comparison pool was too narrow - that was a wrong turn;
  // the default "vs personal-best" compare mode is actually correct once
  // paired with the right metric, confirmed by matching 5 of 6 players
  // exactly against the CSV.) WCL ranks the WHOLE request by one metric,
  // not per-character, so DPS and healers can't both be scored correctly
  // in a single call - this runs twice, once per role.
  const [dpsStatsData, healerStatsData] = await Promise.all([
    wclQuery(env, `
      query($code: String!, $allIds: [Int]!, $killIds: [Int]!) {
        reportData {
          report(code: $code) {
            rankings(fightIDs: $killIds, playerMetric: dps)
            playerDetails(fightIDs: $allIds)
          }
        }
      }
    `, { code, allIds: allFightIds, killIds: killFightIds }),
    wclQuery(env, `
      query($code: String!, $killIds: [Int]!) {
        reportData {
          report(code: $code) {
            rankings(fightIDs: $killIds, playerMetric: hps)
          }
        }
      }
    `, { code, killIds: killFightIds }),
  ]);

  // Deaths/Interrupts tables pulled across ALL fights (not just kills) -
  // wipes matter just as much as kills for "what are we dying to", and
  // interrupt performance is relevant on trash/wipes too. Deliberately kept
  // as their OWN separate requests, not merged into the query above: live
  // testing showed that bundling both table() calls in with rankings +
  // playerDetails made WCL silently return null for the table fields (no
  // GraphQL error, just empty) - almost certainly a per-query cost/
  // complexity cap that table() blows past when combined with anything
  // else. Standalone, each one reliably returns real data, so that's worth
  // the extra round trips.
  // Best-effort: these are two extra round trips on top of the core report
  // fetch, so a transient failure here (rate limit, timeout) shouldn't take
  // down the whole preview - it just means the fallout report falls back to
  // "no death/interrupt data" instead of the core rankings failing too.
  let deathsData = null, interruptsData = null;
  try {
    deathsData = await wclQuery(env, `
      query($code: String!, $ids: [Int]!) {
        reportData { report(code: $code) { table(fightIDs: $ids, dataType: Deaths) } }
      }
    `, { code, ids: allFightIds });
  } catch (err) {
    console.warn('Deaths table fetch failed:', err.message);
  }
  try {
    interruptsData = await wclQuery(env, `
      query($code: String!, $ids: [Int]!) {
        reportData { report(code: $code) { table(fightIDs: $ids, dataType: Interrupts) } }
      }
    `, { code, ids: allFightIds });
  } catch (err) {
    console.warn('Interrupts table fetch failed:', err.message);
  }

  return {
    // Full report info (title/dates), for callers that only have a code and
    // skipped findLatestGuildReport's own discovery query.
    report: reportInfo ? { code, title: reportInfo.title, startTime: reportInfo.startTime, endTime: reportInfo.endTime } : null,
    fights,
    killFights,
    // Two separate rankings blobs (see comment above) - dps role data only
    // trustworthy from rankingsRawDps, healers only from rankingsRawHealers.
    rankingsRawDps: dpsStatsData?.reportData?.report?.rankings ?? null,
    rankingsRawHealers: healerStatsData?.reportData?.report?.rankings ?? null,
    playerDetailsRaw: dpsStatsData?.reportData?.report?.playerDetails ?? null,
    deathsRaw: deathsData?.reportData?.report?.table ?? null,
    interruptsRaw: interruptsData?.reportData?.report?.table ?? null,
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

// Confirmed live shape: rankings is one entry PER KILLED FIGHT, each with
// roles.{tanks,healers,dps}.characters[], each character carrying amount +
// rankPercent (the actual WCL percentile) for that specific pull. Rather
// than blending a person's percentile across every kill into one vague
// number, track their best AND worst single-encounter result separately,
// each tagged with which boss it was — "on the encounter" instead of "on
// the raid night in general", which is what actually makes a tip specific
// and useful (that fight's mechanics are the reason for the low percentile,
// not some abstract raid-wide average).
// deaths (from extractDeaths) let "worst" mean "worst SURVIVED pull"
// specifically, not just the single lowest value ever - a death blotting
// out someone's real worst-but-alive performance on a different encounter
// was why this list and classifyLowParses (which correctly walks every
// pull) could end up naming completely different people as needing work.
// Falls back to the raw overall worst only if they never survived a
// single logged pull this raid (rare).
function extractRoleParses(rankingsRaw, roleKey, deaths = []) {
  try {
    const deathSet = new Set(deaths.map(d => `${d.name}|${d.fightID}`));
    const fights = rankingsRaw?.data || [];
    const byPlayer = new Map();
    // A world-wide percentile can look great off a thin comparison pool
    // (a rarely-played spec/role combo) while the person is doing almost
    // none of the raid's actual work that fight. raidSharePct - this
    // person's share of the WHOLE role's total output that fight - is a
    // much harder number to game: if everyone parses well, a healthy
    // spread of shares is normal; one inflated percentile next to a tiny
    // share means someone else is carrying the real workload.
    const fightTotals = new Map(); // fightID -> summed amount across the role
    for (const fight of fights) {
      const chars = fight?.roles?.[roleKey]?.characters || [];
      let total = 0;
      for (const c of chars) total += (typeof c.amount === 'number' ? c.amount : 0);
      fightTotals.set(fight?.fightID, total);
    }
    for (const fight of fights) {
      const chars = fight?.roles?.[roleKey]?.characters || [];
      const encounter = fight?.encounter?.name || 'Unknown';
      const fightID = fight?.fightID;
      const fightTotal = fightTotals.get(fightID) || 0;
      for (const c of chars) {
        if (!c?.name || typeof c.rankPercent !== 'number') continue;
        if (!byPlayer.has(c.name)) {
          byPlayer.set(c.name, { name: c.name, class: c.class, spec: c.spec, results: [] });
        }
        const raidSharePct = fightTotal > 0 && typeof c.amount === 'number'
          ? Math.round((c.amount / fightTotal) * 1000) / 10
          : null;
        // totalParses is the size of the comparison pool WCL ranked this
        // percentile against - carried through so a rarely-logged spec/role
        // combo (a handful of parses) can be flagged as statistically
        // unreliable instead of presented at face value (see WCL_SMALL_SAMPLE).
        byPlayer.get(c.name).results.push({
          rankPercent: c.rankPercent, encounter, fightID, totalParses: c.totalParses, raidSharePct,
          survived: !deathSet.has(`${c.name}|${fightID}`),
        });
      }
    }
    return [...byPlayer.values()].map(p => {
      const survived = p.results.filter(r => r.survived);
      return {
        name: p.name,
        class: p.class,
        spec: p.spec,
        best: p.results.reduce((a, b) => (b.rankPercent > a.rankPercent ? b : a)),
        worst: (survived.length ? survived : p.results).reduce((a, b) => (b.rankPercent < a.rankPercent ? b : a)),
      };
    });
  } catch {
    return [];
  }
}

// Deaths table shape (confirmed live 2026-08-22): table.data.entries[] is
// one entry PER DEATH (not per player) - {name, fight (fightID), killingBlow:
// {name}, ...}. This is what actually killed them, straight from the log.
function extractDeaths(deathsRaw) {
  try {
    return (deathsRaw?.data?.entries || []).map(e => ({
      name: e.name,
      fightID: e.fight,
      killingBlow: e.killingBlow?.name || 'Unknown',
    }));
  } catch {
    return [];
  }
}

// Interrupts table shape (confirmed live 2026-08-22): table.data.entries[]
// is one entry per ability that got interrupted, each carrying a details[]
// array naming who got interrupted and a nested actors[] naming who landed
// the interrupt. We only care about raid-wide "who's landing interrupts",
// so every actors[] hit gets flattened into a simple name -> count tally
// regardless of what got interrupted or who cast it.
// actors[].type is the actual WoW class for real players ("Shaman",
// "Hunter", ...) and "NPC"/"Boss" for everything else (confirmed live: a
// raw interrupts pull for one report mixed in "Kael'thas Sunstrider" (Boss,
// count 40) and "Staff of Disintegration" (an item proc, type NPC) right
// alongside real raiders). Only the 9 classic WoW classes count as a player.
const PLAYER_CLASSES = new Set(['Warrior', 'Paladin', 'Hunter', 'Rogue', 'Priest', 'Shaman', 'Mage', 'Warlock', 'Druid']);

function extractInterruptCounts(interruptsRaw) {
  try {
    const counts = new Map();
    // One extra nesting level vs. what the shape looks like at a glance:
    // data.entries[] wraps ANOTHER entries[] array (confirmed live 2026-08-22)
    // - the per-ability objects with .details are at data.entries[*].entries[],
    // not data.entries[] directly.
    for (const wrapper of interruptsRaw?.data?.entries || []) {
      for (const entry of wrapper?.entries || []) {
        for (const detail of entry?.details || []) {
          for (const actor of detail?.actors || []) {
            if (!actor?.name || !PLAYER_CLASSES.has(actor.type)) continue;
            counts.set(actor.name, (counts.get(actor.name) || 0) + (actor.total || 0));
          }
        }
      }
    }
    return [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
  } catch {
    return [];
  }
}

// The real "red flag" per the officers: a 0% parse from dying tells you
// nothing you don't already know ("don't die"). A grey-tier parse (WCL's
// own 0-24 tier) from someone who SURVIVED the whole fight is the actual
// rotation/gear/positioning problem worth coaching. This walks rankingsRaw
// directly (not the best/worst-only shape extractRoleParses returns) since
// it needs every individual pull, cross-referenced against deaths by
// fightID, to tell "grey because they died" apart from "grey while alive".
function classifyLowParses(rankingsRaw, roleKey, deaths) {
  const deathSet = new Set(deaths.map(d => `${d.name}|${d.fightID}`));
  const byPlayer = new Map();
  for (const fight of rankingsRaw?.data || []) {
    const chars = fight?.roles?.[roleKey]?.characters || [];
    const encounter = fight?.encounter?.name || 'Unknown';
    const fightID = fight?.fightID;
    for (const c of chars) {
      if (!c?.name || typeof c.rankPercent !== 'number') continue;
      if (c.rankPercent >= 25) continue; // only WCL's grey tier is in scope
      if (deathSet.has(`${c.name}|${fightID}`)) continue; // died - not a rotation issue
      const cur = byPlayer.get(c.name);
      if (!cur || c.rankPercent < cur.rankPercent) {
        // fightID carried through so a per-fight uptime/ability breakdown
        // can be pulled for exactly this pull, not just the raw percentile.
        // totalParses carried through too - see WCL_SMALL_SAMPLE_THRESHOLD.
        byPlayer.set(c.name, { name: c.name, class: c.class, spec: c.spec, rankPercent: c.rankPercent, encounter, fightID, totalParses: c.totalParses });
      }
    }
  }
  return [...byPlayer.values()].sort((a, b) => a.rankPercent - b.rankPercent);
}

// Below this share of the role's total output that fight, a percentile
// stops being trustworthy evidence of real contribution - a thin/off-meta
// comparison pool can make someone look like a world-beater while they're
// doing almost none of the raid's actual work. 5% is deliberately
// conservative: even accounting for uneven healing assignments, a healthy
// contributor rarely falls this far below an equal share (100/headcount%).
const HOLLOW_SHARE_THRESHOLD = 5;

// The mirror image of classifyLowParses: instead of catching a real
// performance problem hiding behind a death, this catches a percentile
// that LOOKS great but isn't backed by real output - purple-tier-or-better
// (75+) on a pull where the person's actual share of the role's combined
// output was tiny. This is what "parsing 99 as a healer while doing ~1%
// of the raid's healing" looks like in the data, and it's a much harder
// number to argue with than a percentile from a rarely-played spec/role.
function classifyHollowTopPerformers(rankingsRaw, roleKey, deaths) {
  const deathSet = new Set(deaths.map(d => `${d.name}|${d.fightID}`));
  const fights = rankingsRaw?.data || [];
  const fightTotals = new Map();
  for (const fight of fights) {
    const chars = fight?.roles?.[roleKey]?.characters || [];
    let total = 0;
    for (const c of chars) total += (typeof c.amount === 'number' ? c.amount : 0);
    fightTotals.set(fight?.fightID, total);
  }
  const byPlayer = new Map();
  for (const fight of fights) {
    const chars = fight?.roles?.[roleKey]?.characters || [];
    const encounter = fight?.encounter?.name || 'Unknown';
    const fightID = fight?.fightID;
    const fightTotal = fightTotals.get(fightID) || 0;
    for (const c of chars) {
      if (!c?.name || typeof c.rankPercent !== 'number') continue;
      if (c.rankPercent < 75) continue; // only the "looks great" tier qualifies
      if (deathSet.has(`${c.name}|${fightID}`)) continue; // dying isn't this pattern
      if (fightTotal <= 0 || typeof c.amount !== 'number') continue;
      const sharePct = Math.round((c.amount / fightTotal) * 1000) / 10;
      if (sharePct >= HOLLOW_SHARE_THRESHOLD) continue; // healthy share - not hollow
      const cur = byPlayer.get(c.name);
      // Keep whichever pull is most striking - highest percentile paired
      // with a hollow share, since that's the biggest "looks great, isn't" gap.
      if (!cur || c.rankPercent > cur.rankPercent) {
        byPlayer.set(c.name, { name: c.name, class: c.class, spec: c.spec, rankPercent: c.rankPercent, sharePct, encounter, fightID, totalParses: c.totalParses });
      }
    }
  }
  return [...byPlayer.values()].sort((a, b) => b.rankPercent - a.rankPercent);
}

// Per-fight actor breakdown (uptime %, top damage/healing sources) for one
// specific pull - this is what turns "keep your rotation tight" into
// "you had 58% active time on this pull, and Melee was 70% of your damage
// with almost none from your core spender" - a real, log-derived reason
// instead of boilerplate. dataType is 'DamageDone' for DPS, 'Healing' for
// healers. Best-effort: wrapped so a shape mismatch or a failed fetch just
// means that person's entry loses the extra detail, not that the whole
// report fails - this table's exact shape hasn't been separately confirmed
// live the way Deaths/Interrupts were (WCL rate limit made that untestable
// today), so treat it as reasoned-but-unverified until the first real run.
// One HTTP request for ALL of these fights instead of one-per-fight, via
// GraphQL aliases (fightIDs varies per alias, so it can't be a shared query
// variable - embedded as a literal instead, safe since these are always our
// own numeric fight IDs off the report's own fight list, never user input).
// This is what used to turn a raid with several problem fights into a burst
// of 10-20+ sequential WCL calls from a single "Fetch" click.
async function getFightActorTablesBatch(env, code, fightIds, dataType) {
  if (!fightIds.length) return new Map();
  const aliases = fightIds.map((fid, i) => `f${i}: table(fightIDs: [${fid}], dataType: $dataType)`).join('\n');
  try {
    const data = await wclQuery(env, `
      query($code: String!, $dataType: TableDataType!) {
        reportData {
          report(code: $code) {
            ${aliases}
          }
        }
      }
    `, { code, dataType });
    const report = data?.reportData?.report || {};
    const result = new Map();
    fightIds.forEach((fid, i) => result.set(fid, report[`f${i}`] ?? null));
    return result;
  } catch (err) {
    console.warn(`Batched ${dataType} table fetch failed:`, err.message);
    return new Map();
  }
}

// Actor-summary shape seen so far (nested inside a Deaths entry's `.damage`)
// carries activeTime/activeTimeReduced and an abilities[] breakdown with
// per-ability totals. Standalone DamageDone/Healing table entries are
// expected to carry that same shape at the top level rather than nested -
// checked defensively for both in case that assumption is wrong.
function extractActorBreakdown(tableRaw, playerName) {
  try {
    const entries = tableRaw?.data?.entries || [];
    const entry = entries.find(e => e?.name === playerName);
    if (!entry) return null;
    const src = entry.damage || entry.healing || entry;
    const abilities = [...(src.abilities || [])].sort((a, b) => (b.total || 0) - (a.total || 0));
    const total = abilities.reduce((sum, a) => sum + (a.total || 0), 0) || src.total || 0;
    return {
      activeTime: typeof src.activeTime === 'number' ? src.activeTime : null,
      abilities: abilities.slice(0, 4).map(a => ({
        name: a.name,
        pct: total ? Math.round(((a.total || 0) / total) * 100) : null,
      })),
    };
  } catch {
    return null;
  }
}

// Attaches uptimePct/topAbilities to each grey-tier-survived entry, fetching
// each unique fight's table only once and sharing it across everyone who
// struggled on that same pull (several people often share an encounter).
// Same immutable-once-logged reasoning as getReportFightsAndStats - a given
// (report, fight, dataType) table never changes, so it's cached indefinitely
// and only ever fetched from WCL the first time any report needs it.
async function enrichWithFightBreakdown(env, code, list, dataType, fightDurationById) {
  const uniqueFightIds = [...new Set(list.map(p => p.fightID).filter(id => id != null))];
  const tables = new Map();

  const misses = [];
  for (const fid of uniqueFightIds) {
    const cacheKey = `fighttable:${code}:${fid}:${dataType}`;
    const cached = env.WCL_CACHE ? await env.WCL_CACHE.get(cacheKey, 'json').catch(() => null) : null;
    if (cached !== null) tables.set(fid, cached);
    else misses.push(fid);
  }

  if (misses.length) {
    const fetched = await getFightActorTablesBatch(env, code, misses, dataType);
    for (const fid of misses) {
      const table = fetched.get(fid) ?? null;
      tables.set(fid, table);
      if (env.WCL_CACHE && table !== null) {
        await env.WCL_CACHE.put(`fighttable:${code}:${fid}:${dataType}`, JSON.stringify(table)).catch(() => {});
      }
    }
  }

  return list.map(p => {
    const table = tables.get(p.fightID);
    const breakdown = table ? extractActorBreakdown(table, p.name) : null;
    const duration = fightDurationById.get(p.fightID);
    const uptimePct = breakdown?.activeTime != null && duration
      ? Math.round((breakdown.activeTime / duration) * 100)
      : null;
    return { ...p, uptimePct, topAbilities: breakdown?.abilities || [] };
  });
}

// Below this many logged parses, WCL's percentile is being compared
// against a tiny/weird sample pool - most often a spec that's rarely
// logged in that role (an off-meta or hybrid build), which can produce a
// misleadingly flattering (or unflattering) percentile that doesn't
// really reflect performance. Flagged rather than trusted at face value.
const WCL_SMALL_SAMPLE_THRESHOLD = 20;

function topByBest(list, n = 5) {
  return [...list].sort((a, b) => b.best.rankPercent - a.best.rankPercent).slice(0, n);
}
// "Needs work" must have an actual floor - without one, on a small roster
// the bottom N by relative rank can include someone whose "worst" pull was
// still a 99 (e.g. a healer who only logged once), which reads as a bug,
// not a coaching signal. Purple tier (75+) and up is never "needs work".
function bottomByWorst(list, n = 5) {
  return [...list]
    .filter(p => p.worst.rankPercent < 75)
    .sort((a, b) => a.worst.rankPercent - b.worst.rankPercent)
    .slice(0, n);
}

// Standard WCL parse-color tiers, boundaries matching their own site
// (0-24 grey, 25-49 green, 50-74 blue, 75-94 purple, 95-98 orange, 99 pink,
// 100 gold). Discord embeds can't color arbitrary inline text, so a colored
// circle emoji is the closest practical stand-in for "parse color" here.
function parseColorEmoji(pct) {
  const p = Math.round(pct);
  if (p >= 100) return '🟡';
  if (p >= 99) return '🩷';
  if (p >= 95) return '🟠';
  if (p >= 75) return '🟣';
  if (p >= 50) return '🔵';
  if (p >= 25) return '🟢';
  return '⚪';
}

// which: 'best' or 'worst' — picks the matching {rankPercent, encounter} off
// each entry, so a "top" list shows their best pull and a "bottom" list
// shows their worst, each correctly tagged with which boss it happened on.
// Discord's plain markdown has no inline text-color, so the parse-tier
// "dot" emoji is the only color signal available - but Discord's font
// isn't monospace, so nothing here lines up into real columns no matter
// what order it's in. Icon/dot/number go right after the rank number
// (fixed content, roughly constant width) and the variable-length name
// goes last, so at least the dot doesn't visibly jump left/right based on
// how long each person's name happens to be.
function formatParseLines(list, which) {
  if (!list.length) return '—';
  return list
    .map((p, i) => {
      const r = p[which];
      const icon = getWCLSpecEmoji(p.class, p.spec);
      const pct = Math.round(r.rankPercent);
      const smallSample = typeof r.totalParses === 'number' && r.totalParses < WCL_SMALL_SAMPLE_THRESHOLD
        ? ` ⚠_(rare in this role — only ${r.totalParses} logged, take with a grain of salt)_`
        : '';
      // Only on the "best"/top list - a world-wide percentile can look
      // great off a thin comparison pool while contributing almost none of
      // this raid's actual output; share of the role's total output that
      // fight is a much harder number to game.
      const shareNote = which === 'best' && typeof r.raidSharePct === 'number'
        ? ` _(${r.raidSharePct}% of raid total)_`
        : '';
      return `**${i + 1}.** ${icon ? icon + ' ' : ''}${parseColorEmoji(r.rankPercent)} **${pct}** — ${p.name} _(${r.encounter})_${shareNote}${smallSample}`;
    })
    .join('\n');
}

// All deaths (not just whatever the single tracked "worst" pull happens to
// be) for anyone who appears in this role at all - so someone who died on
// one fight but also had a separate bad-but-survived pull elsewhere shows
// correctly in BOTH the Died line and Needs Work, instead of the death
// silently eating their one "worst" slot.
function deathsForRole(deaths, roleList, fightNameById) {
  const names = new Set(roleList.map(p => p.name));
  return deaths
    .filter(d => names.has(d.name))
    .map(d => ({ name: d.name, encounter: fightNameById.get(d.fightID) || 'Unknown' }));
}

// A per-name laundry list of every death is noise, not a coaching signal -
// what's actually useful is "how many, and which encounters are the real
// problem" (a positioning/mechanics pattern worth flagging), not who.
function tallyDeathsByEncounter(died) {
  const counts = new Map();
  for (const d of died) counts.set(d.encounter, (counts.get(d.encounter) || 0) + 1);
  return [...counts.entries()].map(([encounter, count]) => ({ encounter, count })).sort((a, b) => b.count - a.count);
}

// Top N (by best pull) and bottom N (by worst-SURVIVED pull, purple/75+
// never counts) in one field, since embeds have limited field slots -
// "who's crushing it" and "who needs help" are both useful in one glance.
// Fewer top slots than needs-work slots on purpose: the coaching content
// (fallout report) is the main event, the rankings are just the receipts.
function formatTopAndBottom(list, died, topN = 3, bottomN = 7) {
  if (!list.length) return 'No parse data available.';
  const top = topByBest(list, topN);
  let out = formatParseLines(top, 'best');

  const bottom = bottomByWorst(list, bottomN);
  if (bottom.length) {
    out += `\n\n*Needs work:*\n` + formatParseLines(bottom, 'worst');
  }
  if (died.length) {
    const topCauses = tallyDeathsByEncounter(died).slice(0, 5).map(t => `${t.encounter} (${t.count})`).join(', ');
    out += `\n\n☠️ *Died ${died.length}x* — top causes: ${topCauses}`;
  }
  return out;
}

// Discord hard-caps a single embed field's value at 1024 chars - real
// failure seen live: "Invalid Form Body" with no field name to blame,
// because top-3/needs-work-7 plus the small-sample warnings, raid-share
// notes, and Died fact-sheet added tonight can now realistically push
// DPS/Healers past that cap (and a big attendance list can too). Rather
// than silently truncating real performance data, split an overlong
// section across "(cont.)" fields at line boundaries so nothing is lost.
function splitIntoFields(name, value, maxLen = 1024) {
  if (value.length <= maxLen) return [{ name, value, inline: false }];
  const lines = value.split('\n');
  const chunks = [];
  let current = '';
  for (const line of lines) {
    // A single line longer than the whole cap (pathological) still needs
    // a hard break so we never emit an invalid field.
    if (line.length > maxLen) {
      if (current) { chunks.push(current); current = ''; }
      for (let i = 0; i < line.length; i += maxLen) chunks.push(line.slice(i, i + maxLen));
      continue;
    }
    const next = current ? `${current}\n${line}` : line;
    if (next.length > maxLen) { chunks.push(current); current = line; }
    else current = next;
  }
  if (current) chunks.push(current);
  return chunks.map((v, i) => ({ name: i === 0 ? name : `${name} (cont.)`, value: v, inline: false }));
}

// Discord also caps an embed at 25 fields and ~6000 total chars across
// title+description+footer+all field names/values. Splitting fields alone
// can't fix that ceiling on a genuinely huge roster, so as a last resort
// spill overflow fields into additional embeds (still one Discord message -
// up to 10 embeds/message - so it reads as one post, not a flood).
function packFieldsIntoEmbeds(baseEmbed, fields) {
  const baseLen = (baseEmbed.title?.length || 0) + (baseEmbed.description?.length || 0) + (baseEmbed.footer?.text?.length || 0);
  const groups = [];
  let group = [];
  let groupLen = baseLen;
  for (const f of fields) {
    const fLen = f.name.length + f.value.length;
    if (group.length && (group.length >= 25 || groupLen + fLen > 5900)) {
      groups.push(group);
      group = [];
      groupLen = baseLen;
    }
    group.push(f);
    groupLen += fLen;
  }
  if (group.length) groups.push(group);
  return groups.map((fields, i) => ({
    ...baseEmbed,
    title: i === 0 ? baseEmbed.title : `${baseEmbed.title} (cont.)`,
    description: i === 0 ? baseEmbed.description : undefined,
    fields,
  }));
}

// Returns an array of embeds (almost always just one) - callers post them
// together in a single Discord message via { embeds: [...] }.
function buildLogSummaryEmbeds(report, details, roster) {
  const participants = extractParticipantNames(details.playerDetailsRaw);
  const attendance = matchAttendanceToRoster(participants, roster);
  const deaths = extractDeaths(details.deathsRaw);
  const dps = extractRoleParses(details.rankingsRawDps, 'dps', deaths);
  const healers = extractRoleParses(details.rankingsRawHealers, 'healers', deaths);
  const fightNameById = new Map(details.fights.map(f => [f.id, f.name]));

  const fields = [
    // Stacked full-width instead of side-by-side inline - two inline
    // columns squeeze each into ~half the embed's (fixed, Discord-
    // controlled) width, forcing mid-entry wraps that look cramped.
    ...splitIntoFields('⚔️ DPS', formatTopAndBottom(dps, deathsForRole(deaths, dps, fightNameById))),
    ...splitIntoFields('✚ Healers', formatTopAndBottom(healers, deathsForRole(deaths, healers, fightNameById))),
    ...splitIntoFields('👥 Attendance', attendance.length ? attendance.join(', ') : '—'),
  ];

  const baseEmbed = {
    title: `📊 ${report.title || 'Raid Log Summary'}`,
    url: `https://www.warcraftlogs.com/reports/${report.code}`,
    description: `${details.killFights.length}/${details.fights.length} encounters killed · ${attendance.length} guildies logged`,
    color: 0xC9A227,
    footer: { text: 'Kaizen Raid Manager • click title for the full report' },
    timestamp: new Date().toISOString(),
  };

  return packFieldsIntoEmbeds(baseEmbed, fields);
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

    const embeds = buildLogSummaryEmbeds(report, details, guildData.roster || []);

    // Slash-command replies only support one PATCH to @original, so even
    // in the rare overflow-to-multiple-embeds case this stays one message
    // (Discord allows up to 10 embeds per message).
    await fetch(followupUrl, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: embeds.slice(0, 10) }),
    });
  } catch (err) {
    await fetch(followupUrl, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: `❌ Couldn't post log summary: ${err.message}` }),
    });
  }
}

// GET /logs/recent — list of recent reports for the Guild Logs tab's report
// picker (so an officer can pick SSC vs TK etc. instead of always getting
// whichever the "most complete" heuristic picks).
async function handleRecentLogsData(request, env) {
  try {
    if (!env.WCL_CLIENT_ID || !env.WCL_CLIENT_SECRET) {
      throw new Error('Warcraft Logs API credentials not configured.');
    }
    const reports = await listRecentGuildReports(env, 10);
    if (reports.length === 0) {
      const rl = await getWCLRateLimit(env);
      const suffix = rateLimitSuffix(rl);
      if (suffix) throw new Error(`No reports returned for this guild.${suffix}`);
    }
    return corsResponse(JSON.stringify({ reports }), 200);
  } catch (err) {
    return corsResponse(JSON.stringify({ error: err.message }), 500);
  }
}

// GET /logs/latest — raw-ish log data for the raid manager's Guild Logs tab.
// ?code=REPORTCODE fetches that specific report instead of auto-detecting.
async function handleLatestLogsData(request, env) {
  try {
    if (!env.WCL_CLIENT_ID || !env.WCL_CLIENT_SECRET) {
      throw new Error('Warcraft Logs API credentials not configured.');
    }
    const url = new URL(request.url);
    // ?debug=1 includes the raw JSON blobs verbatim - temporary, for
    // inspecting the real shape of rankings/playerDetails against a live
    // report rather than guessing at their schema again.
    const debug = url.searchParams.get('debug');
    const requestedCode = url.searchParams.get('code');

    let report, details;
    if (requestedCode) {
      details = await getReportFightsAndStats(env, requestedCode);
      report = details.report;
      if (!report?.title) {
        const suffix = rateLimitSuffix(await getWCLRateLimit(env));
        throw new Error(`Report ${requestedCode} not found.${suffix}`);
      }
    } else {
      report = await findLatestGuildReport(env);
      if (!report) throw new Error('No recent reports found for the guild.');
      details = await getReportFightsAndStats(env, report.code);
    }

    const participants = extractParticipantNames(details.playerDetailsRaw);
    const deaths = extractDeaths(details.deathsRaw);
    const dps = extractRoleParses(details.rankingsRawDps, 'dps', deaths);
    const healers = extractRoleParses(details.rankingsRawHealers, 'healers', deaths);

    const fightNameById = new Map(details.fights.map(f => [f.id, f.name]));
    const fightDurationById = new Map(details.fights.map(f => [f.id, f.endTime - f.startTime]));
    let dpsSurvivedBad = classifyLowParses(details.rankingsRawDps, 'dps', deaths);
    let healersSurvivedBad = classifyLowParses(details.rankingsRawHealers, 'healers', deaths);
    // Best-effort enrichment (uptime %, top damage/healing sources per
    // pull) - failures here just mean plainer entries, not a broken fetch.
    try {
      dpsSurvivedBad = await enrichWithFightBreakdown(env, report.code, dpsSurvivedBad, 'DamageDone', fightDurationById);
      healersSurvivedBad = await enrichWithFightBreakdown(env, report.code, healersSurvivedBad, 'Healing', fightDurationById);
    } catch (err) {
      console.warn('Fight breakdown enrichment failed:', err.message);
    }
    const dpsHollowTop = classifyHollowTopPerformers(details.rankingsRawDps, 'dps', deaths);
    const healersHollowTop = classifyHollowTopPerformers(details.rankingsRawHealers, 'healers', deaths);
    const interrupts = extractInterruptCounts(details.interruptsRaw).slice(0, 8);

    return corsResponse(JSON.stringify({
      report,
      fights: details.fights,
      killFights: details.killFights,
      participants,
      dps,
      healers,
      // Death-adjusted grey-tier (0-24 percentile) lists - the real
      // coaching target, since a 0% from dying just means "don't die"
      // which isn't useful feedback on its own.
      dpsSurvivedBad,
      healersSurvivedBad,
      // The mirror case: a great-looking percentile backed by almost none
      // of the raid's actual output that fight (see HOLLOW_SHARE_THRESHOLD).
      dpsHollowTop,
      healersHollowTop,
      deaths: {
        count: deaths.length,
        notable: deaths.slice(0, 8).map(d => ({
          name: d.name,
          encounter: fightNameById.get(d.fightID) || 'Unknown',
          killingBlow: d.killingBlow,
        })),
        // Real aggregate counts (not just 8 anecdotal examples) - which
        // encounters are actually the biggest death sinks this raid, for
        // the fallout report to reason about mechanics/positioning
        // patterns accurately instead of picking essentially at random.
        byEncounter: tallyDeathsByEncounter(deaths.map(d => ({ encounter: fightNameById.get(d.fightID) || 'Unknown' }))).slice(0, 8),
        // Full name+fightID pairs (not just the capped "notable" display
        // list) so the frontend can build the same died-vs-survived split
        // for its own parse-list preview that the Discord embed uses.
        pairs: deaths.map(d => ({ name: d.name, fightID: d.fightID })),
      },
      interrupts,
      ...(debug ? { rankingsRawDps: details.rankingsRawDps, rankingsRawHealers: details.rankingsRawHealers, playerDetailsRaw: details.playerDetailsRaw, deathsRaw: details.deathsRaw, interruptsRaw: details.interruptsRaw } : {}),
    }), 200);
  } catch (err) {
    return corsResponse(JSON.stringify({ error: err.message }), 500);
  }
}

// POST /post-log-summary — direct HTTP post from the raid manager's Guild
// Logs tab, bypassing the Discord slash command entirely (its registration/
// visibility is an unresolved separate issue as of this writing). If
// reportCode is given, posts that exact report — matching what the app
// already previewed rather than re-discovering "latest" a second time and
// risking a mismatch; falls back to auto-detecting latest if omitted.
async function handleDirectLogPost(request, env) {
  try {
    if (!env.WCL_CLIENT_ID || !env.WCL_CLIENT_SECRET) {
      throw new Error('Warcraft Logs API credentials not configured.');
    }
    const { channelId, reportCode } = await request.json();
    if (!channelId) throw new Error('No channel ID provided.');

    let report, details;
    if (reportCode) {
      details = await getReportFightsAndStats(env, reportCode);
      report = details.report;
      if (!report?.title) {
        const suffix = rateLimitSuffix(await getWCLRateLimit(env));
        throw new Error(`Report ${reportCode} not found.${suffix}`);
      }
    } else {
      report = await findLatestGuildReport(env);
      if (!report) throw new Error('No recent reports found for the guild on Warcraft Logs.');
      details = await getReportFightsAndStats(env, report.code);
    }

    const dataRes = await fetch(`https://kaizen-tbc.github.io/kaizen_data.json?v=${Date.now()}`);
    const guildData = dataRes.ok ? await dataRes.json() : { roster: [] };

    // Embed, not plain content - tested live, without a card the rankings
    // read cramped/ran together (same finding as strats and fallout).
    const embeds = buildLogSummaryEmbeds(report, details, guildData.roster || []);

    // Almost always one message. Only a genuinely huge roster (25+ embeds
    // worth of overflow, effectively never in an 8-40 person raid) would
    // need more than the 10 embeds Discord allows per message - handled
    // here by posting in sequential batches rather than failing outright.
    for (let i = 0; i < embeds.length; i += 10) {
      const batch = embeds.slice(i, i + 10);
      const postRes = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
        method: 'POST',
        headers: { 'Authorization': `Bot ${env.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ embeds: batch }),
      });
      if (!postRes.ok) {
        const err = await postRes.json().catch(() => ({}));
        throw new Error(err.message || `Discord API error ${postRes.status}`);
      }
    }

    return corsResponse(JSON.stringify({ ok: true, report: { title: report.title, code: report.code } }), 200);
  } catch (err) {
    return corsResponse(JSON.stringify({ error: err.message }), 500);
  }
}

// ── AI fallout report (OpenAI, not Anthropic — per explicit choice) ─────
// Bumped from gpt-5-nano ($0.05/$0.40 per 1M) to gpt-5-mini ($0.25/$2.00) -
// nano was blending in mechanics from other expansions (Lava Burst,
// Insanity) despite an explicit TBC Classic version-lock in the prompt.
// For a report this short (a few hundred tokens in/out), the price step up
// is cents, not dollars - worth it for coaching content people act on.
const OPENAI_MODEL = 'gpt-5-mini';

// Strips a "- P1"/"- P2" phase suffix and non-alphanumerics so a strat
// entry like "Kael'thas - P2" and a WCL fight name like "Kael'thas
// Sunstrider" can be fuzzy-matched against each other.
function normalizeEncounterName(name) {
  return (name || '').replace(/\s*-\s*P\d+.*/i, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
}

// The AI has no idea this guild self-casts Earth Shield on Void Reaver
// instead of the tank - that's exactly the kind of guild-specific tactical
// exception a generalist model will get wrong by falling back on textbook
// convention (real example: it told a resto shaman to put Earth Shield on
// the MT here, an officer immediately caught it as backwards for this
// fight). The guild's own Strategy Notes (+ the assigns notes, which often
// carry the same shorthand) are ground truth for exactly that gap - pull
// whatever's on file for encounters this report is actually coaching on,
// so the model corrects itself against real tactics instead of guessing.
function findStratNotesForEncounter(encounterName, strats) {
  const target = normalizeEncounterName(encounterName);
  if (!target) return null;
  const matches = (strats || []).filter(s => {
    const n = normalizeEncounterName(s.name);
    return n && (target.includes(n) || n.includes(target));
  });
  if (!matches.length) return null;
  const notes = new Set();
  for (const s of matches) {
    const section = (s.sections || []).find(sec => /strategy notes/i.test(sec.label || ''));
    for (const row of section?.rows || []) {
      if (row.typeA === 'notes' && row.valueA?.trim()) notes.add(row.valueA.trim());
    }
    if (s.assigns?.notes?.trim()) notes.add(s.assigns.notes.trim());
  }
  return notes.size ? [...notes].join('\n---\n') : null;
}

// Only pulls notes for encounters this report is actually coaching on
// (death clusters + needs-work people), not the whole strat book - keeps
// the prompt tight and avoids diluting it with irrelevant fights.
function gatherRelevantStratNotes(strats, dpsSurvivedBad, healersSurvivedBad, deaths) {
  const encounters = new Set();
  for (const d of deaths?.byEncounter || []) if (d.encounter) encounters.add(d.encounter);
  for (const p of [...(dpsSurvivedBad || []), ...(healersSurvivedBad || [])]) if (p.encounter) encounters.add(p.encounter);
  const lines = [];
  for (const enc of encounters) {
    const notes = findStratNotesForEncounter(enc, strats);
    if (notes) lines.push(`${enc}: ${notes}`);
  }
  return lines.join('\n\n');
}

// A 0% parse from dying tells you nothing you don't already know ("don't
// die"). The real red flag is a grey-tier parse (WCL's own 0-24 tier) from
// someone who SURVIVED the whole fight - that's an actual rotation/gear/
// positioning problem worth coaching, and it's what classifyLowParses (see
// kaizen-worker.js) isolates by cross-referencing against the deaths table.
// Deaths themselves are still reported, just as brief raid-wide context
// rather than individual coaching targets.
function buildFalloutPrompt(report, dpsSurvivedBad, healersSurvivedBad, deaths, interrupts, stratNotes) {
  const fmtBad = list => (list || []).map(p => {
    const uptimeNote = p.uptimePct != null ? `, ${p.uptimePct}% active time` : '';
    const abilityNote = p.topAbilities?.length
      ? ` | top sources: ${p.topAbilities.map(a => `${a.name} (${a.pct}%)`).join(', ')}`
      : '';
    const smallSampleNote = typeof p.totalParses === 'number' && p.totalParses < WCL_SMALL_SAMPLE_THRESHOLD
      ? ` [rare spec/role combo - only ${p.totalParses} logged parses to compare against, percentile may not be meaningful]`
      : '';
    return `${p.name} (${p.class || '?'} ${p.spec || ''}) — ${Math.round(p.rankPercent)} percentile on ${p.encounter}${uptimeNote} (survived the full fight - this is a real performance issue, not a death)${abilityNote}${smallSampleNote}`;
  }).join('\n') || '(none — no non-death grey-tier parses this raid, nice)';

  // byEncounter is REAL aggregate counts (every death, not a handful of
  // anecdotal examples) - this is what actually supports a raid-wide
  // "we're dying to the same mechanic repeatedly" observation instead of
  // picking a few death instances close to at random.
  const deathsSummary = deaths?.count
    ? `${deaths.count} death${deaths.count === 1 ? '' : 's'} logged this raid. Top causes by encounter (all deaths counted, not a sample): ` +
      (deaths.byEncounter?.length ? deaths.byEncounter.map(d => `${d.encounter} (${d.count})`).join(', ') : 'no breakdown available') +
      (deaths.notable?.length ? '. A few specific examples: ' + deaths.notable.slice(0, 4).map(d => `${d.name} to ${d.killingBlow} on ${d.encounter}`).join('; ') : '')
    : 'No deaths logged this raid.';

  const interruptsSummary = (interrupts || []).length
    ? interrupts.slice(0, 8).map(i => `${i.name} (${i.count})`).join(', ')
    : '(no interrupt data for this report)';

  return `You are writing content for a Discord message ("fallout report") for a World of Warcraft: TBC Classic raid guild, following up on last night's raid ("${report?.title || 'Raid'}"). This message's whole purpose is teaching a lesson and calling out what needs work - it runs separately from a plain rankings post that already covered the numbers matter-of-factly, so don't repeat those, don't mention top performers here. Tone: constructive and factual, never confrontational or shaming - the goal is to spark conversation, not chastise anyone. This is its own standalone post with the rankings post being the only other content in this channel, so you have real room to explain the "why," not just a one-liner - go deep on the actual analysis below.

CRITICAL - this is specifically The Burning Crusade Classic (patch 2.4.3 era, character level 70), NOT retail WoW and NOT any other expansion. Do not reference abilities, talents, resources, or mechanics from Wrath of the Lich King, Cataclysm, Mists of Pandaria, Warlords of Draenor, Legion, Battle for Azeroth, Shadowlands, Dragonflight, or current retail - even if they're iconic for that class today. Concretely, as commonly-made mistakes to avoid: Elemental Shaman has NO Lava Burst (added in Wrath); Shadow Priest has NO Insanity resource bar (added in Legion) - TBC Shadow Priest is just Mind Flay/SW:P/VT/Mind Blast on a global cooldown, no special resource; Enhancement Shaman has NO Maelstrom Weapon proc (added in Wrath); Feral Druid has NO Energy-and-Combo-Point-only kit changes from later redesigns. If you are not fully confident an ability or mechanic existed at level 70 in TBC, do NOT name it specifically - give generic advice instead (e.g. "keep your damage-over-time spells refreshed" rather than naming a spell you're unsure of, "use your cooldowns during burn windows" rather than naming a specific one). Generic-but-correct beats specific-but-wrong.

DEATHS this raid (context only - "don't die" isn't useful coaching by itself, don't dwell here):
${deathsSummary}

GREY-TIER PARSES (0-24th percentile) where the player SURVIVED the entire fight - this is the main event, an actual performance problem, not a death:
DPS:
${fmtBad(dpsSurvivedBad)}
Healers:
${fmtBad(healersSurvivedBad)}

INTERRUPTS landed this raid, raid-wide total per player (all fights, kills and wipes):
${interruptsSummary}

KNOWN GUILD TACTICS for the encounters above (this guild's own strategy notes, not generic textbook knowledge) - treat these as ground truth for THIS guild's actual play, and let them override your own generic-convention assumptions when they conflict. Concrete example of why this matters: generic advice says "keep Earth Shield on the tank," but this guild has confirmed self-casting it on Void Reaver instead, since raid damage there causes cast pushback - a coaching tip that assumed the textbook default would have been backwards. If a note below is directly relevant to someone's tip, use it; if nothing here applies to a given person, just don't reference it:
${stratNotes || '(no strategy notes on file for these encounters)'}

Return three things:
1. generalNotes - 2-3 sentences on any pattern worth flagging raid-wide (e.g. several people struggling on the same encounter suggests a mechanic/positioning issue, not an individual one). Use the death breakdown's real per-encounter counts as evidence: if deaths cluster heavily on one or two encounters, name them and take a concrete guess at what's going wrong mechanically (positioning, a specific ability/phase, an add that needs to be handled) based on TBC Classic knowledge of that encounter - "we're getting sloppy on X's mechanic" is far more useful than "there were some deaths." Don't just restate the raw counts back - explain what they mean. If deaths are spread thin with no real cluster, say so briefly and move on - don't force a pattern that isn't there.
2. needsWork - up to 6-8 entries, one per person from the grey-tier-survived lists above. Each entry's "name" must be copied EXACTLY as given above (used elsewhere to attach their class icon and the encounter - don't restate their name, class, spec, or encounter inside "tip", just the coaching itself). "tip" is 1-2 sentences of TBC Classic-accurate (level 70, patch 2.4.3 - see the version constraint above) coaching, grounded in whatever hard numbers are given for that person, not generic advice:
   - If "active time" is given, use it as your primary evidence: low active time (well under what's typical, ~85%+ for most specs when nothing's gone wrong) means real downtime - reference the actual number and reason about why (repositioning, movement off the boss, dying partway and this being their only surviving pull data, etc.) rather than just saying "stay in melee range."
   - "top sources" is much easier to misread than active time - an ability dominating the damage/healing breakdown is NOT reliably a sign of bad play. Concrete trap to avoid: an Arms Warrior with a slow two-handed weapon getting a large share of damage from Slam is CORRECT, high-skill play (timing Slam around the weapon's swing timer, "Slam weaving") - not a rotation problem, even though it looks like one ability is "dominating." Ability-mix patterns like this vary by spec/weapon/talents in ways you may not be fully certain of. So: only call out an ability-mix pattern as a problem when you are genuinely confident that specific mix is wrong for that spec/weapon at level 70 TBC - otherwise just note the top sources as a factual, neutral observation ("most of the damage came from X, Y") without diagnosing it as good or bad, and lean on active time (or gear/consumables/execution in general) as the actual explanation instead.
   - Only fall back to generic advice (no specific ability/number cited) for someone with no active-time or ability data available - and say something different for each person, don't reuse the same boilerplate line across multiple entries.
   - If an entry is flagged as a rare spec/role combo with few logged parses, say so plainly (e.g. "not many logged parses for this spec/role to compare against, so take this percentile with a grain of salt") instead of coaching the number as if it were a reliable signal.
   If both lists above are empty, return an empty array - don't invent entries that aren't there.
3. interruptsNote - 1-2 sentences: note who's carrying the interrupt load this raid. Only flag a specific class/spec as under-contributing if you're genuinely confident that spec has an interrupt and this encounter needed it - don't guess at specs you're unsure of.

Be direct, no fluffy intro or conclusion - just the substance for each of the three fields.`;
}

// Strict-mode JSON schema (OpenAI Structured Outputs, /v1/responses) - every
// property must appear in "required" and additionalProperties must be
// false. Getting the AI's output back as structured fields, rather than
// freeform markdown prose, means we can attach each person's real class/
// spec icon and their exact encounter ourselves (from our own known data,
// not the AI restating it) and control spacing between entries directly -
// both were unreliable when the AI formatted the whole message itself.
const FALLOUT_REPORT_SCHEMA = {
  type: 'object',
  properties: {
    generalNotes: { type: 'string' },
    needsWork: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          tip: { type: 'string' },
        },
        required: ['name', 'tip'],
        additionalProperties: false,
      },
    },
    interruptsNote: { type: 'string' },
  },
  required: ['generalNotes', 'needsWork', 'interruptsNote'],
  additionalProperties: false,
};

// Builds the final Discord markdown ourselves from the AI's structured
// fields - icon + name + encounter for each "Needs Work" entry come from
// our own dps/healersSurvivedBad data (ground truth), not the AI restating
// them, and a blank line between entries keeps it from reading as one wall
// of text. Split into two separate posts (DPS, then Healers + interrupts)
// per explicit request - keeps each message shorter (helps stay under
// Discord's per-embed character limit too) and easier to actually read.
function buildFalloutMarkdowns(parsed, dpsSurvivedBad, healersSurvivedBad) {
  const known = new Map();
  for (const p of [...(dpsSurvivedBad || []), ...(healersSurvivedBad || [])]) {
    known.set(p.name, p);
  }
  const dpsNames = new Set((dpsSurvivedBad || []).map(p => p.name));
  const healerNames = new Set((healersSurvivedBad || []).map(p => p.name));

  const renderEntry = item => {
    const p = known.get(item.name);
    const icon = p ? getWCLSpecEmoji(p.class, p.spec) : '';
    const encounter = p ? ` — _${p.encounter}_` : '';
    return `${icon ? icon + ' ' : ''}**${item.name}**${encounter}\n${item.tip}`;
  };

  const needsWork = parsed.needsWork || [];
  // A name could in principle not match either list if the model didn't
  // copy it exactly - dropped silently rather than guessed at, same as
  // the icon-lookup fallback below.
  const dpsEntries = needsWork.filter(item => dpsNames.has(item.name));
  const healerEntries = needsWork.filter(item => healerNames.has(item.name));

  // Explicit framing on both posts (not just the first one) since they go
  // out as separate messages and someone might only ever see the healers
  // half. The parses are real - not waving that away - but the AI's read
  // on WHY a number looks the way it does can miss context it has no way
  // to know (a guild-specific tactic, a fight it's less sure about, etc,
  // exactly what prompted this in the first place). Short on purpose -
  // this repeats on every single report, every week.
  const disclaimer = `_Automatically generated from this raid's WCL data. The analysis is generalized and may not account for every factor behind your parse._`;

  const dpsText = `${disclaimer}\n\n**General Notes**\n${parsed.generalNotes}\n\n**DPS Needs Work**\n${
    dpsEntries.length ? dpsEntries.map(renderEntry).join('\n\n') : '_Nobody survived-and-grey on DPS this raid — nice._'
  }`;
  const healersText = `${disclaimer}\n\n**Healers Needs Work**\n${
    healerEntries.length ? healerEntries.map(renderEntry).join('\n\n') : '_Nobody survived-and-grey on healing this raid — nice._'
  }\n\n**Interrupts**\n${parsed.interruptsNote}`;

  return { dpsText, healersText };
}

// The Responses API's output_text is an SDK convenience property, not
// guaranteed present in a raw HTTP JSON response - the real text lives in
// output[].content[].text, and output[] can contain non-text items
// (reasoning, tool calls) that don't have that shape at all.
function extractOpenAIText(data) {
  if (typeof data?.output_text === 'string' && data.output_text) return data.output_text;
  try {
    const parts = [];
    for (const item of data?.output || []) {
      for (const c of item?.content || []) {
        if (typeof c?.text === 'string') parts.push(c.text);
      }
    }
    return parts.join('\n').trim();
  } catch {
    return '';
  }
}

// OpenAI's API occasionally 5xx's transiently (server overload) - not
// something wrong with the request, and retrying once or twice with a
// short backoff resolves it far more often than not. 4xx (bad request,
// auth, etc.) is never retried since trying again won't fix it.
async function callOpenAIWithRetry(body, env, maxAttempts = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (res.ok) return res;
    const err = await res.json().catch(() => ({}));
    lastErr = new Error(err.error?.message || `OpenAI API error ${res.status}`);
    if (res.status < 500 || attempt === maxAttempts) throw lastErr;
    await new Promise(r => setTimeout(r, 500 * attempt)); // 500ms, then 1000ms
  }
  throw lastErr;
}

async function handleFalloutReport(request, env) {
  try {
    if (!env.OPENAI_API_KEY) throw new Error('OpenAI API key not configured.');
    const { report, dpsSurvivedBad, healersSurvivedBad, deaths, interrupts } = await request.json();

    // Best-effort - a strat-notes fetch failure shouldn't block the report,
    // it just falls back to generic coaching (today's prior behavior).
    let stratNotes = '';
    try {
      const dataRes = await fetch(`https://kaizen-tbc.github.io/kaizen_data.json?v=${Date.now()}`);
      const guildData = dataRes.ok ? await dataRes.json() : null;
      if (guildData?.strats) {
        stratNotes = gatherRelevantStratNotes(guildData.strats, dpsSurvivedBad, healersSurvivedBad, deaths);
      }
    } catch { /* fine, prompt just runs without guild-specific tactics */ }

    const res = await callOpenAIWithRetry({
      model: OPENAI_MODEL,
      input: buildFalloutPrompt(report, dpsSurvivedBad, healersSurvivedBad, deaths, interrupts, stratNotes),
      text: {
        format: {
          type: 'json_schema',
          name: 'fallout_report',
          strict: true,
          schema: FALLOUT_REPORT_SCHEMA,
        },
      },
    }, env);

    const data = await res.json();
    const raw = extractOpenAIText(data);
    if (!raw) throw new Error('OpenAI returned no text output.');
    const parsed = JSON.parse(raw); // structured output - guaranteed valid JSON matching FALLOUT_REPORT_SCHEMA
    const { dpsText, healersText } = buildFalloutMarkdowns(parsed, dpsSurvivedBad, healersSurvivedBad);

    return corsResponse(JSON.stringify({ dpsText, healersText }), 200);
  } catch (err) {
    return corsResponse(JSON.stringify({ error: err.message }), 500);
  }
}

// Posts arbitrary pre-generated text (the fallout report) as its own
// message. Back to an embed after testing plain content live - without a
// card, everything ran together and read badly (same finding as strats,
// and rankings gets the same treatment for consistency).
async function handlePostTextMessage(request, env) {
  try {
    const { channelId, title, text, plain } = await request.json();
    if (!channelId) throw new Error('No channel ID provided.');
    if (!text) throw new Error('No text to post.');

    let body;
    if (plain) {
      // Discord does NOT ping @mentions placed inside an embed - they just
      // render as inert text, no notification fires. Anything that needs a
      // real role/user mention to actually notify people has to go out as
      // plain message `content`, not an embed. Discord hard-caps plain
      // content at 2000 chars.
      const combined = title ? `# ${title}\n\n${text}` : text;
      const content = combined.length > 2000 ? combined.slice(0, 1985) + '\n\n_(truncated)_' : combined;
      body = { content };
    } else {
      // Discord hard-caps an embed description at 4096 chars (and a title
      // at 256) - post silently failed with a 400 in the past when the AI
      // ran long. Truncate defensively rather than trust the prompt's soft
      // word target to always hold.
      const safeTitle = (title || '').slice(0, 256);
      const safeText = text.length > 4000 ? text.slice(0, 3985) + '\n\n_(truncated)_' : text;
      body = {
        embeds: [{
          title: safeTitle || undefined,
          description: safeText,
          color: 0xC9A227,
          footer: { text: 'Kaizen Raid Manager' },
          timestamp: new Date().toISOString(),
        }],
      };
    }

    const postRes = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bot ${env.DISCORD_BOT_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!postRes.ok) {
      const err = await postRes.json();
      throw new Error(err.message || `Discord API error ${postRes.status}`);
    }
    // messageId returned so a caller can fix a typo via /edit-message
    // afterward without needing to delete-and-repost.
    const posted = await postRes.json();

    return corsResponse(JSON.stringify({ ok: true, messageId: posted.id }), 200);
  } catch (err) {
    return corsResponse(JSON.stringify({ error: err.message }), 500);
  }
}

// Fixes a typo/mistake in an already-posted message without deleting and
// reposting (which would lose its position/timestamp and re-ping anyone
// mentioned in it a second time). If messageId isn't given, finds the most
// recent message the bot itself posted in that channel and edits that one -
// covers the common case of "I just posted this, fix it" where the caller
// didn't capture the ID from the original post response.
async function handleEditMessage(request, env) {
  try {
    const { channelId, messageId: givenId, title, text, plain } = await request.json();
    if (!channelId) throw new Error('No channel ID provided.');
    if (!text) throw new Error('No text to post.');

    const headers = { 'Authorization': `Bot ${env.DISCORD_BOT_TOKEN}` };

    let messageId = givenId;
    if (!messageId) {
      const meRes = await fetch(`${DISCORD_API}/users/@me`, { headers });
      if (!meRes.ok) throw new Error('Could not identify the bot itself to find its last message.');
      const me = await meRes.json();

      const listRes = await fetch(`${DISCORD_API}/channels/${channelId}/messages?limit=10`, { headers });
      if (!listRes.ok) {
        const err = await listRes.json().catch(() => ({}));
        throw new Error(err.message || `Failed to list messages: ${listRes.status}`);
      }
      const messages = await listRes.json();
      const mine = messages.find(m => m.author?.id === me.id);
      if (!mine) throw new Error("Couldn't find a recent message from the bot in that channel to edit.");
      messageId = mine.id;
    }

    let body;
    if (plain) {
      const combined = title ? `# ${title}\n\n${text}` : text;
      const content = combined.length > 2000 ? combined.slice(0, 1985) + '\n\n_(truncated)_' : combined;
      body = { content };
    } else {
      const safeTitle = (title || '').slice(0, 256);
      const safeText = text.length > 4000 ? text.slice(0, 3985) + '\n\n_(truncated)_' : text;
      body = {
        embeds: [{
          title: safeTitle || undefined,
          description: safeText,
          color: 0xC9A227,
          footer: { text: 'Kaizen Raid Manager' },
          timestamp: new Date().toISOString(),
        }],
      };
    }

    const editRes = await fetch(`${DISCORD_API}/channels/${channelId}/messages/${messageId}`, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!editRes.ok) {
      const err = await editRes.json().catch(() => ({}));
      throw new Error(err.message || `Edit failed: ${editRes.status}`);
    }

    return corsResponse(JSON.stringify({ ok: true, messageId }), 200);
  } catch (err) {
    return corsResponse(JSON.stringify({ error: err.message }), 500);
  }
}

// Deletes every message in a channel, so the Guild Logs channel only ever
// shows the current week's posts. Requires the bot to have Manage Messages
// in that channel. Discord's bulk-delete endpoint only works on messages
// under 14 days old and needs 2+ ids at a time; anything older, or a lone
// straggler, falls back to deleting one at a time.
//
// If archiveChannelId is given, our own bot's report posts get reposted
// there first, before anything is deleted - identified by the footer text
// we always set on them (buildLogSummaryEmbed / handlePostTextMessage),
// not by author id, so no extra lookup of the bot's own user id is needed.
// Only our own posts get archived; anything else in the channel (human
// chatter) is just deleted, per explicit choice.
// Extracted so other flows (e.g. strat posting) can clear-then-post
// in-process, without a wasteful self-fetch through the HTTP route.
async function clearChannelMessages(env, channelId, archiveChannelId) {
  if (!channelId) throw new Error('No channel ID provided.');

  const headers = { 'Authorization': `Bot ${env.DISCORD_BOT_TOKEN}` };
    const fourteenDaysAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
    let deleted = 0;
    let archived = 0;
    let before;

    while (true) {
      const listUrl = `${DISCORD_API}/channels/${channelId}/messages?limit=100${before ? `&before=${before}` : ''}`;
      const listRes = await fetch(listUrl, { headers });
      if (!listRes.ok) {
        const err = await listRes.json().catch(() => ({}));
        throw new Error(err.message || `Failed to list messages: ${listRes.status}`);
      }
      const messages = await listRes.json();
      if (!messages.length) break;
      before = messages[messages.length - 1].id;

      if (archiveChannelId) {
        const ours = messages.filter(m => m.embeds?.some(e => e.footer?.text?.includes('Kaizen Raid Manager')));
        for (const m of ours) {
          const repostRes = await fetch(`${DISCORD_API}/channels/${archiveChannelId}/messages`, {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ embeds: m.embeds }),
          });
          if (repostRes.ok) archived++;
        }
      }

      const recent = messages.filter(m => new Date(m.timestamp).getTime() > fourteenDaysAgo);
      const stale = messages.filter(m => new Date(m.timestamp).getTime() <= fourteenDaysAgo);
      const bulkable = recent.length >= 2 ? recent : [];
      const individual = recent.length >= 2 ? stale : [...recent, ...stale];

      for (let i = 0; i < bulkable.length; i += 100) {
        const chunk = bulkable.slice(i, i + 100);
        const bulkRes = await fetch(`${DISCORD_API}/channels/${channelId}/messages/bulk-delete`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: chunk.map(m => m.id) }),
        });
        if (!bulkRes.ok) {
          const err = await bulkRes.json().catch(() => ({}));
          throw new Error(err.message || `Bulk delete failed: ${bulkRes.status}`);
        }
        deleted += chunk.length;
      }

      for (const m of individual) {
        const delRes = await fetch(`${DISCORD_API}/channels/${channelId}/messages/${m.id}`, {
          method: 'DELETE',
          headers,
        });
        if (delRes.ok) deleted++;
        // Individual message deletion has a stricter per-route rate limit
        // than bulk-delete — a small gap avoids tripping it on a long backlog.
        await new Promise(r => setTimeout(r, 350));
      }

      if (messages.length < 100) break;
    }

    return { deleted, archived };
}

async function handleClearChannel(request, env) {
  try {
    const { channelId, archiveChannelId } = await request.json();
    const { deleted, archived } = await clearChannelMessages(env, channelId, archiveChannelId);
    return corsResponse(JSON.stringify({ ok: true, deleted, archived }), 200);
  } catch (err) {
    return corsResponse(JSON.stringify({ error: err.message }), 500);
  }
}

// GET /discord/channel-name?id=X — just for display purposes (confirm
// dialogs showing "#channel-name" instead of a raw numeric ID).
async function handleChannelName(request, env) {
  try {
    const id = new URL(request.url).searchParams.get('id');
    if (!id) throw new Error('No channel ID provided.');
    const res = await fetch(`${DISCORD_API}/channels/${id}`, {
      headers: { 'Authorization': `Bot ${env.DISCORD_BOT_TOKEN}` },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `Discord API error ${res.status}`);
    }
    const data = await res.json();
    return corsResponse(JSON.stringify({ name: data.name || null }), 200);
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

// Warcraft Logs' own auto-detected "spec" string doesn't always match our
// naming (confirmed live: "BeastMastery", no space, vs our "Beastmastery").
// Only normalizing cases we're actually confident about here - an
// unrecognized/off-meta spec label (e.g. "Justicar") just shows no icon
// rather than risk guessing wrong.
const WCL_SPEC_NORMALIZE = { 'BeastMastery': 'Beastmastery' };
function getWCLSpecEmoji(cls, spec) {
  return getSpecEmoji(cls, WCL_SPEC_NORMALIZE[spec] || spec);
}

function buildRosterEmbed(raid, roster, pugs, guildies = [], notify = true) {
  // Negative ids cover BOTH manually-added guildies (+Guildie) and pugs -
  // previously only checked pugs, so a guildie posted in a group silently
  // vanished from the Discord embed (id just never resolved to anyone).
  function getPlayer(id) {
    if (id < 0) return guildies.find(p => p.id === id) || pugs.find(p => p.id === id);
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
          // Discord pings for <@id> mentions anywhere in a message, including
          // inside embed fields — not just the top summary line. Only use
          // real mentions here when notify is on, otherwise plain names, or
          // unchecking "notify" silently still pings everyone individually.
          const mention = (notify && userIdMap[p.id]) ? `<@${userIdMap[p.id]}>` : p.name;
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

  // Bench/Absent/Tentative - manually placed by an officer (see
  // movePlayerToPoolBucket in the raid manager), independent of whatever
  // Raid Helper originally said. Being in a group always wins - someone
  // dragged out of Bench into a group shows there, not here, even though
  // their id may still technically be in raid.bench (see renderPool's own
  // comment on the same precedence). Unassigned is deliberately never
  // shown here - only the 3 "here's why they're not in a group" buckets
  // are worth posting; leftover unassigned sign-ups aren't a statement
  // about anyone. Each section is skipped entirely if empty.
  const assignedIds = new Set(groups.flat().map(Number));
  const namesFor = ids => (ids || [])
    .map(Number)
    .filter(id => !assignedIds.has(id))
    .map(id => getPlayer(id))
    .filter(Boolean)
    .map(p => p.name);
  const benchNames = namesFor(raid.bench);
  const absentNames = namesFor(raid.absent);
  const tentativeNames = namesFor(raid.tentative);
  // Discord's 1024-char-per-field cap, same guard established earlier for
  // the rankings embed - unlikely to matter for a bench list, cheap
  // insurance against a real "Invalid Form Body" on a big roster night.
  const capField = v => v.length > 1024 ? v.slice(0, 1009) + '\n_(truncated)_' : v;
  if (benchNames.length || absentNames.length || tentativeNames.length) {
    // Same breathing-room spacer used between the group rows above -
    // without it this section reads as crowded right up against the last
    // group, reported live. inline:true (not false, like before) so the
    // three sit side by side as their own row, same 2-3-per-row pattern
    // the groups already use, instead of stacking full-width.
    spacedFields.push({ name: '​', value: '​', inline: false });
    if (benchNames.length) spacedFields.push({ name: '🪑 Bench', value: capField(benchNames.join(', ')), inline: true });
    if (absentNames.length) spacedFields.push({ name: '❌ Absent', value: capField(absentNames.join(', ')), inline: true });
    if (tentativeNames.length) spacedFields.push({ name: '❔ Tentative', value: capField(tentativeNames.join(', ')), inline: true });
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
