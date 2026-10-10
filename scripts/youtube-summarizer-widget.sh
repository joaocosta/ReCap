#!/data/data/com.termux/files/usr/bin/bash
set -eu
# Widgets do not necessarily inherit an interactive shell's environment.
export PATH="/data/data/com.termux/files/usr/bin:$PATH"
APP="$HOME/src/yt"
URL="http://127.0.0.1:8765"
LOG="$APP/data/logs/server-$(date +%F).log"

healthy() {
  curl -fsS --max-time 2 "$URL/health" >/dev/null 2>&1
}

if ! healthy; then
  cd "$APP"
  mkdir -p "$APP/data/logs"
  # Run Node directly, in a separate session, with no terminal-owned streams.
  # nohup alone does not separate the server from the terminal's process group.
  nohup setsid node "$APP/app/server.js" >>"$LOG" 2>&1 </dev/null &
  ready=false
  for _ in $(seq 1 60); do
    if healthy; then
      ready=true
      break
    fi
    sleep 0.5
  done
  if [ "$ready" != true ]; then
    message="YouTube Summarizer failed to start. See $LOG"
    printf '%s\n' "$message" >&2
    if command -v termux-toast >/dev/null 2>&1; then
      termux-toast -l "$message" || true
    fi
    exit 1
  fi
fi
termux-open-url "$URL/"
