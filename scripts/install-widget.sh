#!/data/data/com.termux/files/usr/bin/bash
set -e
mkdir -p "$HOME/.shortcuts"
install -m 700 "$(dirname "$0")/youtube-summarizer-widget.sh" "$HOME/.shortcuts/YouTube Summarizer"
echo "Installed Termux:Widget shortcut: YouTube Summarizer"
