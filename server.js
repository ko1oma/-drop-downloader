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

function validUrl(value){
  try{
    const u=new URL(value),h=u.hostname.toLowerCase().replace(/^www\./,'');
    return u.protocol==='https:'&&(h==='tiktok.com'||h.endsWith('.tiktok.com')||h==='instagram.com'||h.endsWith('.instagram.com'));
  }catch{return false}
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
function safeInfo(info){
  const filesize=info.filesize||info.filesize_approx||null;
  return {ok:true,title:info.title||'Media',thumbnail:info.thumbnail||null,type:info._type||'video',filesize,width:info.width||null,height:info.height||null,ext:info.ext||'mp4'};
}
app.get('/health',(q,r)=>r.json({ok:true,service:'drop'}));

app.post('/api/resolve',async(q,r)=>{
  const url=String(q.body?.url||'').trim();
  if(!validUrl(url))return r.status(400).json({error:'Поддерживаются только HTTPS-ссылки TikTok и Instagram.'});
  try{
    const info=JSON.parse(await ytdlp(['--dump-single-json','--no-playlist','--skip-download','--no-warnings','--no-check-certificates',url]));
    if(info.duration>MAX_DURATION)return r.status(413).json({error:'Видео длиннее 15 минут не поддерживается.'});
    r.json(safeInfo(info));
  }catch(e){
    r.status(422).json({error:'Не удалось получить публичное медиа. Проверьте ссылку и доступность публикации.'});
  }
});

app.get('/api/preview',async(q,r)=>{
  const url=String(q.query.url||'').trim();
  if(!validUrl(url))return r.status(400).send('Invalid URL');
  let p;
  try{
    p=spawn('yt-dlp',['--no-playlist','--no-warnings','--quiet','--no-check-certificates','-f','b[ext=mp4]/b','-o','-',url],{stdio:['ignore','pipe','pipe']});
    r.setHeader('Content-Type','video/mp4');
    r.setHeader('Cache-Control','no-store');
    p.stdout.pipe(r);
    p.on('error',()=>{if(!r.headersSent)r.status(422).end();else r.end()});
    p.on('close',code=>{if(code!==0&&!r.headersSent)r.status(422).end();else if(!r.writableEnded)r.end()});
    q.on('close',()=>{if(p&&!p.killed)p.kill('SIGTERM')});
  }catch{if(!r.headersSent)r.status(422).send('Preview unavailable')}
});

app.get('/api/download',async(q,r)=>{
  const url=String(q.query.url||'').trim();
  if(!validUrl(url))return r.status(400).send('Invalid URL');
  const dir=await mkdtemp(path.join(tmpdir(),'drop-'));
  const out=path.join(dir,crypto.randomUUID()+'.%(ext)s');
  try{
    const info=JSON.parse(await ytdlp(['--dump-single-json','--no-playlist','--no-warnings','--no-check-certificates',url]));
    if(info.duration>MAX_DURATION)throw new Error('too long');
    await ytdlp(['--no-playlist','--no-warnings','--no-check-certificates','--no-mtime','--retries','2','--fragment-retries','2','--socket-timeout','20','-N','8','-f','bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b','--merge-output-format','mp4','-o',out,url]);
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
  }catch{
    r.status(500).send('Application unavailable');
  }
});
app.listen(PORT,'0.0.0.0',()=>console.log('Drop listening on '+PORT));
