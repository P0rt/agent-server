#!/bin/bash
# Автобэкап workspace OpenClaw → GitHub
# Запускается по крону каждые 6 часов

set -e

WORKSPACE="/srv/openclaw/.openclaw/workspace"
LOG="/root/.openclaw/logs/backup.log"

cd "$WORKSPACE"

# Проверяем есть ли что коммитить
if git diff --quiet && git diff --cached --quiet && [ -z "$(git ls-files --others --exclude-standard)" ]; then
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) no changes" >> "$LOG"
  exit 0
fi

# Добавляем всё новое и изменённое (кроме .gitignore'd)
git add -A

# Коммит с датой
git commit -m "auto backup $(date -u +%Y-%m-%d\ %H:%M\ UTC)"

# Пуш
git push origin master

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) pushed ok" >> "$LOG"
