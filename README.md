# D&D Weekly Scheduling Bot

A small Node.js bot that automates weekly D&D session scheduling in a WhatsApp group. Players fill a Google Form; the bot posts the form link, reminds the group, and announces a winner based on the responses (with a DM-availability filter). Includes a password-protected admin panel for state and a "send form link" button.

## What it does

| Day / Time (local TZ) | Action |
|---|---|
| Sunday 10:00 | Posts the Google Form link in the WhatsApp group (pinned for 7 days). |
| Tuesday 10:00 | Posts a reminder: "X people filled the form out of Y players!" (no tagging, also pinned). |
| Wednesday 10:00 | Reads form responses, filters to slots the DM can play, announces the winner. If the top slots are tied, posts a small WhatsApp tiebreaker poll. |
| Wednesday 20:00 | If a tiebreaker poll was posted, reads it and announces the final winner. |
| After winner announced | Bot clears all form responses (via Apps Script webhook) so the next Sunday starts clean. |

Every message the bot posts to the group is automatically pinned for 7 days. Pinning requires the bot's WhatsApp account to be a **group admin** — otherwise the message is still sent, but the pin call logs a warning and is skipped.

## Requirements

- Node.js 20+
- A VPS reachable by the admin panel (and ideally behind Tailscale)
- A WhatsApp account you can leave logged in on the bot — **must be a group admin** for message pinning to work
- A Google account that owns the Google Form
- A Google Cloud service account (for reading the form + responses)
- The `config.groupId` of the target WhatsApp group

## Install

```sh
npm install
cp config.example.json config.json
```

## Google Form setup

**1. Build the form with two Multiple-choice grid questions.**

The form must have two **Multiple-choice grid** questions:

- A **player grid** everyone fills (e.g. title "When can you play?")
- A **DM grid** only the DM fills (e.g. title "When can the DM run?")

Each grid has:

- One **row per time slot** (e.g. "Thu evening", "Fri morning", …)
- The same **columns** in both grids — one column must mean "cannot play" (e.g. "Can't"), the others mean some form of "can". Whatever column value means "cannot" is configured as `unavailableAnswer` in `config.json`; every other answer is treated as "available".

