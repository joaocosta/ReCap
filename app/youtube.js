import fs from 'node:fs/promises';
import path from 'node:path';
import { canonicalizeYouTube, formatTime, run, technicalMessage } from './utils.js';

const YTDLP = ['-m', 'yt_dlp'];

async function attempt(args, timeoutMs, onSpawn) {
  let last;
  for (let i = 0; i < 2; i++) {
    last = await run('python', [...YTDLP, ...args], { timeoutMs, onSpawn });
    if (last.code === 0) return last;
    const details = `${last.stderr}\n${last.stdout}`;
    const networkFailure = last.timedOut || /timed? ?out|network|connection|temporary failure|remote end closed|HTTP Error (?:429|5\d\d)/i.test(details);
    if (!networkFailure || i === 1) break;
  }
  throw Object.assign(new Error(technicalMessage(last, 'YouTube request')), { technical: technicalMessage(last, 'YouTube request'), exitCode: last.code });
}

function trackChoices(meta) {
  const language = String(meta.language || '').toLowerCase();
  const choices = [];
  const add = (tracks, source) => {
    for (const [key, formats] of Object.entries(tracks || {})) {
      if (!Array.isArray(formats) || !formats.some(x => x.ext === 'json3')) continue;
      const name = formats.find(x => x.name)?.name || key;
      const translated = / from /i.test(name) || formats.some(f => /[?&]tlang=/.test(f.url || ''));
      choices.push({ id: `${source}:${key}`, source, key, language: key, label: `${name} — ${source === 'manual' ? 'manual' : 'automatic'}${translated ? ' (machine-translated)' : ''}`, translated });
    }
  };
  add(meta.subtitles, 'manual');
  add(meta.automatic_captions, 'automatic');
  const score = c => (c.source === 'manual' ? 0 : 10) + (c.translated ? 100 : 0) + (language && c.key.toLowerCase().startsWith(language.split('-')[0]) ? 0 : 20);
  choices.sort((a, b) => score(a) - score(b) || a.label.localeCompare(b.label));
  return choices;
}

export async function inspectYouTube(input, onSpawn) {
  const canonical = canonicalizeYouTube(input);
  const result = await attempt(['--dump-single-json', '--skip-download', '--no-playlist', '--no-warnings', canonical.url], 30_000, onSpawn);
  let m;
  try { m = JSON.parse(result.stdout); } catch { throw new Error('YouTube returned unreadable metadata.'); }
  if (m._type === 'playlist' || !m.id) throw new Error('Select a single public video, not a playlist.');
  if (m.is_live || m.live_status === 'is_live' || m.live_status === 'is_upcoming') throw new Error('Live and upcoming videos are not supported.');
  const captions = trackChoices(m);
  if (!captions.length) throw new Error('This video has no supported captions.');
  return {
    inspectId: crypto.randomUUID(), url: canonical.url, videoId: canonical.videoId,
    title: m.title || 'Untitled video', duration: Number(m.duration) || 0,
    durationText: formatTime(m.duration), thumbnailUrl: m.thumbnail || '', uploader: m.uploader || m.channel || '',
    uploadDate: m.upload_date || '', originalLanguage: m.language || '', captions,
    defaultCaptionId: captions[0].id
  };
}

function cueText(event) {
  return (event.segs || []).map(s => s.utf8 || '').join('').replace(/\s+/g, ' ').trim();
}

export function cleanJson3(raw) {
  const parsed = JSON.parse(raw), cues = [];
  let previous = '';
  for (const e of parsed.events || []) {
    let text = cueText(e);
    if (!text) continue;
    if (text === previous) continue;
    // Remove only exact rolling-caption prefix overlap.
    if (previous && text.startsWith(previous) && text.length > previous.length) text = text.slice(previous.length).trim();
    if (!text) continue;
    cues.push({ start: (Number(e.tStartMs) || 0) / 1000, duration: (Number(e.dDurationMs) || 0) / 1000, text });
    previous = cueText(e);
  }
  const timestamped = cues.map(c => `[${formatTime(c.start)}] ${c.text}`).join('\n') + '\n';
  const paragraphs = []; let current = '', lastEnd = 0;
  for (const c of cues) {
    if (current && (c.start - lastEnd > 8 || current.length + c.text.length > 900)) { paragraphs.push(current); current = ''; }
    current += `${current ? ' ' : ''}${c.text}`; lastEnd = c.start + c.duration;
  }
  if (current) paragraphs.push(current);
  return { cues, timestamped, clean: paragraphs.join('\n\n') + '\n' };
}

export async function downloadCaption(jobDir, url, choice, onSpawn) {
  for (const f of await fs.readdir(jobDir)) if (f.endsWith('.json3')) await fs.rm(path.join(jobDir, f));
  const escaped = choice.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const args = ['--skip-download', '--no-playlist', '--no-warnings', '--sub-format', 'json3', '--sub-langs', `^${escaped}$`, '-o', path.join(jobDir, 'caption.%(ext)s')];
  args.push(choice.source === 'manual' ? '--write-subs' : '--write-auto-subs', url);
  await attempt(args, 60_000, onSpawn);
  const file = (await fs.readdir(jobDir)).find(f => f.endsWith('.json3'));
  if (!file) throw new Error('The selected caption track could not be downloaded.');
  const source = path.join(jobDir, 'source-caption.json3');
  await fs.rename(path.join(jobDir, file), source);
  const raw = await fs.readFile(source, 'utf8');
  const cleaned = cleanJson3(raw);
  await fs.writeFile(path.join(jobDir, 'transcript-timestamped.txt'), cleaned.timestamped);
  await fs.writeFile(path.join(jobDir, 'transcript-clean.txt'), cleaned.clean);
  return cleaned;
}

export async function downloadThumbnail(jobDir, thumbnailUrl) {
  if (!thumbnailUrl) return null;
  let u; try { u = new URL(thumbnailUrl); } catch { return null; }
  if (u.protocol !== 'https:' || !/(^|\.)(ytimg\.com|googleusercontent\.com)$/.test(u.hostname)) return null;
  const response = await fetch(u, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) return null;
  const data = Buffer.from(await response.arrayBuffer());
  if (data.length > 5_000_000) return null;
  const type = response.headers.get('content-type') || 'image/jpeg';
  const ext = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : 'jpg';
  await fs.writeFile(path.join(jobDir, `thumbnail.${ext}`), data);
  return `thumbnail.${ext}`;
}
