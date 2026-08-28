import express from 'express';
import cors from 'cors';
import {spawn} from 'node:child_process';
import {mkdtemp,rm,stat,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
const app=express();
const PORT=Number(process.env.PORT||10000);
const MAX_BYTES=200*1024*1024, MAX_DURATION=15*60;
app.use(cors()); app.use(express.json({limit:'32kb'})); app.use(express.static('public'));
function validUrl(value){try{const u=new URL(value),h=u.hostname.toLowerCase().replace(/^www\./,'');return u.protocol==='https:'&&(h==='tiktok.com'||h.endsWith('.tiktok.com')||h==='instagram.com'||h.endsWith('.instagram.com'));}catch{return false}}
function ytdlp(args){return new Promise((resolve,reject)=>{const p=spawn('yt-dlp',args,{stdio:['ignore','pipe','pipe']});let out='',err='';p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>err+=d);p.on('error',reject);p.on('close',c=>c===0?resolve(out):reject(new Error(err.trim().split('\n').slice(-1)[0]||'media unavailable')));})}
function name(s){return (s||'drop-media').replace(/[^a-z0-9._-]+/gi,'_').slice(0,80)||'drop-media'}
app.get('/health',(q,r)=>r.json({ok:true,service:'drop'}));
app.post('/api/resolve',async(q,r)=>{const url=String(q.body?.url||'').trim();if(!validUrl(url))return r.status(400).json({error:'Поддерживаются только HTTPS-ссылки TikTok и Instagram.'});try{const info=JSON.parse(await ytdlp(['--dump-single-json','--no-playlist','--skip-download','--no-warnings',url]));if(info.duration>MAX_DURATION)return r.status(413).json({error:'Видео длиннее 15 минут не поддерживается.'});r.json({ok:true,title:info.title||'Media',thumbnail:info.thumbnail||null,type:info._type||'video'});}catch{r.status(422).json({error:'Не удалось получить публичное медиа. Проверьте ссылку и доступность публикации.'});}});
app.get('/api/download',async(q,r)=>{const url=String(q.query.url||'').trim();if(!validUrl(url))return r.status(400).send('Invalid URL');const dir=await mkdtemp(path.join(tmpdir(),'drop-')),out=path.join(dir,crypto.randomUUID()+'.%(ext)s');try{const info=JSON.parse(await ytdlp(['--dump-single-json','--no-playlist','--no-warnings',url]));if(info.duration>MAX_DURATION)throw new Error('too long');await ytdlp(['--no-playlist','--no-warnings','-f','bv*+ba/b','--merge-output-format','mp4','-o',out,url]);const files=await readdir(dir),file=files.find(f=>!f.endsWith('.part'));if(!file)throw new Error('no file');const full=path.join(dir,file),s=await stat(full);if(s.size>MAX_BYTES)throw new Error('too large');r.download(full,name((info.title||'drop-media')+'.mp4'),async()=>rm(dir,{recursive:true,force:true}));}catch{await rm(dir,{recursive:true,force:true});if(!r.headersSent)r.status(422).send('Download unavailable');}});
app.get(/^(?!\/api).*/, (q,r)=>r.sendFile(path.resolve('public/index.html')));
app.listen(PORT,'0.0.0.0',()=>console.log('Drop listening on '+PORT));
