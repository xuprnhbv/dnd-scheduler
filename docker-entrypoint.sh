#!/bin/sh
set -e

# Run from the persistent volume so every path the app resolves relative to
# process.cwd() lands on /data: config.json (src/index.js), state.db (src/db.js),
# .wwebjs_auth/ (src/whatsapp.js), logs/ (src/logger.js), and the Google
# service-account key. The code stays read-only in /app.
# On Fly the volume is mounted at /data; mkdir keeps local runs (no volume)
# from failing here so the clearer config.json check below can fire instead.
mkdir -p /data
cd /data

if [ ! -f /data/config.json ]; then
  echo "FATAL: /data/config.json not found." >&2
  echo "Upload config.json (and service-account.json) to the Fly volume mounted at /data," >&2
  echo "e.g. via 'fly ssh sftp shell'. See the migration runbook." >&2
  exit 1
fi

exec node /app/src/index.js "$@"
