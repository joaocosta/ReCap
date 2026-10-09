import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { JobManager } from '../app/manager.js';
import { JOBS_DIR } from '../app/utils.js';
import { inspectionFromMetadata } from '../app/youtube.js';
import { commentsOnlyContext, analysisPrompt, synthesisPrompt } from '../app/comments.js';

const info = inspectionFromMetadata({title:'A Short',duration:30,comment_count:1},
  {url:'https://www.youtube.com/watch?v=SskpzE422pQ',videoId:'SskpzE422pQ'});
const choice={id:'manual:en',language:'en',label:'English',key:'en',source:'manual'};
class TestManager extends JobManager {
  process() {}
  async log() {}
}
function cleanup(t,j){t.after(()=>fs.rm(path.join(JOBS_DIR,j.id),{recursive:true,force:true}));}

test('captionless inspection preserves metadata and comment availability',()=>{
  assert.deepEqual(info.captions,[]);
  assert.equal(info.defaultCaptionId,null);
  assert.equal(info.commentCount,1);
  assert.equal(info.title,'A Short');
});

test('comments-only prompts prohibit claims about unavailable video content',()=>{
  const context=commentsOnlyContext({title:'A Short'});
  for(const prompt of [analysisPrompt(context,[],{hasVideoContext:false}),synthesisPrompt(context,[],{hasVideoContext:false})]){
    assert.match(prompt,/Attribute claims to commenters/);
    assert.match(prompt,/Return no videoTimestamps/);
    assert.match(prompt,/video content was not available/i);
  }
});

test('independent comment jobs are reusable and later summaries keep their reports',async t=>{
  const manager=new TestManager();
  const j=await manager.create(info,null,{commentsOnly:true});cleanup(t,j);
  assert.equal(j.status,'not_summarized');
  assert.deepEqual(manager.queue,[]);
  assert.equal((await manager.create(info,null,{commentsOnly:true})).id,j.id);
  await manager.analyzeComments(j.id);
  assert.equal(j.comments.status,'queued');
  j.comments={status:'completed',hasReport:true,hasVideoContext:false};
  manager.commentQueue=[];
  const summary=await manager.create(info,choice);
  assert.equal(summary.id,j.id);
  assert.equal(summary.status,'queued');
  assert.equal(summary.comments.hasReport,true);
  assert.equal(summary.comments.hasVideoContext,false);
  assert.deepEqual(manager.commentQueue,[]);
  assert.deepEqual(manager.queue,[j.id]);
});

test('video retry keeps comment reports and waits for the previous run to stop',async t=>{
  const manager=new TestManager();
  const j=await manager.create(info,choice,{commentsOnly:true});cleanup(t,j);
  j.status='cancelled';
  j.comments={status:'completed',hasReport:true,hasVideoContext:false};
  manager.active={type:'summary',jobId:j.id};
  await assert.rejects(manager.retry(j,info,choice,false),/previous video summary run to stop/);
  assert.deepEqual(manager.queue,[]);
  manager.active=null;
  const retried=await manager.retry(j,info,choice,false);
  assert.equal(retried.id,j.id);
  assert.equal(j.comments.hasReport,true);
  assert.equal(j.comments.hasVideoContext,false);
  assert.deepEqual(manager.queue,[j.id]);
  await assert.rejects(manager.retry(j,info,choice,false),/Only failed or cancelled/);
  assert.deepEqual(manager.queue,[j.id]);
});

test('positive and unknown counts allow analysis, while zero is rejected',async t=>{
  const manager=new TestManager();
  await assert.rejects(manager.create({...info,commentCount:0},null,{commentsOnly:true}),/No comments/);
  const j=await manager.create({...info,commentCount:null},null,{commentsOnly:true});cleanup(t,j);
  await manager.analyzeComments(j.id);
  assert.equal(j.comments.status,'queued');
  j.comments.status='not_analyzed';j.status='failed';
  await manager.analyzeComments(j.id);
  assert.equal(j.comments.status,'queued');
});

