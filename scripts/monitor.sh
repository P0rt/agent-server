#!/bin/bash
# Watchdog + threat detector for openclaw-tg-bot
# Runs every 5 min via cron.
# - Checks Docker daemon + container health, auto-restarts
# - Checks network threats (DDoS, brute-force) — alerts immediately
# - Re-alert cooldown: 30 min per threat type to avoid spam

CONTAINER="openclaw-gateway"
source /root/.alert-env
BOT_TOKEN="$ALERT_BOT_TOKEN"
CHAT_ID="$ALERT_CHAT_ID"
LOG="/root/.openclaw/logs/monitor.log"
THREAT_STATE="/root/.openclaw/logs/threat-state.json"

# Thresholds
THR_SYN_RECV=50       # SYN_RECV connections → SYN flood
THR_IP_CONNS=20       # connections from single IP → suspicious
THR_SSH_FAILS=15      # SSH auth failures in 5 min → brute-force
THR_TOTAL_CONNS=300   # total established connections → high load / flood
COOLDOWN=1800         # seconds between repeated alerts for same threat (30 min)

log() {
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" >> "$LOG"
}

tg() {
  curl -s "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
    -d chat_id="$CHAT_ID" \
    --data-urlencode "text=$1" \
    -d parse_mode="HTML" \
    --max-time 10 > /dev/null 2>&1
}

now_ts() { date +%s; }

# Read last alert timestamp for a threat type from state file
last_alert() {
  local key="$1"
  python3 -c "
import json, sys
try:
    d = json.load(open('$THREAT_STATE'))
    print(d.get('$key', 0))
except:
    print(0)
" 2>/dev/null
}

# Save alert timestamp for a threat type
save_alert() {
  local key="$1"
  python3 -c "
import json, time
try:
    d = json.load(open('$THREAT_STATE'))
except:
    d = {}
d['$key'] = int(time.time())
json.dump(d, open('$THREAT_STATE','w'))
" 2>/dev/null
}

# Check cooldown — returns 0 (ok to alert) or 1 (still in cooldown)
can_alert() {
  local key="$1"
  local last
  last=$(last_alert "$key")
  local now
  now=$(now_ts)
  [ $(( now - last )) -gt $COOLDOWN ]
}

# ============================================================
# 1. DOCKER DAEMON
# ============================================================
if ! systemctl is-active --quiet docker; then
  log "CRITICAL: docker daemon not running, attempting start"
  systemctl start docker
  sleep 5
  if ! systemctl is-active --quiet docker; then
    log "CRITICAL: docker daemon failed to start"
    tg "🔴 <b>КРИТИЧНО — openclaw-tg-bot</b>: Docker daemon упал и не поднялся!"
    exit 1
  fi
  log "INFO: docker daemon restarted"
  tg "🟡 <b>openclaw-tg-bot</b>: Docker daemon был упавший, перезапустил."
fi

# ============================================================
# 2. CONTAINER HEALTH
# ============================================================
STATUS=$(docker inspect --format='{{.State.Status}}' "$CONTAINER" 2>/dev/null)

if [ -z "$STATUS" ]; then
  log "ERROR: container $CONTAINER not found"
  tg "🔴 <b>openclaw-tg-bot</b>: Контейнер <code>$CONTAINER</code> не найден!"
  exit 1
fi

if [ "$STATUS" = "running" ]; then
  if ss -tlnp 2>/dev/null | grep -q ':18789'; then
    log "OK: $CONTAINER running, port 18789 up"
    python3 -c "
import json, time
try: d=json.load(open('$THREAT_STATE'))
except: d={}
d['container_ok_ts']=int(time.time())
json.dump(d,open('$THREAT_STATE','w'))
" 2>/dev/null
  else
    log "WARN: $CONTAINER running but port 18789 not listening — restarting"
    docker restart "$CONTAINER" >> "$LOG" 2>&1
    tg "🟡 <b>openclaw-tg-bot</b>: Контейнер завис (порт не отвечал). Перезапустил."
  fi
