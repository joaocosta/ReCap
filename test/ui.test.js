import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

async function appContext(fetchOverride=null){
  const elements=new Map();
  const get=selector=>{
    if(!elements.has(selector))elements.set(selector,{innerHTML:'',textContent:'',dataset:{},hidden:false,addEventListener(){},querySelectorAll(){return [];},scrollIntoView(){}});
    return elements.get(selector);
  };
  const listeners=new Map(),timers=new Map();let timerId=0;
  const context=vm.createContext({document:{querySelector:get,hidden:false,addEventListener:(event,fn)=>listeners.set(event,fn)},fetch:fetchOverride|| (async url=>({json:async()=>url==='/api/config'?{csrf:'test'}:url==='/health'?{ok:true}:[],ok:true})),AbortSignal,setTimeout:(fn)=>{timers.set(++timerId,fn);return timerId},clearTimeout:id=>timers.delete(id),console});
  vm.runInContext(await fs.readFile(new URL('../public/app.js',import.meta.url),'utf8'),context);
  await vm.runInContext('healthCheck',context);
  return {context,get,listeners,timers};
}

test('captionless preview offers independent comment analysis',async()=>{
  const {context,get}=await appContext();
  vm.runInContext(`currentInspection={title:'Short',captions:[],commentCount:null};showInspection()`,context);
  assert.match(get('#inspection').innerHTML,/This video has no supported captions/);
  assert.match(get('#inspection').innerHTML,/id="summarize" disabled/);
  assert.match(get('#inspection').innerHTML,/id="inspect-comments" >Analyze comments/);
  vm.runInContext(`currentInspection.commentCount=0;showInspection()`,context);
  assert.match(get('#inspection').innerHTML,/id="inspect-comments" disabled/);
  assert.match(get('#inspection').innerHTML,/No comments available/);
});

test('comments-only jobs have separate video and comment panels',async()=>{
  const {context,get}=await appContext();
  await vm.runInContext(`currentTab='summary';renderJob({id:'test',title:'Short',status:'not_summarized'})`,context);
  assert.match(get('#viewer').innerHTML,/Video not summarized/);
  assert.match(get('#viewer').innerHTML,/data-tab="comments"/);
  await vm.runInContext(`currentTab='comments';renderJob({id:'test',title:'Short',status:'not_summarized',commentCount:null,comments:{status:'not_analyzed',hasReport:false}})`,context);
  assert.match(get('#viewer').innerHTML,/comments and video metadata only/);
  assert.match(get('#viewer').innerHTML,/id="analyze-comments"/);
});

test('backend checks report reachability and recover the session and visible job',async()=>{
  let online=true,token='first';const requests=[];
  const {context,get}=await appContext(async(url,options)=>{
    requests.push({url,options});
    if(!online)throw new TypeError('Failed to fetch');
    return {ok:true,json:async()=>url==='/health'?{ok:true}:url==='/api/config'?{csrf:token}:[]};
  });
  assert.equal(get('#backend-status').textContent,'Backend online');
  assert.equal(get('#backend-retry').hidden,true);
  assert.equal(requests[0].options.cache,'no-store');
  assert.ok(requests[0].options.signal instanceof AbortSignal);
  await vm.runInContext(`currentInspection={inspectId:'old'};currentJob={id:'job'};viewer.hidden=false;globalThis.reopened=null;openJob=async(...args)=>{reopened=args}`,context);
  online=false;
  await vm.runInContext('checkBackend()',context);
  assert.equal(get('#backend-status').textContent,'Backend unreachable');
  assert.equal(get('#backend-help').hidden,false);
  assert.equal(get('#backend-retry').hidden,false);
  assert.equal(vm.runInContext('currentJob.id',context),'job');
  online=true;token='second';
  await get('#backend-retry').onclick();
  assert.equal(get('#backend-status').dataset.state,'online');
  assert.equal(get('#backend-help').hidden,true);
  assert.equal(vm.runInContext('csrf',context),'second');
  assert.equal(vm.runInContext('currentInspection',context),null);
  assert.equal(get('#inspection').hidden,true);
  assert.deepEqual(Array.from(context.reopened),['job','summary',false]);
});

test('backend checks reject unhealthy responses and timeouts',async()=>{
  for(const fetcher of [
    async()=>({ok:false,json:async()=>({ok:true})}),
    async()=>({ok:true,json:async()=>({ok:false})}),
    async()=>{throw new DOMException('Timed out','TimeoutError')}
  ]){
    const {get}=await appContext(fetcher);
    assert.equal(get('#backend-status').dataset.state,'offline');
    assert.equal(get('#backend-retry').hidden,false);
  }
});

test('backend polling pauses in hidden tabs and checks immediately on return',async()=>{
  let checks=0;
  const {context,listeners,timers}=await appContext(async url=>{
    if(url==='/health')checks++;
    return {ok:true,json:async()=>url==='/health'?{ok:true}:url==='/api/config'?{csrf:'test'}:[]};
  });
  assert.equal(checks,1);
  assert.equal(timers.size,1);
  const poll=[...timers.values()][0];timers.clear();poll();
  await vm.runInContext('healthCheck',context);
  assert.equal(checks,2);
  context.document.hidden=true;listeners.get('visibilitychange')();
  assert.equal(timers.size,0);
  context.document.hidden=false;listeners.get('visibilitychange')();
  await vm.runInContext('healthCheck',context);
  assert.equal(checks,3);
  assert.equal(timers.size,1);
});
