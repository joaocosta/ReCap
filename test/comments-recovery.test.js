import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JobManager } from '../app/manager.js';
import { parseModelJson } from '../app/comments.js';

const valid=JSON.stringify({overview:'Discussion',findings:[],keyTakeaways:[],caveats:[]});
async function fixture(t,responses) {
  const work=await fs.mkdtemp(path.join(os.tmpdir(),'comment-recovery-'));
  t.after(()=>fs.rm(work,{recursive:true,force:true}));
  const manager=new JobManager();
  const prompts=[];
  manager.commentStage=async()=>{};
  manager.runPi=async(_system,prompt)=>{prompts.push(prompt);return {text:responses.shift(),model:'test',usage:{output:1}};};
  const j={duration:30,comments:{status:'analyzing'}};
  const usages=[];
  return {work,prompts,usages,run:()=>manager.runCommentAnalysis(j,work,'system','original prompt',{comments:[]},()=>{},usages)};
}

test('unwraps one valid object without repairing syntax or choosing objects',()=>{
  assert.deepEqual(parseModelJson('```json\n'+valid+'\n```'),JSON.parse(valid));
  assert.deepEqual(parseModelJson('Here is the result: '+valid+' End.'),JSON.parse(valid));
  assert.equal(parseModelJson('Result: {"text":"brace } and escaped \\\" quote"}').text,'brace } and escaped " quote');
  for(const text of ['{"a":[1 2]}','{"a":1,}',"{'a':1}",'{"a":1',valid+' '+valid])assert.throws(()=>parseModelJson(text));
});

test('retries malformed JSON with feedback and removes private diagnostics on recovery',async t=>{
  const f=await fixture(t,['{"findings":[1 2]}',valid]);
  assert.deepEqual((await f.run()).analysis.findings,[]);
  assert.equal(f.prompts.length,2);
  assert.match(f.prompts[1],/previous response failed validation/);
  assert.equal(f.usages.length,2);
  await assert.rejects(fs.access(path.join(f.work,'failed-model-response.json')));
});

test('caps attempts, retains latest response, and hides parser errors',async t=>{
  const f=await fixture(t,['first invalid','second invalid','{"a":[1 2]}']);
  await assert.rejects(f.run(),err=>{
    assert.match(err.message,/completed batches are saved/);
    assert.doesNotMatch(err.message,/Expected|position|SyntaxError/);
    return true;
  });
  assert.equal(f.prompts.length,3);
  const saved=JSON.parse(await fs.readFile(path.join(f.work,'failed-model-response.json'),'utf8'));
  assert.equal(saved.attempt,3);
  assert.equal(saved.response,'{"a":[1 2]}');
});

test('schema and invented evidence failures also trigger retries',async t=>{
  const invented=JSON.stringify({overview:'Discussion',findings:[{title:'X',summary:'X',relationship:'adds context',matchingCommentIds:['invented'],evidenceCommentIds:['invented'],videoTimestamps:[]}],keyTakeaways:[],caveats:[]});
  const f=await fixture(t,['{}',invented,valid]);
  await f.run();
  assert.equal(f.prompts.length,3);
  assert.match(f.prompts[2],/eligible supporting and evidence/);
});

test('transport errors do not cause structured-output retries',async t=>{
  const f=await fixture(t,[]);
  // Exercise the production helper with a failing transport separately.
  const manager=new JobManager();
  let calls=0;
  manager.runPi=async()=>{calls++;throw new Error('Transport failed');};
  await assert.rejects(manager.runCommentAnalysis({comments:{status:'analyzing'}},f.work,'','',{comments:[]},()=>{},[]),/Transport failed/);
  assert.equal(calls,1);
});
