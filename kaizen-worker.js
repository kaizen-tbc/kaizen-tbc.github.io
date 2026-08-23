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

    // ── Clear every message in a channel, so the Guild Logs channel only
    // ever shows the current week's posts ── /clear-channel
    if (url.pathname === '/clear-channel' && request.method === 'POST') {
      return handleClearChannel(request, env);
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
// (not fully-typed GraphQL). Confirmed live shape: rankings is one entry per
// killed fight, each with roles.{tanks,healers,dps}.characters[] carrying
// amount + rankPercent (see extractRoleParses). extractParticipantNames/
// extractRoleParses still wrapped in try/catch in case that shape drifts.
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

// Fight list, rankings, and participant data for one report. Two queries:
// rankings/playerDetails need fight ID arrays as arguments, which we only
// have after the first query returns the fight list.
async function getReportFightsAndStats(env, code) {
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
    // Full report info (title/dates), for callers that only have a code and
    // skipped findLatestGuildReport's own discovery query.
    report: reportInfo ? { code, title: reportInfo.title, startTime: reportInfo.startTime, endTime: reportInfo.endTime } : null,
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

// Confirmed live shape: rankings is one entry PER KILLED FIGHT, each with
// roles.{tanks,healers,dps}.characters[], each character carrying amount +
// rankPercent (the actual WCL percentile) for that specific pull. Rather
// than blending a person's percentile across every kill into one vague
// number, track their best AND worst single-encounter result separately,
// each tagged with which boss it was — "on the encounter" instead of "on
// the raid night in general", which is what actually makes a tip specific
// and useful (that fight's mechanics are the reason for the low percentile,
// not some abstract raid-wide average).
function extractRoleParses(rankingsRaw, roleKey) {
  try {
    const fights = rankingsRaw?.data || [];
    const byPlayer = new Map();
    for (const fight of fights) {
      const chars = fight?.roles?.[roleKey]?.characters || [];
      const encounter = fight?.encounter?.name || 'Unknown';
      for (const c of chars) {
        if (!c?.name || typeof c.rankPercent !== 'number') continue;
        if (!byPlayer.has(c.name)) {
          byPlayer.set(c.name, { name: c.name, class: c.class, spec: c.spec, results: [] });
        }
        byPlayer.get(c.name).results.push({ rankPercent: c.rankPercent, encounter });
      }
    }
    return [...byPlayer.values()].map(p => ({
      name: p.name,
      class: p.class,
      spec: p.spec,
      best: p.results.reduce((a, b) => (b.rankPercent > a.rankPercent ? b : a)),
      worst: p.results.reduce((a, b) => (b.rankPercent < a.rankPercent ? b : a)),
    }));
  } catch {
    return [];
  }
}

function topByBest(list, n = 5) {
  return [...list].sort((a, b) => b.best.rankPercent - a.best.rankPercent).slice(0, n);
}
function bottomByWorst(list, n = 5) {
  return [...list].sort((a, b) => a.worst.rankPercent - b.worst.rankPercent).slice(0, n);
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
function formatParseLines(list, which) {
  if (!list.length) return '—';
  return list
    .map((p, i) => {
      const r = p[which];
      const icon = getWCLSpecEmoji(p.class, p.spec);
      const pct = Math.round(r.rankPercent);
      // A literal 0 in the "worst" list almost always means an early death
      // (near-zero uptime), not a genuinely bad rotation - flag it so it
      // doesn't read as a performance callout.
      const deathNote = which === 'worst' && pct === 0 ? ' _(likely died early)_' : '';
      return `**${i + 1}.** ${icon ? icon + ' ' : ''}${p.name} — ${parseColorEmoji(r.rankPercent)} **${pct}** _(${r.encounter})_${deathNote}`;
    })
    .join('\n');
}

// Top N (by best pull) and bottom N (by worst pull) in one field, since
// embeds have limited field slots - "who's crushing it" and "who needs
// help" are both useful in one glance.
function formatTopAndBottom(list, n = 5) {
  if (!list.length) return 'No parse data available.';
  const top = topByBest(list, n);
  const bottom = bottomByWorst(list, n);
  let out = formatParseLines(top, 'best');
  if (bottom.length && !(top.length === list.length && bottom[0].name === top[top.length - 1]?.name)) {
    out += `\n\n*Needs work:*\n` + formatParseLines(bottom, 'worst');
  }
  return out;
}

function buildLogSummaryEmbed(report, details, roster) {
  const participants = extractParticipantNames(details.playerDetailsRaw);
  const attendance = matchAttendanceToRoster(participants, roster);
  const dps = extractRoleParses(details.rankingsRaw, 'dps');
  const healers = extractRoleParses(details.rankingsRaw, 'healers');

  return {
    title: `📊 ${report.title || 'Raid Log Summary'}`,
    url: `https://www.warcraftlogs.com/reports/${report.code}`,
    description: `${details.killFights.length}/${details.fights.length} encounters killed · ${attendance.length} guildies logged`,
    fields: [
      // Stacked full-width instead of side-by-side inline - two inline
      // columns squeeze each into ~half the embed's (fixed, Discord-
      // controlled) width, forcing mid-entry wraps that look cramped.
      { name: '⚔️ DPS', value: formatTopAndBottom(dps), inline: false },
      { name: '✚ Healers', value: formatTopAndBottom(healers), inline: false },
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
    const dps = extractRoleParses(details.rankingsRaw, 'dps');
    const healers = extractRoleParses(details.rankingsRaw, 'healers');

    return corsResponse(JSON.stringify({
      report,
      fights: details.fights,
      killFights: details.killFights,
      participants,
      dps,
      healers,
      ...(debug ? { rankingsRaw: details.rankingsRaw, playerDetailsRaw: details.playerDetailsRaw } : {}),
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

    const embed = buildLogSummaryEmbed(report, details, guildData.roster || []);

    const postRes = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bot ${env.DISCORD_BOT_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ embeds: [embed] }),
    });
    if (!postRes.ok) {
      const err = await postRes.json();
      throw new Error(err.message || `Discord API error ${postRes.status}`);
    }

    return corsResponse(JSON.stringify({ ok: true, report: { title: report.title, code: report.code } }), 200);
  } catch (err) {
    return corsResponse(JSON.stringify({ error: err.message }), 500);
  }
}

// ── AI fallout report (OpenAI, not Anthropic — per explicit choice) ─────
// Cheapest current model as of this writing; swap here if quality needs
// bumping up to gpt-5-mini.
const OPENAI_MODEL = 'gpt-5-nano';

function buildFalloutPrompt(report, dpsBottom, healersBottom) {
  // Each entry's worst pull, tagged with which encounter it happened on -
  // this is what lets a tip say "on Magtheridon" instead of a vague blended
  // raid-night average. Top performers are deliberately excluded - that's
  // already covered plainly in the separate rankings post; this one is
  // specifically the lesson + call-out.
  // A literal 0 percentile is almost always an early death (near-zero
  // uptime), not a bad rotation - flagged here so the model calls it out
  // for what it likely is instead of guessing at a rotation/gear tip for
  // someone who barely got to play the fight.
  const fmt = list => (list || []).map(p => {
    const pct = Math.round(p.worst.rankPercent);
    const deathNote = pct === 0 ? ' [likely an early death, not a rotation issue - little to actually analyze here]' : '';
    return `${p.name} (${p.class || '?'} ${p.spec || ''}) — ${pct} percentile on ${p.worst.encounter}${deathNote}`;
  }).join('\n') || '(none)';
  return `You are writing a Discord message ("fallout report") for a World of Warcraft: TBC Classic raid guild, following up on last night's raid ("${report?.title || 'Raid'}"). This message's whole purpose is teaching a lesson and calling out what needs work - it runs separately from a plain rankings post that already covered the numbers matter-of-factly, so don't repeat those, don't mention top performers here. Tone: constructive and factual, never confrontational or shaming - the goal is to spark conversation, not chastise anyone. This is its own standalone post (not squeezed into the rankings embed), so you have room to actually explain the "why," not just a one-liner.

Lowest DPS parses this raid (with the specific encounter each happened on):
${fmt(dpsBottom)}

Lowest Healer parses this raid (with the specific encounter each happened on):
${fmt(healersBottom)}

Write a report (under 220 words total, two sections):
1. "**General Notes**" - 2-3 sentences on any pattern worth flagging across the raid as a whole (e.g. if several people struggled on the same encounter, that's likely a mechanic/positioning issue worth calling out raid-wide, not an individual one).
2. "**Needs Work**" - one to two sentences each for 3-5 of the people listed above, referencing the specific encounter they struggled on. For a normal low parse, give ONE concrete, class/spec-appropriate tip based on general TBC Classic gameplay knowledge (rotation, positioning, gear, consumables, that encounter's mechanics, etc.) and briefly say why it matters. For anyone flagged as a likely early death, don't invent a rotation/gear tip - just note it plainly (e.g. dying early cost the raid their DPS/healing for that pull) and, only if the encounter's mechanics make it obvious, a short survivability-angle guess (positioning, a specific mechanic to watch for) - otherwise just flag it as a death worth reviewing in the log, not a rotation problem.

Use Discord markdown. Be direct and readable, not a wall of text - short sentences, no fluffy intro or conclusion, just the two sections.`;
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

async function handleFalloutReport(request, env) {
  try {
    if (!env.OPENAI_API_KEY) throw new Error('OpenAI API key not configured.');
    const { report, dpsBottom, healersBottom } = await request.json();

    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        input: buildFalloutPrompt(report, dpsBottom, healersBottom),
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || `OpenAI API error ${res.status}`);
    }

    const data = await res.json();
    const text = extractOpenAIText(data);
    if (!text) throw new Error('OpenAI returned no text output.');

    return corsResponse(JSON.stringify({ text }), 200);
  } catch (err) {
    return corsResponse(JSON.stringify({ error: err.message }), 500);
  }
}

// Posts arbitrary pre-generated text (the fallout report) as its own
// message - separate from the rankings post, same bot-token pattern.
async function handlePostTextMessage(request, env) {
  try {
    const { channelId, title, text } = await request.json();
    if (!channelId) throw new Error('No channel ID provided.');
    if (!text) throw new Error('No text to post.');

    const embed = {
      title: title || undefined,
      description: text,
      color: 0xC9A227,
      footer: { text: 'Kaizen Raid Manager' },
      timestamp: new Date().toISOString(),
    };

    const postRes = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bot ${env.DISCORD_BOT_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ embeds: [embed] }),
    });
    if (!postRes.ok) {
      const err = await postRes.json();
      throw new Error(err.message || `Discord API error ${postRes.status}`);
    }

    return corsResponse(JSON.stringify({ ok: true }), 200);
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
async function handleClearChannel(request, env) {
  try {
    const { channelId, archiveChannelId } = await request.json();
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

    return corsResponse(JSON.stringify({ ok: true, deleted, archived }), 200);
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
