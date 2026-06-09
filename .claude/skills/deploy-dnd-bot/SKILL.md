---
name: deploy-dnd-bot
description: Deploy the D&D scheduling bot to the production server via SSH. Use this skill whenever the user says "deploy", "push to server", "update the server", "deploy the bot", or anything about getting code changes onto the live bot. The skill handles copying changed files to the server and restarting the bot process.
---

# Deploy D&D Bot

Deploy changed source files to the production server and restart the bot.

## ⛔ Deploy ONLY from `master`

**The production server must only ever run code that is on `master`.** Before doing anything else, check the current branch:

```powershell
git rev-parse --abbrev-ref HEAD
```

- **If you are on `master`** (and it is up to date with the remote): proceed with the deploy.
- **If you are on any other branch** (a feature branch, a `claude/...` worktree branch, etc.): **STOP. Do not deploy.** Deploying uncommitted or unmerged work puts code on the live bot that has not been reviewed or merged — and the next legitimate deploy from `master` would silently overwrite it, making the server state confusing and unreproducible.

  When the current session introduced changes on a non-`master` branch, the correct flow is:
  1. Finish the change and open a PR.
  2. Get it merged into `master`.
  3. Check out `master`, pull the merge, and **only then** run this skill to deploy.

  Tell the user explicitly: *"This change isn't on master yet — I'll deploy it once it's merged."* Do not offer to deploy the branch directly.

If the user insists on deploying a non-`master` branch anyway, treat that as a hard, outward-facing action: confirm they understand it bypasses review and will be clobbered by the next `master` deploy, and only proceed on an explicit, unambiguous yes.

## Server details

- **Host:** `46.101.164.69`
- **User:** `root`
- **Bot directory:** `/opt/dnd-poll-bot`
- **SSH tools:** `plink` (shell commands) and `pscp` (file copy) — PuTTY CLI tools, available on this machine

The server has no git — deploy by copying files directly.

## Step 1: Ask for the SSH password

Before doing anything else, use the `AskUserQuestion` tool to ask:

> "What's the SSH password for root@46.101.164.69?"

Use a free-text question (the user will type it in the Other field). Do not log, display, or store the password anywhere after use.

> ⚠️ **Never hardcode or write any password into this skill file.** Passwords must always be obtained fresh from the user at runtime.

## Step 2: Identify changed files

Figure out which source files have changed and need to be deployed. Since deploys come from `master`, this is usually the diff of the merge you just pulled (`git diff --name-only HEAD~1 HEAD`, or compare against the last deployed commit). If it's not obvious, ask the user which files to deploy, or check git status in the working directory.

Only copy files that actually changed — don't bulk-copy the entire repo.

## Step 3: Copy files to the server

Use `pscp` to upload each changed file. The server directory structure mirrors the local repo:

```powershell
echo y | pscp -pw "<password>" "<local-path>" "root@46.101.164.69:/opt/dnd-poll-bot/<relative-path>"
```

**Example** — deploying a changed job file:
```powershell
echo y | pscp -pw "PASS" "C:\...\src\jobs\postFormLink.js" "root@46.101.164.69:/opt/dnd-poll-bot/src/jobs/postFormLink.js"
```

Run uploads in parallel if there are multiple files (multiple PowerShell tool calls in one message).

Confirm each file uploaded successfully (pscp prints progress and exits 0 on success).

## Step 4: Restart the bot

**Do NOT use `tmux send-keys` to start the process** — it is unreliable over non-interactive SSH and the command often silently fails to execute.

**Do NOT launch with a bare `nohup node ... &` over plink either.** A plain backgrounded job is still a child of the transient SSH login shell; when that shell tears down at the end of the plink session, the node process gets killed shortly after — it may run for a few seconds (long enough to log "Admin panel listening") and then vanish. You MUST fully detach it from the session with `setsid` (see launch step below).

### 4a. Stop the old process cleanly

