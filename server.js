import express from 'express';
import cors from 'cors';
import {Readable} from 'node:stream';
import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const app=express();
const PORT=Number(process.env.PORT||10000);
const ROOT=path.dirname(fileURLToPath(import.meta.url));
const PUBLIC=path.join(ROOT,'public');
const MAX_BYTES=200*1024*1024;
const MAX_DURATION=15*60;
const UA='Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Version/18.6 Mobile/15E148 Safari/604.1';
const APP_UA='Drop-Downloader/1.0 (+https://github.com/ko1oma/-drop-downloader)';

app.use(cors());
app.use(express.json({limit:'32kb'}));
app.use(express.static(PUBLIC,{index:false}));

function parseUrl(value){
  try{
    const u=new URL(value); const h=u.hostname.toLowerCase().replace(/^www\./,'');
    if(u.protocol!=='https:')return null;
    if(h==='tiktok.com'||h.endsWith('.tiktok.com'))return{site:'tiktok'};
    if(h==='instagram.com'||h.endsWith('.instagram.com'))return{site:'instagram'};
    if(h==='t.me'||h==='telegram.me'||h==='telegram.dog')return{site:'telegram'};
    return null;
  }catch{return null}
}

function child(args,{cmd='yt-dlp',timeout=45000}={}){
  return new Promise((resolve,reject)=>{
    const p=spawn(cmd,args,{stdio:['ignore','pipe','pipe']}); let out='',err='',done=false;
    const timer=setTimeout(()=>{if(done)return;done=true;try{p.kill('SIGTERM')}catch{};reject(new Error(`${cmd} timeout`))},timeout);
    p.stdout.on('data',d=>out+=d); p.stderr.on('data',d=>err+=d);
    p.on('error',e=>{if(done)return;done=true;clearTimeout(timer);reject(e)});
    p.on('close',c=>{if(done)return;done=true;clearTimeout(timer);if(c===0)resolve(out);else{const lines=err.trim().split('\n').filter(Boolean);reject(new Error(lines.slice(-1)[0]||`${cmd} failed`))}});
  });
}
const ytdlp=(args,o={})=>child(args,{...o,cmd:'yt-dlp'});
function safeName(s){return(s||'drop-media').replace(/[^a-z0-9._-]+/gi,'_').slice(0,80)||'drop-media'}
function safeInfo(info,source,provider){
  const url=info.url||null;
  return{ok:true,title:info.title||'Media',thumbnail:info.thumbnail||null,type:info._type||'video',filesize:info.filesize||info.filesize_approx||null,width:info.width||null,height:info.height||null,ext:info.ext||'mp4',url,items:url?[{url,title:info.title||'Media',thumbnail:info.thumbnail||null,size:info.filesize||info.filesize_approx||null,format:info.ext||'mp4',resolution:info.width&&info.height?`${info.width}×${info.height}`:''}]:[],sourceUrl:source,provider};
}
function firstSuccess(tasks){
  return new Promise((resolve,reject)=>{
    let left=tasks.length,settled=false; const errors=[];
    if(!left)return reject(new Error('no providers configured'));
    for(const [name,fn] of tasks){
      Promise.resolve().then(fn).then(v=>{if(!settled&&v?.url){settled=true;resolve(v);return}left--;if(!left&&!settled)reject(new Error(errors.join(' | ')||'no media URL'))}).catch(e=>{errors.push(`${name}: ${e?.message||e}`);left--;if(!left&&!settled)reject(new Error(errors.join(' | ')))})
    }
  });
}

