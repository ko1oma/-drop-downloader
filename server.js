import express from 'express';
import cors from 'cors';
import {spawn} from 'node:child_process';
import {mkdtemp,rm,stat,readdir,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import crypto from 'node:crypto';

const app=express();
const PORT=Number(process.env.PORT||10000);
const ROOT=path.dirname(fileURLToPath(import.meta.url));
const PUBLIC=path.join(ROOT,'public');
const MAX_BYTES=200*1024*1024, MAX_DURATION=15*60;
app.use(cors());
app.use(express.json({limit:'32kb'}));
app.use(express.static(PUBLIC,{index:false}));

function parseUrl(value){
  try{
    const u=new URL(value),h=u.hostname.toLowerCase().replace(/^www\./,'');
    if(u.protocol!=='https:')return null;
    if(h==='tiktok.com'||h.endsWith('.tiktok.com'))return {url:u,site:'tiktok'};
    if(h==='instagram.com'||h.endsWith('.instagram.com'))return {url:u,site:'instagram'};
    if(h==='t.me'||h==='telegram.me'||h==='telegram.dog')return {url:u,site:'telegram'};
    return null;
  }catch{return null}
}
function ytdlp(args){
  return new Promise((resolve,reject)=>{
    const p=spawn('yt-dlp',args,{stdio:['ignore','pipe','pipe']});
    let out='',err='';
    p.stdout.on('data',d=>out+=d);
    p.stderr.on('data',d=>err+=d);
    p.on('error',reject);
    p.on('close',c=>c===0?resolve(out):reject(new Error(err.trim().split('\n').slice(-1)[0]||'media unavailable')));
  });
}
function name(s){return(s||'drop-media').replace(/[^a-z0-9._-]+/gi,'_').slice(0,80)||'drop-media'}
function safeInfo(info,sourceUrl){
  const filesize=info.filesize||info.filesize_approx||null;
  const mediaUrl=info.url||null;
  const ext=info.ext||'mp4';
  return {ok:true,title:info.title||'Media',thumbnail:info.thumbnail||null,type:info._type||'video',filesize,width:info.width||null,height:info.height||null,ext,url:mediaUrl,items:mediaUrl?[{url:mediaUrl,title:info.title||'Media',thumbnail:info.thumbnail||null,size:filesize,format:ext,resolution:info.width&&info.height?`${info.width}×${info.height}`:''}]:[],sourceUrl};
}
function telegramPath(u){
  const parts=u.pathname.split('/').filter(Boolean);
  if(parts[0]==='s')parts.shift();
  if(parts.length<2)return null;
  const channel=parts[0].replace(/^@/,'');
  const id=parts[1];
  if(!/^[A-Za-z0-9_]+$/.test(channel)||!/^[0-9]+$/.test(id))return null;
  return {channel,id};
}
async function telegramInfo(source){
  const p=telegramPath(source);
  if(!p)throw new Error('invalid telegram link');
  const embed=`https://t.me/${p.channel}/${p.id}?embed=1`;
  const resp=await fetch(embed,{redirect:'follow',headers:{'User-Agent':'Mozilla/5.0 (compatible; Drop/1.0)'}});
  if(!resp.ok)throw new Error('telegram unavailable');
  const html=await resp.text();
  const get=(re)=>{const m=html.match(re);return m?m[1].replace(/&amp;/g,'&').replace(/&#x2F;/g,'/'):null};
  const video=get(/<meta[^>]+property=["']og:video(?::url)?["'][^>]+content=["']([^"']+)/i)||get(/<meta[^>]+name=["']twitter:player:stream["'][^>]+content=["']([^"']+)/i)||get(/<video[^>]+src=["']([^"']+)/i);
  const image=get(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)/i);
  const title=get(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i)||`Telegram ${p.channel}`;
  if(!video&&!image)throw new Error('telegram media unavailable');
  return {ok:true,title,thumbnail:image||null,type:video?'video':'image',filesize:null,width:null,height:null,ext:video?'mp4':'jpg',url:video||image,items:[{url:video||image,title,thumbnail:image||null,size:null,format:video?'MP4':'JPG',resolution:''}],sourceUrl:source};
}
app.get('/health',(q,r)=>r.json({ok:true,service:'drop'}));

app.post('/api/resolve',async(q,r)=>{
  const source=String(q.body?.url||'').trim();
  const parsed=parseUrl(source);
  if(!parsed)return r.status(400).json({error:'Поддерживаются HTTPS-ссылки TikTok, Instagram и публичных Telegram-постов.'});
  try{
    if(parsed.site==='telegram')return r.json(await telegramInfo(source));
    const info=JSON.parse(await ytdlp(['--dump-single-json','--no-playlist','--skip-download','--no-warnings','--no-check-certificates',source]));
    if(info.duration>MAX_DURATION)return r.status(413).json({error:'Видео длиннее 15 минут не поддерживается.'});
    r.json(safeInfo(info,source));
  }catch(e){
    r.status(422).json({error:'Не удалось получить публичное медиа. Проверьте ссылку и доступность публикации.'});
  }
});

app.get('/api/preview',async(q,r)=>{
  const source=String(q.query.url||'').trim();
  const parsed=parseUrl(source);
  if(!parsed)return r.status(400).send('Invalid URL');
  try{
    if(parsed.site==='telegram'){
      const info=await telegramInfo(source);
      if(!info.url)return r.status(422).send('Preview unavailable');
      return r.redirect(info.url);
    }
    const p=spawn('yt-dlp',['--no-playlist','--no-warnings','--quiet','--no-check-certificates','-f','b[ext=mp4]/b','-o','-',source],{stdio:['ignore','pipe','pipe']});
    r.setHeader('Content-Type','video/mp4');
    r.setHeader('Cache-Control','no-store');
    p.stdout.pipe(r);
    p.on('error',()=>{if(!r.headersSent)r.status(422).end();else r.end()});
    p.on('close',code=>{if(code!==0&&!r.headersSent)r.status(422).end();else if(!r.writableEnded)r.end()});
    q.on('close',()=>{if(p&&!p.killed)p.kill('SIGTERM')});
  }catch{if(!r.headersSent)r.status(422).send('Preview unavailable')}
});

app.get('/api/download',async(q,r)=>{
  const source=String(q.query.url||'').trim();
  const parsed=parseUrl(source);
  if(!parsed)return r.status(400).send('Invalid URL');
  if(parsed.site==='telegram'){
    try{
      const info=await telegramInfo(source);
      const media=await fetch(info.url,{headers:{'User-Agent':'Mozilla/5.0'}});
      if(!media.ok||!media.body)throw new Error('media unavailable');
      const type=media.headers.get('content-type')||'application/octet-stream';
      const ext=type.includes('image')?'jpg':'mp4';
      r.setHeader('Content-Type',type);
      r.setHeader('Content-Disposition',`attachment; filename="${name(info.title||'telegram-media')}.${ext}"`);
      return media.body.pipeTo(WritableStream.prototype).catch(()=>{});
    }catch(e){return r.status(422).send('Download unavailable')}
  }
  const dir=await mkdtemp(path.join(tmpdir(),'drop-'));
  const out=path.join(dir,crypto.randomUUID()+'.%(ext)s');
  try{
    const info=JSON.parse(await ytdlp(['--dump-single-json','--no-playlist','--no-warnings','--no-check-certificates',source]));
    if(info.duration>MAX_DURATION)throw new Error('too long');
    await ytdlp(['--no-playlist','--no-warnings','--no-check-certificates','--no-mtime','--retries','2','--fragment-retries','2','--socket-timeout','20','-N','8','-f','bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b','--merge-output-format','mp4','-o',out,source]);
    const files=await readdir(dir),file=files.find(f=>!f.endsWith('.part'));
    if(!file)throw new Error('no file');
    const full=path.join(dir,file),s=await stat(full);
    if(s.size>MAX_BYTES)throw new Error('too large');
    r.download(full,name((info.title||'drop-media')+'.mp4'),async()=>rm(dir,{recursive:true,force:true}));
  }catch(e){
    await rm(dir,{recursive:true,force:true});
    if(!r.headersSent)r.status(422).send('Download unavailable');
  }
});

app.get('/',async(q,r)=>{
  try{
    const html=await readFile(path.join(PUBLIC,'index.html'),'utf8');
    r.type('html').send(html.replace('</head>','<link rel="stylesheet" href="/mobile-fix.css?v=2"></head>'));
  }catch{r.status(500).send('Application unavailable')}
});
app.listen(PORT,'0.0.0.0',()=>console.log('Drop listening on '+PORT));