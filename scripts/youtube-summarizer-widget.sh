#!/data/data/com.termux/files/usr/bin/bash
set -u
APP="$HOME/src/yt"
URL="http://127.0.0.1:8765"
if ! curl -fsS --max-time 2 "$URL/health" >/dev/null 2>&1; then
  cd "$APP" || exit 1
  mkdir -p "$APP/data/logs"
  nohup npm start >>"$APP/data/logs/server-$(date +%F).log" 2>&1 </dev/null &
  for _ in $(seq 1 30); do
    curl -fsS --max-time 1 "$URL/health" >/dev/null 2>&1 && break
    sleep 0.3
  done
fi
termux-open-url "$URL/"
