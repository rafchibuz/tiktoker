import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {groupClips} from '../tools/watch-clips.mjs';
import {MediaQueue} from './media-queue.mjs';
import {RenderQueue} from './render-queue.mjs';
import {analyzeStream,createTwitchClient,parseStreamLink} from './stream-analysis.mjs';
import {addChannel,importClip,manualClips,parseClipLink,registeredChannels} from './manual-clips.mjs';
import {TikTokPublisher} from './tiktok.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const validChannel=s=>typeof s==='string' && /^[a-z0-9_]{1,25}$/.test(s);
export function clipIdFromLink(value,channel){
  if(typeof value!=='string'||value.length>500)return null;
  try {const url=new URL(value.trim());if(url.protocol!=='https:')return null;
    let id=null;
    if(url.hostname==='clips.twitch.tv')id=url.pathname.split('/')[1];
    else if(url.hostname==='www.twitch.tv'||url.hostname==='twitch.tv'){
      const parts=url.pathname.split('/').filter(Boolean);
      if(parts[0]?.toLowerCase()===channel&&parts[1]==='clip')id=parts[2];
    }
    return id&&/^[A-Za-z0-9_-]{5,120}$/.test(id)?id:null;
  }catch{return null;}
}
function readJson(file,fallback) {try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}}
function writeJson(file,data) {fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file+'.tmp',JSON.stringify(data,null,2));fs.renameSync(file+'.tmp',file);}

