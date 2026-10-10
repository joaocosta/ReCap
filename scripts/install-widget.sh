#!/data/data/com.termux/files/usr/bin/bash
set -e
mkdir -p "$HOME/.shortcuts/tasks"
install -m 700 "$(dirname "$0")/youtube-summarizer-widget.sh" "$HOME/.shortcuts/tasks/YouTube Summarizer"
# Migrate the old terminal shortcut to a background task.
rm -f "$HOME/.shortcuts/YouTube Summarizer"
echo "Installed Termux:Widget background task: YouTube Summarizer"
echo "Refresh Termux:Widget (or remove and re-add it) to pick up the change."