else
  # Not running — grab crash logs before restart
  GW_CRASH_LOG=$(docker logs "$CONTAINER" --tail=15 2>&1 | grep -iE "error|fail|invalid|problem|crash|panic|SIGKILL|OOM" | tail -5 | head -c 600)
  GW_EXIT_CODE=$(docker inspect --format='{{.State.ExitCode}}' "$CONTAINER" 2>/dev/null)

  log "WARN: $CONTAINER status=$STATUS exit=$GW_EXIT_CODE — restarting"
  docker start "$CONTAINER" >> "$LOG" 2>&1
  sleep 10
  NEW_STATUS=$(docker inspect --format='{{.State.Status}}' "$CONTAINER" 2>/dev/null)
  if [ "$NEW_STATUS" = "running" ]; then
    log "INFO: $CONTAINER restarted successfully"
    PM_MSG="🟡 <b>POSTMORTEM</b> — <code>$CONTAINER</code>

<b>was</b>  <code>$STATUS</code> (exit <code>$GW_EXIT_CODE</code>)
<b>now</b>  running ✓"
    if [ -n "$GW_CRASH_LOG" ]; then
      PM_MSG="$PM_MSG

<b>cause</b>
<code>$(echo "$GW_CRASH_LOG" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g')</code>"
    fi
    tg "$PM_MSG"
  else
    log "ERROR: $CONTAINER failed to restart, status=$NEW_STATUS"
    tg "🔴 <b>openclaw-tg-bot</b>: <code>$CONTAINER</code> <code>$STATUS</code> → перезапуск не помог (<code>$NEW_STATUS</code>)

<b>last logs</b>
<code>$(echo "$GW_CRASH_LOG" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g')</code>"
  fi
fi

# ============================================================
# 3. THREAT DETECTION (no LLM — pure thresholds)
# ============================================================

# -- SYN flood --
SYN_RECV=$(ss -tn state syn-recv 2>/dev/null | wc -l)
if [ "$SYN_RECV" -gt "$THR_SYN_RECV" ] && can_alert "syn_flood"; then
  log "THREAT: SYN flood — syn_recv=$SYN_RECV (threshold=$THR_SYN_RECV)"
  save_alert "syn_flood"
  tg "<b>!! syn flood</b>

syn_recv  <code>$SYN_RECV</code>  (thr: $THR_SYN_RECV)
вероятная ddos-атака"
fi

# -- Connection flood (total established) --
TOTAL_CONNS=$(ss -tn state established 2>/dev/null | wc -l)
if [ "$TOTAL_CONNS" -gt "$THR_TOTAL_CONNS" ] && can_alert "conn_flood"; then
  log "THREAT: connection flood — total_established=$TOTAL_CONNS (threshold=$THR_TOTAL_CONNS)"
  save_alert "conn_flood"
  TOP_IPS=$(ss -tn state established 2>/dev/null \
    | awk 'NR>1{print $5}' | cut -d: -f1 \
    | sort | uniq -c | sort -rn | head -5 \
    | python3 -c "
import sys
lines = []
for l in sys.stdin:
    parts = l.strip().split()
    if len(parts)==2:
        lines.append(f'{parts[1]}  x{parts[0]}')
print('\n'.join(lines))
")
  tg "<b>!! connection flood</b>

established  <code>$TOTAL_CONNS</code>  (thr: $THR_TOTAL_CONNS)

<b>top ips</b>
<code>$TOP_IPS</code>"
fi

# -- Single IP with too many connections --
BAD_IP=$(ss -tn state established 2>/dev/null \
  | awk 'NR>1{print $5}' | cut -d: -f1 \
  | sort | uniq -c | sort -rn \
  | awk -v thr="$THR_IP_CONNS" '$1 > thr {print $1" "$2}' \
  | head -3)
if [ -n "$BAD_IP" ] && can_alert "ip_flood"; then
  log "THREAT: single IP flood — $BAD_IP"
  save_alert "ip_flood"
  FMT_IPS=$(echo "$BAD_IP" | python3 -c "
import sys
lines = []
for l in sys.stdin:
    parts = l.strip().split()
    if len(parts)==2:
        lines.append(f'{parts[1]}  x{parts[0]}')
print('\n'.join(lines))
")
  tg "<b>!! ip flood</b>

подозрительные ip  (>${THR_IP_CONNS} соединений)

<code>$FMT_IPS</code>"
fi

# -- SSH brute-force (last 5 min) --
SSH_FAILS=$(journalctl _SYSTEMD_UNIT=ssh.service \
  --since "5 minutes ago" --no-pager -q 2>/dev/null \
  | grep -ci 'invalid\|failed\|error')
if [ "$SSH_FAILS" -gt "$THR_SSH_FAILS" ] && can_alert "ssh_brute"; then
  log "THREAT: SSH brute-force — failures=$SSH_FAILS in last 5 min (threshold=$THR_SSH_FAILS)"
  save_alert "ssh_brute"
  BANNED_NOW=$(fail2ban-client status sshd 2>/dev/null | grep 'Currently banned' | awk '{print $NF}')
  TOP_SSH=$(journalctl _SYSTEMD_UNIT=ssh.service \
    --since "5 minutes ago" --no-pager -q 2>/dev/null \
    | grep -i 'invalid\|failed' \
    | grep -oP '(\d{1,3}\.){3}\d{1,3}' \
    | sort | uniq -c | sort -rn | head -5 \
    | python3 -c "
import sys
lines = []
for l in sys.stdin:
    parts = l.strip().split()
    if len(parts)==2:
        lines.append(f'{parts[1]}  x{parts[0]}')
print('\n'.join(lines))
")
  tg "<b>!! ssh brute-force</b>

failures  <code>$SSH_FAILS</code> / 5min
fail2ban  <code>$BANNED_NOW</code> banned  [3 tries → 24h ban]

<b>top attackers</b>
<code>$TOP_SSH</code>"
fi

# ============================================================
# 4. WORKBOT CONTAINER HEALTH (openclaw-workbot)
# ============================================================
WB_CONTAINER="openclaw-workbot"
WB_STATUS=$(docker inspect --format='{{.State.Status}}' "$WB_CONTAINER" 2>/dev/null)

if [ -n "$WB_STATUS" ]; then
  if [ "$WB_STATUS" = "running" ]; then
    if ss -tlnp 2>/dev/null | grep -q ':18791'; then
      log "OK: $WB_CONTAINER running, port 18791 up"
    else
      log "WARN: $WB_CONTAINER running but port 18791 not listening — restarting"
      docker restart "$WB_CONTAINER" >> "$LOG" 2>&1
      tg "🟡 <b>openclaw-tg-bot</b>: <code>$WB_CONTAINER</code> завис (порт не отвечал). Перезапустил."
    fi
  else
    # Grab crash logs before restart
    WB_CRASH_LOG=$(docker logs "$WB_CONTAINER" --tail=15 2>&1 | grep -iE "error|fail|invalid|problem|crash|panic|SIGKILL|OOM" | tail -5 | head -c 600)
    WB_EXIT_CODE=$(docker inspect --format='{{.State.ExitCode}}' "$WB_CONTAINER" 2>/dev/null)

    log "WARN: $WB_CONTAINER status=$WB_STATUS exit=$WB_EXIT_CODE — restarting"
    docker start "$WB_CONTAINER" >> "$LOG" 2>&1
    sleep 10
    WB_NEW=$(docker inspect --format='{{.State.Status}}' "$WB_CONTAINER" 2>/dev/null)
    if [ "$WB_NEW" = "running" ]; then
      log "INFO: $WB_CONTAINER restarted successfully"
      # Postmortem alert with crash reason
      PM_MSG="🟡 <b>POSTMORTEM</b> — <code>$WB_CONTAINER</code>

<b>was</b>  <code>$WB_STATUS</code> (exit <code>$WB_EXIT_CODE</code>)
<b>now</b>  running ✓"
      if [ -n "$WB_CRASH_LOG" ]; then
        PM_MSG="$PM_MSG

<b>cause</b>
<code>$(echo "$WB_CRASH_LOG" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g')</code>"
      fi
      tg "$PM_MSG"
    else
      log "WARN: $WB_CONTAINER restart failed ($WB_NEW), trying autofix"
      /root/autofix.sh "$WB_CONTAINER" /srv/openclaw-work &
    fi
  fi
fi

# --- Claude Code zombie/stuck cleanup in workbot ---
if docker inspect --format='{{.State.Running}}' "$WB_CONTAINER" 2>/dev/null | grep -q true; then
  # Kill defunct (zombie) claude processes
  ZOMBIES=$(docker exec "$WB_CONTAINER" sh -c 'ps -o pid,stat,comm 2>/dev/null | grep -E "Z.*(claude|acpx)" | awk "{print \$1}"' 2>/dev/null)
  if [ -n "$ZOMBIES" ]; then
    ZCOUNT=$(echo "$ZOMBIES" | wc -w)
    log "INFO: killing $ZCOUNT zombie claude/acpx processes in $WB_CONTAINER"
    docker exec "$WB_CONTAINER" sh -c "echo $ZOMBIES | xargs kill -9" 2>/dev/null
  fi

  # Kill claude/acpx processes running longer than 30 min (stuck)
  # Catch both claude and claude-agent-acp (parent node process)
  STUCK=$(docker exec "$WB_CONTAINER" sh -c 'ps -o pid,etimes,rss,args 2>/dev/null | grep -E "claude-agent-acp|/claude " | grep -v grep | awk "\$2 > 1800 {print \$1}"' 2>/dev/null)
  if [ -n "$STUCK" ]; then
    SCOUNT=$(echo "$STUCK" | wc -w)
    # Memory before kill (KB → MB)
    MEM_KB=$(docker exec "$WB_CONTAINER" sh -c 'ps -o pid,rss 2>/dev/null | grep -E "'"$(echo $STUCK | tr ' ' '|')"'" | awk "{s+=\$2} END {print s+0}"' 2>/dev/null)
    MEM_MB=$(( ${MEM_KB:-0} / 1024 ))

    log "WARN: killing $SCOUNT stuck claude/acpx processes (>30min, ~${MEM_MB}MB) in $WB_CONTAINER"

    # SIGTERM first
    docker exec "$WB_CONTAINER" sh -c "echo $STUCK | xargs kill 2>/dev/null" 2>/dev/null
    sleep 3

    # Check survivors → SIGKILL
    SURVIVORS=$(docker exec "$WB_CONTAINER" sh -c "echo $STUCK | xargs -n1 sh -c 'kill -0 \$1 2>/dev/null && echo \$1' _" 2>/dev/null)
    if [ -n "$SURVIVORS" ]; then
      SURV_COUNT=$(echo "$SURVIVORS" | wc -w)
      log "WARN: $SURV_COUNT processes survived SIGTERM, sending SIGKILL"
      docker exec "$WB_CONTAINER" sh -c "echo $SURVIVORS | xargs kill -9" 2>/dev/null
    fi

    # Alert with cooldown
    if can_alert "claude_stuck"; then
      save_alert "claude_stuck"
      tg "🟡 <b>openclaw-tg-bot</b>: убил <code>$SCOUNT</code> зависших claude процессов в <code>$WB_CONTAINER</code> (~<code>${MEM_MB}MB</code> освобождено)"
    fi
  fi
fi

log "check complete (syn=$SYN_RECV conns=$TOTAL_CONNS ssh_fails=$SSH_FAILS)"
