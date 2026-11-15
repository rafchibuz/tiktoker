import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fetchTwitch} from '../src/twitch-http.mjs';
test('network denial reports actionable cause and does not repeat',async()=>{
 let calls=0;
 await assert.rejects(fetchTwitch('https://id.twitch.tv/oauth2/token',{}, {fetchImpl:async()=>{calls++;throw new TypeError('fetch failed',{cause:{code:'EACCES'}});},wait:async()=>{}}),/EACCES\/EPERM/);
 assert.equal(calls,1);
});
test('transient connection failure retries then returns response',async()=>{
 let calls=0;const result=await fetchTwitch('https://api.twitch.tv/helix/clips',{}, {fetchImpl:async()=>{if(++calls<3)throw Error('network');return {status:200};},wait:async()=>{}});
 assert.equal(result.status,200);assert.equal(calls,3);
});
test('final network error excludes headers, query and raw error text',async()=>{
 await assert.rejects(fetchTwitch('https://api.twitch.tv/helix/clips?secret=hidden',{headers:{Authorization:'hidden'}},{fetchImpl:async()=>{throw Error('hidden');},wait:async()=>{}}),error=>error.message.includes('3 попытки')&&!error.message.includes('hidden'));
});
