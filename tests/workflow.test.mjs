import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {once} from 'node:events';
import {createApp} from '../src/server.mjs';

test('clip approval gates preparation and creates a separate montage job',async()=>{
 const parent=path.resolve('output/tests');fs.mkdirSync(parent,{recursive:true});const dataRoot=fs.mkdtempSync(path.join(parent,'workflow-'));
 const channelDir=path.join(dataRoot,'clip-watch','shadowkekw');fs.mkdirSync(channelDir,{recursive:true});
 fs.writeFileSync(path.join(channelDir,'state.json'),JSON.stringify({channel:'shadowkekw',clips:{one:{id:'one',title:'Момент',duration:20,created_at:'2026-11-15T11:00:00Z',discovery:'live',first_seen_at:'2026-11-15T11:00:05Z'}}}));
 const app=createApp({dataRoot,allowSpawn:false});app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
 const base=`http://127.0.0.1:${app.server.address().port}`;
 const post=(url,data)=>fetch(base+url,{method:'POST',headers:{'Content-Type':'application/json','X-Tiktoker-Request':'1'},body:JSON.stringify(data)});
 try{
  app.mediaQueue.scan();assert.equal(Object.keys(app.mediaQueue.state.jobs).length,0);
  assert.equal((await(await fetch(base+'/api/montage')).json()).jobs.length,0);
  assert.equal((await post('/api/review',{channel:'shadowkekw',id:'one',status:'shortlisted'})).status,200);
  const job=Object.values(app.mediaQueue.state.jobs)[0];assert.equal(job.status,'queued');
  job.status='ready';job.media={duration:20,width:1920,height:1080,sha256:'test-source',preview:true};app.mediaQueue.save();
  app.renderQueue.scan();assert.equal(Object.values(app.renderQueue.state.renders).length,1);
  const montage=await(await fetch(base+'/api/montage')).json();assert.equal(montage.jobs[0].id,job.id);assert.equal(montage.renders[0].status,'queued');
  assert.equal((await post('/api/review',{channel:'shadowkekw',id:'one',status:'pending'})).status,200);
  assert.equal((await(await fetch(base+'/api/montage')).json()).jobs.length,0);
  assert.equal(Object.values(app.renderQueue.state.renders)[0].status,'cancelled');
  assert.equal((await post('/api/review',{channel:'shadowkekw',id:'one',status:'shortlisted'})).status,200);
  app.renderQueue.scan();assert.equal(Object.values(app.renderQueue.state.renders)[0].status,'queued');
  job.status='duplicate';app.mediaQueue.save();assert.equal((await(await fetch(base+'/api/montage')).json()).jobs.length,0);
 }finally{app.shutdown();await once(app.server,'close');fs.rmSync(dataRoot,{recursive:true});}
});