The two grids are independent — you can have different rows or column choices in each, but for the DM-availability filter to work the **row labels must match between the two grids** for the same slot (the slot label in `config.json` is what gets matched, not the row title in the form, but it's clearer if they match).

**2. Create a service account.**

In Google Cloud Console: create a project, enable the **Google Forms API**, create a service account, download its JSON key and save it as `./service-account.json` next to `config.json`.

In the Google Form, use the three-dot menu → "Add collaborators" and share **with the service account's email** as an editor. Without this, the API will return 403.

**3. Find the questionId of every grid row.**

Each row in a Multiple-choice grid is its own sub-question with its own `questionId`. Use the helper script:

```sh
node bin/list-form-questions.js <formId>
```

It prints, for each grid row:

```
• When can you play?  [GRID / RADIO]
    columns: Can | Can't | Maybe
    row "Thu evening"  questionId: 19970eb1
    row "Fri morning"  questionId: 1bfeac6f
    …
```

You'll plug the row IDs into `playerSlotQuestions` / `dmSlotQuestions` in `config.json` — see the example below.

**4. Deploy the response-deletion Apps Script.**

The Google Forms REST API cannot delete responses, so the bot calls a small Apps Script bound to the form. See `google-apps-script/delete-responses.gs` — paste its contents into the form's script editor, set `SHARED_SECRET` to a long random string, then Deploy → New Deployment → "Web app":

- Execute as: **Me** (account that owns the form)
- Who has access: **Anyone**

Copy the deployment URL into `config.googleForm.deleteWebhookUrl`, and put the same secret in `config.googleForm.deleteWebhookSecret`. (The bot will run fine without these — responses just won't auto-clear between weeks.)

## Generate the admin panel password hash

```sh
node bin/hash-password.js 'mypassword'
```

Copy the printed bcrypt hash into `config.adminPanel.passwordHash`, and set a long random value for `config.adminPanel.sessionSecret` (e.g. `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`).

## Finding the WhatsApp group ID

Leave `config.groupId` as-is on the first run — the bot will log the group ID whenever any message is sent to a WhatsApp group. Send any message to your D&D group and copy the `..._serialized` value (ends in `@g.us`) into `config.groupId`.

## Fill out `config.json`

```jsonc
{
  "timezone": "Asia/Jerusalem",
  "groupId": "1203630xxxxxxxxx@g.us",
  "playerCount": 5,
  "googleForm": {
    "formId": "1XdA7YL6TEPM7Rbj...",
    "publicUrl": "https://docs.google.com/forms/d/e/.../viewform",
    "serviceAccountKeyPath": "./service-account.json",

    // Map every player-grid row's questionId → the slot label you want to
    // appear in the winner announcement. Get the IDs from
    // `node bin/list-form-questions.js <formId>`.
    "playerSlotQuestions": {
      "19970eb1": "Thu evening",
      "1bfeac6f": "Fri morning",
      "2143c766": "Fri evening",
      "0469f0ac": "Sat morning",
      "4da50c4b": "Sat evening"
    },

    // Same for the DM grid. The slot labels (values) must match the player
    // labels above for the DM-availability filter to work — the row titles
    // in the form itself can differ.
    "dmSlotQuestions": {
      "27dd8488": "Thu evening",
      "2d037dc8": "Fri morning",
      "3b62f1a7": "Fri evening",
      "36a1ee96": "Sat morning",
      "44a29833": "Sat evening"
    },

    // The exact column text in your grids that means "cannot play".
    // Every other answer (e.g. "Can", "Maybe") is treated as available.
    "unavailableAnswer": "Can't",

    "deleteWebhookUrl": "https://script.google.com/macros/s/.../exec",
    "deleteWebhookSecret": "long-random-hex"
  },
  "adminPanel": {
    "port": 3000,
    "passwordHash": "$2b$12$...",
    "sessionSecret": "long-random-hex"
  },
  "messages": {
    "formAnnouncement": "D&D form for the week of {weekStart}: {formUrl}",
    "reminder": "Reminder: {filledCount} people filled the form out of {playerCount} players! {formUrl}",
    "winner": "🎲 This week's session: {slot}. See you there!",
    "tiebreakerIntro": "We have a tie between {slots}. Please vote again:",
    "tiebreakerWinner": "🎲 Tiebreaker decided: {slot}. See you there!",
    "noResponses": "No responses received — no session scheduled for this week.",
    "dmUnavailable": "🎲 The DM has no available slots this week — session cancelled.",
    "dmNoResponse": "⏳ The DM hasn't filled the form yet — holding off on picking a slot."
  }
}
```

After editing `config.json` while the bot is running, use the **Restart bot** button in the admin panel (`/config`) to apply changes, or kill and re-launch the process manually.

## First run

```sh
node src/index.js
```

On first run, a QR code appears in the terminal — scan it with WhatsApp on your phone (Settings → Linked Devices → Link a device). The session is persisted in `./.wwebjs_auth/` so subsequent runs skip the QR.

Once you see `WhatsApp client ready` and `Admin panel listening on :3000`, you're set.

## Admin panel

Open `http://<vps-ip>:3000` → login. The panel shows:

- Next week: when the form link will post, link to the form
- Current week: form link sent? responses (X/Y), DM responded?, reminder sent, winner, tiebreaker state
- "Send form link now" button (only while no link has been posted for the current week)

## Google Calendar integration

When a session winner is announced, the bot can automatically create a Google Calendar event ("D&D Session", 5 hours) and include its link in the WhatsApp message. The feature is **optional** — omit the `googleCalendar` block from `config.json` to keep the bot behaving exactly as before.

**1. Enable the Google Calendar API.**

In the same Google Cloud project you created for the Forms API, enable the **Google Calendar API** as well. No new service account is needed — the same `service-account.json` works.

**2. Share a calendar with the service account.**

In Google Calendar, open the target calendar's settings → **Share with specific people** → add the service account's `client_email` (from `service-account.json`) with **"Make changes to events"** permission. The bot will create events on that calendar.

The `calendarId` in config is the calendar's ID — for a personal calendar it is usually the account email (e.g. `user@gmail.com`). For other calendars, find it under calendar settings → "Integrate calendar".

**3. Add `googleCalendar` to `config.json`.**

```jsonc
"googleCalendar": {
  "calendarId": "user@gmail.com",
  "serviceAccountKeyPath": "./service-account.json",
  "eventTitle": "D&D Session",
  "eventDurationHours": 5,

  // Map each slot label (must exactly match the values in
  // googleForm.playerSlotQuestions) to the day-of-week and start time.
  "slotTimes": {
    "Thu evening": { "dayOfWeek": "thursday", "time": "20:00" },
    "Fri morning": { "dayOfWeek": "friday",   "time": "10:00" },
    "Fri evening": { "dayOfWeek": "friday",   "time": "20:00" },
    "Sat morning": { "dayOfWeek": "saturday", "time": "10:00" },
    "Sat evening": { "dayOfWeek": "saturday", "time": "20:00" }
  }
}
```

`time` is `"HH:mm"` in 24-hour format in `config.timezone`. `dayOfWeek` is a lowercase English day name.

**Calendar link in messages.**

Once the winner is determined the bot creates the event and includes the link in the WhatsApp announcement:

- If your `winner` / `tiebreakerWinner` message template contains the `{calendarLink}` placeholder, the URL is substituted in place.
- If not, the link is appended automatically on a new line: `📅 <url>`.

If event creation fails for any reason (API error, unmapped slot label), the WhatsApp announcement still goes out — calendar integration is non-blocking and non-fatal.

## Test mode

Run any job immediately, regardless of the cron schedule:

```sh
node src/index.js --test post-form-link
node src/index.js --test send-reminder
node src/index.js --test announce-winner
node src/index.js --test announce-tiebreaker
```

The bot starts up (you'll need the QR on first ever run), runs the job once, then exits.

**If the bot is already running, stop it first** — only one instance can hold the WhatsApp session and bind to the admin panel port at a time:

```sh
kill $(ps aux | grep 'node src/index' | grep -v grep | awk '{print $2}')
node src/index.js --test post-form-link
```

Then restart the bot normally when done (see [Running the bot](#running-the-bot)).

Each job is also idempotent per-week — `post-form-link` won't re-post if the week already has an announcement on record. To force a re-run for the current week, delete that week's row from the DB:

```sh
node -e "const db = require('./src/db').open(); db.db.prepare(\"DELETE FROM weekly_state WHERE week_start = '2026-04-19'\").run(); db.close()"
```

## Running the bot

Start the bot in the background with `nohup`, appending logs to `/tmp/bot.log`:

```sh
cd /opt/dnd-poll-bot
nohup node src/index.js >> /tmp/bot.log 2>&1 &
echo "Started PID $!"
```

Follow logs:

```sh
tail -f /tmp/bot.log
```

Stop the bot:

```sh
kill $(ps aux | grep 'node src/index' | grep -v grep | awk '{print $2}')
```

After a config change, use the **Restart bot** button in the admin panel (`/config`) — it spawns a fresh process and exits the current one automatically.

## Exposing the admin panel

**Private via Tailscale is strongly recommended.**

### Private via Tailscale (preferred)

Install Tailscale on the VPS (`curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up`) and on the device you'll admin from. The panel is then reachable at `http://<vps-tailscale-ip>:3000` from your tailnet.

Close port 3000 to the public internet with UFW:

```sh
sudo ufw default deny incoming
sudo ufw allow ssh
# Do NOT `ufw allow 3000` publicly.
sudo ufw allow in on tailscale0
sudo ufw enable
```

### Public over HTTPS (acceptable, less safe)

Put the panel behind Caddy for HTTPS:

```caddy
admin.example.com {
    reverse_proxy localhost:3000
}
```

The bcrypt password and rate limiter (5 attempts / 15 min / IP) are the only defenses, so pick a strong password.

## Troubleshooting

- **WhatsApp session breaks**: delete `./.wwebjs_auth/` and restart; you'll need to re-scan the QR.
- **"The browser is already running for ./.wwebjs_auth/session"**: a previous Chromium process didn't shut down cleanly. `pkill -9 -f chromium && rm -f ./.wwebjs_auth/session/SingletonLock` then restart.
- **403 from Google Forms API**: the service account hasn't been added as an editor on the form, or the Forms API is not enabled in the Cloud project.
- **`list-form-questions.js` shows `(no question — skipped)`**: the item is a section header, image, or video, not a question. The grid case is handled — anything else legitimately has no questionId.
- **Messages aren't being pinned**: the bot's WhatsApp account must be a **group admin**. Promote it from the group settings on the phone that owns the linked WhatsApp account.
- **"DM hasn't filled the form yet"**: the DM must submit the form (answering the DM grid) before Wednesday 10:00. If they miss it, the bot will keep posting the "waiting for DM" message until they respond — kick the announce-winner job manually from the admin panel after the DM submits.
- **Responses not clearing between weeks**: check the Apps Script web app deployment URL and shared secret; test by POSTing `{"secret":"..."}` to the URL manually.
- **Timezone looks wrong**: `config.timezone` must be a valid IANA zone (e.g. `Asia/Jerusalem`); the cron jobs use that zone, not the server's local time.
- **Logs**: `logs/bot-YYYY-MM-DD.log` (one file per day). Stdout is also logged.

## Project layout

```
src/
  index.js              entrypoint: load config, start clients, scheduler, admin
  whatsapp.js           WhatsApp client wrapper (sendText, sendPoll, pinMessage)
  googleform.js         Google Forms API wrapper (read responses, delete via webhook)
  scheduler.js          node-cron setup
  jobs/
    postFormLink.js     Sunday: announce form link (pinned 7d)
    sendReminder.js     Tuesday: post "X of Y filled" (pinned 7d)
    announceWinner.js   Wednesday: DM filter, winner or tiebreaker poll (pinned 7d)
    announceTiebreaker.js  Wednesday evening: finalize after tiebreaker poll
  slots.js              week-boundary helpers
  db.js                 better-sqlite3 wrapper
  logger.js             stdout + rotating file logs
  admin/
    server.js           express app + routes
    auth.js             bcrypt + session + rate limit
    views/              login.html, panel.html
google-apps-script/
  delete-responses.gs   Apps Script the form owner deploys
bin/
  hash-password.js      CLI helper for bcrypting an admin-panel password
  list-form-questions.js  CLI helper that prints every questionId in the form
test/                   node --test tests
```

## Tests

```sh
npm test
```

Covers week boundaries, vote tallying, and the DM availability filter.

## Out of scope

Multi-group support, editing the form via the panel, multi-user admin, HTTPS inside the app (use Caddy), analytics, responder-identity tracking.