test('comments-only analysis produces labeled artifacts without transcript files',async t=>{
  let calls=0;
  const manager=new TestManager({fetchComments:async()=>({reportedCount:1,comments:[{id:'one',parent:'root',text:'Useful firsthand experience',author:'Viewer'}]})});
  manager.runPi=async(_system,prompt)=>{
    calls++;assert.match(prompt,/COMMENTS-ONLY ANALYSIS/);
    return {text:JSON.stringify({overview:'A commenter shares experience.',findings:[{title:'Experience',summary:'A commenter reports a result.',relationship:'corrects',matchingCommentIds:['one'],evidenceCommentIds:['one'],videoTimestamps:['00:01']}],keyTakeaways:[],caveats:[]}),model:'test',usage:null};
  };
  const j=await manager.create(info,null,{commentsOnly:true});cleanup(t,j);
  await manager.runCommentJob(j,'analyze');
  assert.equal(calls,1);
  assert.equal(j.status,'not_summarized');
  assert.equal(j.comments.status,'completed');
  assert.equal(j.comments.hasVideoContext,false);
  const dir=path.join(JOBS_DIR,j.id,j.comments.artifactDir);
  assert.match(await fs.readFile(path.join(dir,'comment-summary.md'),'utf8'),/Comments-only analysis: video content was not available/);
  const record=JSON.parse(await fs.readFile(path.join(dir,'comment-analysis.json'),'utf8'));
  assert.equal(record.result.findings[0].relationship,'adjacent context');
  assert.deepEqual(record.result.findings[0].videoTimestamps,[]);
});

test('existing completed video context is used and a refresh adopts new context',async t=>{
  const manager=new TestManager({fetchComments:async()=>({reportedCount:1,comments:[{id:'one',parent:'root',text:'Useful correction',author:'Viewer'}]})});
  const modes=[];
  manager.runPi=async(_system,prompt)=>{
    modes.push(prompt.includes('COMMENTS-ONLY ANALYSIS'));
    return {text:JSON.stringify({overview:'Discussion',findings:[],keyTakeaways:[],caveats:[]}),model:'test'};
  };
  const j=await manager.create(info,choice,{commentsOnly:true});cleanup(t,j);
  await manager.runCommentJob(j,'analyze');
  const dir=path.join(JOBS_DIR,j.id);
  await fs.writeFile(path.join(dir,'summary.md'),'Known video summary');
  await fs.writeFile(path.join(dir,'transcript-timestamped.txt'),'[00:01] Known content');
  j.status='completed';
  assert.equal(j.comments.hasVideoContext,false);
  assert.equal((await manager.create(info,choice,{commentsOnly:true})).id,j.id);
  await manager.runCommentJob(j,'refresh');
  assert.deepEqual(modes,[true,false]);
  assert.equal(j.comments.hasVideoContext,true);
});

test('retry preserves comments-only context after a video summary becomes available',async t=>{
  let fetches=0,calls=0;
  const manager=new TestManager({fetchComments:async()=>{fetches++;return {reportedCount:1,comments:[{id:'one',parent:'root',text:'Useful experience',author:'Viewer'}]};}});
  manager.runPi=async(_system,prompt)=>{
    calls++;assert.match(prompt,/COMMENTS-ONLY ANALYSIS/);
    if(calls===1)throw new Error('Temporary model failure');
    return {text:JSON.stringify({overview:'Discussion',findings:[],keyTakeaways:[],caveats:[]}),model:'test'};
  };
  const j=await manager.create(info,null,{commentsOnly:true});cleanup(t,j);
  await manager.runCommentJob(j,'analyze');
  assert.equal(j.comments.status,'failed');
  j.status='completed';
  await fs.writeFile(path.join(JOBS_DIR,j.id,'summary.md'),'New video summary');
  await fs.writeFile(path.join(JOBS_DIR,j.id,'transcript-timestamped.txt'),'[00:01] New content');
  await manager.runCommentJob(j,'retry');
  assert.equal(fetches,1);
  assert.equal(j.comments.status,'completed');
  assert.equal(j.comments.hasVideoContext,false);
});

test('empty or inaccessible comments do not call the model',async t=>{
  for(const reportedCount of [0,null]){
    const manager=new TestManager({fetchComments:async()=>({reportedCount,comments:[]})});
    manager.runPi=async()=>{assert.fail('Model must not be called');};
    const j=await manager.create(info,null,{commentsOnly:true});cleanup(t,j);
    await manager.runCommentJob(j,'analyze');
    if(reportedCount===0){
      assert.equal(j.comments.status,'completed');
      assert.match(await fs.readFile(path.join(JOBS_DIR,j.id,j.comments.artifactDir,'comment-summary.md'),'utf8'),/No accessible comments were found/);
    }else{
      assert.equal(j.comments.status,'failed');
      assert.match(j.comments.error,/Comments could not be retrieved/);
    }
  }
});
