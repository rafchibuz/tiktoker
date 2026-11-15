import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

export const projectRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const binary=name=>process.platform==='win32'?path.join(projectRoot,'.runtime',`${name}.exe`):name;
export function run(binaryPath,args,{timeout=180000,maxBuffer=32*1024*1024,signal}={}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(binaryPath,args,{windowsHide:true,stdio:['ignore','pipe','pipe'],signal});
    let stdout=[],stderr=[],size=0,errSize=0,problem;
    const timer=setTimeout(()=>{problem=Error('Время обработки истекло');child.kill();},timeout);
    child.stdout.on('data',c=>{size+=c.length;if(size>maxBuffer){problem=Error('Превышен размер результата анализа');child.kill();}else stdout.push(c);});
    child.stderr.on('data',c=>{errSize+=c.length;if(errSize<16384)stderr.push(c);});
    child.on('error',e=>{clearTimeout(timer);reject(e.code==='ENOENT'?Error('Не установлен инструмент '+path.basename(binaryPath)):Error('Не удалось запустить '+path.basename(binaryPath)));});
    child.on('close',code=>{
      clearTimeout(timer);if(problem)return reject(problem);
      if(code!==0) {
        const output=Buffer.concat(stderr).toString();
        const hint=/403|Forbidden/.test(output)?'доступ к клипу отклонён':/404|not found|does not exist/i.test(output)?'клип недоступен':/timed out|timeout/i.test(output)?'таймаут сети':/sign in|login|private|restricted/i.test(output)?'требуется доступ владельца':/requested format.*not available/i.test(output)?'нет подходящего MP4':`код ${code}`;
        return reject(Error(`${path.basename(binaryPath)}: ${hint}`));
      }
      resolve({stdout:Buffer.concat(stdout),stderr:Buffer.concat(stderr).toString()});
    });
  });
}

export async function probe(file,options={}) {
  const {stdout}=await run(binary('ffprobe'),['-v','error','-show_entries','format=duration:stream=codec_type,width,height,codec_name','-of','json',file],options);
  const info=JSON.parse(stdout.toString()),video=info.streams.find(s=>s.codec_type==='video');
  const duration=Number(info.format.duration);
  if(!video||!Number.isFinite(duration)||duration<=0||duration>180)throw Error('Ожидался видеоклип длительностью до 180 секунд');
  return {duration,width:video.width,height:video.height,video_codec:video.codec_name,has_audio:info.streams.some(s=>s.codec_type==='audio')};
}

export async function hashFile(file) {
  const hash=createHash('sha256');for await(const chunk of fs.createReadStream(file))hash.update(chunk);return hash.digest('hex');
}

export async function createPreview(file,dir,options={}) {
  const target=path.join(dir,'preview.mp4');
  if(fs.existsSync(target))return target;
  const partial=path.join(dir,'preview.partial.mp4');
  await run(binary('ffmpeg'),['-v','error','-y','-i',file,'-map','0:v:0','-map','0:a:0?','-vf','scale=w=min(1280\\,iw):h=-2','-c:v','libx264','-preset','veryfast','-crf','24','-pix_fmt','yuv420p','-threads','2','-c:a','aac','-b:a','128k','-movflags','+faststart',partial],{timeout:240000,...options});
  fs.renameSync(partial,target);return target;
}

export async function downloadClip(clip,dir,options={}) {
  if(!/^[A-Za-z0-9_-]{1,200}$/.test(clip.id))throw Error('Некорректный ID клипа');
  fs.mkdirSync(dir,{recursive:true});
  const file=path.join(dir,'source.mp4');
  if(!fs.existsSync(file)) {
    await run(binary('yt-dlp'),['--ignore-config','--no-plugin-dirs','--no-playlist','--no-progress','--no-warnings','--no-cache-dir','--socket-timeout','20','--retries','2','--fragment-retries','2','--max-filesize','500M','--match-filters','duration <= 180','-f','best[ext=mp4]','-o',file,`https://clips.twitch.tv/${clip.id}`],{timeout:240000,...options});
  }
  if(!fs.existsSync(file))throw Error('Исходник не получен: размер или длительность превышают ограничение');
  return {file,info:await probe(file,options),sha256:await hashFile(file)};
}