`ps aux | grep` can return **multiple** PIDs (the `bash -c` wrapper + the `node` process, sometimes a stale run too). `kill $NODE_PID` with multiple values breaks the `[ -n ... ]` test (`binary operator expected`) and may not kill everything. Use `pkill -f` and free the port explicitly:

```powershell
echo y | plink -ssh root@46.101.164.69 -pw "<password>" "pkill -f 'node src/index' 2>/dev/null; sleep 1; fuser -k 3000/tcp 2>/dev/null; sleep 2; ps aux | grep 'node src/index' | grep -v grep || echo 'node stopped'"
```

### 4b. Kill orphaned Chrome and clear the singleton locks

This is the step that bites if skipped. When the old node process dies abruptly (including the SSH-teardown kill described above), it leaves **orphaned `google-chrome` processes** still holding `.wwebjs_auth/session/SingletonLock`. The next node launch then dies at startup with:

> `Fatal error in main: Error: The browser is already running for /opt/dnd-poll-bot/.wwebjs_auth/session. Use a different userDataDir or stop the running browser first.`

Always kill stray Chrome and remove the singleton files before relaunching:

```powershell
echo y | plink -ssh root@46.101.164.69 -pw "<password>" "pkill -9 -f 'google/chrome' 2>/dev/null; sleep 2; rm -f /opt/dnd-poll-bot/.wwebjs_auth/session/SingletonLock /opt/dnd-poll-bot/.wwebjs_auth/session/SingletonCookie /opt/dnd-poll-bot/.wwebjs_auth/session/SingletonSocket /root/.config/google-chrome/Singleton*; ps aux | grep -E 'node src/index|google/chrome' | grep -v grep | wc -l"
```

The final `wc -l` should print `0`. (Removing `SingletonLock` does NOT log you out — the WhatsApp session lives in `IndexedDB`, not the lock file.)

### 4c. Launch fully detached with `setsid`

```powershell
echo y | plink -ssh root@46.101.164.69 -pw "<password>" "cd /opt/dnd-poll-bot && setsid bash -c 'nohup node src/index.js >> /tmp/bot.log 2>&1' < /dev/null > /dev/null 2>&1 & sleep 3"
```

Then confirm the process is its own session leader (look for state `Ss` on the `bash -c` line, meaning `setsid` worked):

```powershell
echo y | plink -ssh root@46.101.164.69 -pw "<password>" "ps aux | grep 'node src/index' | grep -v grep || echo 'NOT RUNNING'"
```

Key points:
- Append (`>>`) to `/tmp/bot.log` so previous log lines are preserved for debugging
- If `fuser -k 3000/tcp` still doesn't free the port, re-run step 4b — a held port almost always means orphaned Chrome is still alive

## Step 5: Verify the bot is up

**Do NOT poll tmux scrollback** — it contains old log lines that will match prematurely. Poll `/tmp/bot.log` directly instead — but `grep` over the **whole** file will also match stale "Admin panel listening" / "Fatal error" lines from previous runs and return instantly. Match only the **tail** so you're seeing this run's output:

```powershell
echo y | plink -ssh root@46.101.164.69 -pw "<password>" "until tail -40 /tmp/bot.log | grep -q 'Admin panel listening\|Fatal error'; do sleep 5; done; echo '=== log ==='; tail -6 /tmp/bot.log; echo '=== process ==='; ps aux | grep 'node src/index' | grep -v grep; echo '=== port ==='; fuser 3000/tcp 2>/dev/null && echo ' (listening)'"
```

`Admin panel listening on :3000` plus a PID on port 3000 and `WhatsApp client ready` in the log confirms the bot is fully up. Note that WhatsApp auth takes ~40 seconds on this server, so the `until` loop will run for a while — that is normal. If the tail shows the `Fatal error ... browser is already running` message, go back to **step 4b** (orphaned Chrome wasn't cleared).

## Step 6: Confirm to the user

Report:
- Which files were uploaded
- The new bot PID
- Last few log lines showing successful startup

If the process didn't come back up, show the full log tail: `tail -30 /tmp/bot.log`
