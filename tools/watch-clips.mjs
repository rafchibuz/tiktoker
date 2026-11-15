import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import {fetchTwitch} from '../src/twitch-http.mjs';

export function groupClips(clips) {
  const groups = [];
  for (const c of [...clips].sort((a,b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))) {
    const located = c.video_id && Number.isFinite(c.vod_offset) && c.duration > 0;
    const matches = other => {
      if (!located || !other.video_id || !Number.isFinite(other.vod_offset)) return false;
      const overlap = Math.max(0, Math.min(c.vod_offset+c.duration, other.vod_offset+other.duration)-Math.max(c.vod_offset,other.vod_offset));
      return c.broadcaster_id === other.broadcaster_id && c.video_id === other.video_id && overlap / Math.min(c.duration,other.duration) >= 0.6;
    };
    // Complete-link matching avoids chains that merge unrelated adjacent events.
    let g = groups.find(g => g.clips.every(matches) && Math.max(c.vod_offset+c.duration,...g.clips.map(x=>x.vod_offset+x.duration))-Math.min(c.vod_offset,...g.clips.map(x=>x.vod_offset)) <= 120);
    if (!g) { g = {id:c.id, status:located?'interval_candidate':'awaiting_offset', clips:[]}; groups.push(g); }
    g.clips.push(c);
  }
  return groups.map(g => ({...g, unique_creators:new Set(g.clips.map(c=>c.creator_id)).size,
    representative_id:[...g.clips].sort((a,b)=>b.duration-a.duration || b.view_count-a.view_count || a.id.localeCompare(b.id))[0].id,
    reason:g.status==='awaiting_offset'?'No source timeline; not merged by creation time':'All intervals overlap >=60% of shorter clip; content review still required'}));
}

export function ingest(state, clips, now) {
  let added = 0;
  for (const c of clips) {
    const old = state.clips[c.id];
    if (!old) added++;
    state.clips[c.id] = {...c, first_seen_at:old?.first_seen_at ?? now, last_seen_at:now,
      discovery:old?.discovery ?? (!state.baseline_complete ? 'baseline' :
        state.observation_started_at && Date.parse(c.created_at)<Date.parse(state.observation_started_at) ? 'backfill' : 'live')};
  }
  return added;
}

function refreshRequest(dir) {
  try { const value=JSON.parse(fs.readFileSync(path.join(dir,'refresh-request.json'),'utf8'));return typeof value.id==='string'?value:null; }
  catch(e) { if(e.code==='ENOENT'||e instanceof SyntaxError)return null;throw e; }
}

export async function waitForRefreshRequest(dir,intervalMs,lastId,{wait=sleep}={}) {
  const deadline=Date.now()+intervalMs;
  while(Date.now()<deadline) {
    const request=refreshRequest(dir);
    if(request&&request.id!==lastId)return request.id;
    await wait(Math.min(250,deadline-Date.now()));
  }
  return null;
}

const iso = ms => new Date(ms).toISOString();
const esc = s => String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function save(dir, state) {
  fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'state.tmp'),JSON.stringify(state,null,2));
  fs.renameSync(path.join(dir,'state.tmp'),path.join(dir,'state.json'));
  const groups=groupClips(Object.values(state.clips));
  fs.writeFileSync(path.join(dir,'moments.json'),JSON.stringify(groups,null,2));
  fs.writeFileSync(path.join(dir,'report.html'),`<!doctype html><meta charset="utf-8"><title>Twitch clip observer</title><style>body{font:16px system-ui;background:#10121a;color:#eee;max-width:1100px;margin:40px auto}article{background:#202432;padding:20px;margin:14px 0;border-radius:12px}a{color:#a9bbff}small{color:#b8bcc8}</style><h1>Клипы Twitch: ${esc(state.channel)}</h1><p>Обновлено: ${esc(state.last_poll_at)} · ${Object.keys(state.clips).length} клипов · ${groups.length} предварительных моментов</p><p>Группы по таймкодам — гипотезы. Полнота сюжета и совпадение контента пока не проверены. Обновите страницу для новых данных.</p>${groups.map(g=>`<article><b>${esc(g.status)} · ${g.clips.length} клипов · ${g.unique_creators} авторов</b><p>${esc(g.reason)}</p>${g.clips.map(c=>`<p><a href="https://clips.twitch.tv/${encodeURIComponent(c.id)}">${esc(c.title)}</a> ${c.id===g.representative_id?'★':''}<br><small>Создан: ${esc(c.created_at)}; обнаружен: ${esc(c.first_seen_at)}; VOD: ${esc(c.video_id)}; начало: ${esc(c.vod_offset)}; длина: ${esc(c.duration)} с</small></p>`).join('')}</article>`).join('')}`);
  return groups;
}

