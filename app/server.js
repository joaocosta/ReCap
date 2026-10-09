import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { JobManager } from './manager.js';
import { inspectYouTube } from './youtube.js';
import { JOBS_DIR, ROOT, TERMINAL, publicJob } from './utils.js';
import { renderMarkdown } from './render.js';
import { threadsForClient } from './comments.js';

const app = express(), manager = new JobManager(), csrf = crypto.randomBytes(24).toString('base64url');
const inspections = new Map(), PORT = 8765;
await manager.init();

app.disable('x-powered-by');
app.use((req,res,next) => {
  if (!['127.0.0.1:8765','localhost:8765'].includes(req.headers.host || '')) return res.status(403).send('Invalid Host');
  if (req.headers.origin && !['http://127.0.0.1:8765','http://localhost:8765'].includes(req.headers.origin)) return res.status(403).send('Invalid Origin');
  res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Security-Policy',"default-src 'self'; img-src 'self' data: https://i.ytimg.com https://*.ytimg.com https://*.googleusercontent.com; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"); next();
});
app.use(express.json({ limit: '16kb' }));
const protect = (req,res,next) => String(req.get('x-csrf-token') || '') === csrf ? next() : res.status(403).json({error:'Invalid anti-CSRF token.'});
const commentArtifact = j => /^comments-\d+-[a-f0-9]{8}$/.test(j?.comments?.artifactDir || '') ? path.join(JOBS_DIR,j.id,j.comments.artifactDir) : null;

