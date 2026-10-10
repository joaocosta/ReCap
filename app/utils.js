import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const JOBS_DIR = path.join(ROOT, 'data', 'jobs');
export const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'not_summarized']);

export function canonicalizeYouTube(input) {
  let u;
  try { u = new URL(String(input).trim()); } catch { throw new Error('Enter a valid YouTube URL.'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Only HTTP(S) YouTube URLs are supported.');
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  let id = '';
  if (host === 'youtu.be') id = u.pathname.split('/').filter(Boolean)[0] || '';
  else if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
    if (u.pathname === '/watch') id = u.searchParams.get('v') || '';
    else {
      const m = u.pathname.match(/^\/(?:shorts|live|embed)\/([^/?#]+)/);
      if (m) id = m[1];
    }
  } else throw new Error('Only youtube.com and youtu.be links are accepted.');
  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) {
    if (u.searchParams.has('list')) throw new Error('Playlist-only URLs are not supported. Select one video.');
    throw new Error('The URL does not contain a valid YouTube video ID.');
  }
  return { videoId: id, url: `https://www.youtube.com/watch?v=${id}` };
}

export function publicJob(j) {
  const { technical, ...safe } = j;
  return { ...safe, technical: technical ? { message: technical.message, exitCode: technical.exitCode, partialOutput: technical.partialOutput || '' } : undefined };
}

export async function atomicJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(value, null, 2));
  await fs.rename(tmp, file);
}

export async function loadJobs() {
  await fs.mkdir(JOBS_DIR, { recursive: true });
  const out = [];
  for (const name of await fs.readdir(JOBS_DIR)) {
    try { out.push(JSON.parse(await fs.readFile(path.join(JOBS_DIR, name, 'job.json'), 'utf8'))); } catch {}
  }
  return out;
}

// Launch Pi through Node rather than its /usr/bin/env shebang, which is
// unavailable on Android when a widget starts us without termux-exec.
export async function resolvePiEntrypoint(searchPath = process.env.PATH || '') {
  for (const directory of searchPath.split(path.delimiter)) {
    try {
      const entrypoint = await fs.realpath(path.resolve(directory || '.', 'pi'));
      if ((await fs.stat(entrypoint)).isFile()) return entrypoint;
    } catch (err) {
      if (!['ENOENT', 'ENOTDIR'].includes(err.code)) throw err;
    }
  }
  throw new Error('Pi is not installed or is not on the backend PATH. Install Pi and restart the server.');
}

export function run(command, args, { timeoutMs, cwd = ROOT, input, onSpawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    onSpawn?.(child);
    const chunks = [], errors = [];
    let timedOut = false, settled = false;
    const timer = timeoutMs ? setTimeout(() => { timedOut = true; child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 1500).unref(); }, timeoutMs) : null;
    child.stdout.on('data', d => chunks.push(d));
    child.stderr.on('data', d => errors.push(d));
    child.on('error', err => { if (!settled) { settled = true; if (timer) clearTimeout(timer); reject(err); } });
    child.on('close', code => {
      if (settled) return;
      settled = true; if (timer) clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(chunks).toString('utf8'), stderr: Buffer.concat(errors).toString('utf8'), timedOut });
    });
    if (input != null) child.stdin.end(input); else child.stdin.end();
  });
}

export function formatTime(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}` : `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
}

export function technicalMessage(result, fallback) {
  if (result.timedOut) return `${fallback} timed out.`;
  return (result.stderr || result.stdout || `${fallback} exited with code ${result.code}`).trim().slice(0, 4000);
}
