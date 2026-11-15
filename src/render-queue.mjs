import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {normalizeRecipe} from '../web/composition.js';
import {renderVertical} from './vertical-render.mjs';
import {transcribeClip,readTranscript,saveTranscriptWords} from './subtitles.mjs';
const now=()=>new Date().toISOString();
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const RENDER_STYLE_VERSION=7;
const CHANNEL_DEFAULTS={ravshann:{mode:'irl',actionFit:'cover',action:{x:0,y:0,w:1,h:1},titleY:200}};
const load=(file,fallback)=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}};
const postText=(value,max)=>String(value??'').trim().slice(0,max);
export function composeDescription(title,template){return [postText(title,120),postText(template,1800)].filter(Boolean).join('\n\n');}

export class RenderQueue{
 constructor(dataRoot,mediaQueue,{render=renderVertical,transcribe=transcribeClip}={}){this.root=dataRoot;this.file=path.join(dataRoot,'renders.json');this.mediaQueue=mediaQueue;this.render=render;this.transcribe=transcribe;this.transcribeTasks=new Map();this.state=load(this.file,{version:1,drafts:{},renders:{},profiles:{},approvals:{}});this.stopped=true;this.busy=false;
  this.state.posts??={};
  if(!this.state.subtitle_opt_in_migrated){for(const draft of Object.values(this.state.drafts))if((draft.recipe?.version??0)<5)draft.recipe.subtitles=false;for(const profile of Object.values(this.state.profiles))if((profile.recipe?.version??0)<5)profile.recipe.subtitles=false;this.state.subtitle_opt_in_migrated=true;this.save();}
 }
 save(){fs.mkdirSync(this.root,{recursive:true});fs.writeFileSync(this.file+'.tmp',JSON.stringify(this.state,null,2));fs.renameSync(this.file+'.tmp',this.file);}
 source(id){const job=this.mediaQueue.state.jobs[id];if(!job?.media)throw Error('Сначала подготовь исходник');return job;}
 descriptionTemplate(channel){return this.state.profiles[channel]?.description_template??`${channel} #${channel} #twitch #clips`;}
 getPost(id){const job=this.source(id),saved=this.state.posts[id],template=this.descriptionTemplate(job.channel);return saved??{description:composeDescription(job.title,template),cover_second:0,updated_at:null};}
 savePost(id,raw){const job=this.source(id),description=postText(raw?.description,2200),cover=Number(raw?.cover_second);if(!description)throw Error('Добавь описание ролика');if(!Number.isFinite(cover)||cover<0||cover>job.media.duration)throw Error('Выбери кадр обложки внутри клипа');const old=this.getPost(id);if(old.description!==description||old.cover_second!==cover)delete this.state.approvals[id];this.state.posts[id]={description,cover_second:cover,updated_at:now()};this.save();return this.state.posts[id];}
 saveDescriptionTemplate(id,value){const job=this.source(id),profile=this.state.profiles[job.channel]??{channel:job.channel};profile.description_template=postText(value,1800);this.state.profiles[job.channel]=profile;this.save();return {channel:job.channel,description_template:profile.description_template};}
 transcript(id){const job=this.source(id);return readTranscript(path.join(this.root,'subtitles',id),job.media.sha256);}
 generateSubtitles(id){const job=this.source(id);if(this.transcribeTasks.has(id))return this.transcribeTasks.get(id);const task=this.transcribe(path.join(this.root,'media',id,'source.mp4'),path.join(this.root,'subtitles',id),job.media).finally(()=>this.transcribeTasks.delete(id));this.transcribeTasks.set(id,task);return task;}
 editSubtitles(id,words,revision){const job=this.source(id),updated=saveTranscriptWords(path.join(this.root,'subtitles',id),job.media.sha256,job.media.duration,words,revision);delete this.state.approvals[id];for(const item of Object.values(this.state.renders))if(item.job_id===id&&item.recipe.subtitles&&['queued','rendering'].includes(item.status)){item.status='cancelled';item.error='Слова субтитров изменены';if(this.activeId===item.id)this.controller?.abort();}this.save();return updated;}
 recipeHash(id,recipe){const job=this.source(id),transcript=recipe.subtitles?this.transcript(id):null;if(recipe.subtitles&&!transcript)throw Error('Сначала создай субтитры для этого клипа');return hash({recipe,source:job.media.sha256,style:RENDER_STYLE_VERSION,words:transcript?.words??null});}
 getDraft(id){const job=this.source(id),saved=this.state.drafts[id],profile=this.state.profiles[job.channel];return saved?{...saved,recipe:normalizeRecipe(saved.recipe,job.media)}:{revision:0,recipe:normalizeRecipe({...CHANNEL_DEFAULTS[job.channel],...profile?.recipe,title:[...(job.title??'')].slice(0,120).join(''),start:0,end:job.media.duration},job.media)};}
 saveDraft(id,raw,expectedRevision){const job=this.source(id),old=this.getDraft(id);if(expectedRevision!==undefined&&expectedRevision!==old.revision)throw Error('Черновик изменился. Обнови редактор перед сохранением.');const recipe=normalizeRecipe(raw,job.media);if(hash(recipe)===hash(old.recipe)&&this.state.drafts[id]){const stored=this.state.drafts[id];if(hash(stored.recipe)!==hash(recipe)){stored.recipe=recipe;this.save();}return stored;}const draft={revision:old.revision+1,recipe,updated_at:now()};this.state.drafts[id]=draft;delete this.state.approvals[id];this.save();return draft;}
 enqueue(id,raw,expectedRevision){
  if(!this.mediaQueue.renderCandidates().includes(id))throw Error('Сначала разреши совпадения и верни клип из отклонённых');
  const draft=this.saveDraft(id,raw,expectedRevision),recipeHash=this.recipeHash(id,draft.recipe),renderId=hash({job:id,recipeHash}).slice(0,24);
  if(!this.state.renders[renderId]){const version=Object.values(this.state.renders).filter(r=>r.job_id===id).length+1;this.state.renders[renderId]={id:renderId,job_id:id,version,style_version:RENDER_STYLE_VERSION,recipe_hash:recipeHash,recipe:draft.recipe,transcript:draft.recipe.subtitles?this.transcript(id):null,status:'queued',created_at:now(),attempts:0};}
  else if(this.state.renders[renderId].status==='cancelled'){this.state.renders[renderId].status='queued';this.state.renders[renderId].error=null;}
  this.save();return this.state.renders[renderId];
 }
 retry(id){const item=this.state.renders[id];if(!item||item.status!=='failed')throw Error('Повтор доступен только для ошибки');item.status='queued';item.error=null;this.save();return item;}
 review(id,decision){
  const item=this.state.renders[id];if(!item||item.status!=='ready')throw Error('Видео ещё не готово');
  if(!['approved','rejected'].includes(decision))throw Error('Неизвестное решение');
  if(decision==='approved'){
    const draft=this.getDraft(item.job_id);
    if(this.recipeHash(item.job_id,draft.recipe)!==item.recipe_hash)throw Error('Это старая версия. Сначала создай видео с текущими правками.');
    if(!this.mediaQueue.renderCandidates().includes(item.job_id))throw Error('Клип отклонён или требует проверки совпадения');
    this.state.approvals[item.job_id]={render_id:id,recipe_hash:item.recipe_hash,post:{...this.getPost(item.job_id)},at:now()};
  }else if(this.state.approvals[item.job_id]?.render_id===id)delete this.state.approvals[item.job_id];
  item.review={decision,at:now()};this.save();
 }
 profile(id,raw,autoRender){const job=this.source(id),recipe=normalizeRecipe(raw,job.media);const {start,end,title,subtitles,...layout}=recipe;this.state.profiles[job.channel]={...this.state.profiles[job.channel],channel:job.channel,mode:recipe.mode,recipe:layout,auto_render:!!autoRender,enabled_at:now()};this.save();return this.state.profiles[job.channel];}
 snapshot(){return {worker:{running:!this.stopped,busy:this.busy,error:this.workerError??null},profiles:this.state.profiles,approvals:this.state.approvals,renders:Object.values(this.state.renders).map(({transcript,...r})=>({...r,url:r.status==='ready'?`/api/render-media/${r.id}`:null}))};}
 editor(id){const job=this.source(id),draft=this.getDraft(id);let currentHash=null;try{currentHash=this.recipeHash(id,draft.recipe);}catch{}return {job:{...job,media:{...job.media,url:`/api/media/${job.id}`}},draft,post:this.getPost(id),description_template:this.descriptionTemplate(job.channel),transcript:this.transcript(id),current_render_hash:currentHash,profile:this.state.profiles[job.channel]??null,...this.snapshot()};}
 scan(){for(const id of this.mediaQueue.renderCandidates()){if(Object.values(this.state.renders).some(r=>r.job_id===id&&r.style_version===RENDER_STYLE_VERSION&&r.status!=='cancelled'))continue;this.enqueue(id,this.getDraft(id).recipe);}}
 invalidateSource(id){delete this.state.approvals[id];for(const r of Object.values(this.state.renders))if(r.job_id===id&&['queued','rendering'].includes(r.status)){r.status='cancelled';r.error='Исходный клип больше не одобрен';if(this.activeId===r.id)this.controller?.abort();}this.save();}
 async processNext(){
  if(this.busy||this.stopped)return;const item=Object.values(this.state.renders).find(r=>r.status==='queued');if(!item)return;
  this.busy=true;this.activeId=item.id;this.controller=new AbortController();
  try{
    if(!this.mediaQueue.renderCandidates().includes(item.job_id))throw Error('Исходник отклонён или требует проверки совпадений');
    const job=this.source(item.job_id),disk=fs.statfsSync(this.root);if(disk.bavail*disk.bsize<1024**3)throw Error('Мало места для рендера: нужен запас 1 ГБ');
    item.status='rendering';item.attempts++;item.started_at=now();item.error=null;this.save();
    const source=path.join(this.root,'media',item.job_id,'source.mp4');
    const transcript=item.transcript??(item.recipe.subtitles?this.transcript(item.job_id):null);
    if(item.recipe.subtitles&&!transcript)throw Error('Сначала создай субтитры для этого клипа');
    if(item.status==='cancelled'||this.controller.signal.aborted)return;
    const result=await this.render({source,outputDir:path.join(this.root,'renders',item.id),recipe:item.recipe,media:job.media,transcript},{signal:this.controller.signal});
    if(item.status==='cancelled')return;
    item.status='ready';item.output={...result.info,bytes:result.bytes};item.subtitle_words=transcript?.words.length??0;item.completed_at=now();this.save();
  }catch(e){if(item.status!=='cancelled'){item.status=this.stopped?'queued':'failed';item.error=this.stopped?null:e.message;this.save();}}
  finally{this.busy=false;this.activeId=null;this.controller=null;}
 }
 start(){if(!this.stopped)return;for(const r of Object.values(this.state.renders))if(r.status==='rendering')r.status='queued';this.stopped=false;this.save();const tick=async()=>{if(this.stopped)return;try{this.scan();await this.processNext();this.workerError=null;}catch(e){this.workerError=e.message;}};this.timer=setInterval(tick,3000);tick();}
 stop(){this.stopped=true;clearInterval(this.timer);this.controller?.abort();}
}
