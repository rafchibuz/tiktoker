import test from 'node:test';
import assert from 'node:assert/strict';
import {parseStreamLink,durationSeconds,groupStreamClips,analyzeStream} from '../src/stream-analysis.mjs';

test('accepts Twitch VOD and channel links only',()=>{
  assert.deepEqual(parseStreamLink('https://www.twitch.tv/videos/1234567890'),{videoId:'1234567890'});
  assert.deepEqual(parseStreamLink('https://twitch.tv/Leva2k'),{channel:'leva2k'});
  assert.equal(parseStreamLink('https://evil.example/videos/1234567890'),null);
  assert.equal(parseStreamLink('http://twitch.tv/leva2k'),null);
  assert.equal(durationSeconds('2h10m5s'),7805);
});

test('nearby source moments are grouped, ranked and kept separate from nearby creation times',()=>{
  const base={video_id:'1234',created_at:'2026-11-15T12:00:00Z',duration:30};
  const groups=groupStreamClips([
    {...base,id:'a',vod_offset:60,view_count:20},
    {...base,id:'b',vod_offset:70,view_count:100,created_at:'2026-11-15T12:08:00Z'},
    {...base,id:'c',vod_offset:130,view_count:50},
    {...base,id:'d',video_id:'',vod_offset:null,view_count:10},
  ]);
  assert.equal(groups.length,3);
  assert.deepEqual(groups[0].clips.map(c=>c.id),['b','a']);
  assert.equal(groups[0].max_views,100);
  assert.equal(groups[2].approximate,true);
});

test('VOD analysis keeps clips from its recording and paginates',async()=>{
  const calls=[];
  const video={id:'1234567890',type:'archive',user_id:'42',user_login:'leva2k',title:'Эфир',created_at:'2026-11-15T10:00:00Z',duration:'1h5m',url:'https://www.twitch.tv/videos/1234567890'};
  const clip=(id,videoId,views,offset)=>({id,video_id:videoId,broadcaster_id:'42',title:id,created_at:'2026-11-15T10:10:00Z',duration:30,vod_offset:offset,view_count:views});
  const api=async(endpoint,params)=>{
    calls.push({endpoint,params});
    if(endpoint==='videos')return {data:[video]};
    if(params.started_at==='2026-11-15T10:00:00.000Z'&&!params.after)return {data:[clip('a','1234567890',50,60),clip('other','999',1000,70)],pagination:{cursor:'next'}};
    if(params.after)return {data:[clip('b','1234567890',200,63)],pagination:{}};
    return {data:[],pagination:{}};
  };
  const result=await analyzeStream(video.url,{api});
  assert.deepEqual(result.clips.map(c=>c.id),['b','a']);
  assert.equal(result.groups.length,1);
  assert.deepEqual(result.groups[0].clips.map(c=>c.id),['b','a']);
  assert.equal(calls.filter(x=>x.endpoint==='clips').length,3);
});
