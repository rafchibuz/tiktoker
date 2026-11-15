import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {parseWhisperWords,buildAss,captionGroups,saveTranscriptWords} from '../src/subtitles.mjs';
import {normalizeRecipe} from '../web/composition.js';

test('word tokens form short timed captions with one highlighted word',()=>{
 const result={transcription:[{tokens:[
  {text:' Прив',offsets:{from:0,to:200}},{text:'ет',offsets:{from:200,to:400}},
  {text:' всем',offsets:{from:400,to:800}},{text:'!',offsets:{from:800,to:800}},
 ]}]};
 const words=parseWhisperWords(result);assert.deepEqual(words,[{text:'Привет',start:0,end:.4},{text:'всем!',start:.4,end:.8}]);
 assert.equal(captionGroups(words).length,1);
 const recipe=normalizeRecipe({start:0,end:2,subtitleY:1400}, {duration:2});
 const ass=buildAss(words,recipe);
 assert.match(ass,/Style: Text,Komika Title - Axis RUS-LAT/);
 assert.match(ass,/\\pos\(540,1400\)/);
 assert.equal((ass.match(/Dialogue: 1,/g)??[]).length,2);
 assert.match(ass,/\\1c&H0000D8FF&/);
});

test('subtitles require an explicit opt-in and have adjustable size and position',()=>{
 const media={duration:10};
 assert.equal(normalizeRecipe({start:0,end:10},media).subtitles,false);
 assert.equal(normalizeRecipe({start:0,end:10,subtitles:false},media).subtitles,false);
 const recipe=normalizeRecipe({start:0,end:10,subtitles:true,subtitleSize:70,subtitleX:120,subtitleY:1300},media);
 assert.match(buildAss([{text:'Привет',start:1,end:2}],recipe),/\\pos\(660,1300\)\\fs70/);
});

test('word corrections and deletions persist with ordered timings',()=>{
 const parent=path.resolve('output/tests');fs.mkdirSync(parent,{recursive:true});const dir=fs.mkdtempSync(path.join(parent,'caption-edit-'));
 try{
  fs.writeFileSync(path.join(dir,'transcript.json'),JSON.stringify({source_sha256:'sha',revision:0,words:[{text:'ошибка',start:1,end:2}]}));
  const saved=saveTranscriptWords(dir,'sha',10,[{text:'верно',start:1,end:2},{text:'слово',start:2,end:3}],0);
  assert.equal(saved.revision,1);assert.equal(saved.words[0].text,'верно');
  assert.throws(()=>saveTranscriptWords(dir,'sha',10,[],0),/изменились/);
  assert.throws(()=>saveTranscriptWords(dir,'sha',10,[{text:'поздно',start:4,end:5},{text:'рано',start:2,end:3}],1),/порядку/);
  assert.deepEqual(saveTranscriptWords(dir,'sha',10,[saved.words[1]],1).words,[{text:'слово',start:2,end:3}]);
 }finally{fs.rmSync(dir,{recursive:true});}
});
