#!/usr/bin/env python3
"""
Hourly server digest — collects logs, asks Claude to analyze, sends to Telegram.
"""

import json, subprocess, urllib.request, urllib.parse, datetime, sys

# --- Config ---
# Alert bot credentials — set in /root/.alert-env (sourced by cron wrapper)
import os
CLAUDE_CONFIG = "/root/.claude.json"
BOT_TOKEN     = os.environ.get("ALERT_BOT_TOKEN", "")
CHAT_ID       = os.environ.get("ALERT_CHAT_ID", "")
LOG_FILE      = "/root/.openclaw/logs/digest.log"
MODEL         = "claude-sonnet-4-6"
MAX_LOG_LINES = 80


def log(msg):
    ts = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    line = f"{ts} {msg}"
    print(line)
    with open(LOG_FILE, "a") as f:
        f.write(line + "\n")


def run(cmd):
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    return (r.stdout + r.stderr).strip()


def tg(text):
    url = f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage"
    for chunk in [text[i:i+4000] for i in range(0, len(text), 4000)]:
        data = urllib.parse.urlencode({
            "chat_id": CHAT_ID,
            "text": chunk,
            "parse_mode": "HTML"
        }).encode()
        with urllib.request.urlopen(urllib.request.Request(url, data=data), timeout=15) as resp:
            r = json.load(resp)
            if not r.get("ok"):
                log(f"TG error: {r}")


def call_claude(api_key, prompt):
    payload = json.dumps({
        "model": MODEL,
        "max_tokens": 1500,
        "messages": [{"role": "user", "content": prompt}]
    }).encode()
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=payload,
        headers={
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json"
        }
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.load(resp)["content"][0]["text"]


def collect():
    s = {}

    # --- All Docker containers (not just openclaw) ---
    s["docker_containers"] = run(
        "docker ps -a --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}\t{{.Ports}}'"
    )

    # --- Per-container resource usage ---
    s["docker_stats"] = run(
        "docker stats --no-stream --format "
        "'{{.Name}}: cpu={{.CPUPerc}} mem={{.MemUsage}} net={{.NetIO}} block={{.BlockIO}}'"
    ) or "(no containers running)"

    # --- OpenClaw logs ---
    s["openclaw_logs"] = run(
        f"docker logs openclaw-gateway --since 1h 2>&1 | tail -n {MAX_LOG_LINES}"
    ) or "(no logs)"

    # --- System resources ---
    s["system_resources"] = "\n".join([
        "Memory: " + run("free -h | awk '/Mem:/{print $2\" total, \"$3\" used, \"$4\" free\"}'"),
        "Swap:   " + run("free -h | awk '/Swap:/{print $2\" total, \"$3\" used\"}'"),
        "Disk:   " + run("df -h / | awk 'NR==2{print $2\" total, \"$3\" used, \"$5\" use%\"}'"),
        "Load:   " + run("uptime | awk -F'load average:' '{print $2}'"),
        "Uptime: " + run("uptime -p"),
    ])

    # --- Network: established connections detail ---
    s["established_connections"] = run(
        "ss -tnp state established 2>/dev/null | awk 'NR>1{print $4, \"→\", $5, $6}' | head -20"
    ) or "(none)"

    # --- Network: DDoS / connection flood detection ---
    tcp_total   = run("ss -s | awk '/TCP:/{print $0}'")
    tcp_estab   = run("ss -tn state established 2>/dev/null | wc -l")
    tcp_timewait = run("ss -tn state time-wait 2>/dev/null | wc -l")
    tcp_synrecv  = run("ss -tn state syn-recv 2>/dev/null | wc -l")
    # Top 10 source IPs by connection count
    top_ips = run(
        "ss -tn state established 2>/dev/null | awk 'NR>1{print $5}' "
        "| cut -d: -f1 | sort | uniq -c | sort -rn | head -10"
    ) or "(none)"
    # fail2ban recent bans
    fail2ban = run("fail2ban-client status 2>/dev/null | head -5") or "(fail2ban not available)"
    fail2ban_log = run(
        "journalctl -u fail2ban --since '1 hour ago' --no-pager -q 2>/dev/null | tail -10"
    ) or "(no events)"
    # SSH brute-force attempts
    ssh_fails = run(
        "journalctl _SYSTEMD_UNIT=ssh.service --since '1 hour ago' --no-pager -q 2>/dev/null "
        "| grep -i 'invalid\\|failed\\|error' | wc -l"
    )

    s["network_security"] = "\n".join([
        f"TCP stats:      {tcp_total}",
        f"Established:    {tcp_estab} connections",
        f"TIME_WAIT:      {tcp_timewait}",
        f"SYN_RECV:       {tcp_synrecv}  ← >50 может быть SYN flood",
        f"Top source IPs: \n{top_ips}",
        f"SSH failed auth (1h): {ssh_fails}",
        f"fail2ban status:\n{fail2ban}",
        f"fail2ban events (1h):\n{fail2ban_log}",
    ])

    # --- System errors ---
    s["system_errors"] = run(
        "journalctl -p err --since '1 hour ago' --no-pager -q 2>/dev/null | tail -20"
    ) or "(none)"

    # --- Monitor & backup events ---
    s["monitor_log"]  = run("tail -n 15 /root/.openclaw/logs/monitor.log 2>/dev/null") or "(empty)"
    s["backup_log"]   = run("tail -n 5 /root/.openclaw/logs/backup.log 2>/dev/null")   or "(empty)"

    return s


