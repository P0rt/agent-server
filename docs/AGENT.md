# AGENT.md — openclaw-tg-bot server

> Server reference for Claude Code. Last updated: 2026-02-24.

---

## What is this server

A VPS running **OpenClaw** — an AI agent connected to Telegram (and WhatsApp).
Hostname: `openclaw-tg-bot`
OS: Ubuntu 24.04 LTS, Linux 6.8.0-90-generic
RAM: 3.7 GB / Disk: 38 GB (~35% used)

---

## Architecture

```
Telegram (@p00rt / Sergei Parfenov)
        │
        ▼
OpenClaw Bot (Docker container)
  ghcr.io/openclaw/openclaw:latest
  ports: 127.0.0.1:18789-18790 (gateway), 0.0.0.0:3334 (voice webhook)
        │
        ├── Claude (Anthropic API — OAuth, serzhooo@gmail.com, org: Symptomato)
        ├── Voice Call (OpenAI Realtime speech-to-speech via Twilio)
        │     Twilio (g711_ulaw) ↔ OpenAI Realtime (gpt-realtime-mini)
        │     Public: https://voicesegozavr.com/voice/webhook
        ├── OpenAI Whisper (voice messages)
        ├── OpenAI Image Gen (DALL-E)
        ├── Notion (integration)
        └── Web Search (BSA key)
```

---

## File structure

```
/root/
├── AGENT.md                          ← this file
├── backup-workspace.sh               ← auto-backup cron script
└── .openclaw/                        ← OpenClaw data
    ├── openclaw.json                 ← main config (contains secrets!)
    ├── openclaw.json.bak.*           ← auto-backups of config
    ├── agents/
    │   └── main/
    │       ├── agent/auth.json       ← agent auth token
    │       └── sessions/             ← session history
    ├── workspace/                    ← agent workspace (git repo → GitHub)
    │   ├── AGENT.md                  ← this file (tracked)
    │   ├── AGENTS.md                 ← agent instructions
    │   ├── SOUL.md                   ← agent personality
    │   ├── IDENTITY.md               ← name, vibe, emoji
    │   ├── USER.md                   ← info about the user
    │   ├── BOOTSTRAP.md              ← initial setup guide
    │   ├── HEARTBEAT.md              ← periodic tasks
    │   ├── TOOLS.md                  ← tool-specific notes
    │   └── .git/                     ← git, remote: P0rt/openclaw-workspace
    ├── credentials/
    │   ├── telegram-pairing.json     ← Telegram pairing data
    │   └── whatsapp/                 ← WhatsApp session data
    ├── telegram/                     ← Telegram state (offset)
    ├── canvas/index.html             ← web UI
    ├── identity/device.json          ← device ID
    ├── cron/jobs.json                ← cron jobs (empty)
    └── logs/config-audit.jsonl       ← config change audit log
```

---

## Systemd services

| Service | Status |
|---------|--------|
| docker.service | running |
| containerd.service | running |
| ssh.service | running |
| fail2ban.service | running |
| cron.service | running |
| unattended-upgrades | running |

OpenClaw runs as a **Docker container**, not a systemd service.

---

## Docker

```
Container:  openclaw-gateway
Image:      ghcr.io/openclaw/openclaw:latest
Ports:      127.0.0.1:18789-18790 -> 18789-18790/tcp
            0.0.0.0:3334 -> 3334/tcp (voice webhook + media stream WS)
Volumes:    /srv/openclaw/extensions-override/voice-call:/app/extensions/voice-call
Status:     Up (auto-restart)
```

```bash
docker ps                                            # status
docker restart openclaw-gateway                      # restart
docker logs openclaw-gateway -f --tail=50            # live logs
docker pull ghcr.io/openclaw/openclaw:latest         # update image
```

---

## Telegram integration

- Bot connected via token in `openclaw.json`
- Paired with: **Sergei Parfenov** (@p00rt, ID: 94046463)
- dmPolicy: `pairing` (paired users only)
- groupPolicy: `allowlist`
- streamMode: `partial` (streamed responses)

---

## Backups

**What is backed up:**
- `/srv/openclaw/.openclaw/workspace/` — agent workspace (memory, identity, instructions)
- `/root/AGENT.md` — this file

**What is NOT backed up (gitignored):**
- `.openclaw/` runtime dir inside workspace
- `openclaw.json` (contains secrets — do not commit)

**Setup:**
- [x] SSH key generated: `/root/.ssh/id_ed25519`
- [x] Public key added to GitHub
- [x] Remote: `git@github.com:P0rt/openclaw-workspace.git`
- [x] Initial commit: 2026-02-23
- [x] Auto-push: cron every 6 hours via `/root/backup-workspace.sh`

---

## Sensitive data (never commit!)

`/srv/openclaw/.openclaw/openclaw.json` contains:
- `gateway.auth.token` — gateway auth token
- `channels.telegram.botToken` — Telegram bot token
- `plugins.entries.voice-call.config.twilio.accountSid/authToken` — Twilio credentials
- `plugins.entries.voice-call.config.streaming.openaiApiKey` — OpenAI key (Realtime API)
- `skills.entries.openai-whisper-api.apiKey` — OpenAI key
- `skills.entries.notion.apiKey` — Notion key
- `tools.web.search.apiKey` — web search key

`/srv/openclaw/.env` contains env vars referenced by config: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `OPENAI_API_KEY`

---

## Useful commands

```bash
# Container status
docker ps

# OpenClaw logs
docker logs openclaw-gateway -f --tail=50

# Update OpenClaw
docker pull ghcr.io/openclaw/openclaw:latest
docker restart openclaw-gateway

# Reconfigure
openclaw configure

# View config
cat /root/.openclaw/openclaw.json

# Agent workspace
ls /root/.openclaw/workspace/

# Manual backup
/root/backup-workspace.sh
```
