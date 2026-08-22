// Run once to register slash commands with Discord:
// node register-commands.js

const APPLICATION_ID = '1539371978983604314';
const BOT_TOKEN = 'YOUR_BOT_TOKEN_HERE'; // paste your bot token here before running

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
