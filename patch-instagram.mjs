import {readFile, writeFile} from 'node:fs/promises';

const serverPath=new URL('./server.js',import.meta.url);
const indexPath=new URL('./public/index.html',import.meta.url);
let s=await readFile(serverPath,'utf8');
let html=await readFile(indexPath,'utf8');

// Add Instaloader as an Instagram fallback. It is already installed in the
// Docker image; unlike public Cobalt instances it runs on our own Render host.
if(!s.includes('async function instagramInstaloader')){
  const marker='async function instagramGallery(source){';
  const actual=`async function instagramInstaloader(source){
  const py=${JSON.stringify("import sys,re\nfrom urllib.parse import urlparse\nimport instaloader\nfrom instaloader import Post\nu=urlparse(sys.argv[1])\nparts=[x for x in u.path.split('/') if x]\nsc=None\nfor i,x in enumerate(parts):\n    if x in ('reel','p','tv') and i+1<len(parts):\n        sc=parts[i+1]\n        break\nif not sc:\n    m=re.search(r'/([A-Za-z0-9_-]{5,})/?$',u.path)\n    sc=m.group(1) if m else None\nif not sc:\n    raise SystemExit('Instagram shortcode not found')\nL=instaloader.Instaloader(quiet=True,download_pictures=False,download_videos=False,download_video_thumbnails=False,save_metadata=False,compress_json=False)\npost=Post.from_shortcode(L.context,sc)\nprint(post.video_url if post.is_video else post.url")};
  const fn=`async function instagramInstaloader(source){
  const out=await child(['-c',py,source],{cmd:'python3',timeout:45000});
  const url=out.trim().split(/\\s+/).find(x=>/^https?:\\/\\//.test(x));
  if(!url)throw new Error('Instaloader returned no media URL');
  return{ok:true,title:'Instagram media',thumbnail:null,type:'video',filesize:null,width:null,height:null,ext:'mp4',url,items:[{url,title:'Instagram media',thumbnail:null,size:null,format:'MP4',resolution:''}],sourceUrl:source,provider:'instaloader'};
}
`;
  s=s.replace(marker,fn+marker);
}

const oldInstagram="async function instagramInfo(source){return firstSuccess([['Cobalt',()=>cobaltInfo(source)],['yt-dlp',()=>ytInfo(source)],['gallery-dl',()=>instagramGallery(source)]]);}";
const newInstagram="async function instagramInfo(source){const tasks=[['yt-dlp',()=>ytInfo(source)],['Instaloader',()=>instagramInstaloader(source)],['Cobalt',()=>cobaltInfo(source)],['gallery-dl',()=>instagramGallery(source)]];try{return await firstSuccess(tasks)}catch(e){console.error('[Instagram providers]',e?.stack||e);throw new Error('Instagram providers failed')}}";
if(s.includes(oldInstagram))s=s.replace(oldInstagram,newInstagram);

// Keep provider diagnostics in server logs, not in the public error card.
s=s.replace(/res\.status\(422\)\.json\(\{error:[^\n]*\}\)/g,"res.status(422).json({error:'Не удалось получить публичное медиа. Возможно, публикация недоступна или Instagram временно ограничил доступ.',diagnostic:String(e?.message||e).slice(0,2500)})");
await writeFile(serverPath,s);

// Intercept the existing Paste button before its old click handler. Safari may
// still display Apple's own clipboard permission UI; that is an iOS restriction
// and cannot be removed by website JavaScript.
if(!html.includes('drop-paste-direct-fix')){
  const script=`<script id="drop-paste-direct-fix">(()=>{const boot=()=>{const b=document.querySelector('.paste'),i=document.querySelector('input');if(!b||!i)return;b.addEventListener('click',async e=>{e.preventDefault();e.stopImmediatePropagation();try{const t=(await navigator.clipboard.readText()).trim();if(t){i.value=t;i.dispatchEvent(new Event('input',{bubbles:true}));i.dispatchEvent(new Event('change',{bubbles:true}));}}catch{try{i.focus();document.execCommand('paste')}catch{}}},true)};document.readyState==='loading'?document.addEventListener('DOMContentLoaded',boot):boot()})();</script>`;
  html=html.replace('</body>',script+'\n</body>');
}
await writeFile(indexPath,html);
console.log('[build] Instagram + paste patch applied');