def build_prompt(sections, now):
    lines = [
        "You are monitoring server 'openclaw-tg-bot' (OpenClaw AI agent + Telegram bot).",
        f"Report time: {now} UTC",
        "",
        "Write a terse server status report. Output plain Telegram HTML only.",
        "Style: Teenage Engineering — minimal, technical, no fluff, no emoji, no box-drawing chars.",
        "",
        "RULES:",
        "- Section headers: <b>CAPS</b>",
        "- Values: <code>value</code>",
        "- Warnings/errors: <b>!!</b> prefix",
        "- NO separator lines (no ─── or --- or ===)",
        "- NO emoji at all",
        "- Blank line between sections",
        "- Lowercase labels, CAPS for status values: OK / WARN / CRIT",
        "- Max 35 lines. Cut anything that is normal/expected.",
        "- Language: Russian for descriptions, English for technical terms",
        "",
        "EXACT FORMAT:",
        "",
        "<b>OPENCLAW-TG-BOT</b>  {DD MON YYYY}  <code>{HH:MM} UTC</code>",
        "",
        "<b>STATUS</b>  OK",
        "",
        "<b>CONTAINERS</b>",
        "openclaw-gateway  <code>up 22m</code>  cpu <code>0.07%</code>  ram <code>359mb</code>",
        "",
        "<b>RESOURCES</b>",
        "cpu <code>0.07%</code>  load <code>0.14 0.15 0.12</code>",
        "mem <code>1.5/3.7G</code> <code>40%</code>  disk <code>13/38G</code> <code>35%</code>",
        "uptime <code>3d 5h</code>",
        "",
        "<b>NETWORK</b>",
        "estab <code>5</code>  syn_recv <code>1</code>  time_wait <code>3</code>",
        "ssh fails <code>201/h</code>",
        "fail2ban <code>3</code> banned",
        "active sessions: <code>79.152.30.156</code> ssh x2  <code>176.120.22.47</code> ssh x1",
        "",
        "<b>EVENTS</b>",
        "<code>16:09</code> openclaw-gateway restart (sigterm) — ok",
        "",
        "<b>!! {конкретная проблема и что делать}</b>",
        "",
        "OMIT any section where there is nothing notable.",
        "OMIT the !! block entirely if STATUS is OK.",
        "For NETWORK active sessions: identify type (ssh/api/etc) and group by IP.",
        "For threats: exact numbers, no vague wording.",
    ]
    for title, content in sections.items():
        lines += [f"=== {title} ===", content, ""]
    return "\n".join(lines)


def main():
    log("digest started")

    try:
        config = json.load(open(CLAUDE_CONFIG))
        api_key = config.get("primaryApiKey", "")
        if not api_key:
            raise ValueError("primaryApiKey not found in ~/.claude.json")
    except Exception as e:
        log(f"ERROR loading API key: {e}")
        tg(f"🔴 <b>digest error</b>: {e}")
        sys.exit(1)

    now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M")

    try:
        sections = collect()
        prompt = build_prompt(sections, now)
        log(f"data collected, calling {MODEL}")
        report = call_claude(api_key, prompt)
        log("response received, sending to Telegram")
        tg(f"📊 <b>Hourly digest</b> — {now} UTC\n\n{report}")
        log("digest sent OK")
    except Exception as e:
        log(f"ERROR: {e}")
        tg(f"🔴 <b>digest script error</b>: <code>{e}</code>")
        sys.exit(1)


if __name__ == "__main__":
    main()
