# Termux YouTube Summarizer

A localhost-only mobile web app that inspects YouTube captions, queues transcript jobs, and summarizes videos and their public comments with Pi's current default model.

## Run

```sh
npm install
npm start
```

Open <http://127.0.0.1:8765>. The server exits after 30 idle minutes and binds only to localhost.

## Termux:Widget

Run `npm run setup-widget` to install `~/.shortcuts/YouTube Summarizer`. Refresh Termux:Widget, then tap the shortcut. It reuses a healthy server or starts one before opening the browser.

## Data

Each persistent job is under `data/jobs/<job-id>/`, including source `json3`, timestamped and clean transcripts, thumbnail, Markdown, and offline HTML. On-demand comment analysis adds a normalized comment snapshot, report, offline HTML, and analysis metadata. It examines complete threads in YouTube's top-comment order, with a hard limit of 10,000 comments and an explicit coverage warning when truncated. Logs are under `data/logs/` and never contain transcript, comment, or model response text.

Run tests with `npm test`.
