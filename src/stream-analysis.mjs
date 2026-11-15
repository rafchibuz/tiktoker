import fs from 'node:fs';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fetchTwitch} from './twitch-http.mjs';

export function parseStreamLink(value){
  if(typeof value!=='string'||value.length>500)return null;
  try{
    const url=new URL(value.trim());
    if(url.protocol!=='https:'||!['twitch.tv','www.twitch.tv','m.twitch.tv'].includes(url.hostname))return null;
    const parts=url.pathname.split('/').filter(Boolean);
    if(parts[0]==='videos'&&/^\d{4,20}$/.test(parts[1]??'')&&parts.length===2)return {videoId:parts[1]};
    if(parts.length===1&&/^[a-z0-9_]{1,25}$/i.test(parts[0]))return {channel:parts[0].toLowerCase()};
  }catch{}
  return null;
}

export function durationSeconds(value){
  const match=/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(value??'');
  return match&&match[0]?Number(match[1]??0)*3600+Number(match[2]??0)*60+Number(match[3]??0):NaN;
}

export function groupStreamClips(clips,windowSeconds=5){
  const groups=[];
  for(const clip of [...clips].sort((a,b)=>a.created_at.localeCompare(b.created_at)||a.id.localeCompare(b.id))){
    const located=Number.isFinite(clip.vod_offset)&&clip.video_id;
    const key=located?clip.vod_offset:Date.parse(clip.created_at)/1000;
    let group=groups.find(g=>g.located===!!located&&(!located||g.video_id===clip.video_id)&&g.clips.every(other=>{
      if(!located)return Math.abs(key-Date.parse(other.created_at)/1000)<=windowSeconds;
      const overlap=Math.max(0,Math.min(clip.vod_offset+clip.duration,other.vod_offset+other.duration)-Math.max(clip.vod_offset,other.vod_offset));
      return Math.abs(key-other.vod_offset)<=windowSeconds||overlap/Math.min(clip.duration,other.duration)>=0.6;
    })&&(!located||Math.max(clip.vod_offset+clip.duration,...g.clips.map(c=>c.vod_offset+c.duration))-Math.min(clip.vod_offset,...g.keys)<=120));
    if(!group){group={located:!!located,video_id:located?clip.video_id:null,keys:[],clips:[]};groups.push(group);}
    group.keys.push(key);group.clips.push(clip);
  }
  return groups.map(g=>({id:g.clips[0].id,approximate:!g.located,offset:g.located?Math.min(...g.keys):null,clips:g.clips.sort((a,b)=>b.view_count-a.view_count||a.id.localeCompare(b.id)),max_views:Math.max(...g.clips.map(c=>c.view_count)),total_views:g.clips.reduce((n,c)=>n+c.view_count,0)})).sort((a,b)=>b.max_views-a.max_views||b.total_views-a.total_views);
}

export function createTwitchClient(dataRoot,{request=fetchTwitch,wait=delay}={}){
  const file=path.join(dataRoot,'.secrets','twitch.json');
  const cfg=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'' )).twitch??{}:{};
  const clientId=process.env.TWITCH_CLIENT_ID||cfg.clientId,secret=process.env.TWITCH_CLIENT_SECRET||cfg.clientSecret;
  if(!clientId||!secret)throw Error('Добавь Twitch-ключи в output/.secrets/twitch.json');
  let token;
  async function authorize(){const r=await request('https://id.twitch.tv/oauth2/token',{method:'POST',body:new URLSearchParams({client_id:clientId,client_secret:secret,grant_type:'client_credentials'})});if(!r.ok)throw Error(`Twitch OAuth: HTTP ${r.status}`);token=(await r.json()).access_token;}
  return async function api(endpoint,params){
    if(!token)await authorize();
    for(let attempt=0;attempt<4;attempt++){
      const r=await request(`https://api.twitch.tv/helix/${endpoint}?${new URLSearchParams(params)}`,{headers:{'Client-Id':clientId,Authorization:`Bearer ${token}`}});
      if(r.status===401&&attempt<3){await authorize();continue;}
      if(r.status===429&&attempt<3){await wait(Math.min(60000,Math.max(1000,Number(r.headers.get('Ratelimit-Reset'))*1000-Date.now()+1000)));continue;}
      if(r.status>=500&&attempt<3){await wait(1000*2**attempt);continue;}
      if(!r.ok)throw Error(`Twitch ${endpoint}: HTTP ${r.status}`);
      return r.json();
    }
    throw Error('Twitch временно недоступен');
  };
}

export async function analyzeStream(link,{api,now=()=>Date.now()}={}){
  const target=parseStreamLink(link);
  if(!target)throw Error('Вставь ссылку на Twitch VOD или канал');
  if(!api)throw Error('Twitch API unavailable');
  let stream,channel,userId;
  if(target.videoId){
    const video=(await api('videos',{id:target.videoId})).data[0];
    if(!video||video.type!=='archive')throw Error('Запись эфира не найдена. Нужен Twitch VOD типа archive.');
    const seconds=durationSeconds(video.duration);
    if(!Number.isFinite(seconds)||seconds<=0)throw Error('Twitch не сообщил длительность записи');
    stream={id:video.id,title:video.title,start:video.created_at,end:new Date(Date.parse(video.created_at)+seconds*1000).toISOString(),url:video.url,live:false};
    channel=video.user_login.toLowerCase();userId=video.user_id;
  }else{
    channel=target.channel;
    const user=(await api('users',{login:channel})).data[0];
    if(!user)throw Error('Канал Twitch не найден');
    userId=user.id;
    const live=(await api('streams',{user_id:userId})).data[0];
    if(live){stream={id:live.id,title:live.title,start:live.started_at,end:new Date(now()).toISOString(),url:`https://www.twitch.tv/${channel}`,live:true};}
    else{
      const video=(await api('videos',{user_id:userId,type:'archive',sort:'time',first:'1'})).data[0];
      if(!video)throw Error('У канала нет доступной записи эфира. Вставь ссылку на VOD.');
      const seconds=durationSeconds(video.duration);
      if(!Number.isFinite(seconds)||seconds<=0)throw Error('Twitch не сообщил длительность записи');
      stream={id:video.id,title:video.title,start:video.created_at,end:new Date(Date.parse(video.created_at)+seconds*1000).toISOString(),url:video.url,live:false};
    }
  }
  const startMs=Date.parse(stream.start),endMs=Date.parse(stream.end);
  if(!Number.isFinite(startMs)||!Number.isFinite(endMs)||endMs<=startMs||endMs-startMs>48*3600000)throw Error('Некорректные границы эфира');
  const clips=new Map();let truncated=false;
  for(let from=startMs;from<endMs;from+=3600000){
    const to=Math.min(endMs,from+3600000),params={broadcaster_id:userId,started_at:new Date(from).toISOString(),ended_at:new Date(to).toISOString(),first:'100'};
    let cursor;
    for(let page=0;page<10;page++){
      const result=await api('clips',cursor?{...params,after:cursor}:params);
      for(const clip of result.data??[]){
        if(clip.video_id&& !stream.live && clip.video_id!==stream.id)continue;
        if(!clip.video_id&&(Date.parse(clip.created_at)<startMs||Date.parse(clip.created_at)>endMs))continue;
        clips.set(clip.id,clip);
      }
      cursor=result.pagination?.cursor;
      if(!cursor)break;
      if(page===9)truncated=true;
    }
  }
  const ranked=[...clips.values()].sort((a,b)=>b.view_count-a.view_count);
  return {stream,channel,clips:ranked,groups:groupStreamClips(ranked),truncated,analyzed_at:new Date(now()).toISOString()};
}
