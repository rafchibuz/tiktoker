const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const date=s=>new Date(s).toLocaleString('ru-RU',{dateStyle:'medium',timeStyle:'short'});
const clock=s=>`${String(Math.floor(s/3600)).padStart(2,'0')}:${String(Math.floor(s%3600/60)).padStart(2,'0')}:${String(Math.floor(s%60)).padStart(2,'0')}`;
let analysis=null;
function safeThumbnail(value){try{const u=new URL(value);return u.protocol==='https:'&&(u.hostname==='static-cdn.jtvnw.net'||u.hostname.endsWith('.twitch.tv'))?u.href:'';}catch{return '';}}
function render(){
  if(!analysis)return;
  const threshold=Math.max(0,Number($('min-views').value)||0);
  const groups=analysis.groups.map(g=>({...g,clips:g.clips.filter(c=>c.view_count>=threshold)})).filter(g=>g.clips.length);
  const count=groups.reduce((n,g)=>n+g.clips.length,0);
  $('analysis-count').textContent=`${count} клипов · ${groups.length} моментов`;
  $('analysis-groups').innerHTML=groups.map((g,i)=>`<article class="analysis-group"><div class="analysis-group-head"><div><strong>#${i+1} · ${g.max_views.toLocaleString('ru-RU')} просмотров у лидера</strong><p class="muted">${g.approximate?'Время создания близкое; точный таймкод Twitch пока не вернул':`Момент эфира ${clock(g.offset)}`} · ${g.clips.length} клипов</p></div></div><div class="analysis-clips">${g.clips.map(c=>`<a class="analysis-clip" href="https://clips.twitch.tv/${encodeURIComponent(c.id)}" target="_blank" rel="noopener noreferrer"><img src="${esc(safeThumbnail(c.thumbnail_url))}" alt="" loading="lazy"><span><strong>${esc(c.title||'Клип без названия')}</strong><small>${esc(c.creator_name||'Автор неизвестен')} · ${date(c.created_at)} · ${Math.round(c.duration)} с</small></span><b>${Number(c.view_count).toLocaleString('ru-RU')} 👁</b></a>`).join('')}</div></article>`).join('')||'<p class="empty">Клипов с таким количеством просмотров нет. Уменьши порог.</p>';
}
$('analysis-form').addEventListener('submit',async e=>{
  e.preventDefault();const button=$('analyze');button.disabled=true;$('analysis-error').hidden=true;$('analysis-status').hidden=false;$('analysis-status').textContent='Ищем эфир и клипы через Twitch…';
  try{
    const response=await fetch('/api/stream/analyze',{method:'POST',headers:{'Content-Type':'application/json','X-Tiktoker-Request':'1'},body:JSON.stringify({url:$('stream-url').value})});
    const result=await response.json();if(!response.ok)throw Error(result.error||'Не удалось получить клипы');
    analysis=result;$('stream-title').textContent=result.stream.title||`Эфир ${result.channel}`;
    $('stream-meta').textContent=`${result.channel} · ${date(result.stream.start)} — ${date(result.stream.end)}${result.stream.live?' · сейчас в эфире':''}`;
    $('stream-link').href=result.stream.url;$('analysis-result').hidden=false;
    $('analysis-warning').hidden=!result.truncated;
    if(result.truncated)$('analysis-warning').textContent='Клипов очень много: Twitch ограничил выдачу за один временной отрезок. Показаны найденные клипы с наибольшими просмотрами.';
    $('analysis-status').textContent=`Анализ завершён: ${result.clips.length} клипов. Просмотры обновятся при повторном анализе.`;render();
  }catch(error){$('analysis-status').hidden=true;$('analysis-error').hidden=false;$('analysis-error').textContent=error.message;}
  finally{button.disabled=false;}
});
$('min-views').addEventListener('input',render);
