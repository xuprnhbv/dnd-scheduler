# D&D Weekly Poll Bot

A small Node.js bot that automates weekly D&D session scheduling in a WhatsApp group using native WhatsApp polls, plus a password-protected admin panel for editing next week's slots.

## What it does

| Day / Time (local TZ) | Action |
|---|---|
| Sunday 10:00 | Posts a native WhatsApp poll with this week's slots. Locks slot edits for the week. |
| Tuesday 10:00 | Tags everyone in `config.members` who hasn't voted yet. |
| Wednesday 10:00 | Announces the winner. If there's a tie, posts a second poll with only the tied slots. |
| Wednesday 20:00 | If a tiebreaker poll was posted, reads it and announces the final winner. |
| After the week closes | Seeds a fresh editable copy of the slot template for next week. |

## Requirements

- Node.js 20+
- A VPS reachable by the admin panel (and ideally behind Tailscale — see below)
- A WhatsApp account you can leave logged in on the bot
- The `config.groupId` of the target group (see "Finding the group ID")

## Install

```sh
npm install
cp config.example.json config.json
```

## Generate the admin panel password hash

Pick a password and run:

```sh
node bin/hash-password.js 'mypassword'
```

Copy the printed bcrypt hash into `config.adminPanel.passwordHash`. Also set a long random value for `config.adminPanel.sessionSecret` (e.g. `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`).

## Finding the group ID

On first run, after the QR code is scanned, open a Node REPL in another terminal or log chats from code:

```js
const { Client, LocalAuth } = require('whatsapp-web.js');
const c = new Client({ authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }) });
c.on('ready', async () => {
  const chats = await c.getChats();
  for (const chat of chats) {
    if (chat.isGroup) console.log(chat.name, chat.id._serialized);
  }
});
c.initialize();
```

Copy the `..._serialized` value (ends in `@g.us`) into `config.groupId`.

## Fill out `config.json`

```json
{
  "timezone": "Asia/Jerusalem",
  "groupId": "1203630xxxxxxxxx@g.us",
  "members": [
    { "name": "Alice", "number": "972501234567" },
    { "name": "Bob", "number": "972507654321" }
  ],
  "slotTemplate": {
    "days": ["Thursday", "Friday", "Saturday"],
    "times": ["10:00", "14:00", "20:00"],
    "durationHours": 5
  },
  "adminPanel": {
    "port": 3000,
    "passwordHash": "$2b$12$...",
    "sessionSecret": "long-random-hex"
  },
  "messages": {
    "pollQuestion": "D&D session for the week of {weekStart} — which slots work for you? (each is {duration}h)",
    "reminder": "Reminder: please vote in this week's D&D poll! {mentions}",
    "winner": "🎲 This week's session: {slot}. See you there!",
    "tiebreakerIntro": "We have a tie between {slots}. Please vote again:",
    "tiebreakerWinner": "🎲 Tiebreaker decided: {slot}. See you there!",
    "noVotes": "No votes received — no session scheduled for this week."
  }
}
```

Numbers are the WhatsApp phone numbers with country code, digits only (no `+`, no spaces).

## First run

```sh
node src/index.js
```

You'll see a QR code in the terminal on first run — scan it with WhatsApp on your phone (Settings → Linked Devices → Link a device). The session is persisted in `./.wwebjs_auth/` so subsequent runs skip the QR.

Once you see `WhatsApp client ready` and `Admin panel listening on :3000`, you're set.

## Admin panel

Open `http://<vps-ip>:3000` — you'll be redirected to `/login`. Enter the password you hashed above.

The panel shows:
- The next poll date and whether slot editing is currently Editable / Locked
- An editable list of slots for next week (add/remove rows, reset to template)
- The current week's state: poll posted, reminder sent, winner announced, tiebreaker status

Slot edits are accepted up until the Sunday 10:00 cron runs; at that point the poll is posted and the week is locked. After Wednesday's flow completes, the panel unlocks with a fresh copy of the base template for the following week.