const COBALT_STATIC=['https://cobalt-api.meowing.de/','https://cobalt-backend.canine.tools/','https://kityune.imput.net/','https://capi.3kh0.net/','https://nachos.imput.net/','https://sunny.imput.net/','https://blossom.imput.net/'];
let cobaltCache={at:0,urls:COBALT_STATIC};
async function cobaltInstances(){
  if(Date.now()-cobaltCache.at<10*60*1000)return cobaltCache.urls;
  let dynamic=[];
  try{
    const r=await fetch('https://instances.cobalt.best/api/instances.json',{headers:{'User-Agent':APP_UA,'Accept':'application/json'},signal:AbortSignal.timeout(8000)});
    if(r.ok){const list=await r.json();if(Array.isArray(list))dynamic=list.filter(x=>x?.online===true&&x?.api&&x?.info?.auth!==true).sort((a,b)=>(b.score||0)-(a.score||0)).map(x=>`${x.protocol||'https'}://${String(x.api).replace(/^https?:\/\//,'').replace(/\/$/,'')}/`).slice(0,12)}
  }catch(e){console.warn('[cobalt instances]',e?.message||e)}
  cobaltCache={at:Date.now(),urls:[...new Set([...dynamic,...COBALT_STATIC])]}; return cobaltCache.urls;
}
function cobaltNormalize(json,source,provider){
  if(!json||json.status==='error')throw new Error(json?.error?.code||json?.error?.context?.service||'Cobalt error');
  const item=json.status==='picker'&&Array.isArray(json.picker)?(json.picker.find(x=>x.type==='video')||json.picker[0]):null;
  const url=json.url||item?.url;if(!url)throw new Error('Cobalt returned no media URL');
  const filename=json.filename||'drop-media.mp4';const ext=(filename.match(/\.([a-z0-9]+)$/i)?.[1]||'mp4').toLowerCase();
  return{ok:true,title:filename.replace(/\.[^.]+$/,'')||'Media',thumbnail:item?.thumb||null,type:item?.type||'video',filesize:null,width:null,height:null,ext,url,items:[{url,title:filename,thumbnail:item?.thumb||null,size:null,format:ext.toUpperCase(),resolution:''}],sourceUrl:source,provider};
}
async function cobalt(source,base){
  const r=await fetch(base,{method:'POST',headers:{'User-Agent':APP_UA,'Accept':'application/json','Content-Type':'application/json'},body:JSON.stringify({url:source,videoQuality:'1080',downloadMode:'auto',filenameStyle:'basic',alwaysProxy:true}),signal:AbortSignal.timeout(25000)});
  const text=await r.text();if(!r.ok)throw new Error(`Cobalt HTTP ${r.status}`);let json;try{json=JSON.parse(text)}catch{throw new Error('Cobalt invalid JSON')}return cobaltNormalize(json,source,`cobalt:${new URL(base).hostname}`);
}
async function cobaltInfo(source){return firstSuccess((await cobaltInstances()).map(base=>[`Cobalt ${new URL(base).hostname}`,()=>cobalt(source,base)]))}