export async function main(argv=process.argv.slice(2)) {
  const args={};
  for(let i=0;i<argv.length;i+=2) { if(!argv[i].startsWith('--') || !argv[i+1]) throw Error('Expected --option value'); args[argv[i].slice(2)]=argv[i+1]; }
  const channel=(args.channel || 'ravshann').toLowerCase();
  if(!/^[a-zA-Z0-9_]+$/.test(channel)) throw Error('Invalid channel');
  const seconds=Number(args.seconds??120), interval=Number(args.interval??15), lookback=Number(args['lookback-minutes']??60);
  if(![seconds,interval,lookback].every(Number.isFinite) || seconds<0 || interval<5 || lookback<=0) throw Error('Invalid numeric options');
  const dir=path.resolve(args.output || `output/clip-watch/${channel}`);
  fs.mkdirSync(dir,{recursive:true});
  const event = data => {
    const line=JSON.stringify({at:iso(Date.now()),...data});
    console.log(line);
    fs.appendFileSync(path.join(dir,'events.jsonl'),line+'\n');
  };
  const cfg=args['credentials-file']?JSON.parse(fs.readFileSync(args['credentials-file'],'utf8').replace(/^\uFEFF/,'' )).twitch:{};
  const clientId=process.env.TWITCH_CLIENT_ID || cfg.clientId;
  const secret=process.env.TWITCH_CLIENT_SECRET || cfg.clientSecret;
  if(!clientId || !secret) throw Error('Missing Twitch client credentials');
  let token;
  async function authorize() {
    const r=await fetchTwitch('https://id.twitch.tv/oauth2/token',{method:'POST',body:new URLSearchParams({client_id:clientId,client_secret:secret,grant_type:'client_credentials'})});
    if(!r.ok) throw Error(`Twitch authentication HTTP ${r.status}`);
    token=(await r.json()).access_token;
  }
  async function api(endpoint,params) {
    for(let attempt=0;attempt<4;attempt++) {
      const r=await fetchTwitch(`https://api.twitch.tv/helix/${endpoint}?${new URLSearchParams(params)}`,{headers:{'Client-Id':clientId,Authorization:`Bearer ${token}`}});
      if(r.status===401 && attempt<3) {await authorize();continue;}
      if(r.status===429 && attempt<3) {await sleep(Math.min(60000,Math.max(1000,Number(r.headers.get('Ratelimit-Reset'))*1000-Date.now()+1000)));continue;}
      if(r.status>=500 && attempt<3) {await sleep(1000*2**attempt);continue;}
      if(!r.ok) throw Error(`Twitch ${endpoint} HTTP ${r.status}`);
      return await r.json();
    }
    throw Error('API retry limit reached');
  }
  await authorize();
  const user=(await api('users',{login:channel})).data[0];
  if(!user) throw Error('Channel not found');
  let stream=(await api('streams',{user_id:user.id})).data[0]??null;
  event({event:'channel',channel,live:!!stream,stream_started_at:stream?.started_at??null});
  const stateFile=path.join(dir,'state.json');
  const state=fs.existsSync(stateFile)?JSON.parse(fs.readFileSync(stateFile,'utf8')):{channel,clips:{}};
  if(state.channel!==channel) throw Error('Output folder belongs to another channel');
  // Older diagnostic snapshots predate discovery labels; treat them as baseline.
  const firstSnapshot=Object.values(state.clips).map(c=>c.first_seen_at).filter(Boolean).sort()[0];
  state.observation_started_at ??= firstSnapshot ?? iso(Date.now());
  for(const clip of Object.values(state.clips)) clip.discovery ??= clip.first_seen_at===firstSnapshot?'baseline':'live';
  for(const clip of Object.values(state.clips)) if(clip.discovery==='live' && Date.parse(clip.created_at)<Date.parse(state.observation_started_at)) clip.discovery='backfill';
  if(Object.keys(state.clips).length) state.baseline_complete=true;
  const started=Date.now();
  let poll=0;
  async function windowClips(start,end) {
    let after='', clips=[];
    do {
      const page=await api('clips',{broadcaster_id:user.id,started_at:iso(start),ended_at:iso(end),first:'100',...(after?{after}:{})});
      clips.push(...page.data); after=page.pagination?.cursor??'';
      if(clips.length>=900) {
        if(end-start<=60000) throw Error('Clip volume exceeds safe pagination within one minute; coverage incomplete');
        const mid=Math.floor((start+end)/120000)*60000;
        return [...await windowClips(start,mid),...await windowClips(mid,end)];
      }
    } while(after);
    return clips;
  }
  do {
    try {
    const now=Date.now();
    const request=refreshRequest(dir);
    if(poll>0 && poll%4===0) stream=(await api('streams',{user_id:user.id})).data[0]??null;
    // API truncates query bounds to minutes: include the entire current minute.
    const end=(Math.floor(now/60000)+1)*60000;
    const back=(poll%20===0?lookback:10)*60000;
    const start=Math.floor(Math.min(now-back,state.last_poll_at?Date.parse(state.last_poll_at)-600000:now-back)/60000)*60000;
    const found=await windowClips(start,end);
    if(request?.clip_id){
      const direct=(await api('clips',{id:request.clip_id})).data[0];
      if(!direct)throw Error('Клип пока не доступен по прямому ID в Twitch API');
      if(direct.broadcaster_id!==user.id)throw Error('Этот клип принадлежит другому каналу');
      if(!found.some(c=>c.id===direct.id))found.push(direct);
    }
    const oldIds=new Set(Object.keys(state.clips));
    let added=ingest(state,found,iso(Date.now()));
    const unresolved=Object.values(state.clips).filter(c=>(!c.video_id || !Number.isFinite(c.vod_offset)) && Date.now()-Date.parse(c.created_at)<86400000);
    for(let i=0;i<unresolved.length;i+=100) {
      const refreshed=await api('clips',unresolved.slice(i,i+100).map(c=>['id',c.id]));
      ingest(state,refreshed.data,iso(Date.now()));
    }
    state.last_poll_at=iso(now); state.stream=stream; state.last_error=null;
    if(request)state.last_refresh_request_id=request.id;
    for(const c of found) if(!oldIds.has(c.id)) { oldIds.add(c.id); event({event:'clip_discovered',id:c.id,created_at:c.created_at,discovery:state.clips[c.id].discovery}); }
    state.baseline_complete=true;
    const groups=save(dir,state);
    event({event:'poll',at:iso(now),added,total:Object.keys(state.clips).length,groups:groups.length,unresolved:groups.filter(g=>g.status==='awaiting_offset').length});
    } catch(e) {
      state.last_error={at:iso(Date.now()),message:e.message};
      save(dir,state); event({event:'poll_error',message:e.message});
      if(seconds===0) throw e;
    }
    poll++;
    if(seconds===0 || Date.now()-started>=seconds*1000) break;
    await waitForRefreshRequest(dir,Math.min(interval*1000,Math.max(0,seconds*1000-(Date.now()-started))),state.last_refresh_request_id);
  } while(true);
  event({event:'complete',report:path.join(dir,'report.html')});
}

