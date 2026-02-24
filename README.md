# Agent Server

OpenClaw AI agent on a VPS with Telegram integration and voice calls via OpenAI Realtime + Twilio.

## Architecture

```
Telegram (user)
    │
    ▼
OpenClaw (Docker container)
    ├── Claude Sonnet 4.6 (main agent brain)
    ├── Voice Call (OpenAI Realtime speech-to-speech via Twilio)
    │     Twilio (g711_ulaw) ↔ OpenAI Realtime (gpt-realtime-mini)
    │     Caddy reverse proxy → https://YOUR_DOMAIN/voice/webhook
    ├── OpenAI Whisper (voice message transcription)
    ├── OpenAI DALL-E (image generation)
    ├── Notion (workspace integration)
    └── Brave Search (web search)
```

### Voice Call Flow

```
1. User in Telegram: "Call +7xxx, ask about the meeting"
2. Agent (Claude) → voice_call tool with instructions
3. OpenAI Realtime conducts the call autonomously (<500ms latency)
4. After call: transcript → Agent → summary to Telegram
```

## Prerequisites

- Ubuntu 22.04+ VPS (tested on 24.04), 2+ GB RAM
- Docker + Docker Compose
- Domain pointed to server IP (for voice webhook HTTPS)
- Caddy (auto-HTTPS) or nginx with certbot
- Accounts: Anthropic, OpenAI, Twilio, Brave Search, Telegram Bot

## Quick Start

### 1. Clone

```bash
git clone git@github.com:P0rt/agent-server.git /root/agent-server
cd /root/agent-server
```

### 2. Install Docker

```bash
curl -fsSL https://get.docker.com | sh
systemctl enable docker
```

### 3. Install Caddy (reverse proxy for voice webhook)

```bash
apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install caddy
```

Edit `/etc/caddy/Caddyfile` (or copy the included one):
```
your-domain.com {
    reverse_proxy localhost:3334
}
```

```bash
systemctl enable caddy
systemctl restart caddy
```

### 4. Install OpenClaw CLI

```bash
# Install the openclaw CLI tool
curl -fsSL https://get.openclaw.dev | bash
```

### 5. Configure Environment

```bash
# Copy and fill in secrets
cp .env.example /srv/openclaw/.env
nano /srv/openclaw/.env

# Copy config template
mkdir -p /srv/openclaw/.openclaw
cp config/openclaw.json.example /srv/openclaw/.openclaw/openclaw.json
nano /srv/openclaw/.openclaw/openclaw.json
# Replace: YOUR_TELEGRAM_USER_ID, GENERATE_RANDOM_TOKEN_HERE, YOUR_DOMAIN

# Copy docker-compose
cp docker-compose.yml /srv/openclaw/docker-compose.yml

# Copy voice-call extension override
cp -r extensions-override /srv/openclaw/extensions-override
```

### 6. Set Permissions

```bash
# OpenClaw runs as UID 1001 inside the container
useradd -u 1001 -r -s /bin/false claudeops 2>/dev/null || true
chown -R 1001:1001 /srv/openclaw/.openclaw
```

### 7. Start Container

```bash
cd /srv/openclaw
docker compose pull
docker compose up -d
```

Verify:
```bash
docker logs openclaw-gateway --tail=20
# Should see:
# [gateway] listening on ws://127.0.0.1:18789
# [voice-call] Media streaming initialized (with conversation support)
# [telegram] starting provider (@your_bot)
```

### 8. Pair Telegram Bot

Open your Telegram bot and send `/start`. The bot will ask for pairing.

### 9. Setup Twilio Webhook

In Twilio Console → Phone Numbers → your number:
- Voice webhook URL: `https://YOUR_DOMAIN/voice/webhook`
- Method: POST

### 10. Setup Monitoring (optional)

