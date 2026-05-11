# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start                          # Run the bot (scheduler + admin panel)
npm test                           # Run the slot math/validation test suite
node src/index.js --test <job>     # Run a single job manually (see job keys below)
node bin/hash-password.js <pw>     # Generate bcrypt hash for config.adminPanel.passwordHash
```

`--test` job keys: `create-poll`, `send-reminder`, `announce-winner`, `announce-tiebreaker`, `seed-next-week`.

## Configuration

Copy `config.example.json` → `config.json` (git-ignored). Required fields: `timezone`, `groupId`, `members`, `slotTemplate`, `adminPanel` (with `passwordHash` and `sessionSecret`), `messages`. Optional: `dmNumber` (enables DM availability filter).

To find the WhatsApp `groupId`: start the bot with `"groupId": "REPLACE_..."`, send any message in the target group — the ID will appear in the log.

## Architecture

The bot is a single Node.js process with three concerns running in parallel:

**1. Scheduled jobs** (`src/scheduler.js` + `src/jobs/`)  
Five cron jobs run weekly in the configured timezone:
- Sunday 10:00 → `createMainPoll` — post WhatsApp poll from that week's slots, lock slots, pin poll 7 days
- Tuesday 10:00 → `sendReminder` — @mention members who haven't voted yet
- Wednesday 10:00 → `announceWinner` — tally votes, apply DM filter, announce winner or post tiebreaker poll
- Wednesday 20:00 → `announceTiebreaker` — read tiebreaker poll, announce final winner
- `seedNextWeekSlots` — called after winner/tiebreaker jobs; seeds next week's editable slots

All jobs are idempotent (check DB state before acting) and are passed a shared `ctx = { config, db, whatsapp }`.

**2. WhatsApp client** (`src/whatsapp.js`)  
Wraps `whatsapp-web.js`. First run prints a QR code; session is persisted in `.wwebjs_auth/`. On VPS, detects system Chrome (preferred over Puppeteer's bundled binary) and uses `protocolTimeout: 0` plus a 3-attempt retry loop to survive WhatsApp's internal navigation errors during startup. Key methods: `sendPoll`, `sendText`, `readPollVotes`, `pinMessage`, `getGroupParticipantNumbers`.

**3. Admin panel** (`src/admin/server.js`)  
Express app at `config.adminPanel.port` (default 3000). Password-protected (bcrypt + express-session, 5-attempt rate limit). Main panel lets the admin edit next week's time slots before the poll fires and manually trigger the poll if needed. Slots are stored as a JSON array in SQLite and locked after the poll is posted.

> **Rule: every `config.json` field must have a corresponding entry in `src/admin/configSchema.js`.**  
> Any time a new field is added to `config.json` or `config.example.json`, add a matching schema entry so it is editable from the admin dashboard. The schema drives the edit-config UI automatically — no HTML changes are needed, only a new object in the `SCHEMA` array with the correct `path`, `section`, `label`, `help`, `type`, and `required` values. See the existing entries for examples.

**State machine per week** (stored in `state.db`):
```
slots editable → poll posted (slots locked) → reminder sent → winner announced / tiebreaker posted → tiebreaker decided
```

**DM availability filter** (`src/jobs/announceWinner.js` → `applyDmFilter`): if `config.dmNumber` is set, only slots that the DM voted for are eligible. If the DM voted for none, `dmUnavailable` message is sent and the week is cancelled.

## Key Files

| File | Role |
|------|------|
| `src/db.js` | SQLite wrapper (`poll_state` + `weekly_slots` tables); all methods are synchronous via `better-sqlite3` |
| `src/slots.js` | `currentWeekStart` / `nextPollWeekStart` (week = Sun–Sat), `expandTemplate`, `formatSlotLabel`, `validateSlots` |
| `src/logger.js` | Writes to stdout + `logs/bot-YYYY-MM-DD.log`; set `DEBUG=1` for debug-level output |

## Database

SQLite at `state.db` (WAL mode). Two tables:
- `poll_state` — one row per `week_start` (ISO date = Sunday), tracks poll IDs, boolean flags, winner slot
- `weekly_slots` — one row per `week_start`, stores a JSON array of `{ day, time, durationHours }` objects

## Deployment (VPS)

The bot runs in a `tmux` session on the VPS at `/opt/dnd-poll-bot`:
```bash
tmux new-session -d -s dnd-bot
tmux send-keys -t dnd-bot 'cd /opt/dnd-poll-bot && node src/index.js' Enter
tmux capture-pane -t dnd-bot -p   # view output
```
Logs are in `logs/`. To redeploy: build a tarball excluding `node_modules`, `.git`, `.wwebjs_auth`, `state.db`, and `config.json`; extract on server; `npm install`.
