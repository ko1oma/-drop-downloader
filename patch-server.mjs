import {readFile, writeFile} from 'node:fs/promises';

const path = new URL('./server.js', import.meta.url);
let s = await readFile(path, 'utf8');

// Keep the official Cobalt instance in the fallback pool. Community instances
// can disappear or rate-limit Render's shared IPs.
if (!s.includes("https://api.cobalt.tools/")) {
  s = s.replace(
    "const COBALT_STATIC=[",
    "const COBALT_STATIC=['https://api.cobalt.tools/',"
  );
}

// TikTok currently requires browser-like TLS/request fingerprints in some
// regions. curl-cffi is installed by Dockerfile, so ask yt-dlp to use it.
// Do not override the browser UA after impersonation: curl-cffi must keep its
// TLS fingerprint and User-Agent consistent.
const oldYt = "'--socket-timeout','15','--user-agent',UA,source";
const newYt = "'--socket-timeout','15','--impersonate','chrome','--extractor-args','tiktok:app_name=trill',source";
if (s.includes(oldYt) && !s.includes("'--impersonate','chrome'")) {
  s = s.replace(oldYt, newYt);
}

// Do not hide the real provider diagnostics while debugging a public link.
const oldError = "res.status(422).json({error:'Не удалось получить публичное медиа. Проверьте ссылку и доступность публикации.',diagnostic:String(e?.message||e).slice(0,2500)})";
const newError = "res.status(422).json({error:`Не удалось получить публичное медиа. ${String(e?.message||e).slice(0,2500)}`,diagnostic:String(e?.message||e).slice(0,2500)})";
if (s.includes(oldError)) s = s.replace(oldError, newError);

await writeFile(path, s);
console.log('[build] server compatibility patch applied');
