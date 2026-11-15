// Shared geometry for the browser's draft preview and FFmpeg rendering.
export const WIDTH=1080,HEIGHT=1920;
const number=(v,name)=>{const n=Number(v);if(!Number.isFinite(n))throw Error(`Некорректное значение: ${name}`);return n;};
export function rectangle(value,name){
 if(!value||typeof value!=='object')throw Error(`Не задана область: ${name}`);
 const r={};for(const key of ['x','y','w','h'])r[key]=Math.round(number(value[key],name)*100000)/100000;
 if(r.x<0||r.y<0||r.w<0.02||r.h<0.02||r.x+r.w>1.00001||r.y+r.h>1.00001)throw Error(`Область «${name}» выходит за границы кадра`);
 return r;
}
export function actionRectangle(value){
 if(!value||typeof value!=='object')throw Error('Не задана область: основной кадр');
 const r={};for(const key of ['x','y','w','h'])r[key]=Math.round(number(value[key],'основной кадр')*100000)/100000;
 if(r.x< -1||r.y< -1||r.x>1||r.y>1||r.w<0.02||r.h<0.02||r.w>2||r.h>2||Math.min(1,r.x+r.w)-Math.max(0,r.x)<0.02||Math.min(1,r.y+r.h)-Math.max(0,r.y)<0.02)throw Error('Область основного кадра должна пересекать исходное видео');
 return r;
}
export function visibleSourceRect(rect){return {x:Math.max(0,rect.x),y:Math.max(0,rect.y),w:Math.min(1,rect.x+rect.w)-Math.max(0,rect.x),h:Math.min(1,rect.y+rect.h)-Math.max(0,rect.y)};}
export function normalizeRecipe(raw,media){
 const mode=raw.mode??'split';if(!['split','single','irl'].includes(mode))throw Error('Неизвестный шаблон');
 const start=Math.round(number(raw.start??0,'начало')*1000)/1000;
 const end=Math.round(number(raw.end??media.duration,'конец')*1000)/1000;
 if(start<0||end>media.duration+0.01||end-start<1||end-start>180)throw Error('Длина фрагмента должна быть от 1 до 180 секунд в пределах исходника');
 const cameraHeight=Math.round(number(raw.cameraHeight??560,'высота камеры')/2)*2;
 if(cameraHeight<320||cameraHeight>800)throw Error('Высота камеры: от 320 до 800 пикселей');
 const title=String(raw.title??'').replace(/[\u0000-\u001f]/g,' ').replace(/\s+/g,' ').trim();
 if([...title].length>120)throw Error('Заголовок: не больше 120 символов');
 const subtitles=raw.subtitles??false;if(typeof subtitles!=='boolean')throw Error('Некорректная настройка субтитров');
 const subtitleY=Math.round(number(raw.subtitleY??1420,'положение субтитров')/2)*2;
 if(subtitleY<300||subtitleY>1650)throw Error('Положение субтитров: от 300 до 1650 пикселей');
 const subtitleX=Math.round(number(raw.subtitleX??0,'смещение субтитров по горизонтали')/2)*2;
 const subtitleSize=Math.round(number(raw.subtitleSize??54,'размер субтитров')/2)*2;
 if(Math.abs(subtitleX)>300||subtitleSize<30||subtitleSize>90)throw Error('Настройки положения или размера субтитров вне диапазона');
 const actionFit=raw.actionFit??'cover';if(!['cover','contain'].includes(actionFit))throw Error('Некорректный режим основного кадра');
 const titleBand=raw.titleBand??true;if(typeof titleBand!=='boolean')throw Error('Некорректная настройка подложки');
 const titleY=Math.round(number(raw.titleY??(mode==='split'?cameraHeight+80:200),'положение заголовка'));
 if(titleY<100||titleY>1820)throw Error('Положение заголовка: от 100 до 1820 пикселей');
 const titleTextX=Math.round(number(raw.titleTextX??0,'смещение текста по горизонтали'));
 const titleTextY=Math.round(number(raw.titleTextY??0,'смещение текста по вертикали'));
 if(Math.abs(titleTextX)>400||Math.abs(titleTextY)>160)throw Error('Смещение текста выходит за допустимые границы');
 const squareSize=Math.round(number(raw.squareSize??900,'размер квадрата')/2)*2;
 const squareX=Math.round(number(raw.squareX??(WIDTH-squareSize)/2,'положение квадрата слева')/2)*2;
 const squareY=Math.round(number(raw.squareY??(HEIGHT-squareSize)/2,'положение квадрата сверху')/2)*2;
 if(squareSize<720||squareSize>1080||squareX<200-squareSize||squareX>WIDTH-200||squareY<0||squareY+squareSize>HEIGHT)throw Error('Квадрат должен оставаться видимым в вертикальном кадре');
 return {version:5,mode,start,end,cameraHeight,title,subtitles,subtitleY,subtitleX,subtitleSize,actionFit,titleBand,titleY,titleTextX,titleTextY,squareSize,squareX,squareY,camera:rectangle(raw.camera??{x:0,y:0.41667,w:0.20833,h:0.21296},'вебка'),action:actionRectangle(raw.action??{x:0,y:0,w:1,h:1})};
}
export function pixelRect(rect,width,height){
 const x=Math.floor(rect.x*width/2)*2,y=Math.floor(rect.y*height/2)*2;
 const w=Math.max(2,Math.min(Math.floor(rect.w*width/2)*2,Math.floor((width-x)/2)*2));
 const h=Math.max(2,Math.min(Math.floor(rect.h*height/2)*2,Math.floor((height-y)/2)*2));
 return {x,y,w,h};
}
export function zones(recipe){const cameraHeight=recipe.mode==='split'?recipe.cameraHeight:0;return {camera:{x:0,y:0,w:WIDTH,h:cameraHeight},action:{x:0,y:cameraHeight,w:WIDTH,h:HEIGHT-cameraHeight},background:{x:0,y:0,w:WIDTH,h:HEIGHT},square:{x:recipe.squareX,y:recipe.squareY,w:recipe.squareSize,h:recipe.squareSize}};}
const charWeight=char=>/\s/.test(char)?0.32:/[WMШЩЮЖФ@%]/i.test(char)?0.96:/[ilI1.,!:'|]/.test(char)?0.3:char.codePointAt(0)>0xffff?1.1:0.65;
export function titleLayout(title){
 for(let size=64;size>=28;size-=2){
   const max=(WIDTH-100)/size,lines=[];let line='',weight=0;
   for(const word of title.split(' ')){
     const wordWeight=[...word].reduce((s,c)=>s+charWeight(c),0);
     if(line&&weight+0.32+wordWeight>max){lines.push(line);line='';weight=0;}
     if(line){line+=' ';weight+=0.32;}
     for(const c of word){if(weight+charWeight(c)>max&&line){lines.push(line);line='';weight=0;}line+=c;weight+=charWeight(c);}
   }
   if(line)lines.push(line);
   const lineHeight=Math.ceil(size*1.2);
   if(lines.length*lineHeight<=136||size===28)return {size,lineHeight,lines,widestLine:lines.reduce((best,next)=>[...next].reduce((s,c)=>s+charWeight(c),0)>[...best].reduce((s,c)=>s+charWeight(c),0)?next:best,'')};
 }
}
export function titlePlacement(recipe){
 const layout=titleLayout(recipe.title),height=layout.lines.length*layout.lineHeight;
 return {...layout,bandY:Math.round(recipe.titleY-(height+30)/2),bandHeight:Math.round(height+30),textTop:Math.round(recipe.titleY-height/2+recipe.titleTextY)};
}
export function captionGroups(words){
 const groups=[];let group=[];
 const flush=()=>{if(group.length){groups.push(group);group=[];}};
 for(const word of words){
  if(group.length&&(word.start-group.at(-1).end>.8||word.end-group[0].start>3.2))flush();
  group.push(word);
  if(group.length===3||/[.!?…]$/.test(word.text))flush();
 }
 flush();return groups;
}