export function acquireLock(dir) {
  fs.mkdirSync(dir,{recursive:true});
  const file=path.join(dir,'observer.lock');
  if(fs.existsSync(file)) {
    let previous;
    try { previous=JSON.parse(fs.readFileSync(file,'utf8')); } catch { throw Error('Invalid observer lock; inspect before restarting'); }
    let alive=true;
    try { process.kill(previous.pid,0); } catch(e) { if(e.code==='ESRCH') alive=false; }
    if(alive) throw Error('An observer is already running for this output folder');
    fs.unlinkSync(file);
  }
  fs.writeFileSync(file,JSON.stringify({pid:process.pid,started_at:iso(Date.now())}),{flag:'wx'});
  return ()=> { if(fs.existsSync(file)) { const lock=JSON.parse(fs.readFileSync(file,'utf8')); if(lock.pid===process.pid) fs.unlinkSync(file); } };
}

if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  const argv=process.argv.slice(2);
  const value=(name,fallback)=>{const i=argv.indexOf('--'+name);return i<0?fallback:argv[i+1];};
  let release;
  try {
    const channel=value('channel','ravshann').toLowerCase();
    if(!/^[a-z0-9_]+$/.test(channel)) throw Error('Invalid channel');
    release=acquireLock(path.resolve(value('output',`output/clip-watch/${channel}`)));
    process.on('exit',()=>release());
    for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>process.exit(0));
    main().catch(e=>{console.error(`Observer failed: ${e.message}`);process.exitCode=1;}).finally(()=>release());
  } catch(e) { console.error(`Observer failed: ${e.message}`);process.exitCode=1; }
}
