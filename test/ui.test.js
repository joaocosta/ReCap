import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

async function appContext(){
  const elements=new Map();
  const get=selector=>{
    if(!elements.has(selector))elements.set(selector,{innerHTML:'',textContent:'',dataset:{},hidden:false,addEventListener(){},querySelectorAll(){return [];},scrollIntoView(){}});
    return elements.get(selector);
  };
  const context=vm.createContext({document:{querySelector:get},fetch:async url=>({json:async()=>url==='/api/config'?{csrf:'test'}:[],ok:true}),console});
  vm.runInContext(await fs.readFile(new URL('../public/app.js',import.meta.url),'utf8'),context);
  return {context,get};
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
