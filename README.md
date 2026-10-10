# Termux YouTube Summarizer

A localhost-only mobile web app that inspects YouTube captions, queues transcript jobs, and summarizes videos and their public comments with Pi's current default model.

## Run

```sh
npm install
npm start
```

Open <http://127.0.0.1:8765>. The server exits after 30 idle minutes and binds only to localhost.

## Termux:Widget

Run `npm run setup-widget` to install `~/.shortcuts/tasks/YouTube Summarizer` as a background task (and remove the old terminal shortcut). Refresh Termux:Widget, or remove and re-add the widget, then tap the task. It reuses a healthy server or starts a detached Node process before opening the browser; no terminal or tmux session is needed. If startup fails, it does not open the browser; check `data/logs/server-YYYY-MM-DD.log` for details.

Android can still stop Termux in the background. If jobs are interrupted after switching apps or locking the screen, set Termux's battery usage to unrestricted in Android settings (the wording varies by phone).

## Summarizing comments independently

After inspecting a URL, choose **Summarize video** or **Analyze comments**. Comment analysis does not require captions or a video summary. The action is available when YouTube reports comments or the count is unknown; a reported count of zero disables it.

If a completed video summary exists, comment analysis uses it and the transcript as context. Otherwise, reports are explicitly labeled **comments-only** and attribute claims to commenters without verifying them against the video. A comments-only entry can later gain a video summary by inspecting the same URL and choosing a caption track. Existing comment reports stay unchanged until you explicitly refresh them; retries preserve the context used for their original snapshot.

Malformed or invalid structured comment analyses are automatically retried up to twice for the failed batch or synthesis step, without repeating validated checkpoints. The app unwraps valid JSON but does not guess repairs to malformed syntax. If recovery fails, it shows a friendly failure and preserves checkpoints for manual retry. The latest failed response and validation diagnostic are saved locally in the job’s `.comments-work/failed-model-response.json` (which may contain comment text); they are removed when the step succeeds or the job is deleted, and are not copied into published reports or general logs.

## Data

Each persistent job is under `data/jobs/<job-id>/`, including source `json3`, timestamped and clean transcripts, thumbnail, Markdown, and offline HTML. On-demand comment analysis adds a normalized comment snapshot, report, offline HTML, and analysis metadata. It examines complete threads in YouTube's top-comment order, with a hard limit of 10,000 comments and an explicit coverage warning when truncated. Logs are under `data/logs/` and never contain transcript, comment, or model response text.

Run tests with `npm test`.