export function createApp({dataRoot=path.join(root,'output'),allowSpawn=true,publicOrigin=process.env.PUBLIC_ORIGIN,twitchApi=null}={}) {
  const children=new Map();
  const statuses=new Map();
  const refreshes=new Map();
  const reviewFile=path.join(dataRoot,'reviews.json');
  const reviews=()=>readJson(reviewFile,{});
  const channelDir=channel=>path.join(dataRoot,'clip-watch',channel);
  const stateFor=channel=>{const state=readJson(path.join(channelDir(channel),'state.json'),{channel,clips:{}});return {...state,clips:{...state.clips,...manualClips(dataRoot,channel)}};};
  const twitch=()=>twitchApi??createTwitchClient(dataRoot);
  const mediaQueue=new MediaQueue(dataRoot);
  const renderQueue=new RenderQueue(dataRoot,mediaQueue);
  const tiktoks={production:new TikTokPublisher(dataRoot,renderQueue,{origin:publicOrigin}),sandbox:new TikTokPublisher(dataRoot,renderQueue,{origin:publicOrigin,environment:'sandbox'})};
  const tiktokFor=environment=>{if(!['production','sandbox'].includes(environment))throw Error('Выбери Production или Sandbox');return tiktoks[environment];};
  function running(channel) {
    if(children.has(channel)) return true;
    const lock=readJson(path.join(channelDir(channel),'observer.lock'),null);
    if(!lock)return false;
    try {process.kill(lock.pid,0);return true;}catch{return false;}
  }
  function channels() {
    const dir=path.join(dataRoot,'clip-watch');
    const found=fs.existsSync(dir)?fs.readdirSync(dir,{withFileTypes:true}).filter(x=>x.isDirectory()&&validChannel(x.name)).map(x=>x.name):[];
    return [...new Set(['ravshann','leva2k','shadowkekw',...registeredChannels(dataRoot),...found])].map(channel=>{
      const s=stateFor(channel),clips=Object.values(s.clips);
      return {channel,running:running(channel),live:!!s.stream,last_poll_at:s.last_poll_at??null,last_error:s.last_error??null,
        process:statuses.get(channel)??null,total:clips.length,new_count:clips.filter(c=>c.discovery==='live').length,
        unresolved:clips.filter(c=>!c.video_id||!Number.isFinite(c.vod_offset)).length};
    });
  }
  async function body(req) {
    let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>262144)throw Error('Request too large');}
    return JSON.parse(raw||'{}');
  }
  const server=http.createServer(async(req,res)=>{
    const send=(status,data,type='application/json; charset=utf-8')=>{
      res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});
      res.end(type.startsWith('application/json')?JSON.stringify(data):data);
    };
    try {
      const host=req.headers.host??'';
      if(!/^(127\.0\.0\.1|localhost):\d+$/.test(host))return send(403,{error:'Local host required'});
      const origin=req.headers.origin;
      if(origin && origin!==`http://${host}` && origin!==publicOrigin)return send(403,{error:'Cross-origin request refused'});
      const url=new URL(req.url,`http://${host}`);
      if(req.method==='POST' && (req.headers['x-tiktoker-request']!=='1' || !String(req.headers['content-type']).startsWith('application/json')))return send(403,{error:'Local application request required'});
      if(req.method==='GET' && url.pathname==='/api/tiktok/status'){
        try{const tiktok=tiktokFor(url.searchParams.get('environment')??'production');return send(200,{...tiktok.status(),publications:tiktok.publications()});}catch(e){return send(400,{error:e.message});}
      }
      if(req.method==='POST' && url.pathname==='/api/tiktok/config'){
        try{const data=await body(req);return send(200,tiktokFor(data.environment??'production').configure(data));}catch(e){return send(400,{error:e.message});}
      }
      if(req.method==='GET' && url.pathname==='/tiktok/connect'){
        try{res.writeHead(302,{Location:tiktokFor(url.searchParams.get('environment')??'production').authorize(),'Cache-Control':'no-store'});return res.end();}catch(e){return send(400,{error:e.message});}
      }
      if(req.method==='GET' && url.pathname==='/tiktok/callback'){
        try{if(url.searchParams.has('error'))throw Error('Авторизация TikTok отклонена');const state=url.searchParams.get('state')??'',environment=state.startsWith('sandbox_')?'sandbox':'production';await tiktoks[environment].exchange(url.searchParams.get('code'),state);res.writeHead(302,{Location:`/tiktok/settings?tiktok=${environment}-connected`,'Cache-Control':'no-store'});return res.end();}
        catch(e){return send(400,`Ошибка TikTok: ${e.message}`,'text/plain; charset=utf-8');}
      }
      if(req.method==='GET' && url.pathname==='/api/tiktok/creator'){
        try{return send(200,{creator:await tiktokFor(url.searchParams.get('environment')??'production').creator()});}catch(e){return send(502,{error:e.message});}
      }
      if(req.method==='POST' && url.pathname==='/api/tiktok/publish'){
        try{const data=await body(req);return send(200,{publication:await tiktokFor(data.environment??'production').publish(data)});}catch(e){return send(400,{error:e.message});}
      }
      if(req.method==='POST' && url.pathname==='/api/tiktok/publication/refresh'){
        try{const data=await body(req);return send(200,{publication:await tiktokFor(data.environment??'production').refreshStatus(data.render_id)});}catch(e){return send(400,{error:e.message});}
      }
      if(['GET','HEAD'].includes(req.method) && /^\/tiktok\/media\/[a-f0-9]{24}\/\d{10,13}\/[a-f0-9]{64}$/.test(url.pathname)){
        const [, , ,id,expires,signature]=url.pathname.split('/');const file=tiktoks.production.mediaFile(id,expires,signature)??tiktoks.sandbox.mediaFile(id,expires,signature);if(!file)return send(404,{error:'Video unavailable'});
        const size=fs.statSync(file).size;let start=0,end=size-1,status=200;
        if(req.headers.range){const match=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);if(!match||!match[1]&&!match[2]){res.writeHead(416,{'Content-Range':`bytes */${size}`});return res.end();}if(!match[1])start=Math.max(0,size-Number(match[2]));else{start=Number(match[1]);if(match[2])end=Math.min(end,Number(match[2]));}if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=size){res.writeHead(416,{'Content-Range':`bytes */${size}`});return res.end();}status=206;}
        res.writeHead(status,{'Content-Type':'video/mp4','Accept-Ranges':'bytes','Content-Length':end-start+1,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...(status===206?{'Content-Range':`bytes ${start}-${end}/${size}`}:{})});if(req.method==='HEAD')return res.end();const stream=fs.createReadStream(file,{start,end});stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());return stream.pipe(res);
      }
      if(req.method==='GET' && url.pathname==='/api/channels')return send(200,{channels:channels()});
      if(req.method==='POST' && url.pathname==='/api/channels/add'){
        try{const data=await body(req),channel=await addChannel(dataRoot,data.channel,twitch());return send(200,{channel});}catch(e){return send(400,{error:e.message});}
      }
      if(req.method==='POST' && url.pathname==='/api/stream/analyze'){
        const data=await body(req);
        if(!parseStreamLink(data.url))return send(400,{error:'Вставь ссылку на Twitch VOD или канал'});
        try{return send(200,await analyzeStream(data.url,{api:twitch()}));}
        catch(e){return send(502,{error:e.message});}
      }
      if(req.method==='POST' && url.pathname==='/api/clips/refresh'){
        const data=await body(req),channel=data.channel;
        if(!validChannel(channel))return send(400,{error:'Некорректный канал'});
        if(!allowSpawn)return send(403,{error:'Ручной опрос отключён'});
        if(!running(channel))return send(409,{error:'Сначала включи наблюдение за каналом'});
        let task=refreshes.get(channel);
        if(!task){task=(async()=>{
          const before=stateFor(channel),previous=new Set(Object.keys(before.clips)),id=randomUUID(),requestedAt=Date.now();
          writeJson(path.join(channelDir(channel),'refresh-request.json'),{id,at:new Date(requestedAt).toISOString()});
          while(Date.now()-requestedAt<30000){
            const current=stateFor(channel);
            if(current.last_refresh_request_id===id){const clips=Object.values(current.clips),added=clips.filter(c=>!previous.has(c.id)),latest=clips.sort((a,b)=>b.created_at.localeCompare(a.created_at))[0];return {ok:true,added:added.length,new_live:added.filter(c=>c.discovery==='live').length,total:clips.length,last_poll_at:current.last_poll_at,latest_created_at:latest?.created_at??null};}
            if(current.last_error&&Date.parse(current.last_error.at)>=requestedAt)throw Error(`Twitch не ответил: ${current.last_error.message}`);
            if(!running(channel))throw Error('Наблюдение остановилось до завершения опроса');
            await delay(250);
          }
          throw Error('Опрос Twitch не завершился за 30 секунд. Попробуй ещё раз.');
        })().finally(()=>refreshes.delete(channel));refreshes.set(channel,task);}
        try{return send(200,await task);}catch(e){return send(503,{error:e.message});}
      }
      if(req.method==='POST' && url.pathname==='/api/clips/import'){
        const data=await body(req);if(!parseClipLink(data.url)||data.approve!==undefined&&typeof data.approve!=='boolean')return send(400,{error:'Вставь ссылку на Twitch-клип'});
        try{const {channel,clip}=await importClip(dataRoot,data.url,twitch());let job=null;
          if(data.approve){const all=reviews();all[`${channel}:${clip.id}`]={status:'shortlisted',updated_at:new Date().toISOString()};writeJson(reviewFile,all);job=mediaQueue.enqueue(channel,clip.id);}
          return send(200,{ok:true,channel,id:clip.id,title:clip.title,created_at:clip.created_at,discovery:'manual',review:reviews()[`${channel}:${clip.id}`]?.status??'pending',job_id:job?.id??null});
        }catch(e){return send(502,{error:e.message});}
      }
      if(req.method==='GET' && url.pathname==='/api/pipeline')return send(200,mediaQueue.snapshot());
      if(req.method==='GET' && url.pathname==='/api/render-queue')return send(200,renderQueue.snapshot());
      if(req.method==='GET' && url.pathname==='/api/montage'){
        const decisions=reviews(),pipeline=mediaQueue.snapshot(),rendering=renderQueue.snapshot();
        return send(200,{jobs:pipeline.jobs.filter(j=>j.status!=='duplicate'&&decisions[`${j.channel}:${j.clip_id}`]?.status==='shortlisted'),matches:pipeline.matches,worker:{media:pipeline.worker,render:rendering.worker},renders:rendering.renders,approvals:rendering.approvals});
      }
      if(req.method==='GET' && url.pathname==='/api/editor'){
        try{return send(200,renderQueue.editor(url.searchParams.get('job')));}catch(e){return send(400,{error:e.message});}
      }
      if(req.method==='POST' && url.pathname==='/api/subtitles/generate'){
        const data=await body(req);try{return send(200,{transcript:await renderQueue.generateSubtitles(data.job_id)});}catch(e){return send(400,{error:e.message});}
      }
      if(req.method==='POST' && url.pathname==='/api/subtitles/edit'){
        const data=await body(req);try{return send(200,{transcript:renderQueue.editSubtitles(data.job_id,data.words,data.revision)});}catch(e){return send(400,{error:e.message});}
      }
      if(req.method==='POST' && url.pathname==='/api/editor/draft'){
        const data=await body(req);try{return send(200,{draft:renderQueue.saveDraft(data.job_id,data.recipe,data.revision)});}catch(e){return send(400,{error:e.message});}
      }
      if(req.method==='POST' && url.pathname==='/api/editor/profile'){
        const data=await body(req);try{return send(200,{profile:renderQueue.profile(data.job_id,data.recipe,data.auto_render)});}catch(e){return send(400,{error:e.message});}
      }
      if(req.method==='POST' && url.pathname==='/api/editor/post'){
        const data=await body(req);try{return send(200,{post:renderQueue.savePost(data.job_id,data.post)});}catch(e){return send(400,{error:e.message});}
      }
      if(req.method==='POST' && url.pathname==='/api/editor/description-template'){
        const data=await body(req);try{return send(200,{template:renderQueue.saveDescriptionTemplate(data.job_id,data.description_template)});}catch(e){return send(400,{error:e.message});}
      }
      if(req.method==='POST' && url.pathname==='/api/render'){
        const data=await body(req);try{return send(200,{render:renderQueue.enqueue(data.job_id,data.recipe,data.revision)});}catch(e){return send(400,{error:e.message});}
      }
      if(req.method==='POST' && url.pathname==='/api/render/retry'){
        const data=await body(req);try{return send(200,{render:renderQueue.retry(data.id)});}catch(e){return send(400,{error:e.message});}
      }
      if(req.method==='POST' && url.pathname==='/api/render/review'){
        const data=await body(req);try{renderQueue.review(data.id,data.decision);return send(200,{ok:true});}catch(e){return send(400,{error:e.message});}
      }
      if(req.method==='POST' && url.pathname==='/api/prepare') {
        const data=await body(req);
        if(!validChannel(data.channel))return send(400,{error:'Invalid channel'});
        try{return send(200,{job:mediaQueue.enqueue(data.channel,data.id)});}catch(e){return send(400,{error:e.message});}
      }
      if(req.method==='POST' && url.pathname==='/api/pipeline/settings') {
        const data=await body(req);try{mediaQueue.setAuto(data.auto_prepare);return send(200,{ok:true});}catch(e){return send(400,{error:e.message});}
      }
      if(req.method==='POST' && url.pathname==='/api/pipeline/retry') {
        const data=await body(req);try{return send(200,{job:mediaQueue.retry(data.id)});}catch(e){return send(400,{error:e.message});}
      }
      if(req.method==='POST' && url.pathname==='/api/pipeline/resolve') {
        const data=await body(req);try{mediaQueue.resolve(data.id,data.decision,data.keep_job);return send(200,{ok:true});}catch(e){return send(400,{error:e.message});}
      }
      if(req.method==='GET' && /^\/api\/media\/[a-f0-9]{24}$/.test(url.pathname)) {
        const id=url.pathname.split('/').pop(),job=mediaQueue.state.jobs[id];
        const file=path.join(dataRoot,'media',id,job?.media?.preview?'preview.mp4':'source.mp4');
        if(!job?.media||!fs.existsSync(file))return send(404,{error:'Video not ready'});
        const size=fs.statSync(file).size;let start=0,end=size-1,status=200;
        if(req.headers.range){
          const match=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
          if(!match||!match[1]&&!match[2]){res.writeHead(416,{'Content-Range':`bytes */${size}`});return res.end();}
          if(!match[1])start=Math.max(0,size-Number(match[2]));
          else{start=Number(match[1]);if(match[2])end=Math.min(end,Number(match[2]));}
          if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=size){res.writeHead(416,{'Content-Range':`bytes */${size}`});return res.end();}
          status=206;
        }
        res.writeHead(status,{'Content-Type':'video/mp4','Accept-Ranges':'bytes','Content-Length':end-start+1,'Cache-Control':'private, no-store',...(status===206?{'Content-Range':`bytes ${start}-${end}/${size}`}:{})});
        const stream=fs.createReadStream(file,{start,end});stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());return stream.pipe(res);
      }
      if(req.method==='GET' && /^\/api\/render-media\/[a-f0-9]{24}$/.test(url.pathname)){
        const id=url.pathname.split('/').pop(),item=renderQueue.state.renders[id];
        const file=path.join(dataRoot,'renders',id,'video.mp4');
        if(item?.status!=='ready'||!fs.existsSync(file))return send(404,{error:'Video not ready'});
        const size=fs.statSync(file).size;let start=0,end=size-1,status=200;
        if(req.headers.range){const match=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
          if(!match||!match[1]&&!match[2]){res.writeHead(416,{'Content-Range':`bytes */${size}`});return res.end();}
          if(!match[1])start=Math.max(0,size-Number(match[2]));else{start=Number(match[1]);if(match[2])end=Math.min(end,Number(match[2]));}
          if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=size){res.writeHead(416,{'Content-Range':`bytes */${size}`});return res.end();}status=206;
        }
        res.writeHead(status,{'Content-Type':'video/mp4','Accept-Ranges':'bytes','Content-Length':end-start+1,'Cache-Control':'private, no-store',...(status===206?{'Content-Range':`bytes ${start}-${end}/${size}`}:{})});
        const stream=fs.createReadStream(file,{start,end});stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());return stream.pipe(res);
      }
      if(req.method==='GET' && url.pathname==='/api/clips') {
        const channel=url.searchParams.get('channel');if(!validChannel(channel))return send(400,{error:'Invalid channel'});
        const state=stateFor(channel),decisions=reviews(),groups=groupClips(Object.values(state.clips));
        return send(200,{channel,updated_at:state.last_poll_at??null,groups:groups.map(g=>({...g,clips:g.clips.map(c=>({...c,review:decisions[`${channel}:${c.id}`]??{status:'pending'}}))}))});
      }
      if(req.method==='POST' && url.pathname==='/api/review') {
        const data=await body(req);
        if(!validChannel(data.channel)||typeof data.id!=='string'||!['pending','shortlisted','rejected'].includes(data.status))return send(400,{error:'Invalid review'});
        if(!stateFor(data.channel).clips[data.id])return send(404,{error:'Clip not found'});
        const all=reviews();all[`${data.channel}:${data.id}`]={status:data.status,updated_at:new Date().toISOString()};writeJson(reviewFile,all);
        if(data.status==='shortlisted')mediaQueue.enqueue(data.channel,data.id);
        if(data.status!=='shortlisted'){
          mediaQueue.cancel(data.channel,data.id);
          const job=Object.values(mediaQueue.state.jobs).find(j=>j.channel===data.channel&&j.clip_id===data.id);
          if(job)renderQueue.invalidateSource(job.id);
        }
        return send(200,{ok:true});
      }
      if(req.method==='POST' && url.pathname==='/api/observe') {
        const data=await body(req);if(!validChannel(data.channel)||!['start','stop'].includes(data.action))return send(400,{error:'Invalid observer action'});
        if(!allowSpawn)return send(403,{error:'Observer control disabled'});
        if(data.action==='stop') {
          const child=children.get(data.channel);
          if(!child)return send(409,{error:'This observer was started outside the panel'});
          child.kill();return send(200,{ok:true});
        }
        if(running(data.channel))return send(409,{error:'Observer is already running'});
        const credentials=path.join(dataRoot,'.secrets','twitch.json');
        if(!fs.existsSync(credentials))return send(400,{error:'Add Twitch credentials to output/.secrets/twitch.json'});
        const child=spawn(process.execPath,[path.join(root,'tools/watch-clips.mjs'),'--channel',data.channel,'--credentials-file',credentials,'--output',channelDir(data.channel),'--seconds','14400'],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
        children.set(data.channel,child);statuses.set(data.channel,{state:'starting',error:null});
        child.stdout.on('data',()=>statuses.set(data.channel,{state:'running',error:null}));
        child.stderr.on('data',chunk=>statuses.set(data.channel,{state:'error',error:chunk.toString().slice(0,300)}));
        child.on('error',()=>{children.delete(data.channel);statuses.set(data.channel,{state:'error',error:'Could not start observer'});});
        child.on('exit',code=>{children.delete(data.channel);const old=statuses.get(data.channel);statuses.set(data.channel,{state:code===0?'stopped':'error',error:old?.error??(code?'Observer exited':'')});});
        return send(200,{ok:true});
      }
      if(req.method==='GET' && url.pathname==='/fonts/komika-title-axis-rus-lat.otf')return send(200,fs.readFileSync(path.join(root,'web','fonts','komika-title-axis-rus-lat.otf')),'font/otf');
      const assets={'/':'index.html','/studio':'index.html','/montage':'montage.html','/editor':'montage.html','/analysis':'analysis.html','/tiktok/settings':'tiktok-settings.html','/tiktok-settings.js':'tiktok-settings.js','/app.js':'app.js','/editor.js':'editor.js','/analysis.js':'analysis.js','/composition.js':'composition.js','/style.css':'style.css'};
      if(req.method==='GET' && assets[url.pathname]) {
        const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'};
        return send(200,fs.readFileSync(path.join(root,'web',assets[url.pathname])),types[path.extname(assets[url.pathname])]);
      }
      return send(404,{error:'Not found'});
    }catch(e){console.error('Request failed:',e.code??e.name);send(500,{error:'Request failed; see local server log'});}
  });
  if(allowSpawn)server.once('listening',()=>{mediaQueue.start();renderQueue.start();});
  const shutdown=()=>{renderQueue.stop();mediaQueue.stop();for(const child of children.values())child.kill();server.close();};
  return {server,shutdown,mediaQueue,renderQueue};
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const port=Number(process.env.PORT??4317);
  if(!Number.isInteger(port)||port<1024||port>65535)throw Error('Invalid PORT');
  const app=createApp();
  app.server.listen(port,'127.0.0.1',()=>console.log(`ТикТокер: http://127.0.0.1:${port}`));
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>app.shutdown());
}
