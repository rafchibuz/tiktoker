import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {downloadClip,createPreview} from './media-tools.mjs';
import {fingerprint,compareFingerprints} from './fingerprint.mjs';
import {manualClips} from './manual-clips.mjs';

const now=()=>new Date().toISOString();
const read=(file,fallback)=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}};
const write=(file,data)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file+'.tmp',JSON.stringify(data,null,2));fs.renameSync(file+'.tmp',file);};
const keyFor=(channel,id)=>createHash('sha256').update(`${channel}:${id}`).digest('hex').slice(0,24);
export class MediaQueue {
  constructor(dataRoot,{download=downloadClip,makeFingerprint=fingerprint,makePreview=createPreview,compare=compareFingerprints}={}) {
    this.root=dataRoot;this.file=path.join(dataRoot,'media-queue.json');this.download=download;this.makeFingerprint=makeFingerprint;this.makePreview=makePreview;this.compare=compare;
    this.state=read(this.file,{version:1,settings:{auto_prepare:false,auto_since:now()},jobs:{},matches:{}});
    this.busy=false;this.stopped=true;
  }
  save(){write(this.file,this.state);}
  source(channel,id){return manualClips(this.root,channel)[id]??read(path.join(this.root,'clip-watch',channel,'state.json'),{clips:{}}).clips[id];}
  enqueue(channel,id){
    if(!/^[a-z0-9_]{1,25}$/.test(channel)||typeof id!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(id))throw Error('Некорректный канал или клип');
    const clip=this.source(channel,id);if(!clip)throw Error('Клип не найден');
    const key=keyFor(channel,id);let job=this.state.jobs[key];
    if(!job){job={id:key,channel,clip_id:id,title:clip.title,duration:clip.duration,status:'queued',created_at:now(),updated_at:now(),attempts:0};this.state.jobs[key]=job;this.save();}
    else if(job.status==='cancelled'){job.status='queued';delete job.cancel_requested;job.updated_at=now();this.save();}
    return job;
  }
  cancel(channel,id){const job=this.state.jobs[keyFor(channel,id)];if(!job||!['queued','downloading','analyzing'].includes(job.status))return;job.cancel_requested=true;job.status='cancelled';job.updated_at=now();if(this.activeId===job.id)this.controller?.abort();this.save();}
  retry(id){const job=this.state.jobs[id];if(!job||job.status!=='failed')throw Error('Повтор доступен только для ошибки');job.status='queued';job.error=null;job.updated_at=now();this.save();return job;}
  setAuto(value){if(typeof value!=='boolean')throw Error('Некорректная настройка');if(value&&!this.state.settings.auto_prepare)this.state.settings.auto_since=now();this.state.settings.auto_prepare=value;this.save();}
  scan(){
    const dir=path.join(this.root,'clip-watch'),reviews=read(path.join(this.root,'reviews.json'),{});
    if(!fs.existsSync(dir))return;
    for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
      if(!entry.isDirectory()||!/^[a-z0-9_]{1,25}$/.test(entry.name))continue;
      const state=read(path.join(dir,entry.name,'state.json'),{clips:{}});
      for(const clip of Object.values({...state.clips,...manualClips(this.root,entry.name)})){
        const review=reviews[`${entry.name}:${clip.id}`]?.status;
        if(review==='rejected')continue;
        if(review==='shortlisted')this.enqueue(entry.name,clip.id);
      }
    }
  }
  rootJob(id){const seen=new Set();while(this.state.jobs[id]?.duplicate_of){if(seen.has(id))throw Error('Цикл дублей');seen.add(id);id=this.state.jobs[id].duplicate_of;}return id;}
  recompute(){for(const job of Object.values(this.state.jobs)){if(!job.media||['queued','downloading','analyzing','failed','cancelled'].includes(job.status))continue;if(job.duplicate_of)job.status='duplicate';else job.status=Object.values(this.state.matches).some(m=>m.status==='needs_review'&&m.jobs.includes(job.id))?'needs_review':'ready';}}
  resolve(matchId,decision,keepId){
    const match=this.state.matches[matchId];if(!match||match.status!=='needs_review')throw Error('Совпадение уже обработано или отсутствует');
    if(decision==='distinct'){match.status='distinct';}
    else if(decision==='duplicate'){
      if(!match.jobs.includes(keepId))throw Error('Нужно выбрать сохраняемый клип');
      const keep=this.rootJob(keepId),other=this.rootJob(match.jobs.find(x=>x!==keepId));
      if(keep!==other)this.state.jobs[other].duplicate_of=keep;
      match.status='confirmed';match.keep_job=keep;
    } else throw Error('Неизвестное решение');
    match.reviewed_at=now();this.recompute();this.save();
  }
  renderCandidates(){const decisions=read(path.join(this.root,'reviews.json'),{});return Object.values(this.state.jobs).filter(j=>j.status==='ready'&&!j.duplicate_of&&decisions[`${j.channel}:${j.clip_id}`]?.status==='shortlisted').map(j=>j.id);}
  snapshot(){return {settings:this.state.settings,worker:{running:!this.stopped,busy:this.busy,error:this.workerError??null},render_candidates:this.renderCandidates(),jobs:Object.values(this.state.jobs).map(j=>({...j,media:j.media?{...j.media,url:`/api/media/${j.id}`} :null})),matches:Object.values(this.state.matches)};}
  async processNext(){
    if(this.busy||this.stopped)return;
    const job=Object.values(this.state.jobs).find(j=>j.status==='queued');if(!job)return;
    this.busy=true;this.activeId=job.id;this.controller=new AbortController();const options={signal:this.controller.signal};
    try{
      const disk=fs.statfsSync(this.root);if(disk.bavail*disk.bsize<1024**3)throw Error('Мало свободного места: требуется запас не менее 1 ГБ');
      job.status='downloading';job.error=null;job.attempts++;job.updated_at=now();this.save();
      const dir=path.join(this.root,'media',job.id),clip=this.source(job.channel,job.clip_id);
      if(!clip)throw Error('Исходный клип отсутствует в базе');
      const result=await this.download(clip,dir,options);
      job.status='analyzing';job.updated_at=now();this.save();
      await this.makePreview(result.file,dir,options);
      const fp=await this.makeFingerprint(result.file,result.info.has_audio,options);
      write(path.join(dir,'fingerprint.json'),fp);
      job.media={...result.info,sha256:result.sha256,bytes:fs.statSync(result.file).size,preview:true};
      job.status='ready';job.updated_at=now();
      for(const other of Object.values(this.state.jobs)){
        if(other.id===job.id||other.channel!==job.channel||!other.media)continue;
        const matchId=[other.id,job.id].sort().join('_');
        if(this.state.matches[matchId])continue;
        if(other.media.sha256===result.sha256){
          job.duplicate_of=this.rootJob(other.id);
          this.state.matches[matchId]={id:matchId,jobs:[other.id,job.id],method:'sha256',status:'confirmed',keep_job:job.duplicate_of,created_at:now(),reason:'Побайтово одинаковые видеофайлы'};
          break;
        }
        const otherFp=read(path.join(this.root,'media',other.id,'fingerprint.json'),null);if(!otherFp)continue;
        const match=this.compare(otherFp,fp);
        if(match)this.state.matches[matchId]={...match,id:matchId,jobs:[other.id,job.id],created_at:now(),reason:'Совпадает последовательность изображения и спектра звука. Проверьте границы обоих клипов.'};
      }
      this.recompute();this.save();
    }catch(e){
      delete job.media;
      job.status=job.cancel_requested?'cancelled':this.stopped?'queued':'failed';job.error=job.cancel_requested||this.stopped?null:e.message;job.updated_at=now();this.save();
    }finally{this.busy=false;this.activeId=null;this.controller=null;}
  }
  start(){
    if(!this.stopped)return;
    for(const job of Object.values(this.state.jobs))if(job.media&&!job.media.preview){delete job.media;job.status='queued';}
    for(const job of Object.values(this.state.jobs))if(['downloading','analyzing'].includes(job.status)){job.status='queued';job.error=null;}
    this.stopped=false;this.save();
    const tick=async()=>{if(this.stopped)return;try{this.scan();await this.processNext();this.workerError=null;}catch(e){this.workerError=e.message;}};
    this.timer=setInterval(tick,3000);tick();
  }
  stop(){this.stopped=true;clearInterval(this.timer);this.controller?.abort();}
}
