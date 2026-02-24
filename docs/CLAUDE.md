# Claude Code — openclaw-tg-bot

This is a VPS running **OpenClaw**: an AI agent platform connected to Telegram.
For full server reference see `AGENT.md`.

## Key paths

| Path | Description |
|------|-------------|
| `/srv/openclaw/.openclaw/openclaw.json` | Main config — contains all secrets, never commit |
| `/srv/openclaw/.openclaw/workspace/` | Agent workspace — git repo → github.com/P0rt/openclaw-workspace |
| `/root/.openclaw/logs/` | Logs (monitor.log, backup.log, config-audit.jsonl) |
| `/root/backup-workspace.sh` | Manual backup trigger |
| `/root/monitor.sh` | Watchdog script — checks container + port, restarts if needed |
| `/root/.ssh/id_ed25519` | SSH key for GitHub |

## OpenClaw (Docker)

```bash
docker ps                                         # status
docker logs openclaw-gateway -f --tail=50         # live logs
docker restart openclaw-gateway                   # restart
docker pull ghcr.io/openclaw/openclaw:latest      # update image
openclaw configure                                # reconfigure via CLI
```

OpenClaw runs as container `openclaw-gateway`, port `127.0.0.1:18789-18790`.
It is **not** a systemd service — manage it via `docker`.

## Workspace git

```bash
git -C /root/.openclaw/workspace status
git -C /root/.openclaw/workspace log --oneline -10
git -C /root/.openclaw/workspace push origin master
/root/backup-workspace.sh                         # commit + push if changed
```

Auto-push runs every 6h via cron.

## Rules

- **Never commit `/srv/openclaw/.openclaw/openclaw.json`** — it contains API keys and bot tokens
- **Always use absolute paths** — working directory can shift between bash calls
- When editing OpenClaw config use `openclaw configure`, not manual JSON edits — it maintains `.bak` history
- To apply config changes: `docker restart openclaw-gateway`
- No swap configured — be mindful of memory (3.7 GB total)

## Telegram integration

- Bot paired with @p00rt (Sergei Parfenov, ID 94046463)
- dmPolicy: `pairing` — only paired users can DM the bot
- To check Telegram state: `cat /root/.openclaw/telegram/update-offset-default.json`
- Bot token is in `openclaw.json → channels.telegram.botToken`

## Monitoring

All alerts → @pepe_alertss_bot → @p00rt (chat_id 94046463).

**1. Watchdog + threat detector — `/root/monitor.sh` every 5 min (no LLM)**
- Docker daemon + container status + port 18789 → auto-restart + 🟡/🔴 alert
- Immediate threat alerts (no cooldown spam — 30 min per threat type):
  - 🚨 SYN flood: SYN_RECV > 50
  - 🚨 Connection flood: established > 300
  - 🚨 IP flood: single IP with > 20 connections
  - 🚨 SSH brute-force: > 15 failed auths in 5 min
- State/cooldown file: `/root/.openclaw/logs/threat-state.json`

**2. Daily digest — `/root/digest.py` at 08:00 and 19:00 UTC (LLM-powered)**
- Collects: all docker containers, stats, logs, network, journal errors
- Claude Sonnet 4.6 analyzes → 📊 report in Russian to Telegram
- API key read at runtime from `~/.claude.json → primaryApiKey`

```bash
tail -f /root/.openclaw/logs/monitor.log   # watchdog + threat log
tail -f /root/.openclaw/logs/digest.log    # digest log
cat /root/.openclaw/logs/threat-state.json # last threat timestamps
```

## Voice Call (OpenAI Realtime speech-to-speech)

Voice call extension uses **OpenAI Realtime API** for autonomous phone conversations.
Flow: Telegram → Пепе (Claude) → `voice_call` tool with instructions → OpenAI Realtime conducts call → transcript → Пепе → report to Telegram.

**Architecture:**
```
Twilio (g711_ulaw) ↔ OpenAI Realtime (gpt-realtime-mini, voice: coral)
                        ↕
                   end_call tool → hangup
                   transcript → tool result → Пепе
```

**Key paths:**
| Path | Description |
|------|-------------|
| `/srv/openclaw/extensions-override/voice-call/` | Modified extension (volume-mounted into container) |
| `/srv/openclaw/extensions-override/voice-call/index.ts` | Tool schema + execute (voice_call tool) |
| `/srv/openclaw/extensions-override/voice-call/src/providers/realtime-conversation.ts` | OpenAI Realtime WS provider |
| `/srv/openclaw/extensions-override/voice-call/src/media-stream.ts` | Bidirectional Twilio ↔ OpenAI audio |
| `/srv/openclaw/extensions-override/voice-call/src/webhook.ts` | HTTP server + media stream wiring |
| `/srv/openclaw/extensions-override/voice-call/src/config.ts` | Config schema (streaming section) |

**Config** (in `openclaw.json → plugins.entries.voice-call.config`):
- `streaming.realtimeModel`: `gpt-realtime-mini` (default)
- `streaming.realtimeVoice`: `coral` (female, default)
- `streaming.silenceDurationMs`: 600 (VAD pause before turn-taking)
- `streaming.vadThreshold`: 0.5
- `publicUrl`: `https://voicesegozavr.com/voice/webhook`
- Webhook port: 3334, bound to 0.0.0.0

**Debugging:**
```bash
# Voice call logs (filter from container logs)
docker logs openclaw-gateway -f --tail=100 2>&1 | grep -E '\[voice-call\]|\[RealtimeConversation\]|\[MediaStream\]'

# Key log patterns:
# [RealtimeConversation] WebSocket connected (model: ..., voice: ...)  ← session start
# [RealtimeConversation] session.updated — voice and tools active      ← ready
# [RealtimeConversation] User: ...                                     ← user transcript
# [RealtimeConversation] Assistant: ...                                ← AI response
# [RealtimeConversation] AI called end_call — hanging up               ← AI ends call
# [MediaStream] AI-initiated hangup for ...                            ← WS closing (5s delay)
# [voice-call] Conversation complete for ...: N entries                ← transcript collected
```

**Docker volume mount** (in `/srv/openclaw/docker-compose.yml`):
```yaml
- /srv/openclaw/extensions-override/voice-call:/app/extensions/voice-call
```

**After editing extension files:** `docker restart openclaw-gateway`

## Active skills / integrations

- OpenAI Realtime — voice calls (speech-to-speech, via Twilio)
- OpenAI Whisper — voice transcription
- OpenAI Image Gen — DALL-E image generation
- Notion — workspace integration
- Web Search — via BSA API key
