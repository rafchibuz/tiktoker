import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {parseClipLink,parseChannel,importClip,manualClips,registeredChannels} from '../src/manual-clips.mjs';

test('offline Twitch clip links import independently of the selected observer and persist',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'tiktoker-manual-'));
 const id='RelievedRichPoxAliens-0ehiJ-1Nhsa5QCYg';
 const api=async endpoint=>({data:endpoint==='clips'?[{id,broadcaster_login:'ravshann',broadcaster_id:'1',creator_id:'2',created_at:'2026-11-15T12:00:00Z',duration:30,title:'Тест'}]:[]});
 try{
  assert.deepEqual(parseClipLink(`https://www.twitch.tv/ravshann/clip/${id}?filter=clips`),{id,channel:'ravshann'});
  assert.equal(parseClipLink(`https://evil.example/ravshann/clip/${id}`),null);
  assert.equal(parseChannel('https://www.twitch.tv/Leva2k'),'leva2k');
  await assert.rejects(importClip(root,`https://www.twitch.tv/other/clip/${id}`,api),/не совпадает/);
  const first=await importClip(root,`https://clips.twitch.tv/${id}`,api),second=await importClip(root,`https://clips.twitch.tv/${id}`,api);
  assert.equal(first.channel,'ravshann');assert.equal(second.clip.first_seen_at,first.clip.first_seen_at);
  assert.equal(manualClips(root,'ravshann')[id].discovery,'manual');assert.deepEqual(registeredChannels(root),['ravshann']);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
