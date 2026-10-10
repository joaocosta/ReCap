import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { atomicJson, JOBS_DIR, ROOT, TERMINAL, loadJobs, run, technicalMessage } from './utils.js';
import { inspectYouTube, downloadCaption, downloadThumbnail, downloadComments } from './youtube.js';
import { selfContainedHtml } from './render.js';
import {
  prepareCommentSnapshot, makeBatches, videoContext, commentsOnlyContext, analysisPrompt, synthesisPrompt, parseModelJson,
  assertAnalysisSchema, validateAnalysis, reportMarkdown, selfContainedCommentHtml, snapshotDigest
} from './comments.js';

const COMMENT_ACTIVE = new Set(['queued','fetching','preparing','analyzing','synthesizing','saving']);

export class JobManager extends EventEmitter {
  constructor({ fetchComments = downloadComments } = {}) {
    super(); this.fetchComments = fetchComments; this.jobs = new Map(); this.queue = []; this.commentQueue = []; this.active = null;
    this.child = null; this.lastIdleAt = Date.now(); this.wakeHeld = false;
  }
  async init() {
    for (const j of await loadJobs()) {
      if (['inspecting','downloading','summarizing'].includes(j.status)) {
        j.status = 'failed'; j.error = 'The server stopped while this job was active. Retry manually to avoid repeating a possibly billed model call.';
        j.updatedAt = new Date().toISOString(); await this.save(j);
      }
      if (COMMENT_ACTIVE.has(j.comments?.status)) {
        if (j.comments.status === 'queued') this.commentQueue.push({ jobId:j.id, kind:j.comments.operation || 'retry' });
        else {
          Object.assign(j.comments, { status:'failed', progress:'Interrupted', error:'The server stopped during comment analysis. Retry to continue from validated checkpoints.' });
          j.updatedAt = new Date().toISOString(); await this.save(j);
        }
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
    await this.save(j); await this.log(j, `stage=${status}${extra.technical?.exitCode != null ? ` exit=${extra.technical.exitCode}` : ''}`);
  }
  async commentStage(j, status, progress, extra = {}) {
    j.comments ||= { status:'not_analyzed', hasReport:false };
    Object.assign(j.comments, extra, { status, progress }); j.updatedAt = new Date().toISOString();
    await this.save(j); await this.log(j, `comments-stage=${status}${extra.technical?.exitCode != null ? ` exit=${extra.technical.exitCode}` : ''}`);
  }
  async create(inspected, choice, { regenerate = false, longConfirmed = false, retryOf = null, commentsOnly = false } = {}) {
    if (commentsOnly && inspected.commentCount === 0) throw new Error('No comments available.');
    if (!commentsOnly && !choice) throw new Error('Choose a valid caption track.');
    const reusable = this.list().find(j => j.videoId === inspected.videoId &&
      (commentsOnly ? (!choice || !j.caption || j.caption.id === choice.id) : j.status === 'not_summarized'));
    if (commentsOnly && reusable) return reusable;
    if (!commentsOnly && inspected.duration > 3600 && !longConfirmed) throw Object.assign(new Error('Confirm that you want to summarize this video longer than one hour.'), { code: 'LONG_CONFIRMATION_REQUIRED' });
    if (!commentsOnly && !regenerate) {
      const existing = this.list().find(j => j.status === 'completed' && j.videoId === inspected.videoId && j.caption?.language === choice.language);
      if (existing) throw Object.assign(new Error('A completed summary already exists.'), { code: 'DUPLICATE', existingJobId: existing.id });
    }
    if (reusable) {
      Object.assign(reusable, { caption:choice, status:'queued', progress:'Waiting in queue', updatedAt:new Date().toISOString() });
      this.queue.push(reusable.id); await this.save(reusable); this.process(); return reusable;
    }
    const id = `${Date.now()}-${crypto.randomUUID().slice(0,8)}`, now = new Date().toISOString();
    const j = {
      id, status:commentsOnly?'not_summarized':'queued', progress:commentsOnly?'Video not summarized':'Waiting in queue', createdAt:now, updatedAt:now, url:inspected.url,
      videoId:inspected.videoId, title:inspected.title, duration:inspected.duration, thumbnailUrl:inspected.thumbnailUrl,
      uploader:inspected.uploader, uploadDate:inspected.uploadDate, commentCount:inspected.commentCount, caption:choice, retryOf,
      comments:{ status:'not_analyzed', progress:'Not analyzed', hasReport:false }
    };
    await fs.mkdir(path.join(JOBS_DIR,id),{recursive:true}); this.jobs.set(id,j); if(!commentsOnly)this.queue.push(id); await this.save(j); this.process(); return j;
  }
  async retry(old, inspected, choice, longConfirmed) {
    if (!['failed','cancelled'].includes(old.status)) throw new Error('Only failed or cancelled jobs can be retried.');
    if (this.active?.type==='summary' && this.active.jobId===old.id) throw new Error('Wait for the previous video summary run to stop before retrying.');
    if (!choice) throw new Error('Choose a valid caption track.');
    if (inspected.duration > 3600 && !longConfirmed) throw Object.assign(new Error('Confirm that you want to summarize this video longer than one hour.'), { code:'LONG_CONFIRMATION_REQUIRED' });
    Object.assign(old, { caption:choice, status:'queued', progress:'Waiting in queue', error:null, technical:null, updatedAt:new Date().toISOString() });
    this.queue.push(old.id); await this.save(old); this.process(); return old;
  }
  async cancel(id) {
    const j=this.get(id); if(!j || TERMINAL.has(j.status)) throw new Error('This job is not cancellable.');
    if(j.status==='queued') this.queue=this.queue.filter(x=>x!==id);
    if(this.active?.type==='summary' && this.active.jobId===id) this.child?.kill('SIGTERM');
    await this.stage(j,'cancelled','Cancelled',{error:'Cancelled by user.'}); this.syncWake(); return j;
  }
  async enqueueComments(id, kind) {
    const j=this.get(id); if(!j) throw new Error('Job not found.');
    if(j.commentCount===0 && kind==='analyze') throw new Error('No comments available.');
    j.comments ||= { status:'not_analyzed', progress:'Not analyzed', hasReport:false };
    if(COMMENT_ACTIVE.has(j.comments.status)) throw new Error('Comment analysis is already queued or running.');
    if(kind==='analyze' && j.comments.hasReport) throw new Error('Comments have already been analyzed. Use Refresh.');
    if(kind==='refresh' && !j.comments.hasReport) throw new Error('There is no completed comment report to refresh.');
    if(kind==='retry' && !['failed','cancelled'].includes(j.comments.status)) throw new Error('Only failed or cancelled comment work can be retried.');
    Object.assign(j.comments,{ status:'queued',progress:'Waiting in queue',operation:kind,error:null,technical:null,batch:null,batchCount:null });
    j.updatedAt=new Date().toISOString(); this.commentQueue.push({jobId:id,kind}); await this.save(j); this.process(); return j;
  }
  analyzeComments(id) { return this.enqueueComments(id,'analyze'); }
  refreshComments(id) { return this.enqueueComments(id,'refresh'); }
  retryComments(id) { return this.enqueueComments(id,'retry'); }
  async cancelComments(id) {
    const j=this.get(id); if(!j || !COMMENT_ACTIVE.has(j.comments?.status)) throw new Error('Comment analysis is not cancellable.');
    this.commentQueue=this.commentQueue.filter(x=>x.jobId!==id);
    if(this.active?.type==='comments' && this.active.jobId===id) this.child?.kill('SIGTERM');
    await this.commentStage(j,'cancelled','Cancelled',{error:'Comment analysis was cancelled.'}); this.syncWake(); return j;
  }
  async remove(id) {
    const j=this.get(id); if(!j || !TERMINAL.has(j.status)) throw new Error('Only inactive video jobs can be deleted.');
    if(COMMENT_ACTIVE.has(j.comments?.status)) throw new Error('Cancel comment analysis before deleting this summary.');
    await fs.rm(path.join(JOBS_DIR,id),{recursive:true,force:true}); this.jobs.delete(id); this.emit('delete',{id});
  }
  async syncWake() {
    const needed=!!this.active || this.queue.length>0 || this.commentQueue.length>0;
    if(needed===this.wakeHeld)return; this.wakeHeld=needed;
    await run(needed?'termux-wake-lock':'termux-wake-unlock',[],{timeoutMs:5000}).catch(()=>{});
  }
  async shutdown() { this.child?.kill('SIGTERM'); this.wakeHeld=false; await run('termux-wake-unlock',[],{timeoutMs:5000}).catch(()=>{}); }
  process() {
    if(this.active)return;
    let task;
    while(this.queue.length && !task) { const id=this.queue.shift(),j=this.get(id); if(j?.status==='queued') task={type:'summary',jobId:id}; }
    while(!task && this.commentQueue.length) { const x=this.commentQueue.shift(),j=this.get(x.jobId); if(j && j.comments?.status==='queued') task={type:'comments',jobId:x.jobId,kind:x.kind}; }
    if(!task){this.lastIdleAt=Date.now();this.syncWake();return;}
    this.active=task;this.syncWake();const j=this.get(task.jobId);
    const work=task.type==='summary'?this.runJob(j):this.runCommentJob(j,task.kind);
    work.finally(()=>{this.active=null;this.child=null;this.lastIdleAt=Date.now();this.process();});
  }
  async runJob(j) {
    const dir=path.join(JOBS_DIR,j.id),started=Date.now(),child=c=>{this.child=c;};
    try {
      await this.stage(j,'inspecting','Refreshing video metadata'); const info=await inspectYouTube(j.url,child); if(j.status==='cancelled')return;
      const choice=info.captions.find(c=>c.id===j.caption.id); if(!choice)throw new Error('The selected caption track is no longer available.');
      Object.assign(j,{title:info.title,duration:info.duration,thumbnailUrl:info.thumbnailUrl,uploader:info.uploader,uploadDate:info.uploadDate,commentCount:info.commentCount,caption:choice});
      await fs.writeFile(path.join(dir,'metadata.json'),JSON.stringify({videoId:j.videoId,url:j.url,title:j.title,duration:j.duration,uploader:j.uploader,uploadDate:j.uploadDate,commentCount:j.commentCount,caption:j.caption},null,2));
      await this.stage(j,'downloading','Downloading and cleaning captions');
      const [transcript,thumbnailFile]=await Promise.all([downloadCaption(dir,j.url,choice,child),downloadThumbnail(dir,info.thumbnailUrl)]); if(j.status==='cancelled')return;
      j.thumbnailFile=thumbnailFile;
      if(transcript.clean.length>350000)throw new Error(`The cleaned transcript is ${transcript.clean.length.toLocaleString()} characters; the limit is exactly 350,000.`);
      if(!transcript.clean.trim())throw new Error('The selected caption track is empty.');
      await this.stage(j,'summarizing','Summarizing with Pi');
      const system=await fs.readFile(path.join(ROOT,'prompts','system.md'),'utf8');
      const prompt=`<UNTRUSTED_VIDEO_DATA>\nVIDEO TITLE: ${j.title}\nCAPTION LANGUAGE: ${choice.label}\n\nTRANSCRIPT:\n${transcript.timestamped}\n</UNTRUSTED_VIDEO_DATA>\n`;
      const result=await this.runPi(system,prompt,300000,child);
      const partial=result.text;
      const mdText=value=>String(value).replace(/[\\`*_[\]{}()#+.!|>-]/g,'\\$&').replace(/\r?\n/g,' ');
      const source=`\n\n# Source metadata\n\n- **Title:** ${mdText(j.title)}\n- **Channel:** ${mdText(j.uploader||'Unknown')}\n- **YouTube:** <${j.url}>\n- **Caption track:** ${mdText(choice.label)}\n- **Duration:** ${Math.round(j.duration)} seconds\n- **Summarized:** ${new Date().toISOString()}\n`;
      const markdown=partial.trim()+source;await fs.writeFile(path.join(dir,'summary.md'),markdown);
      j.model=result.model;j.usage=result.usage;const page=await selfContainedHtml(j,dir,markdown);await fs.writeFile(path.join(dir,'summary.html'),page);
      await this.stage(j,'completed','Complete',{completedAt:new Date().toISOString(),elapsedMs:Date.now()-started,error:null,technical:null});
      this.log(j,`completed ${Date.now()-started}ms model=${j.model}`);
    } catch(err) {
      if(j.status==='cancelled')return;
      await this.stage(j,'failed','Failed',{error:friendly(err),technical:{message:err.technical||err.message,exitCode:err.exitCode,partialOutput:err.partial||''}});
      this.log(j,`failed ${Date.now()-started}ms ${String(err.message).slice(0,200)}`);
    }
  }
  async runCommentJob(j,kind) {
    const dir=path.join(JOBS_DIR,j.id),work=path.join(dir,'.comments-work'),started=Date.now(),child=c=>{this.child=c;};
    let snapshot;
    try {
      const reuse=kind==='retry' && j.comments.snapshotReady;
      if(!reuse) {
        await fs.rm(work,{recursive:true,force:true});await fs.mkdir(work,{recursive:true});
        await this.commentStage(j,'fetching','Fetching comments from YouTube',{snapshotReady:false});
        const extracted=await this.fetchComments(j.url,child);if(j.comments.status==='cancelled')return;
        if(!extracted.comments.length && extracted.reportedCount!==0)throw new Error('Comments could not be retrieved. They may be disabled, restricted, or temporarily unavailable.');
        snapshot=prepareCommentSnapshot(j.videoId,extracted);await fs.writeFile(path.join(work,'comments.json'),JSON.stringify(snapshot,null,2));
        j.commentCount=extracted.reportedCount;await this.commentStage(j,'preparing','Preparing comment threads',{snapshotReady:true});
      } else {
        snapshot=JSON.parse(await fs.readFile(path.join(work,'comments.json'),'utf8'));
        await this.commentStage(j,'preparing','Resuming from the saved comment snapshot');
      }
      // Pin context to the snapshot so retry checkpoints never mix context modes.
      const contextFile=path.join(work,'video-context.json');
      let savedContext;
      if(reuse) {
        try { savedContext=JSON.parse(await fs.readFile(contextFile,'utf8')); }
        catch(err) { if(err.code!=='ENOENT')throw err; }
      }
      if(!savedContext) {
        const hasVideoContext=j.status==='completed';
        savedContext={ hasVideoContext, summary:hasVideoContext?await fs.readFile(path.join(dir,'summary.md'),'utf8'):'',
          transcript:hasVideoContext?await fs.readFile(path.join(dir,'transcript-timestamped.txt'),'utf8'):'',
          metadata:{ title:j.title,uploader:j.uploader,url:j.url } };
        await fs.writeFile(contextFile,JSON.stringify(savedContext));
      }
      const {summary,transcript,hasVideoContext}=savedContext;
      const contextSummary=hasVideoContext?summary:commentsOnlyContext(savedContext.metadata);
      const batches=makeBatches(snapshot),system=await fs.readFile(path.join(ROOT,'prompts','comments-system.md'),'utf8');
      const candidates=[],models=new Set(),usages=[];
      if(!batches.length) candidates.push(validateAnalysis({overview:'',findings:[],keyTakeaways:[],caveats:[]},snapshot,j.duration));
      for(let i=0;i<batches.length;i++) {
        if(j.comments.status==='cancelled')return;
        const checkpoint=path.join(work,`comment-batch-${i}.json`);let candidate;
        try {
          const saved=JSON.parse(await fs.readFile(checkpoint,'utf8'));candidate=saved.candidate;models.add(saved.model);usages.push(saved.usage);
        } catch {
          await this.commentStage(j,'analyzing',`Analyzing batch ${i+1} of ${batches.length}`,{batch:i+1,batchCount:batches.length});
          const context=hasVideoContext?videoContext(summary,transcript,batches[i]):contextSummary;
          const response=await this.runCommentAnalysis(j,work,system,analysisPrompt(context,batches[i],{candidate:batches.length>1,hasVideoContext}),snapshot,child,usages);
          candidate=response.analysis;models.add(response.model);
          await fs.writeFile(checkpoint,JSON.stringify({candidate,model:response.model,usage:response.usage},null,2));
        }
        candidates.push(candidate);
      }
      let analysis;
      if(candidates.length<=1) analysis=candidates[0];
      else {
        await this.commentStage(j,'synthesizing','Synthesizing the final comment report');
        const finalFile=path.join(work,'comment-final.json');
        try {
          const saved=JSON.parse(await fs.readFile(finalFile,'utf8'));analysis=saved.analysis;models.add(saved.model);usages.push(saved.usage);
        } catch {
          const response=await this.runCommentAnalysis(j,work,system,synthesisPrompt(contextSummary,candidates,{hasVideoContext}),snapshot,child,usages);
          analysis=response.analysis;models.add(response.model);
          await fs.writeFile(finalFile,JSON.stringify({analysis,model:response.model,usage:response.usage},null,2));
        }
      }
      if(j.comments.status==='cancelled')return;
      await this.commentStage(j,'saving','Validating and saving the report');
      const analyzedAt=new Date().toISOString(),model=[...models].filter(Boolean).join(', ')||j.comments.model||'Pi default';
      const usage=combineUsage(usages),record={schemaVersion:1,analyzedAt,model,usage,result:analysis};
      if(!hasVideoContext) for(const finding of analysis.findings) {
        if(['corrects','corroborates','challenges','clarifies'].includes(finding.relationship)) finding.relationship='adjacent context';
        finding.videoTimestamps=[];
      }
      const markdown=reportMarkdown(j,analysis,snapshot,analyzedAt,{hasVideoContext});
      const metadata={schemaVersion:1,hasVideoContext,videoId:j.videoId,snapshotAt:snapshot.fetchedAt,analyzedAt,ordering:snapshot.ordering,reportedCount:snapshot.reportedCount,fetchedCount:snapshot.fetchedCount,threadCount:snapshot.threadCount,analyzedCount:snapshot.analyzedCount,analyzedThreadCount:snapshot.analyzedThreadCount,excludedCount:snapshot.excludedCount,limit:snapshot.limit,limitReached:snapshot.limitReached,omittedApprox:snapshot.omittedApprox,digest:snapshotDigest(snapshot),model,usage,batchCount:batches.length,exclusions:countExclusions(snapshot)};
      await Promise.all([
        fs.writeFile(path.join(work,'comment-analysis.json'),JSON.stringify(record,null,2)),
        fs.writeFile(path.join(work,'comment-analysis-metadata.json'),JSON.stringify(metadata,null,2)),
        fs.writeFile(path.join(work,'comment-summary.md'),markdown),
        selfContainedCommentHtml(j,work,markdown,analysis,snapshot).then(x=>fs.writeFile(path.join(work,'comment-summary.html'),x))
      ]);
      if(j.comments.status==='cancelled')return;
      const previousArtifact=j.comments.artifactDir,publishName=`comments-${Date.now()}-${crypto.randomUUID().slice(0,8)}`,publish=path.join(dir,publishName);
      await fs.mkdir(publish,{recursive:true});
      for(const file of ['comments.json','comment-analysis.json','comment-analysis-metadata.json','comment-summary.md','comment-summary.html']) await fs.copyFile(path.join(work,file),path.join(publish,file));
      if(j.comments.status==='cancelled'){await fs.rm(publish,{recursive:true,force:true});return;}
      await this.commentStage(j,'completed','Comment analysis complete',{hasReport:true,hasVideoContext,artifactDir:publishName,snapshotReady:false,snapshotAt:snapshot.fetchedAt,analyzedAt,reportedCount:snapshot.reportedCount,fetchedCount:snapshot.fetchedCount,threadCount:snapshot.threadCount,analyzedCount:snapshot.analyzedCount,analyzedThreadCount:snapshot.analyzedThreadCount,excludedCount:snapshot.excludedCount,limitReached:snapshot.limitReached,omittedApprox:snapshot.omittedApprox,model,usage,batch:null,batchCount:batches.length,completedAt:analyzedAt,elapsedMs:Date.now()-started,error:null,technical:null});
      await fs.rm(work,{recursive:true,force:true}).catch(()=>{});
      if(previousArtifact&&previousArtifact!==publishName)await fs.rm(path.join(dir,previousArtifact),{recursive:true,force:true}).catch(()=>{});
    } catch(err) {
      if(j.comments?.status==='cancelled')return;
      await this.commentStage(j,'failed','Comment analysis failed',{error:friendly(err),technical:{message:err.technical||err.message,exitCode:err.exitCode,partialOutput:err.partial||''}});
      this.log(j,`comments-failed ${Date.now()-started}ms ${String(err.message).slice(0,200)}`);
    }
  }
  async runCommentAnalysis(j,work,system,prompt,snapshot,onSpawn,usages) {
    const diagnostic=path.join(work,'failed-model-response.json');
    let feedback='';
    const attemptUsages=[];
    for(let attempt=1;attempt<=3;attempt++) {
      if(j.comments.status==='cancelled')throw new Error('Comment analysis cancelled.');
      const response=await this.runPi(system,prompt+feedback,15*60_000,onSpawn);
      usages.push(response.usage);attemptUsages.push(response.usage);
      if(j.comments.status==='cancelled')throw new Error('Comment analysis cancelled.');
      let analysis;
      try {
        const value=parseModelJson(response.text);
        assertAnalysisSchema(value);
        const allowed=new Set(snapshot.comments.filter(c=>!c.excludedReason).map(c=>c.id));
        for(const finding of value.findings) {
          if(!finding.matchingCommentIds.length || !finding.evidenceCommentIds.length ||
             [...finding.matchingCommentIds,...finding.evidenceCommentIds].some(id=>!allowed.has(id))) {
            throw new Error('Each finding must reference existing, eligible supporting and evidence comment IDs.');
          }
        }
        analysis=validateAnalysis(value,snapshot,j.duration);
      } catch(err) {
        const detail=String(err.message).slice(0,400);
        await fs.writeFile(diagnostic,JSON.stringify({attempt,model:response.model,error:detail,response:response.text},null,2),{mode:0o600});
        if(attempt===3)throw new Error('The model could not produce a valid structured analysis after several attempts. Your completed batches are saved. You can retry.');
        await this.commentStage(j,j.comments.status,`Retrying structured analysis (attempt ${attempt+1} of 3)`);
        feedback=`\n\nYour previous response failed validation: ${detail}\nReturn a complete replacement JSON object in the requested schema, with valid JSON syntax and only supplied comment IDs. Do not include commentary or Markdown fences.`;
        continue;
      }
      await fs.rm(diagnostic,{force:true});
      return {...response,analysis,usage:combineUsage(attemptUsages)};
    }
  }
  async runPi(system,prompt,timeoutMs,onSpawn) {
    const args=['--mode','json','--no-tools','--no-session','--no-context-files','--no-extensions','--no-skills','--no-prompt-templates','--system-prompt',system];
    const pi=await run('pi',args,{timeoutMs,input:prompt,onSpawn});let assistant=null;
    for(const line of pi.stdout.split('\n')){try{const e=JSON.parse(line);if(e.type==='message_end'&&e.message?.role==='assistant')assistant=e.message;}catch{}}
    const partial=assistant?.content?.filter(x=>x.type==='text').map(x=>x.text).join('')||'';
    if(pi.code!==0||pi.timedOut||!partial.trim()||assistant?.stopReason==='error'||assistant?.stopReason==='aborted')throw Object.assign(new Error(pi.timedOut?'Pi operation timed out.':'Pi could not complete the operation.'),{technical:technicalMessage(pi,'Pi'),exitCode:pi.code,partial});
    return {text:partial,model:[assistant.provider,assistant.model].filter(Boolean).join('/')||'Pi default',usage:assistant.usage||null};
  }
  async log(j,message){const day=new Date().toISOString().slice(0,10),dir=path.join(ROOT,'data','logs');await fs.mkdir(dir,{recursive:true});await fs.appendFile(path.join(dir,`${day}.log`),`${new Date().toISOString()} job=${j.id} ${message}\n`).catch(()=>{});}
}

function countExclusions(snapshot){const out={};for(const c of snapshot.comments)if(c.excludedReason)out[c.excludedReason]=(out[c.excludedReason]||0)+1;return out;}
function combineUsage(usages){const valid=usages.filter(Boolean);if(!valid.length)return null;const out={input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};for(const u of valid){for(const k of ['input','output','cacheRead','cacheWrite','totalTokens'])out[k]+=Number(u[k]||0);for(const k of Object.keys(out.cost))out.cost[k]+=Number(u.cost?.[k]||0);}return out;}
function friendly(err){const s=String(err.message||err);if(!/^Comments could not be retrieved\./.test(s) && /private|sign in|members|age-restricted|unavailable/i.test(err.technical||s))return'This video is unavailable without access or sign-in.';return s.length<500?s:'The operation failed. See technical details.';}
