import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizeYouTube } from '../app/utils.js';
import { cleanJson3 } from '../app/youtube.js';
import { renderMarkdown } from '../app/render.js';

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
