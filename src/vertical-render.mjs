import fs from 'node:fs';
import path from 'node:path';
import {binary,run,probe,projectRoot} from './media-tools.mjs';
import {normalizeRecipe,pixelRect,zones,titlePlacement,visibleSourceRect} from '../web/composition.js';
import {buildAss} from './subtitles.mjs';

function filterPath(file){return file.replaceAll('\\','/').replaceAll(':','\\:').replaceAll("'","'\\''");}
function transform(rect,width,height,fit){
 const scale=fit==='contain'?`scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=0x101418`:`scale=${width}:${height}:force_original_aspect_ratio=increase:force_divisible_by=2,crop=${width}:${height}`;
 return `crop=${rect.w}:${rect.h}:${rect.x}:${rect.y},${scale},setsar=1,fps=30,setpts=PTS-STARTPTS`;
}
export async function renderVertical({source,outputDir,recipe:raw,media,transcript},options={}){
 const recipe=normalizeRecipe(raw,media),layout=zones(recipe),duration=recipe.end-recipe.start;
 fs.mkdirSync(outputDir,{recursive:true});
 const camera=pixelRect(recipe.camera,media.width,media.height),action=pixelRect(visibleSourceRect(recipe.action),media.width,media.height);
 const filters=[];
 if(recipe.mode==='split'){
   filters.push('[0:v]split=2[cam0][action0]');
   filters.push(`[cam0]${transform(camera,1080,layout.camera.h,'cover')}[camera]`);
 }else if(recipe.mode==='irl'){
   filters.push('[0:v]split=2[background0][action0]');
   filters.push('[background0]scale=1080:1920:force_original_aspect_ratio=increase:force_divisible_by=2,crop=1080:1920,boxblur=25:2,setsar=1,fps=30,setpts=PTS-STARTPTS[background]');
 }else filters.push('[0:v]null[action0]');
 const actionWidth=recipe.mode==='irl'?recipe.squareSize:1080,actionHeight=recipe.mode==='irl'?recipe.squareSize:layout.action.h;
 filters.push(`[action0]${transform(action,actionWidth,actionHeight,recipe.actionFit)}[action]`);
 if(recipe.mode==='split')filters.push('[camera][action]vstack=inputs=2:shortest=1[base]');
 else if(recipe.mode==='irl')filters.push(`[background][action]overlay=x=${recipe.squareX}:y=${recipe.squareY}:shortest=1[base]`);
 else filters.push('[action]null[base]');
 let last='base';
 if(recipe.title){
   const font=path.join(projectRoot,'web','fonts','komika-title-axis-rus-lat.otf');
   if(!fs.existsSync(font))throw Error('Не найден шрифт Komika Title Axis RUS-LAT');
   const text=titlePlacement(recipe);
   if(recipe.titleBand){filters.push(`[${last}]drawbox=x=0:y=${text.bandY}:w=1080:h=${text.bandHeight}:color=black@0.3:t=fill[band]`);last='band';}
   for(let i=0;i<text.lines.length;i++){
     const textFile=path.join(outputDir,`title-${i}.txt`);fs.writeFileSync(textFile,text.lines[i]);
     const next=`text${i}`;
     filters.push(`[${last}]drawtext=fontfile='${filterPath(font)}':textfile='${filterPath(textFile)}':expansion=none:fontsize=${text.size}:fontcolor=white:borderw=4:bordercolor=black:x=(w-text_w)/2+${recipe.titleTextX}:y=${text.textTop+i*text.lineHeight}[${next}]`);last=next;
   }
 }
 if(recipe.subtitles&&transcript?.words.length){
   const captionFile=path.join(outputDir,'captions.ass');fs.writeFileSync(captionFile,buildAss(transcript.words,recipe));
   const fontDir=path.join(projectRoot,'web','fonts');
   filters.push(`[${last}]ass=filename='${filterPath(captionFile)}':fontsdir='${filterPath(fontDir)}'[captioned]`);last='captioned';
 }
 const partial=path.join(outputDir,'video.partial.mp4'),file=path.join(outputDir,'video.mp4');
 fs.writeFileSync(path.join(outputDir,'recipe.json'),JSON.stringify(recipe,null,2));
 fs.writeFileSync(path.join(outputDir,'filter.txt'),filters.join(';\n'));
 await run(binary('ffmpeg'),['-v','error','-y','-ss',String(recipe.start),'-i',source,'-filter_complex_threads','2','-filter_complex',filters.join(';'),'-map',`[${last}]`,'-map','0:a:0?','-t',String(duration),'-c:v','libx264','-preset','veryfast','-crf','22','-pix_fmt','yuv420p','-threads','2','-c:a','aac','-b:a','160k','-ar','48000','-movflags','+faststart',partial],{timeout:600000,...options});
 const info=await probe(partial,options);
 if(info.width!==1080||info.height!==1920||Math.abs(info.duration-duration)>0.15)throw Error('Результат рендера не прошёл проверку размера или длительности');
 fs.renameSync(partial,file);return {file,info,bytes:fs.statSync(file).size};
}