app.get('/health', (_req,res) => res.json({ok:true, active:manager.active, queued:manager.queue.length}));
app.get('/api/config', (_req,res) => res.json({csrf}));
app.post('/api/inspect', protect, async (req,res) => {
  try {
    const info = await inspectYouTube(req.body.url); inspections.set(info.inspectId, { info, expires:Date.now()+15*60_000 });
    res.json(info);
  } catch(e) { res.status(400).json({error:friendly(e),technical:e.technical || e.message}); }
});
app.post('/api/jobs', protect, async (req,res) => {
  try {
    const record = inspections.get(req.body.inspectId); if (!record || record.expires < Date.now()) throw new Error('Inspection expired. Inspect the URL again.');
    const commentsOnly = req.body.mode === 'comments';
    const choice = record.info.captions.find(c => c.id === req.body.captionId); if (!commentsOnly && !choice) throw new Error('Choose a valid caption track.');
    const job = await manager.create(record.info, choice, { regenerate:!!req.body.regenerate, longConfirmed:!!req.body.longConfirmed, commentsOnly });
    if(commentsOnly && !job.comments?.hasReport && !['queued','fetching','preparing','analyzing','synthesizing','saving'].includes(job.comments?.status)) {
      await manager.enqueueComments(job.id, ['failed','cancelled'].includes(job.comments?.status)?'retry':'analyze');
    }
    inspections.delete(req.body.inspectId); res.status(201).json(publicJob(job));
  } catch(e) { res.status(e.code === 'DUPLICATE' ? 409 : 400).json({error:e.message, code:e.code, existingJobId:e.existingJobId}); }
});
app.get('/api/jobs', (_req,res) => res.json(manager.list().map(publicJob)));
app.get('/api/jobs/:id', (req,res) => { const j=manager.get(req.params.id); j ? res.json(publicJob(j)) : res.status(404).json({error:'Job not found.'}); });
app.post('/api/jobs/:id/cancel', protect, async(req,res) => { try { res.json(publicJob(await manager.cancel(req.params.id))); } catch(e){ res.status(400).json({error:e.message}); } });
app.post('/api/jobs/:id/comments/analyze', protect, async(req,res) => { try { res.json(publicJob(await manager.analyzeComments(req.params.id))); } catch(e){ res.status(400).json({error:e.message}); } });
app.post('/api/jobs/:id/comments/refresh', protect, async(req,res) => { try { res.json(publicJob(await manager.refreshComments(req.params.id))); } catch(e){ res.status(400).json({error:e.message}); } });
app.post('/api/jobs/:id/comments/retry', protect, async(req,res) => { try { res.json(publicJob(await manager.retryComments(req.params.id))); } catch(e){ res.status(400).json({error:e.message}); } });
app.post('/api/jobs/:id/comments/cancel', protect, async(req,res) => { try { res.json(publicJob(await manager.cancelComments(req.params.id))); } catch(e){ res.status(400).json({error:e.message}); } });
app.post('/api/jobs/:id/retry', protect, async(req,res) => {
  try {
    const old=manager.get(req.params.id); if(!old || !['failed','cancelled'].includes(old.status)) throw new Error('Only failed or cancelled jobs can be retried.');
    const snapshot={url:old.url,videoId:old.videoId,title:old.title,duration:old.duration,thumbnailUrl:old.thumbnailUrl,uploader:old.uploader,uploadDate:old.uploadDate,commentCount:old.commentCount};
    const job=await manager.retry(old,snapshot,old.caption,!!req.body.longConfirmed); res.status(201).json(publicJob(job));
  } catch(e){ res.status(400).json({error:e.message,code:e.code}); }
});
app.delete('/api/jobs/:id', protect, async(req,res) => { try { await manager.remove(req.params.id); res.status(204).end(); } catch(e){ res.status(400).json({error:e.message}); } });
app.get('/api/jobs/:id/events', (req,res) => {
  if(!manager.get(req.params.id)) return res.status(404).end();
  res.setHeader('Content-Type','text/event-stream'); res.setHeader('Cache-Control','no-cache'); res.setHeader('Connection','keep-alive');
  const send=j => { if(j.id===req.params.id) res.write(`data: ${JSON.stringify(publicJob(j))}\n\n`); }; send(manager.get(req.params.id));
  manager.on('change',send); const ping=setInterval(()=>res.write(': ping\n\n'),20000); req.on('close',()=>{clearInterval(ping);manager.off('change',send);});
});
app.get('/api/jobs/:id/rendered', async(req,res) => {
  const j=manager.get(req.params.id); if(!j || j.status!=='completed') return res.status(404).json({error:'Completed summary not found.'});
  const markdown=await fs.readFile(path.join(JOBS_DIR,j.id,'summary.md'),'utf8'); res.json({html:renderMarkdown(markdown,j),job:publicJob(j)});
});
app.get('/api/jobs/:id/comments/rendered', async(req,res) => {
  const j=manager.get(req.params.id); if(!j?.comments?.hasReport) return res.status(404).json({error:'Completed comment analysis not found.'});
  try {
    const artifact=commentArtifact(j); if(!artifact) throw new Error('Invalid comment artifact.');
    const [markdown,snapshot,record]=await Promise.all([
      fs.readFile(path.join(artifact,'comment-summary.md'),'utf8'),
      fs.readFile(path.join(artifact,'comments.json'),'utf8').then(JSON.parse),
      fs.readFile(path.join(artifact,'comment-analysis.json'),'utf8').then(JSON.parse)
    ]);
    res.json({html:renderMarkdown(markdown,j),threads:threadsForClient(record.result,snapshot),job:publicJob(j)});
  } catch { res.status(404).json({error:'Completed comment analysis artifacts not found.'}); }
});
const downloads={html:{file:'summary.html'},markdown:{file:'summary.md'},transcript:{file:'transcript-clean.txt'},caption:{file:'source-caption.json3'},'comments-html':{file:'comment-summary.html',comments:true},'comments-markdown':{file:'comment-summary.md',comments:true},'comments-json':{file:'comments.json',comments:true},'comments-metadata':{file:'comment-analysis-metadata.json',comments:true}};
app.get('/api/jobs/:id/download/:kind', async(req,res) => {
  const j=manager.get(req.params.id), item=downloads[req.params.kind], artifact=j&&commentArtifact(j); if(!j || !item || (item.comments&&!artifact)) return res.status(404).end();
  const full=item.comments?path.join(artifact,item.file):path.join(JOBS_DIR,j.id,item.file); try{await fs.access(full);}catch{return res.status(404).end();}
  const stem=(j.title||'youtube-summary').replace(/[^\p{L}\p{N}._-]+/gu,'-').slice(0,80); res.download(full,`${stem}-${item.file}`);
});
app.get('/api/jobs/:id/thumbnail', async(req,res) => {
  const j=manager.get(req.params.id); if(!j?.thumbnailFile) return res.status(404).end(); res.sendFile(path.join(JOBS_DIR,j.id,j.thumbnailFile));
});
app.use(express.static(path.join(ROOT,'public'),{index:'index.html',fallthrough:true}));
app.get('*splat', (_req,res) => res.sendFile(path.join(ROOT,'public','index.html')));

const server=app.listen(PORT,'127.0.0.1',()=>console.log(`YouTube summarizer: http://127.0.0.1:${PORT}`));
setInterval(async()=>{
  for(const [id,x] of inspections) if(x.expires<Date.now()) inspections.delete(id);
  if(!manager.active && !manager.queue.length && !manager.commentQueue.length && Date.now()-manager.lastIdleAt>=30*60_000){ await manager.shutdown(); server.close(()=>process.exit(0)); }
},30_000).unref();
for(const sig of ['SIGINT','SIGTERM']) process.on(sig,async()=>{await manager.shutdown();server.close(()=>process.exit(0));setTimeout(()=>process.exit(1),2000).unref();});

function friendly(e){ const s=String(e.technical||e.message||e); if(/private|sign in|members|age-restricted|unavailable/i.test(s)) return 'This video is unavailable without access or sign-in.'; return e.message||'Inspection failed.'; }