function tikwmNormalize(json,source,provider){
  if(!json||json.code!==0||!json.data)throw new Error(json?.msg||'TikWM returned no data');const d=json.data,url=d.hdplay||d.play||d.wmplay||d.sdplay;if(!url)throw new Error('TikWM returned no video URL');if(Number(d.duration)>MAX_DURATION)throw new Error('video is too long');
  return{ok:true,title:d.title||'TikTok video',thumbnail:d.cover||d.origin_cover||null,type:'video',filesize:Number(d.size||d.hd_size||0)||null,width:Number(d.width)||null,height:Number(d.height)||null,ext:'mp4',url,items:[{url,title:d.title||'TikTok video',thumbnail:d.cover||d.origin_cover||null,size:Number(d.size||d.hd_size||0)||null,format:'MP4',resolution:d.width&&d.height?`${d.width}×${d.height}`:''}],sourceUrl:source,provider};
}
async function tikwmGet(source){const r=await fetch(`https://www.tikwm.com/api/?url=${encodeURIComponent(source)}&hd=1`,{headers:{'User-Agent':UA,'Accept':'application/json,text/plain,*/*','Referer':'https://www.tikwm.com/'},signal:AbortSignal.timeout(25000)});const t=await r.text();if(!r.ok)throw new Error(`TikWM GET HTTP ${r.status}`);let j;try{j=JSON.parse(t)}catch{throw new Error('TikWM GET invalid JSON')}return tikwmNormalize(j,source,'tikwm-get')}
async function tikwmPost(source){const body=new URLSearchParams({url:source,hd:'1'});const r=await fetch('https://www.tikwm.com/api/',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8','Accept':'application/json,text/plain,*/*','Referer':'https://www.tikwm.com/','User-Agent':UA},body,signal:AbortSignal.timeout(25000)});const t=await r.text();if(!r.ok)throw new Error(`TikWM POST HTTP ${r.status}`);let j;try{j=JSON.parse(t)}catch{throw new Error('TikWM POST invalid JSON')}return tikwmNormalize(j,source,'tikwm-post')}
async function tdown(source){const r=await fetch(`https://tdownv4.sl-bjs.workers.dev/?down=${encodeURIComponent(source)}`,{headers:{'User-Agent':UA,'Accept':'application/json,text/plain,*/*'},redirect:'follow',signal:AbortSignal.timeout(25000)});const t=await r.text();if(!r.ok)throw new Error(`TDown HTTP ${r.status}`);let j;try{j=JSON.parse(t)}catch{throw new Error('TDown invalid JSON')};const d=j.data||j,url=d.download_url||d.downloadUrl||d.video_url||d.media_url||d.url;if(!url)throw new Error(j.error||j.message||d.error||'TDown returned no video URL');return{ok:true,title:d.title||d.author?.nickname||'TikTok video',thumbnail:d.thumbnail||d.cover||null,type:'video',filesize:null,width:Number(d.width)||null,height:Number(d.height)||null,ext:'mp4',url,items:[{url,title:d.title||'TikTok video',thumbnail:d.thumbnail||d.cover||null,size:null,format:'MP4',resolution:d.width&&d.height?`${d.width}×${d.height}`:''}],sourceUrl:source,provider:'tdown'}}
async function clipx(source){const r=await fetch(`https://clipx.zamdev.workers.dev/?url=${encodeURIComponent(source)}`,{headers:{'User-Agent':UA,'Accept':'application/json,text/plain,*/*'},redirect:'follow',signal:AbortSignal.timeout(25000)});const t=await r.text();if(!r.ok)throw new Error(`ClipX HTTP ${r.status}`);let j;try{j=JSON.parse(t)}catch{throw new Error('ClipX invalid JSON')};const d=j.data||j,url=d.download_url||d.downloadUrl||d.video_url||d.media_url||d.url;if(!url)throw new Error(j.error||j.message||d.error||'ClipX returned no video URL');return{ok:true,title:d.title||'TikTok video',thumbnail:d.thumbnail||d.cover||null,type:'video',filesize:null,width:Number(d.width)||null,height:Number(d.height)||null,ext:'mp4',url,items:[{url,title:d.title||'TikTok video',thumbnail:d.thumbnail||d.cover||null,size:null,format:'MP4',resolution:d.width&&d.height?`${d.width}×${d.height}`:''}],sourceUrl:source,provider:'clipx'}}
async function ytInfo(source){const info=JSON.parse(await ytdlp(['--dump-single-json','--no-playlist','--skip-download','--no-warnings','--no-check-certificates','--socket-timeout','15','--user-agent',UA,source],{timeout:45000}));if(info.duration>MAX_DURATION)throw new Error('video is too long');return safeInfo(info,source,'yt-dlp')}
async function tiktokInfo(source){const tasks=[['TDown',()=>tdown(source)],['ClipX',()=>clipx(source)],['TikWM GET',()=>tikwmGet(source)],['TikWM POST',()=>tikwmPost(source)],['Cobalt',()=>cobaltInfo(source)],['yt-dlp',()=>ytInfo(source)]];try{return await firstSuccess(tasks)}catch(e){console.error('[TikTok providers]',e?.stack||e);throw new Error(`TikTok providers failed: ${String(e?.message||e).slice(0,2500)}`)}}

async function instagramGallery(source){const out=await child(['-g','-f','best','--no-mtime',source],{cmd:'gallery-dl',timeout:45000});const url=out.trim().split(/\s+/).find(x=>/^https?:\/\//.test(x));if(!url)throw new Error('gallery-dl returned no media URL');return{ok:true,title:'Instagram media',thumbnail:null,type:'video',filesize:null,width:null,height:null,ext:'mp4',url,items:[{url,title:'Instagram media',thumbnail:null,size:null,format:'MP4',resolution:''}],sourceUrl:source,provider:'gallery-dl'}}
async function instagramInfo(source){return firstSuccess([['Cobalt',()=>cobaltInfo(source)],['yt-dlp',()=>ytInfo(source)],['gallery-dl',()=>instagramGallery(source)]]);}
function telegramPath(source){const u=new URL(source),p=u.pathname.split('/').filter(Boolean);if(p[0]==='s')p.shift();if(p.length<2)return null;return{channel:p[0].replace(/^@/,''),id:p[1]}}
async function telegramEmbed(source,host){const p=telegramPath(source);if(!p||!/^[A-Za-z0-9_]+$/.test(p.channel)||!/^[0-9]+$/.test(p.id))throw new Error('invalid Telegram post link');const r=await fetch(`https://${host}/${p.channel}/${p.id}?embed=1`,{headers:{'User-Agent':UA,'Accept':'text/html,application/xhtml+xml'},signal:AbortSignal.timeout(20000)});if(!r.ok)throw new Error(`Telegram ${host} HTTP ${r.status}`);const h=await r.text();const get=re=>{const m=h.match(re);return m?m[1].replace(/&amp;/g,'&').replace(/&#x2F;/g,'/').replace(/\\u0026/g,'&'):null};const video=get(/<meta[^>]+property=["']og:video(?::url)?["'][^>]+content=["']([^"']+)/i)||get(/<meta[^>]+name=["']twitter:player:stream["'][^>]+content=["']([^"']+)/i)||get(/<video[^>]+src=["']([^"']+)/i);const image=get(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)/i);if(!video&&!image)throw new Error('Telegram media unavailable');const title=get(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i)||`Telegram ${p.channel}`;const url=video||image;return{ok:true,title,thumbnail:image||null,type:video?'video':'image',filesize:null,width:null,height:null,ext:video?'mp4':'jpg',url,items:[{url,title,thumbnail:image||null,size:null,format:video?'MP4':'JPG',resolution:''}],sourceUrl:source,provider:`${host}-embed`}}
async function telegramInfo(source){return firstSuccess(['t.me','telegram.me','telegram.dog'].map(host=>[`Telegram ${host}`,()=>telegramEmbed(source,host)]));}

const cache=new Map();
async function resolve(source){const hit=cache.get(source);if(hit&&Date.now()-hit.at<120000)return hit.info;const parsed=parseUrl(source);if(!parsed)throw new Error('Invalid URL');const info=parsed.site==='tiktok'?await tiktokInfo(source):parsed.site==='instagram'?await instagramInfo(source):await telegramInfo(source);cache.set(source,{at:Date.now(),info});return info;}
function mediaHeaders(site,url){const h={'User-Agent':UA,'Accept':'*/*'};if(site==='tiktok'){h.Referer='https://www.tiktok.com/';h.Origin='https://www.tiktok.com'}if(site==='instagram'){h.Referer='https://www.instagram.com/';h.Origin='https://www.instagram.com'}if(site==='telegram')h.Referer='https://t.me/';if(/cobalt|imput\.net|canine\.tools|wuk\.sh|3kh0\.net|meowing\.de/i.test(url)){delete h.Origin;delete h.Referer;h['User-Agent']=APP_UA}return h}
async function fetchMedia(info,site,req){const range=req.headers.range;const headers=mediaHeaders(site,info.url);if(range)headers.Range=range;const tries=[headers,{...headers,Referer:undefined,Origin:undefined,'User-Agent':APP_UA}];let last;for(const hh of tries){try{const media=await fetch(info.url,{headers:Object.fromEntries(Object.entries(hh).filter(([,v])=>v)),redirect:'follow',signal:AbortSignal.timeout(60000)});if(media.ok&&media.body)return media;last=new Error(`media HTTP ${media.status}`)}catch(e){last=e}}throw last||new Error('media unavailable')}
async function sendMedia(info,site,req,res,download){const media=await fetchMedia(info,site,req);const len=Number(media.headers.get('content-length')||0);if(len>MAX_BYTES)throw new Error('file too large');res.status(media.status);res.setHeader('Content-Type',media.headers.get('content-type')||(info.type==='image'?'image/jpeg':'video/mp4'));if(media.headers.get('content-length'))res.setHeader('Content-Length',media.headers.get('content-length'));if(media.headers.get('content-range'))res.setHeader('Content-Range',media.headers.get('content-range'));res.setHeader('Accept-Ranges',media.headers.get('accept-ranges')||'bytes');res.setHeader('Cache-Control','no-store');res.setHeader('Content-Disposition',`${download?'attachment':'inline'}; filename="${safeName(info.title||'drop-media')}.${info.ext||'mp4'}"`);return Readable.fromWeb(media.body).pipe(res)}

app.post('/api/resolve',async(req,res)=>{const source=String(req.body?.url||'').trim();try{const info=await resolve(source);res.json(info)}catch(e){console.error('[resolve]',e?.stack||e);res.status(422).json({error:'Не удалось получить публичное медиа. Проверьте ссылку и доступность публикации.',diagnostic:String(e?.message||e).slice(0,2500)})}});
app.get('/api/download',async(req,res)=>{const source=String(req.query.url||'').trim();try{const parsed=parseUrl(source);if(!parsed)return res.status(400).send('Invalid URL');const info=await resolve(source);await sendMedia(info,parsed.site,req,res,true)}catch(e){console.error('[download]',e?.stack||e);if(!res.headersSent)res.status(422).send('Download unavailable')}});
app.get('/api/preview',async(req,res)=>{const source=String(req.query.url||'').trim();try{const parsed=parseUrl(source);if(!parsed)return res.status(400).send('Invalid URL');const info=await resolve(source);await sendMedia(info,parsed.site,req,res,false)}catch(e){console.error('[preview]',e?.stack||e);if(!res.headersSent)res.status(422).send('Preview unavailable')}});
app.get('/health',(req,res)=>res.json({ok:true,service:'drop',version:'proxy-v5',providers:{tiktok:['tdown','clipx','tikwm-get','tikwm-post','cobalt','yt-dlp'],instagram:['cobalt','yt-dlp','gallery-dl'],telegram:['t.me-embed','telegram.me-embed','telegram.dog-embed']}}));
app.get('/',async(req,res)=>{try{const html=await readFile(path.join(PUBLIC,'index.html'),'utf8');const fix=`<link rel="stylesheet" href="/mobile-fix.css?v=7"><script>document.addEventListener('click',function(e){const f=e.target.closest('.file-btn');if(f){const u=document.querySelector('#url')?.value?.trim();if(u){e.preventDefault();location.href='/api/download?url='+encodeURIComponent(u)}}const w=e.target.closest('.watch-btn');if(w){const u=document.querySelector('#url')?.value?.trim();if(u){e.preventDefault();window.open('/api/preview?url='+encodeURIComponent(u),'_blank')}}});</script>`;res.type('html').send(html.replace('</head>',fix+'</head>'))}catch{res.status(500).send('Application unavailable')}});
app.listen(PORT,'0.0.0.0',()=>console.log(`Drop listening on ${PORT}`));
