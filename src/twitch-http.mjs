import {setTimeout as sleep} from 'node:timers/promises';

export async function fetchTwitch(url, options={}, {fetchImpl=fetch, wait=sleep}={}) {
  for(let attempt=0;attempt<3;attempt++) {
    try { return await fetchImpl(url,{...options,signal:AbortSignal.timeout(20000)}); }
    catch(error) {
      const codes=[error.cause?.code,error.code,...(error.cause?.errors??[]).map(e=>e.code)];
      if(codes.some(code=>code==='EACCES'||code==='EPERM')) {
        throw Error('Нет доступа к сети (EACCES/EPERM). Перезапустите ТикТокер через start_tiktoker.cmd в обычной Windows-сессии или разрешите сетевой доступ процессу в Codex.');
      }
      if(attempt<2) {await wait(1000*2**attempt);continue;}
      const reason=codes.includes('ENOTFOUND')?'DNS не смог найти Twitch':
        codes.some(c=>['CERT_HAS_EXPIRED','UNABLE_TO_VERIFY_LEAF_SIGNATURE','SELF_SIGNED_CERT_IN_CHAIN'].includes(c))?'ошибка проверки TLS-сертификата':
        codes.includes('ECONNREFUSED')?'соединение отклонено':
        error.name==='TimeoutError'||codes.includes('UND_ERR_CONNECT_TIMEOUT')?'истекло время подключения':'соединение прервано';
      throw Error(`Не удалось подключиться к ${new URL(url).hostname}: ${reason}. Выполнены 3 попытки. Проверьте подключение к интернету.`);
    }
  }
}