```bash
# Copy alert bot credentials
cp .alert-env.example /root/.alert-env
nano /root/.alert-env

# Create log directory
mkdir -p /root/.openclaw/logs

# Install crontab
crontab -e
# Add:
# */5 * * * * /root/agent-server/scripts/monitor.sh >> /root/.openclaw/logs/monitor.log 2>&1
# 0 8 * * * source /root/.alert-env && python3 /root/agent-server/scripts/digest.py >> /root/.openclaw/logs/digest.log 2>&1
# 0 19 * * * source /root/.alert-env && python3 /root/agent-server/scripts/digest.py >> /root/.openclaw/logs/digest.log 2>&1
```

## File Structure

```
agent-server/
├── README.md                          ← this file
├── docker-compose.yml                 ← container config
├── Caddyfile                          ← reverse proxy (voice webhook HTTPS)
├── .env.example                       ← env vars template
├── .alert-env.example                 ← alert bot credentials template
├── config/
│   └── openclaw.json.example          ← OpenClaw config template
├── extensions-override/
│   └── voice-call/                    ← custom voice-call extension
│       ├── index.ts                   ← tool schema + execute
│       ├── openclaw.plugin.json       ← plugin manifest
│       └── src/
│           ├── providers/
│           │   └── realtime-conversation.ts  ← OpenAI Realtime WS provider
│           ├── media-stream.ts        ← bidirectional Twilio ↔ OpenAI audio
│           ├── webhook.ts             ← HTTP server + media stream wiring
│           ├── manager.ts             ← call state management
│           ├── config.ts              ← config schema
│           └── types.ts               ← type definitions
├── scripts/
│   ├── monitor.sh                     ← watchdog + threat detector (cron 5min)
│   ├── digest.py                      ← LLM server digest (cron 2x/day)
│   └── backup-workspace.sh            ← workspace git backup (cron 6h)
└── docs/
    ├── CLAUDE.md                      ← Claude Code context (for AI-assisted server management)
    └── AGENT.md                       ← full server reference
```

## Server Layout (after deployment)

```
/srv/openclaw/
├── docker-compose.yml
├── .env                               ← secrets (never commit!)
├── .openclaw/
│   ├── openclaw.json                  ← main config
│   ├── workspace/                     ← agent workspace (backed up to GitHub)
│   ├── voice-calls/                   ← call logs (auto-created)
│   └── ...                            ← runtime data (sessions, credentials)
└── extensions-override/
    └── voice-call/                    ← volume-mounted into container
```

## Common Operations

```bash
# Container management
docker logs openclaw-gateway -f --tail=50          # live logs
docker restart openclaw-gateway                     # restart (apply config/code changes)
docker compose pull && docker compose up -d         # update OpenClaw

# Voice call debugging
docker logs openclaw-gateway -f 2>&1 | grep -E '\[voice-call\]|\[Realtime|\[Media'

# Config
nano /srv/openclaw/.openclaw/openclaw.json          # edit config
docker restart openclaw-gateway                      # apply changes

# Extension development
nano /srv/openclaw/extensions-override/voice-call/src/providers/realtime-conversation.ts
docker restart openclaw-gateway                      # TypeScript loaded directly, no build step
```

## Claude Code Integration

This server is managed via Claude Code SSH sessions. The `docs/CLAUDE.md` file is loaded as project context, giving Claude full awareness of server architecture, paths, and conventions.

To connect:
```bash
ssh -p 2222 root@SERVER_IP
claude                                              # starts Claude Code session
```

Claude Code reads `CLAUDE.md` on startup and can manage the server, edit extension code, restart containers, and debug issues.

## Security Notes

- All secrets via env vars (`${VAR}` syntax in config) — never hardcoded
- Docker container runs as non-root (UID 1001) with `no-new-privileges` and dropped capabilities
- Gateway binds to localhost only (127.0.0.1:18789)
- Voice webhook on localhost (127.0.0.1:3334), Caddy proxies with auto-HTTPS
- SSH on non-standard port, key-only auth, fail2ban with 24h bans
- Memory limit 1.5GB on container to protect 3.7GB host
