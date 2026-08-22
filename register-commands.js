// Run once (or whenever commands change) to register slash commands with
// Discord. Reads the bot token from an environment variable rather than a
// hardcoded line, so it's never written to disk / at risk of being
// accidentally committed - same token you already have in the Cloudflare
// DISCORD_BOT_TOKEN secret, just passed in for this one process:
//
//   PowerShell:
//     $env:DISCORD_BOT_TOKEN = "your-token-here"
//     node register-commands.js
//
//   (the env var only lives in that terminal session - closing it clears it)

const APPLICATION_ID = '1539371978983604314';
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;

if (!BOT_TOKEN) {
  console.error('❌ Set the DISCORD_BOT_TOKEN environment variable first (see comment at top of this file).');
  process.exit(1);
}

const commands = [
  {
    name: 'import',
    description: 'Fetch the latest Raid Helper sign-ups and prep the roster',
    default_member_permissions: '8', // Administrator only
  },
  {
    name: 'post-roster',
    description: 'Post the current weekly roster groups to this channel',
    default_member_permissions: '8', // Administrator only
    options: [
      {
        name: 'raid',
        description: 'Which raid to post (defaults to first configured)',
        type: 3, // STRING
        required: false,
      }
    ]
  },
  {
    name: 'post-logs',
    description: 'Post top parses + attendance from the latest Warcraft Logs report to this channel',
    default_member_permissions: '8', // Administrator only
  },
  {
    name: 'help',
    description: 'Show available Kaizen raid manager commands',
  },
];

async function register() {
  const url = `https://discord.com/api/v10/applications/${APPLICATION_ID}/commands`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': `Bot ${BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(commands),
  });
  const data = await res.json();
  if (res.ok) {
    console.log(`✅ Registered ${data.length} commands successfully`);
    data.forEach(cmd => console.log(`  /${cmd.name} — ${cmd.id}`));
  } else {
    console.error('❌ Failed:', data);
  }
}

register();
