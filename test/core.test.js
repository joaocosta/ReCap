import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizeYouTube } from '../app/utils.js';
import { cleanJson3 } from '../app/youtube.js';
import { renderMarkdown } from '../app/render.js';
import { prepareCommentSnapshot, commentInput, makeBatches, validateAnalysis, reportMarkdown } from '../app/comments.js';

test('canonicalizes videos and Shorts while dropping playlist data', () => {
  assert.equal(canonicalizeYouTube('https://youtube.com/watch?v=dQw4w9WgXcQ&list=abc').url, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(canonicalizeYouTube('https://youtube.com/shorts/dQw4w9WgXcQ').videoId, 'dQw4w9WgXcQ');
  assert.throws(() => canonicalizeYouTube('https://youtube.com/playlist?list=abc'), /Playlist-only/);
  assert.throws(() => canonicalizeYouTube('https://evil.example/watch?v=dQw4w9WgXcQ'));
});

test('cleans exact rolling overlap without semantic editing', () => {
  const raw=JSON.stringify({events:[
    {tStartMs:0,dDurationMs:1000,segs:[{utf8:'hello world'}]},
    {tStartMs:1000,dDurationMs:1000,segs:[{utf8:'hello world again'}]},
    {tStartMs:2000,dDurationMs:1000,segs:[{utf8:'again'}]}
  ]});
  const result=cleanJson3(raw);
  assert.match(result.timestamped,/\[00:01\] again/);
  assert.equal(result.clean.trim(),'hello world again again');
});

test('renderer blocks HTML, images, and unsafe links; links timestamps', () => {
  const html=renderMarkdown('<script>x</script> ![x](https://bad/img) [bad](javascript:alert(1)) [00:10]',{videoId:'dQw4w9WgXcQ',duration:20});
  assert.doesNotMatch(html,/<script|<img|href="javascript:/);
  assert.match(html,/youtube\.com\/watch\?v=dQw4w9WgXcQ&amp;t=10s/);
});

test('comment snapshots preserve threads and exclude only mechanical noise', () => {
  const snapshot=prepareCommentSnapshot('dQw4w9WgXcQ',{reportedCount:4,comments:[
    {id:'a',parent:'root',text:'A useful correction',author:'One'},
    {id:'b',parent:'a',text:'Thanks',author:'Uploader',author_is_uploader:true},
    {id:'c',parent:'root',text:'👍',author:'Two'},
    {id:'d',parent:'root',text:'Short but useful',author:'Three'}
  ]},'2026-01-01T00:00:00.000Z');
  assert.equal(snapshot.threadCount,3);
  assert.equal(snapshot.analyzedCount,3);
  assert.equal(snapshot.comments.find(c=>c.id==='c').excludedReason,'emoji-only reaction');
  assert.equal(makeBatches(snapshot).length,1);
});

test('contact details remain archived but are redacted from model input', () => {
  const snapshot=prepareCommentSnapshot('dQw4w9WgXcQ',{reportedCount:1,comments:[
    {id:'a',parent:'root',text:'Email me at person@example.com or +44 7700 900123',author:'One'}
  ]});
  assert.match(snapshot.comments[0].text,/person@example\.com/);
  assert.doesNotMatch(commentInput(snapshot.threads[0])[0].text,/person@example\.com|7700/);
});

test('hard comment limit drops the boundary thread instead of splitting it', () => {
  const comments=Array.from({length:10_000},(_,i)=>({id:`c${i}`,parent:'root',text:`Useful comment ${i}`,author:'Viewer'}));
  const snapshot=prepareCommentSnapshot('dQw4w9WgXcQ',{reportedCount:10_001,comments});
  assert.equal(snapshot.limitReached,true);
  assert.equal(snapshot.fetchedCount,9_999);
  assert.equal(snapshot.omittedApprox,2);
});

test('comment analysis rejects invented evidence and derives exact counts', () => {
  const snapshot=prepareCommentSnapshot('dQw4w9WgXcQ',{reportedCount:2,comments:[
    {id:'parent1',parent:'root',text:'The unit is oversized',author:'Viewer'},
    {id:'reply',parent:'parent1',text:'It should be smaller',author:'Creator',author_is_uploader:true}
  ]});
  const result=validateAnalysis({overview:'Useful discussion',findings:[
    {title:'Sizing',summary:'The thread challenges sizing.',relationship:'challenges',matchingCommentIds:['parent1','reply','invented'],evidenceCommentIds:['reply','invented'],videoTimestamps:['00:10','99:00'],verificationNeeded:true}
  ]},snapshot,60);
  assert.deepEqual(result.findings[0].evidenceCommentIds,['reply']);
  assert.deepEqual(result.findings[0].videoTimestamps,['00:10']);
  const markdown=reportMarkdown({videoId:'dQw4w9WgXcQ'},result,snapshot,'now');
  assert.match(markdown,/2 comments across 1 thread/);
  assert.doesNotMatch(markdown,/invented/);
});