## Editing the base slot template

Edit `config.slotTemplate` in `config.json`. The template is the starting point for each new week — the admin panel seeds every new week from it. Changing the template affects weeks that haven't been seeded yet (i.e. not yet written to `weekly_slots`); weeks already seeded keep their existing slots until you edit them in the panel or restart with the week re-seeded.

## Test mode

Trigger any job immediately, regardless of the cron schedule:

```sh
node src/index.js --test create-poll
node src/index.js --test send-reminder
node src/index.js --test announce-winner
node src/index.js --test announce-tiebreaker
node src/index.js --test seed-next-week
```

The bot starts up (you'll need the QR on first ever run), runs the job once, then exits.

## Run as a systemd service

Create `/etc/systemd/system/dnd-poll-bot.service`:

```ini
[Unit]
Description=D&D Weekly Poll Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=dnd
WorkingDirectory=/home/dnd/dnd-poll-bot
ExecStart=/usr/bin/node src/index.js
Restart=on-failure
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

Enable and start:

```sh
sudo systemctl daemon-reload
sudo systemctl enable dnd-poll-bot
sudo systemctl start dnd-poll-bot
sudo journalctl -u dnd-poll-bot -f
```

## Exposing the admin panel

You have two good options. **Private via Tailscale is strongly recommended.**

### Private via Tailscale (preferred)

Install Tailscale on the VPS (`curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up`) and on the device you'll admin from. The panel will automatically be reachable at `http://<vps-tailscale-ip>:3000` from your tailnet.

Then close port 3000 to the public internet with UFW:

```sh
sudo ufw default deny incoming
sudo ufw allow ssh
# Do NOT `ufw allow 3000` publicly.
sudo ufw allow in on tailscale0
sudo ufw enable
```

The panel still requires the password as defense in depth, but the port simply isn't reachable from the public internet.

### Public over HTTPS (acceptable, less safe)

If you can't use Tailscale, put the panel behind Caddy for HTTPS:

```caddy
admin.example.com {
    reverse_proxy localhost:3000
}
```

The bcrypt password and rate limiter (5 attempts / 15 min / IP) are your only defenses, so pick a strong password.

## Troubleshooting

- **Session breaks / auth failure**: delete `./.wwebjs_auth/` and restart; you'll need to re-scan the QR.
- **"Poll message not found"** when reading votes: WhatsApp occasionally evicts old messages from local cache. Usually a retry on the next cron tick resolves it; otherwise restart the bot and it'll re-fetch.
- **Reminder mentions don't notify people**: make sure the numbers in `config.members` exactly match the numbers WhatsApp uses (country code + digits, no separators). Use the group ID snippet above to log participant IDs.
- **Timezone looks wrong**: `config.timezone` must be a valid IANA zone name (e.g. `Asia/Jerusalem`, `Europe/London`), and the cron jobs use that zone, not the server's local time.
- **Logs**: `logs/bot-YYYY-MM-DD.log` (one file per day). Stdout is also logged.

## Project layout

```
src/
  index.js              entrypoint: load config, start client, scheduler, admin
  whatsapp.js           WhatsApp client wrapper (polls, mentions, reconnect)
  scheduler.js          node-cron setup
  jobs/                 individual cron job implementations
  slots.js              slot generation + label formatting
  db.js                 better-sqlite3 wrapper
  logger.js             stdout + rotating file logs
  admin/
    server.js           express app + routes
    auth.js             bcrypt + session + rate limit
    views/              login.html, panel.html
bin/
  hash-password.js      CLI helper
test/                   node --test tests
```

## Tests

```sh
npm test
```

Covers slot label formatting and validation. Jobs and the admin panel are exercised via the `--test` CLI mode against a real WhatsApp session.

## Out of scope

Multi-group support, editing the slot template / members / message text via the panel, multi-user admin, HTTPS inside the app (use Caddy), analytics, calendar integration, handling user-edited or deleted polls.
