#!/bin/bash
# Auto-fix crashed OpenClaw containers
# Called by monitor.sh when restart fails
# Security: only config JSON fixes, backup first, no docker/compose/env edits

set -euo pipefail

CONTAINER="$1"
COMPOSE_DIR="$2"
source /root/.alert-env
BOT_TOKEN="$ALERT_BOT_TOKEN"
CHAT_ID="$ALERT_CHAT_ID"
LOG="/root/.openclaw/logs/monitor.log"
MAX_ATTEMPTS=2

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [autofix] $*" >> "$LOG"; }
tg() {
  curl -s "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
    -d chat_id="$CHAT_ID" --data-urlencode "text=$1" \
    -d parse_mode="HTML" --max-time 10 > /dev/null 2>&1
}
esc() { echo "$1" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g'; }

if [ -z "$CONTAINER" ] || [ -z "$COMPOSE_DIR" ]; then
  log "ERROR: usage: autofix.sh <container> <compose-dir>"
  exit 1
fi

# Rate limit — max 1 autofix per container per hour
LOCK="/tmp/autofix-${CONTAINER}.lock"
if [ -f "$LOCK" ]; then
  LOCK_AGE=$(( $(date +%s) - $(stat -c %Y "$LOCK") ))
  if [ "$LOCK_AGE" -lt 3600 ]; then
    log "SKIP: autofix for $CONTAINER throttled (${LOCK_AGE}s ago)"
    exit 0
  fi
fi
touch "$LOCK"

# Collect crash context
CRASH_LOGS=$(docker logs "$CONTAINER" --tail=30 2>&1 | tail -30)
EXIT_CODE=$(docker inspect --format='{{.State.ExitCode}}' "$CONTAINER" 2>/dev/null)
CONFIG="$COMPOSE_DIR/.openclaw/openclaw.json"

log "start autofix: $CONTAINER exit=$EXIT_CODE"

# ============================================================
# STEP 1: Try known fixes without LLM
# ============================================================

FIXED=""

# Fix: "Unrecognized key" in config — remove it
BAD_KEY=$(echo "$CRASH_LOGS" | grep -oP 'Unrecognized key: "\K[^"]+' | head -1)
if [ -n "$BAD_KEY" ]; then
  # Backup config
  cp "$CONFIG" "${CONFIG}.bak.$(date +%s)"

  # Parse the full path from error (e.g. "agents.defaults: Unrecognized key: systemPrompt")
  PARENT_PATH=$(echo "$CRASH_LOGS" | grep "Unrecognized key" | head -1 | grep -oP '^\s*-\s*\K[^:]+' | sed 's/\s*$//')

  if [ -n "$PARENT_PATH" ] && [ -n "$BAD_KEY" ]; then
    python3 -c "
import json, sys
with open('$CONFIG') as f:
    d = json.load(f)
# Navigate to parent
obj = d
parts = '$PARENT_PATH'.split('.')
for p in parts:
    if isinstance(obj, dict) and p in obj:
        obj = obj[p]
    else:
        sys.exit(1)
# Remove the bad key
if isinstance(obj, dict) and '$BAD_KEY' in obj:
    del obj['$BAD_KEY']
    with open('$CONFIG', 'w') as f:
        json.dump(d, f, indent=2, ensure_ascii=False)
        f.write('\n')
    print('removed')
else:
    sys.exit(1)
" 2>/dev/null && FIXED="removed invalid key '$PARENT_PATH.$BAD_KEY' from config"
  fi
fi

# Fix: "Config invalid" with openclaw doctor --fix
if [ -z "$FIXED" ] && echo "$CRASH_LOGS" | grep -q "openclaw doctor --fix"; then
  cp "$CONFIG" "${CONFIG}.bak.$(date +%s)"
  docker start "$CONTAINER" >> "$LOG" 2>&1 || true
  sleep 3
  docker exec "$CONTAINER" openclaw doctor --fix --yes 2>&1 >> "$LOG" && FIXED="ran openclaw doctor --fix"
  docker stop "$CONTAINER" >> "$LOG" 2>&1 || true
fi

# ============================================================
# STEP 2: If known fixes didn't help, try restart
# ============================================================

if [ -n "$FIXED" ]; then
  log "applied fix: $FIXED"
  docker start "$CONTAINER" >> "$LOG" 2>&1
  sleep 10
  NEW_STATUS=$(docker inspect --format='{{.State.Status}}' "$CONTAINER" 2>/dev/null)

  if [ "$NEW_STATUS" = "running" ]; then
    log "SUCCESS: $CONTAINER fixed and running"
    tg "🟢 <b>AUTOFIX</b> — <code>$CONTAINER</code>

<b>was</b>  exit <code>$EXIT_CODE</code>
<b>fix</b>  <code>$(esc "$FIXED")</code>
<b>now</b>  running ✓"
    exit 0
  else
    log "WARN: fix applied but container still not running ($NEW_STATUS)"
  fi
fi

# ============================================================
# STEP 3: Can't auto-fix — send postmortem
# ============================================================

CAUSE=$(echo "$CRASH_LOGS" | grep -iE "error|fail|invalid|problem|crash|panic|SIGKILL|OOM" | tail -5 | head -c 400)

log "FAIL: could not auto-fix $CONTAINER"
tg "🔴 <b>POSTMORTEM</b> — <code>$CONTAINER</code>

<b>exit</b>  <code>$EXIT_CODE</code>
<b>autofix</b>  не смог починить

<b>cause</b>
<code>$(esc "$CAUSE")</code>

нужна ручная помощь"
