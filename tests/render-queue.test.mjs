import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {RenderQueue,composeDescription} from '../src/render-queue.mjs';
import {normalizeRecipe,visibleSourceRect,pixelRect} from '../web/composition.js';

function fixture(){
 const parent=path.resolve('output/tests');fs.mkdirSync(parent,{recursive:true});
 const root=fs.mkdtempSync(path.join(parent,'render-'));
 const job={id:'clip-one',channel:'shadowkekw',title:'Первый момент',created_at:new Date().toISOString(),status:'ready',media:{duration:30,width:1920,height:1080,sha256:'source-one'}};
 const mediaQueue={state:{jobs:{[job.id]:job}},renderCandidates:()=>[job.id]};
 const calls=[];
 const render=async ({recipe})=>{calls.push(recipe);return {info:{duration:recipe.end-recipe.start,width:1080,height:1920,has_audio:true},bytes:1234};};
 return {root,job,mediaQueue,calls,render,clean:()=>fs.rmSync(root,{recursive:true})};
}

test('recipe validates duration and crop geometry',()=>{
 const media={duration:30};
 assert.throws(()=>normalizeRecipe({start:29,end:31},media),/Длина фрагмента/);
 assert.throws(()=>normalizeRecipe({start:0,end:10,camera:{x:.9,y:0,w:.2,h:.2}},media),/за границы/);
 assert.equal(normalizeRecipe({start:2,end:10},media).camera.x,0);
 assert.equal(normalizeRecipe({start:0,end:10},media).titleBand,true);
 assert.equal(normalizeRecipe({start:0,end:10,titleBand:false,titleY:900,titleTextX:-80},media).titleTextX,-80);
 assert.throws(()=>normalizeRecipe({start:0,end:10,titleY:1900},media),/Положение заголовка/);
 const irl=normalizeRecipe({mode:'irl',start:0,end:10},media);assert.equal(irl.squareSize,900);assert.equal(irl.squareX,90);assert.equal(irl.squareY,510);
 assert.equal(normalizeRecipe({mode:'irl',start:0,end:10,squareSize:1080,squareX:300},media).squareX,300);
 assert.throws(()=>normalizeRecipe({mode:'irl',start:0,end:10,squareSize:1080,squareX:900},media),/Квадрат/);
 const overscan=normalizeRecipe({mode:'irl',start:0,end:10,action:{x:.25,y:0,w:1.25,h:1}},media);
 assert.deepEqual(visibleSourceRect(overscan.action),{x:.25,y:0,w:.75,h:1});
 assert.deepEqual(pixelRect(visibleSourceRect(overscan.action),1920,1080),{x:480,y:0,w:1440,h:1080});
});

test('saved channel layout becomes the default for the next approved clip',()=>{
 const f=fixture();try{
  const q=new RenderQueue(f.root,f.mediaQueue,{render:f.render});
  q.profile(f.job.id,{...q.getDraft(f.job.id).recipe,cameraHeight:640,titleY:780,titleBand:false,titleTextX:50,title:'Не копировать'},true);
  const next={...f.job,id:'clip-two',title:'Другая история',media:{...f.job.media,sha256:'source-two'}};f.mediaQueue.state.jobs[next.id]=next;
  const draft=q.getDraft(next.id).recipe;
  assert.equal(draft.cameraHeight,640);assert.equal(draft.titleY,780);assert.equal(draft.titleBand,false);assert.equal(draft.titleTextX,50);
  assert.equal(draft.title,'Другая история');
 }finally{f.clean();}
});

test('selected template belongs only to the selected streamer',()=>{
 const f=fixture();try{
  const q=new RenderQueue(f.root,f.mediaQueue,{render:f.render});
  const chosen={...q.getDraft(f.job.id).recipe,mode:'irl',squareSize:820,squareX:150};
  const saved=q.profile(f.job.id,chosen,true);
  assert.equal(saved.channel,'shadowkekw');assert.equal(saved.mode,'irl');
  f.mediaQueue.state.jobs.other={...f.job,id:'other',channel:'leva2k',media:{...f.job.media,sha256:'other'}};
  f.mediaQueue.state.jobs.next={...f.job,id:'next',media:{...f.job.media,sha256:'next'}};
  assert.equal(q.getDraft('next').recipe.mode,'irl');
  assert.equal(q.getDraft('next').recipe.squareSize,820);
  assert.equal(q.getDraft('other').recipe.mode,'split');
 }finally{f.clean();}
});

test('description template prefixes the next clip title and stays channel-specific',()=>{
 const f=fixture();try{
  const q=new RenderQueue(f.root,f.mediaQueue,{render:f.render});
  q.saveDescriptionTemplate(f.job.id,'@shadow #twitch');
  q.profile(f.job.id,q.getDraft(f.job.id).recipe,true);
  f.mediaQueue.state.jobs.next={...f.job,id:'next',title:'Новый момент',media:{...f.job.media,sha256:'next'}};
  f.mediaQueue.state.jobs.other={...f.job,id:'other',channel:'leva2k',title:'Лёва',media:{...f.job.media,sha256:'other'}};
  assert.equal(q.getPost('next').description,'Новый момент\n\n@shadow #twitch');
  assert.equal(q.getPost('other').description,'Лёва\n\nleva2k #leva2k #twitch #clips');
  assert.equal(composeDescription('Заголовок','#tag'),'Заголовок\n\n#tag');
  q.savePost('next',{description:'Исправленный текст',cover_second:2.5});
  assert.equal(q.getPost('next').description,'Исправленный текст');
  assert.throws(()=>q.savePost('next',{description:'',cover_second:1}),/описание/);
 }finally{f.clean();}
});

