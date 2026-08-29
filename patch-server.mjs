import {readFile, writeFile} from 'node:fs/promises';

const path = new URL('./server.js', import.meta.url);
let s = await readFile(path, 'utf8');

// Keep the official Cobalt instance in the fallback pool. Community instances
// can disappear or rate-limit Render's shared IP.
if (!s.includes("https://api.cobalt.tools/")) {
  s = s.replace(
    "const COBALT_STATIC=[",
    "const COBALT_STATIC=['https://api.cobalt.tools/',"
  );
}

// TikTok currently requires browser-like TLS/request fingerprints in some
// regions. curl-cffi is installed by Dockerfile, so ask yt-dlp to use it.
const oldYt = "'--socket-timeout','15','--user-agent',UA,source";
const newYt = "'--socket-timeout','15','--impersonate','chrome','--extractor-args','tiktok:app_name=trill',source";
if (s.includes(oldYt)) s = s.replace(oldYt, newYt);

// Cobalt supports tunnel responses when alwaysProxy=true. Keep the status in
// the resolved object so we can see whether a URL is a real tunnel or a redirect.
const oldCobalt = `function cobaltNormalize(json,source,provider){
  if(!json||json.status==='error')throw new Error(json?.error?.code||json?.error?.context?.service||'Cobalt error');
  const item=json.status==='picker'&&Array.isArray(json.picker)?(json.picker.find(x=>x.type==='video')||json.picker[0]):null;
  const url=json.url||item?.url;if(!url)throw new Error('Cobalt returned no media URL');
  const filename=json.filename||'drop-media.mp4';const ext=(filename.match(/\\.([a-z0-9]+)$/i)?.[1]||'mp4').toLowerCase();
  return{ok:true,title:filename.replace(/\\.[^.]+$/,'')||'Media',thumbnail:item?.thumb||null,type:item?.type||'video',filesize:null,width:null,height:null,ext,url,items:[{url,title:filename,thumbnail:item?.thumb||null,size:null,format:ext.toUpperCase(),resolution:''}],sourceUrl:source,provider};
}`;
const newCobalt = `function cobaltNormalize(json,source,provider){
  if(!json||json.status==='error')throw new Error(json?.error?.code||json?.error?.context?.service||'Cobalt error');
  const item=json.status==='picker'&&Array.isArray(json.picker)?(json.picker.find(x=>x.type==='video')||json.picker[0]):null;
  const url=json.url||item?.url;if(!url)throw new Error('Cobalt returned no media URL');
  const filename=json.filename||'drop-media.mp4';const ext=(filename.match(/\\.([a-z0-9]+)$/i)?.[1]||'mp4').toLowerCase();
  return{ok:true,title:filename.replace(/\\.[^.]+$/,'')||'Media',thumbnail:item?.thumb||null,type:item?.type||'video',filesize:null,width:null,height:null,ext,url,items:[{url,title:filename,thumbnail:item?.thumb||null,size:null,format:ext.toUpperCase(),resolution:''}],sourceUrl:source,provider,status:json.status};
}`;
if (s.includes(oldCobalt)) s = s.replace(oldCobalt, newCobalt);

// CRITICAL FIX: do not select a provider merely because it returned a URL.
// TikTok can return a valid-looking v19-webapp-prime URL that immediately
// answers 403 when bytes are requested. Probe the actual media URL from Render
// and only accept a provider that can serve bytes.
const oldFirst = `function firstSuccess(tasks){
  return new Promise((resolve,reject)=>{
    let left=tasks.length,settled=false; const errors=[];
    if(!left)return reject(new Error('no providers configured'));
    for(const [name,fn] of tasks){
      Promise.resolve().then(fn).then(v=>{if(!settled&&v?.url){settled=true;resolve(v);return}left--;if(!left&&!settled)reject(new Error(errors.join(' | ')||'no media URL'))}).catch(e=>{errors.push(\`${name}: \${e?.message||e}\`);left--;if(!left&&!settled)reject(new Error(errors.join(' | ')))})
    }
  });
}`;
const newFirst = `async function probeMediaUrl(url){
  if(!url)return false;
  const h={'User-Agent':UA,'Accept':'*/*'};
  try{
    const host=new URL(url).hostname.toLowerCase();
    if(host.endsWith('tiktok.com')){h.Referer='https://www.tiktok.com/';h.Origin='https://www.tiktok.com'}
    if(host.endsWith('instagram.com')){h.Referer='https://www.instagram.com/';h.Origin='https://www.instagram.com'}
    if(/cobalt|imput\\.net|canine\\.tools|3kh0\\.net|meowing\\.de/i.test(host)){h['User-Agent']=APP_UA;delete h.Referer;delete h.Origin}
    const r=await fetch(url,{method:'GET',headers:{...h,Range:'bytes=0-1'},redirect:'follow',signal:AbortSignal.timeout(12000)});
    const ok=r.ok||r.status===206;
    try{await r.body?.cancel()}catch{}
    return ok;
  }catch{return false}
}
function firstSuccess(tasks){
  return new Promise((resolve,reject)=>{
    let left=tasks.length,settled=false; const errors=[];
    if(!left)return reject(new Error('no providers configured'));
    for(const [name,fn] of tasks){
      Promise.resolve().then(fn).then(async v=>{
        if(settled)return;
        if(v?.url && await probeMediaUrl(v.url)){
          if(!settled){settled=true;resolve(v)}
          return;
        }
        errors.push(\`${name}: media URL rejected or inaccessible\`);
        left--;if(!left&&!settled)reject(new Error(errors.join(' | ')||'no media URL'));
      }).catch(e=>{
        errors.push(\`${name}: \${e?.message||e}\`);
        left--;if(!left&&!settled)reject(new Error(errors.join(' | ')));
      })
    }
  });
}`;
if (s.includes(oldFirst)) s = s.replace(oldFirst, newFirst);

// Try a server-side Cobalt tunnel first. The previous order accepted a direct
// TikTok CDN URL from TDown/yt-dlp before checking whether it was downloadable.
const oldTik = `const tasks=[['TDown',()=>tdown(source)],['ClipX',()=>clipx(source)],['TikWM GET',()=>tikwmGet(source)],['TikWM POST',()=>tikwmPost(source)],['Cobalt',()=>cobaltInfo(source)],['yt-dlp',()=>ytInfo(source)]];`;
const newTik = `const tasks=[['Cobalt',()=>cobaltInfo(source)],['TDown',()=>tdown(source)],['ClipX',()=>clipx(source)],['TikWM GET',()=>tikwmGet(source)],['TikWM POST',()=>tikwmPost(source)],['yt-dlp',()=>ytInfo(source)]];`;
if (s.includes(oldTik)) s = s.replace(oldTik, newTik);

// Expose provider diagnostics in the response instead of hiding them behind the
// generic message. This makes the next failure actionable.
const oldError = "res.status(422).json({error:'Не удалось получить публичное медиа. Проверьте ссылку и доступность публикации.',diagnostic:String(e?.message||e).slice(0,2500)})";
const newError = "res.status(422).json({error:`Не удалось получить публичное медиа. ${String(e?.message||e).slice(0,2500)}`,diagnostic:String(e?.message||e).slice(0,2500)})";
if (s.includes(oldError)) s = s.replace(oldError, newError);

// Make the health endpoint visibly identify this build.
s = s.replace("version:'proxy-v5'", "version:'proxy-v6'");

await writeFile(path, s);
console.log('[build] server compatibility patch applied: provider probing + Cobalt-first TikTok');
