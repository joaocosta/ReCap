import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { atomicJson, JOBS_DIR, ROOT, TERMINAL, loadJobs, run, technicalMessage } from './utils.js';
import { inspectYouTube, downloadCaption, downloadThumbnail } from './youtube.js';
import { selfContainedHtml } from './render.js';

export class JobManager extends EventEmitter {
  constructor() { super(); this.jobs = new Map(); this.queue = []; this.active = null; this.child = null; this.lastIdleAt = Date.now(); this.wakeHeld = false; }
  async init() {
    for (const j of await loadJobs()) {
      if (['inspecting','downloading','summarizing'].includes(j.status)) {
        j.status = 'failed'; j.error = 'The server stopped while this job was active. Retry manually to avoid repeating a possibly billed model call.';
        j.updatedAt = new Date().toISOString(); await this.save(j);
      }
      this.jobs.set(j.id, j); if (j.status === 'queued') this.queue.push(j.id);
    }
    this.process();
  }
  list() { return [...this.jobs.values()].sort((a,b) => b.createdAt.localeCompare(a.createdAt)); }
  get(id) { return this.jobs.get(id); }
  async save(j) { await atomicJson(path.join(JOBS_DIR, j.id, 'job.json'), j); this.emit('change', j); }
  async stage(j, status, progress, extra = {}) {
    Object.assign(j, extra, { status, progress, updatedAt: new Date().toISOString() });
    await this.save(j);
    await this.log(j, `stage=${status}${extra.technical?.exitCode != null ? ` exit=${extra.technical.exitCode}` : ''}`);
  }
  async create(inspected, choice, { regenerate = false, longConfirmed = false, retryOf = null } = {}) {
    if (inspected.duration > 3600 && !longConfirmed) throw Object.assign(new Error('Confirm that you want to summarize this video longer than one hour.'), { code: 'LONG_CONFIRMATION_REQUIRED' });
    if (!regenerate) {
      const existing = this.list().find(j => j.status === 'completed' && j.videoId === inspected.videoId && j.caption?.language === choice.language);
      if (existing) throw Object.assign(new Error('A completed summary already exists.'), { code: 'DUPLICATE', existingJobId: existing.id });
    }
    const id = `${Date.now()}-${crypto.randomUUID().slice(0,8)}`, now = new Date().toISOString();
    const j = { id, status: 'queued', progress: 'Waiting in queue', createdAt: now, updatedAt: now, url: inspected.url, videoId: inspected.videoId, title: inspected.title, duration: inspected.duration, thumbnailUrl: inspected.thumbnailUrl, uploader: inspected.uploader, uploadDate: inspected.uploadDate, caption: choice, retryOf };
    await fs.mkdir(path.join(JOBS_DIR, id), { recursive: true }); this.jobs.set(id, j); this.queue.push(id); await this.save(j); this.process(); return j;
  }
  async retry(old, inspected, choice, longConfirmed) { return this.create(inspected, choice, { regenerate: true, longConfirmed, retryOf: old.id }); }
  async cancel(id) {
    const j = this.get(id); if (!j || TERMINAL.has(j.status)) throw new Error('This job is not cancellable.');
    if (j.status === 'queued') this.queue = this.queue.filter(x => x !== id);
    if (this.active === id) this.child?.kill('SIGTERM');
    await this.stage(j, 'cancelled', 'Cancelled', { error: 'Cancelled by user.' });
    this.syncWake(); return j;
  }
  async remove(id) {
    const j = this.get(id); if (!j || !TERMINAL.has(j.status)) throw new Error('Only completed, failed, or cancelled jobs can be deleted.');
    await fs.rm(path.join(JOBS_DIR, id), { recursive: true, force: true }); this.jobs.delete(id); this.emit('delete', { id });
  }
  async syncWake() {
    const needed = !!this.active || this.queue.length > 0;
    if (needed === this.wakeHeld) return;
    this.wakeHeld = needed;
    await run(needed ? 'termux-wake-lock' : 'termux-wake-unlock', [], { timeoutMs: 5000 }).catch(() => {});
  }
  async shutdown() {
    this.child?.kill('SIGTERM');
    this.wakeHeld = false;
    await run('termux-wake-unlock', [], { timeoutMs: 5000 }).catch(() => {});
  }
  process() {
    if (this.active) return;
    const id = this.queue.shift();
    if (!id) { this.lastIdleAt = Date.now(); this.syncWake(); return; }
    const j = this.get(id); if (!j || j.status !== 'queued') return this.process();
    this.active = id; this.syncWake(); this.runJob(j).finally(() => { this.active = null; this.child = null; this.lastIdleAt = Date.now(); this.process(); });
  }
  async runJob(j) {
    const dir = path.join(JOBS_DIR, j.id), started = Date.now();
    const child = c => { this.child = c; };
    try {
      await this.stage(j, 'inspecting', 'Refreshing video metadata');
      const info = await inspectYouTube(j.url, child);
      if (j.status === 'cancelled') return;
      const choice = info.captions.find(c => c.id === j.caption.id);
      if (!choice) throw new Error('The selected caption track is no longer available.');
      Object.assign(j, { title: info.title, duration: info.duration, thumbnailUrl: info.thumbnailUrl, uploader: info.uploader, uploadDate: info.uploadDate, caption: choice });
      await fs.writeFile(path.join(dir, 'metadata.json'), JSON.stringify({ videoId:j.videoId,url:j.url,title:j.title,duration:j.duration,uploader:j.uploader,uploadDate:j.uploadDate,caption:j.caption }, null, 2));
      await this.stage(j, 'downloading', 'Downloading and cleaning captions');
      const [transcript, thumbnailFile] = await Promise.all([downloadCaption(dir, j.url, choice, child), downloadThumbnail(dir, info.thumbnailUrl)]);
      if (j.status === 'cancelled') return;
      j.thumbnailFile = thumbnailFile;
      if (transcript.clean.length > 350000) throw new Error(`The cleaned transcript is ${transcript.clean.length.toLocaleString()} characters; the limit is exactly 350,000.`);
      if (!transcript.clean.trim()) throw new Error('The selected caption track is empty.');
      await this.stage(j, 'summarizing', 'Summarizing with Pi');
      const system = await fs.readFile(path.join(ROOT, 'prompts', 'system.md'), 'utf8');
      const prompt = `<UNTRUSTED_VIDEO_DATA>\nVIDEO TITLE: ${j.title}\nCAPTION LANGUAGE: ${choice.label}\n\nTRANSCRIPT:\n${transcript.timestamped}\n</UNTRUSTED_VIDEO_DATA>\n`;
      const args = ['--mode','json','--no-tools','--no-session','--no-context-files','--no-extensions','--no-skills','--no-prompt-templates','--system-prompt',system];
      const pi = await run('pi', args, { timeoutMs: 300000, input: prompt, onSpawn: child });
      let assistant = null;
      for (const line of pi.stdout.split('\n')) {
        try { const e = JSON.parse(line); if (e.type === 'message_end' && e.message?.role === 'assistant') assistant = e.message; } catch {}
      }
      const partial = assistant?.content?.filter(x => x.type === 'text').map(x => x.text).join('') || '';
      if (pi.code !== 0 || pi.timedOut || !partial.trim() || assistant?.stopReason === 'error' || assistant?.stopReason === 'aborted') {
        throw Object.assign(new Error(pi.timedOut ? 'Pi summarization timed out after five minutes.' : 'Pi could not complete the summary.'), { technical: technicalMessage(pi, 'Pi'), exitCode: pi.code, partial });
      }
      const mdText = value => String(value).replace(/[\\`*_[\]{}()#+.!|>-]/g, '\\$&').replace(/\r?\n/g, ' ');
      const source = `\n\n# Source metadata\n\n- **Title:** ${mdText(j.title)}\n- **Channel:** ${mdText(j.uploader || 'Unknown')}\n- **YouTube:** <${j.url}>\n- **Caption track:** ${mdText(choice.label)}\n- **Duration:** ${Math.round(j.duration)} seconds\n- **Summarized:** ${new Date().toISOString()}\n`;
      const markdown = partial.trim() + source;
      await fs.writeFile(path.join(dir, 'summary.md'), markdown);
      const message = assistant;
      j.model = [message.provider, message.model].filter(Boolean).join('/') || 'Pi default';
      j.usage = message.usage || null;
      const html = await selfContainedHtml(j, dir, markdown); await fs.writeFile(path.join(dir, 'summary.html'), html);
      await this.stage(j, 'completed', 'Complete', { completedAt: new Date().toISOString(), elapsedMs: Date.now()-started, error: null, technical: null });
      this.log(j, `completed ${Date.now()-started}ms model=${j.model}`);
    } catch (err) {
      if (j.status === 'cancelled') return;
      await this.stage(j, 'failed', 'Failed', { error: friendly(err), technical: { message: err.technical || err.message, exitCode: err.exitCode, partialOutput: err.partial || '' } });
      this.log(j, `failed ${Date.now()-started}ms ${String(err.message).slice(0,200)}`);
    }
  }
  async log(j, message) {
    const day = new Date().toISOString().slice(0,10); const dir = path.join(ROOT, 'data', 'logs'); await fs.mkdir(dir,{recursive:true});
    await fs.appendFile(path.join(dir, `${day}.log`), `${new Date().toISOString()} job=${j.id} ${message}\n`).catch(()=>{});
  }
}

function friendly(err) {
  const s = String(err.message || err);
  if (/private|sign in|members|age-restricted|unavailable/i.test(err.technical || s)) return 'This video is unavailable without access or sign-in.';
  return s.length < 500 ? s : 'The operation failed. See technical details.';
}