test('ravshann IRL defaults to a centered square and blurred backdrop until a profile overrides it',()=>{
 const f=fixture();try{
  f.job.channel='ravshann';const q=new RenderQueue(f.root,f.mediaQueue,{render:f.render});
  const first=q.getDraft(f.job.id).recipe;assert.equal(first.mode,'irl');assert.equal(first.actionFit,'cover');assert.deepEqual(first.action,{x:0,y:0,w:1,h:1});assert.equal(first.squareX,90);assert.equal(first.squareY,510);
  q.profile(f.job.id,{...first,mode:'split'},true);
  f.mediaQueue.state.jobs['clip-two']={...f.job,id:'clip-two',media:{...f.job.media,sha256:'second'}};
  assert.equal(q.getDraft('clip-two').recipe.mode,'split');
 }finally{f.clean();}
});

test('a recipe creates one durable render; changed draft requires a new version',async()=>{
 const f=fixture();try{
  const q=new RenderQueue(f.root,f.mediaQueue,{render:f.render});
  const recipe={...q.getDraft(f.job.id).recipe,title:'Первый заголовок'};
  const first=q.enqueue(f.job.id,recipe,0);
  assert.equal(q.enqueue(f.job.id,recipe,1).id,first.id);
  q.stopped=false;await q.processNext();
  assert.equal(first.status,'ready');assert.equal(f.calls.length,1);
  q.review(first.id,'approved');assert.equal(q.state.approvals[f.job.id].render_id,first.id);
  const secondRecipe={...recipe,title:'Новый заголовок'};
  q.saveDraft(f.job.id,secondRecipe,1);
  assert.equal(q.state.approvals[f.job.id],undefined);
  assert.throws(()=>q.review(first.id,'approved'),/старая версия/);
  assert.throws(()=>q.enqueue(f.job.id,secondRecipe,1),/Черновик изменился/);
  const second=q.enqueue(f.job.id,secondRecipe,2);
  assert.notEqual(second.id,first.id);assert.equal(second.version,2);
  await q.processNext();q.review(second.id,'approved');
  const restored=new RenderQueue(f.root,f.mediaQueue,{render:f.render});
  assert.equal(restored.state.approvals[f.job.id].render_id,second.id);
  assert.equal(restored.state.renders[second.id].status,'ready');
 }finally{f.clean();}
});

test('rejected source cannot be rendered or approved',async()=>{
 const f=fixture();try{
  const q=new RenderQueue(f.root,f.mediaQueue,{render:f.render});const recipe=q.getDraft(f.job.id).recipe;
  const item=q.enqueue(f.job.id,recipe);
  q.stopped=false;await q.processNext();
  f.mediaQueue.renderCandidates=()=>[];
  assert.throws(()=>q.enqueue(f.job.id,recipe),/разреши совпадения/);
  assert.throws(()=>q.review(item.id,'approved'),/отклонён/);
 }finally{f.clean();}
});

test('revoking a clip cancels an active render and reapproval can queue it again',async()=>{
 const f=fixture();try{
  const render=(_input,{signal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}));
  const q=new RenderQueue(f.root,f.mediaQueue,{render});const recipe=q.getDraft(f.job.id).recipe;
  const item=q.enqueue(f.job.id,recipe);q.stopped=false;const running=q.processNext();
  q.invalidateSource(f.job.id);await running;assert.equal(item.status,'cancelled');
  assert.equal(q.enqueue(f.job.id,recipe).status,'queued');
 }finally{f.clean();}
});

test('automatic montage skips ASR; requested words are editable and invalidate old video',async()=>{
 const f=fixture();let transcriptions=0;
 const transcribe=async(_source,dir,media)=>{transcriptions++;fs.mkdirSync(dir,{recursive:true});const transcript={source_sha256:media.sha256,revision:0,words:[{text:'ошибка',start:1,end:2}]};fs.writeFileSync(path.join(dir,'transcript.json'),JSON.stringify(transcript));return transcript;};
 try{
  const q=new RenderQueue(f.root,f.mediaQueue,{render:f.render,transcribe});
  const plain=q.getDraft(f.job.id).recipe;assert.equal(plain.subtitles,false);
  q.enqueue(f.job.id,plain);q.stopped=false;await q.processNext();assert.equal(transcriptions,0);
  await q.generateSubtitles(f.job.id);assert.equal(transcriptions,1);
  const withCaptions={...plain,subtitles:true};q.saveDraft(f.job.id,withCaptions,1);
  const first=q.enqueue(f.job.id,withCaptions,2);await q.processNext();q.review(first.id,'approved');
  assert.equal(q.state.approvals[f.job.id].render_id,first.id);
  q.editSubtitles(f.job.id,[{text:'исправлено',start:1,end:2}],0);
  assert.equal(q.state.approvals[f.job.id],undefined);
  assert.throws(()=>q.review(first.id,'approved'),/старая версия/);
  assert.notEqual(q.enqueue(f.job.id,withCaptions,2).id,first.id);
 }finally{f.clean();}
});
