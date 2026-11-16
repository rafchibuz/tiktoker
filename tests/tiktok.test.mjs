import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {TikTokPublisher} from '../src/tiktok.mjs';

test('TikTok Direct Post uses OAuth state, approved render and signed PULL_FROM_URL',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'tiktoker-tiktok-'));
 const id='a'.repeat(24),requests=[];
 const queue={root,state:{renders:{[id]:{id,job_id:'job',status:'ready',recipe:{start:3,end:13},output:{duration:10}}},approvals:{job:{render_id:id,post:{description:'Название\n\n#twitch',cover_second:5}}}}};
 const fetcher=async(url,options)=>{requests.push({url,options});const data=url.endsWith('/oauth/token/')?{access_token:'access',refresh_token:'refresh',expires_in:7200,refresh_expires_in:86400,scope:'video.publish',open_id:'user'}:url.endsWith('/creator_info/query/')?{data:{creator_username:'owner',creator_nickname:'Owner',privacy_level_options:['PUBLIC_TO_EVERYONE','SELF_ONLY'],max_video_post_duration_sec:60},error:{code:'ok'}}:url.endsWith('/video/init/')?{data:{publish_id:'pub123'},error:{code:'ok'}}:{data:{status:'PUBLISH_COMPLETE'},error:{code:'ok'}};return {ok:true,json:async()=>data};};
 const t=new TikTokPublisher(root,queue,{origin:'https://tiktok.ravshan.tv',fetcher});
 try{
  t.configure({client_key:'clientkey123',client_secret:'secret123456'});
  const link=new URL(t.authorize()),state=link.searchParams.get('state');assert.equal(link.searchParams.get('scope'),'user.info.basic,video.publish');
  await assert.rejects(t.exchange('code','wrong'),/истёк|не совпал/);
  await t.exchange('code',state);assert.equal(t.status().connected,true);
  const folder=path.join(root,'renders',id);fs.mkdirSync(folder,{recursive:true});fs.writeFileSync(path.join(folder,'video.mp4'),'video');
  await assert.rejects(t.publish({render_id:id,privacy_level:'INVALID'}),/приватности/);
  const post=await t.publish({render_id:id,privacy_level:'PUBLIC_TO_EVERYONE'});assert.equal(post.publish_id,'pub123');
  const init=requests.find(x=>x.url.endsWith('/video/init/'));const payload=JSON.parse(init.options.body);assert.equal(payload.source_info.source,'PULL_FROM_URL');assert.equal(payload.post_info.video_cover_timestamp_ms,2000);
  const media=new URL(payload.source_info.video_url),[, , ,renderId,expiry,sig]=media.pathname.split('/');assert.equal(t.mediaFile(renderId,expiry,sig),path.join(folder,'video.mp4'));assert.equal(t.mediaFile(renderId,expiry,'0'.repeat(64)),null);
  await assert.rejects(t.publish({render_id:id,privacy_level:'PUBLIC_TO_EVERYONE'}),/уже отправлена/);
  assert.equal((await t.refreshStatus(id)).status,'PUBLISH_COMPLETE');
  const sandbox=new TikTokPublisher(root,queue,{origin:'https://tiktok.ravshan.tv',fetcher,environment:'sandbox'});
  assert.equal(sandbox.status().configured,false);assert.equal(sandbox.status().connected,false);
  sandbox.configure({client_key:'sandboxkey123',client_secret:'sandboxsecret123'});
  assert.equal(t.config.client_key,'clientkey123');
  const sandboxState=new URL(sandbox.authorize()).searchParams.get('state');assert.match(sandboxState,/^sandbox_/);
  await sandbox.exchange('sandbox-code',sandboxState);
  assert.equal(sandbox.status().connected,true);
  await assert.rejects(sandbox.publish({render_id:id,privacy_level:'PUBLIC_TO_EVERYONE'}),/только приватную/);
  const sandboxPost=await sandbox.publish({render_id:id,privacy_level:'SELF_ONLY'});assert.equal(sandboxPost.publish_id,'pub123');
  assert.equal(sandbox.publications()[id].post_info.privacy_level,'SELF_ONLY');
  assert.equal(t.publications()[id].post_info.privacy_level,'PUBLIC_TO_EVERYONE');
  queue.state.approvals.job=null;assert.equal(t.mediaFile(renderId,expiry,sig),null);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
