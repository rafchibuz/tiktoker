import {binary,run} from './media-tools.mjs';

// Coarse visual sequence + audio spectral envelope. Versioned and deliberately
// conservative: perceptual matches are proposals for review, never auto-deleted.
function spectrum(samples,start) {
  const n=512,re=new Float64Array(n),im=new Float64Array(n);
  let energy=0;
  for(let i=0;i<n;i++){const x=samples[start+i]??0;energy+=x*x;re[i]=x*(0.5-0.5*Math.cos(2*Math.PI*i/(n-1)));}
  if(energy/n<0.000005)return null;
  for(let i=1,j=0;i<n;i++){let bit=n>>1;for(;j&bit;bit>>=1)j^=bit;j^=bit;if(i<j)[re[i],re[j]]=[re[j],re[i]];}
  for(let len=2;len<=n;len<<=1){const angle=-2*Math.PI/len;for(let base=0;base<n;base+=len){for(let j=0;j<len/2;j++){const c=Math.cos(angle*j),s=Math.sin(angle*j),k=base+j,l=k+len/2,tr=re[l]*c-im[l]*s,ti=re[l]*s+im[l]*c;re[l]=re[k]-tr;im[l]=im[k]-ti;re[k]+=tr;im[k]+=ti;}}}
  const bands=[];
  for(let b=0;b<16;b++){const lo=Math.floor(2*Math.pow(120,b/16)),hi=Math.max(lo+1,Math.floor(2*Math.pow(120,(b+1)/16)));let total=0;for(let k=lo;k<Math.min(256,hi);k++)total+=re[k]*re[k]+im[k]*im[k];bands.push(Math.log(1e-8+total/(hi-lo)));}
  const mean=bands.reduce((a,b)=>a+b,0)/bands.length,norm=Math.sqrt(bands.reduce((s,v)=>s+(v-mean)**2,0));
  return norm>0?bands.map(v=>Math.round((v-mean)/norm*10000)/10000):null;
}
export function audioFeatures(pcm) {
  const samples=new Float32Array(pcm.length/2);for(let i=0;i<samples.length;i++)samples[i]=pcm.readInt16LE(i*2)/32768;
  const frames=[];for(let i=0;i+512<=samples.length;i+=1000)frames.push(spectrum(samples,i));return frames;
}
export async function fingerprint(file,hasAudio,options={}) {
  const {stdout}=await run(binary('ffmpeg'),['-v','error','-i',file,'-an','-vf','fps=2,scale=16:9:flags=area','-pix_fmt','gray','-f','rawvideo','pipe:1'],options);
  const video=[];for(let i=0;i+144<=stdout.length;i+=144)video.push([...stdout.subarray(i,i+144)]);
  let audio=[];
  if(hasAudio){const {stdout:pcm}=await run(binary('ffmpeg'),['-v','error','-i',file,'-vn','-ac','1','-ar','8000','-f','s16le','pipe:1'],options);audio=audioFeatures(pcm);}
  return {version:1,video_fps:2,audio_fps:8,video,audio};
}
const mean=values=>values.length?values.reduce((s,v)=>s+v,0)/values.length:0;
const cosine=(a,b)=>a&&b?a.reduce((s,x,i)=>s+x*b[i],0):null;
function visualSimilarity(a,b){let sum=0;for(let i=0;i<a.length;i++)sum+=Math.abs(a[i]-b[i]);return 1-sum/(a.length*255);}

export function compareFingerprints(a,b) {
  if(a.version!==1||b.version!==1)return null;
  const minFrames=Math.max(12,Math.ceil(Math.min(a.video.length,b.video.length)*0.6));
  if(Math.min(a.video.length,b.video.length)<minFrames)return null;
  const candidates=[];
  for(let shift=-(b.video.length-minFrames);shift<=a.video.length-minFrames;shift++){
    const start=Math.max(0,-shift),end=Math.min(b.video.length,a.video.length-shift);
    let total=0,good=0,motion=0;
    for(let j=start;j<end;j++){const score=visualSimilarity(a.video[j+shift],b.video[j]);total+=score;if(score>=0.94)good++;if(j>start)motion+=1-visualSimilarity(b.video[j],b.video[j-1]);}
    const length=end-start,video_score=total/length;
    if(video_score>=0.94&&good/length>=0.75&&motion/Math.max(1,length-1)>=0.003)candidates.push({shift,video_score,video_good:good/length,overlap_seconds:length/2});
  }
  candidates.sort((x,y)=>y.video_score-x.video_score);
  let best=null;
  for(const candidate of candidates.slice(0,8)){
    for(let tweak=-2;tweak<=2;tweak++){
      const shift=candidate.shift*4+tweak,scores=[];
      const start=Math.max(0,-shift),end=Math.min(b.audio.length,a.audio.length-shift);
      for(let i=start;i<end;i++){const score=cosine(a.audio[i+shift],b.audio[i]);if(score!==null)scores.push(score);}
      const audio_score=mean(scores),audio_good=scores.filter(v=>v>=0.9).length/Math.max(1,scores.length);
      if(scores.length<32||audio_score<0.93||audio_good<0.7)continue;
      const score=(audio_score+candidate.video_score)/2;
      if(!best||score>best.score)best={...candidate,score,audio_score,audio_good,offset_seconds:shift/8,method:'audio_video_sequence',status:'needs_review'};
    }
  }
  return best;
}
