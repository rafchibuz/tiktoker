import fs from 'node:fs';
import path from 'node:path';

const validChannel=value=>typeof value==='string'&&/^[a-z0-9_]{1,25}$/.test(value);
const read=(file,fallback)=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}};
const write=(file,data)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file+'.tmp',JSON.stringify(data,null,2));fs.renameSync(file+'.tmp',file);};
export function parseClipLink(value){
 if(typeof value!=='string'||value.length>500)return null;
 try{const url=new URL(value.trim());if(url.protocol!=='https:')return null;
  const parts=url.pathname.split('/').filter(Boolean);let id=null,channel=null;
  if(url.hostname==='clips.twitch.tv'&&parts.length===1)id=parts[0];
  else if(['twitch.tv','www.twitch.tv','m.twitch.tv'].includes(url.hostname)&&parts.length===3&&parts[1]==='clip'){channel=parts[0].toLowerCase();id=parts[2];}
  return id&&/^[A-Za-z0-9_-]{5,120}$/.test(id)&&(!channel||validChannel(channel))?{id,channel}:null;
 }catch{return null;}
}
export function parseChannel(value){
 if(typeof value!=='string')return null;const name=value.trim().toLowerCase();if(validChannel(name))return name;
 try{const url=new URL(name);const parts=url.pathname.split('/').filter(Boolean);return url.protocol==='https:'&&['twitch.tv','www.twitch.tv','m.twitch.tv'].includes(url.hostname)&&parts.length===1&&validChannel(parts[0])?parts[0]:null;}catch{return null;}
}
export function registeredChannels(root){return read(path.join(root,'channels.json'),[]).filter(validChannel);}
function rememberChannel(root,channel){const list=registeredChannels(root);if(!list.includes(channel)){list.push(channel);write(path.join(root,'channels.json'),list);}return list;}
export async function addChannel(root,value,api){const channel=parseChannel(value);if(!channel)throw Error('Введи название или ссылку на Twitch-канал');const user=(await api('users',{login:channel})).data?.[0];if(!user||user.login?.toLowerCase()!==channel)throw Error('Канал Twitch не найден');rememberChannel(root,channel);return channel;}
export function manualClips(root,channel){if(!validChannel(channel))return {};return read(path.join(root,'clip-watch',channel,'manual.json'),{clips:{}}).clips??{};}
export async function importClip(root,value,api){
 const parsed=parseClipLink(value);if(!parsed)throw Error('Вставь ссылку на Twitch-клип');
 const clip=(await api('clips',{id:parsed.id})).data?.[0];if(!clip||clip.id!==parsed.id)throw Error('Twitch пока не вернул этот клип. Проверь ссылку или повтори позже.');
 const channel=String(clip.broadcaster_login??'').toLowerCase();if(!validChannel(channel)||parsed.channel&&parsed.channel!==channel)throw Error('Канал в ссылке не совпадает с клипом Twitch');
 if(!clip.created_at||!Number.isFinite(Number(clip.duration))||Number(clip.duration)<=0)throw Error('Twitch вернул неполные данные клипа');
 const file=path.join(root,'clip-watch',channel,'manual.json'),saved=read(file,{clips:{}}),old=saved.clips?.[clip.id];
 saved.clips??={};saved.clips[clip.id]={...clip,first_seen_at:old?.first_seen_at??new Date().toISOString(),last_seen_at:new Date().toISOString(),discovery:'manual'};write(file,saved);rememberChannel(root,channel);
 return {channel,clip:saved.clips[clip.id]};
}
