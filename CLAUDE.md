# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start                          # Run the bot (scheduler + admin panel)
npm test                           # Run the slot math/validation test suite
node src/index.js --test <job>     # Run a single job manually (see job keys below)
node bin/hash-password.js <pw>     # Generate bcrypt hash for config.adminPanel.passwordHash
```

`--test` job keys: `post-form-link`, `send-reminder`, `announce-winner`, `announce-tiebreaker`.

## Configuration

Copy `config.example.json` → `config.json` (git-ignored). Required fields: `timezone`, `groupId`, `members`, `slotTemplate`, `adminPanel` (with `passwordHash` and `sessionSecret`), `messages`. Optional: `dmNumber` (enables DM availability filter).

To find the WhatsApp `groupId`: start the bot with `"groupId": "REPLACE_..."`, send any message in the target group — the ID will appear in the log.

## Architecture

The bot is a single Node.js process with three concerns running in parallel:

**1. Scheduled jobs** (`src/scheduler.js` + `src/jobs/`)  
Weekly cron jobs in the configured timezone (current Google-Form flow):
- Sunday 10:00 → `postFormLink` — announce this week's Google Form link in the group, pin for 7 days, record message id, then wipe last week's form responses
- Tuesday 10:00 → `sendReminder` — read form responses, @mention members who haven't voted yet
- Wednesday 10:00 → `announceWinner` — tally form responses, apply DM filter, announce winner or post a tiebreaker WhatsApp poll
- Wednesday 20:00 → `announceTiebreaker` — read tiebreaker poll votes, announce final winner

All jobs are idempotent (check DB state before acting) and are passed a shared `ctx = { config, db, whatsapp, googleForm, googleCalendar }`. The scheduler wrapper only logs errors — it does not retry; jobs that need recovery must rely on idempotency at the next scheduled run, or on the WhatsApp wrapper's in-flight retry (below).

**2. WhatsApp client** (`src/whatsapp.js`)  
Wraps `whatsapp-web.js`. First run prints a QR code; session is persisted in `.wwebjs_auth/`. On VPS, detects system Chrome (preferred over Puppeteer's bundled binary) and uses `protocolTimeout: 0` plus a 3-attempt retry loop to survive WhatsApp's internal navigation errors during startup. Key methods: `sendPoll`, `sendText`, `readPollVotes`, `pinMessage`, `getGroupParticipantNumbers`.

Every public op is wrapped with `withTransientRetry`: on a Puppeteer-level transient error (`detached Frame`, `Execution context was destroyed`, `Target closed`, `Session closed`, `Protocol error`, `Most likely the page has been closed`) the wrapper forces a full client re-init and retries the op once. This catches the case where the underlying Chromium frame detaches silently after multi-day uptime without firing whatsapp-web.js's `disconnected` event. `src/index.js` also runs a 30-minute liveness probe (`client.getState()`) that triggers the same re-init when the probe throws — so detachment is usually healed before the next cron fires.

**3. Admin panel** (`src/admin/server.js`)  
Express app at `config.adminPanel.port` (default 3000). Password-protected (bcrypt + express-session, 5-attempt rate limit). Main panel lets the admin edit next week's time slots before the poll fires and manually trigger the poll if needed. Slots are stored as a JSON array in SQLite and locked after the poll is posted.

> **Rule: every `config.json` field must have a corresponding entry in `src/admin/configSchema.js`.**  
> Any time a new field is added to `config.json` or `config.example.json`, add a matching schema entry so it is editable from the admin dashboard. The schema drives the edit-config UI automatically — no HTML changes are needed, only a new object in the `SCHEMA` array with the correct `path`, `section`, `label`, `help`, `type`, and `required` values. See the existing entries for examples.

**State machine per week** (stored in `state.db`):
```
slots editable → form announced (slots locked, mainPollId = announcement msg id) → reminder sent → winner announced / tiebreaker posted → tiebreaker decided
```

**`postFormLink` ordering.** Send + pin + `db.setMainPoll()` happen FIRST; `googleForm.deleteAllResponses()` is the LAST step. A send failure must not wipe last week's responses without a replacement announcement.

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

> ⚠️ **ALWAYS verify where the bot is actually running before touching anything on the server.** There are stale copies of the repo at other paths (e.g. `/root/dnd-scheduler/`). Before any action, run `ps aux | grep 'node src/index'` and inspect `/proc/<pid>/cwd` (or check the symlink target of `readlink /proc/<pid>/cwd`) to confirm the live working directory. Editing files, restarting, or running `--test` from the wrong dir will silently use the wrong `config.json` / `state.db` / `.wwebjs_auth/`. The canonical install is `/opt/dnd-poll-bot/` — but trust the running process, not this doc.

The bot runs in a `tmux` session on the VPS at `/opt/dnd-poll-bot`:
```bash
tmux new-session -d -s dnd-bot
tmux send-keys -t dnd-bot 'cd /opt/dnd-poll-bot && node src/index.js' Enter
tmux capture-pane -t dnd-bot -p   # view output
```
Logs are in `logs/`. To redeploy: build a tarball excluding `node_modules`, `.git`, `.wwebjs_auth`, `state.db`, and `config.json`; extract on server; `npm install`.

### Server-side gotchas (learned the hard way)

- **Snap chromium hijacks the user-data-dir.** `/usr/bin/chromium-browser` is a shell wrapper that execs `/snap/bin/chromium`. Because of snap confinement, the chromium process IGNORES the `--user-data-dir` puppeteer passes and writes its profile to `/root/snap/chromium/common/chromium/Default/` instead. So the WhatsApp IndexedDB / cookies / linked-device session live there, NOT in `/opt/dnd-poll-bot/.wwebjs_auth/session/` (which stays empty). Implications:
  - When debugging auth, look in `/root/snap/chromium/common/chromium/Default/IndexedDB/https_web.whatsapp.com_0.indexeddb.leveldb/` for the real session.
  - If chromium is killed abruptly it leaves `Singleton{Lock,Cookie,Socket}` symlinks in `/root/snap/chromium/common/chromium/`. New launches can hang or behave oddly. Clear them: `rm -f /root/snap/chromium/common/chromium/Singleton*`.
- **`waitForReady` timeout is borderline.** The default 120s in `src/whatsapp.js` is sometimes too short with snap chromium — full auth+ready can take ~105s after `init()` returns. A first-attempt timeout is a known failure mode; just retry (or bump the timeout to 300s temporarily while debugging).
- **Only one process can use the WhatsApp auth at a time.** Before running `--test ...` you MUST stop the running bot (otherwise puppeteer hits "The browser is already running for ... session"). Restart it afterwards.
- **Winner-announce ordering.** Both `announceWinner` and `announceTiebreaker` flip their "announced" flags ONLY after the WhatsApp message has been sent and pinned, so a mid-send failure leaves the week unannounced and the next run will retry cleanly. If you ever see a `winner_announced=1` row with no message in the group, that's a regression — check that the DB write hasn't crept back above the send call. The `calendar_event_link` column is written eagerly (right after the calendar event is created) and is reused on retry to avoid duplicate calendar events.
