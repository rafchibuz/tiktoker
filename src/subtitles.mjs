import fs from 'node:fs';
import path from 'node:path';
import {binary,run,projectRoot} from './media-tools.mjs';
import {captionGroups} from '../web/composition.js';

const whisper=process.platform==='win32'?path.join(projectRoot,'.runtime','whisper-bin','Release','whisper-cli.exe'):process.env.WHISPER_CLI??'whisper-cli';
const models=[['small',path.join(projectRoot,'.runtime','ggml-small.bin')],['base',path.join(projectRoot,'.runtime','ggml-base.bin')]];
const round=n=>Math.round(n*100)/100;
export function transcriptFile(dir){return path.join(dir,'transcript.json');}
export function readTranscript(dir,sourceSha){
 try{const transcript=JSON.parse(fs.readFileSync(transcriptFile(dir),'utf8'));return transcript.source_sha256===sourceSha?{...transcript,revision:transcript.revision??0}:null;}
 catch(e){if(e.code==='ENOENT')return null;throw e;}
}
export function saveTranscriptWords(dir,sourceSha,duration,words,expectedRevision){
 const existing=readTranscript(dir,sourceSha);if(!existing)throw Error('Сначала создай субтитры для этого клипа');
 if(expectedRevision!==existing.revision)throw Error('Субтитры изменились. Обнови редактор перед сохранением.');
 if(!Array.isArray(words)||words.length>1500)throw Error('Слишком много слов в субтитрах');
 let previousStart=-1;
 const normalized=words.map(value=>{
  const text=String(value?.text??'').replace(/[\u0000-\u001f]/g,' ').trim();
  const start=round(Number(value?.start)),end=round(Number(value?.end));
  if(!text||[...text].length>60||!Number.isFinite(start)||!Number.isFinite(end)||start<0||end>duration+.05||end-start<.05||start<previousStart)throw Error('Проверь текст и время слов: слова должны идти по порядку в пределах клипа');
  previousStart=start;return {text,start,end};
 });
 const updated={...existing,words:normalized,revision:existing.revision+1,updated_at:new Date().toISOString()};
 fs.writeFileSync(transcriptFile(dir)+'.tmp',JSON.stringify(updated));fs.renameSync(transcriptFile(dir)+'.tmp',transcriptFile(dir));
 return updated;
}

export function parseWhisperWords(result){
 const words=[];
 for(const segment of result.transcription??[]){
  let current=null;
  const flush=()=>{if(current){current.text=current.text.trim();if(current.text){if(current.end<=current.start)current.end=round(current.start+.1);words.push(current);}current=null;}};
  for(const token of segment.tokens??[]){
   const raw=String(token.text??'');if(!raw||/^\[_/.test(raw))continue;
   const start=Number(token.offsets?.from)/1000,end=Number(token.offsets?.to)/1000;
   if(!Number.isFinite(start)||!Number.isFinite(end))continue;
   if(/^\s/.test(raw))flush();
   if(!current)current={text:'',start:round(start),end:round(Math.max(start,end))};
   current.text+=raw;current.end=round(Math.max(current.end,end));
  }
  flush();
 }
 const spoken=words.filter(w=>/[\p{L}\p{N}]/u.test(w.text)).slice(0,1500);
 for(let i=0;i<spoken.length;i++){
  if(i&&spoken[i].start<spoken[i-1].end)spoken[i].start=spoken[i-1].end;
  if(spoken[i].end<=spoken[i].start)spoken[i].end=round(spoken[i].start+.1);
 }
 return spoken;
}

export {captionGroups};

const assTime=seconds=>{const cs=Math.max(0,Math.round(seconds*100)),hours=Math.floor(cs/360000),minutes=Math.floor(cs/6000)%60,secs=Math.floor(cs/100)%60;return `${hours}:${String(minutes).padStart(2,'0')}:${String(secs).padStart(2,'0')}.${String(cs%100).padStart(2,'0')}`;};
const escapeAss=text=>String(text).replace(/[{}\\\r\n]/g,' ').replace(/\s+/g,' ').trim();
export function buildAss(words,recipe){
 const header=`[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\nScaledBorderAndShadow: yes\nWrapStyle: 2\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Box,Komika Title - Axis RUS-LAT,48,&HFF000000,&HFF000000,&HB2000000,&HB2000000,0,0,0,0,100,100,0,0,3,12,0,5,100,100,0,1\nStyle: Text,Komika Title - Axis RUS-LAT,48,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,4,0,5,100,100,0,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
 const events=[];
 for(const group of captionGroups(words)){
  const visible=group.filter(w=>w.end>recipe.start&&w.start<recipe.end);if(!visible.length)continue;
  const start=Math.max(0,visible[0].start-recipe.start),end=Math.min(recipe.end-recipe.start,visible.at(-1).end-recipe.start);
  if(end<=start)continue;
  const plain=visible.map(w=>escapeAss(w.text)).join(' ');
  const fitSize=Math.floor((900-2*Math.abs(recipe.subtitleX))/Math.max(1,[...plain].length*.62));
  const size=Math.max(30,Math.min(recipe.subtitleSize,fitSize)),position=`{\\pos(${540+recipe.subtitleX},${recipe.subtitleY})\\fs${size}}`;
  events.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Box,,0,0,0,,${position}${plain}`);
  for(let i=0;i<visible.length;i++){
   const from=Math.max(start,visible[i].start-recipe.start),to=Math.min(end,i+1<visible.length?Math.max(visible[i+1].start-recipe.start,visible[i].end-recipe.start):end);
   if(to<=from)continue;
   const phrase=visible.map((w,j)=>`${j===i?'{\\1c&H0000D8FF&}':'{\\1c&H00FFFFFF&}'}${escapeAss(w.text)}`).join(' ');
   events.push(`Dialogue: 1,${assTime(from)},${assTime(to)},Text,,0,0,0,,${position}${phrase}`);
  }
 }
 return header+events.join('\n')+'\n';
}

export async function transcribeClip(source,dir,media,{signal}={}){
 const file=transcriptFile(dir),cached=readTranscript(dir,media.sha256);if(cached)return cached;
 if(!media.has_audio){const empty={source_sha256:media.sha256,model:null,words:[],revision:0,created_at:new Date().toISOString()};fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(file,JSON.stringify(empty));return empty;}
 const [modelName,model]=models.find(([,candidate])=>fs.existsSync(candidate))??[];
 if(!fs.existsSync(whisper)||!model)throw Error('Для автосубтитров нужны whisper-cli.exe и ggml-small.bin в .runtime');
 fs.mkdirSync(dir,{recursive:true});const wav=path.join(dir,'speech.wav'),out=path.join(dir,'whisper');
 try{
  await run(binary('ffmpeg'),['-v','error','-y','-i',source,'-vn','-ac','1','-ar','16000','-c:a','pcm_s16le',wav],{timeout:240000,signal});
  await run(whisper,['-m',model,'-f',wav,'-l','ru','-dtw',modelName,'-ojf','-of',out,'-np'],{timeout:900000,signal});
  const words=parseWhisperWords(JSON.parse(fs.readFileSync(out+'.json','utf8')));
  const transcript={source_sha256:media.sha256,model:modelName,words,revision:0,created_at:new Date().toISOString()};
  fs.writeFileSync(file+'.tmp',JSON.stringify(transcript));fs.renameSync(file+'.tmp',file);
  return transcript;
 }finally{for(const temporary of [wav,out+'.json'])try{fs.unlinkSync(temporary);}catch(e){if(e.code!=='ENOENT')throw e;}}
}
