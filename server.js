import express from "express";
import cors from "cors";
import { spawn } from "node:child_process";
import { mkdtemp, rm, readdir, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const app = express();
const PORT = Number(process.env.PORT || 10000);
const HOST = "0.0.0.0";
app.use(cors());
app.use(express.json({ limit: "32kb" }));
app.use(express.static("public"));

const MAX_SECONDS = Number(process.env.MAX_MEDIA_SECONDS || 900);
const allowed = (value) => {
  try {
    const u = new URL(value);
    const h = u.hostname.toLowerCase();
    return h === "tiktok.com" || h.endsWith(".tiktok.com") || h === "instagram.com" || h.endsWith(".instagram.com");
  } catch { return false; }
};

function runYtdlp(args, cwd) {
  return new Promise((resolve, reject) => {
    const p = spawn("yt-dlp", args, { cwd });
    let stdout = "", stderr = "";
    p.stdout.on("data", d => stdout += d);
    p.stderr.on("data", d => stderr += d);
    p.on("error", reject);
    p.on("close", code => code === 0 ? resolve(stdout) : reject(new Error(stderr.slice(-2500) || `yt-dlp exited ${code}`)));
  });
}

app.get("/health", (_req, res) => res.json({ ok: true, service: "drop" }));

app.post("/api/resolve", async (req, res) => {
  const url = String(req.body?.url || "").trim();
  if (!allowed(url)) return res.status(400).json({ error: "Only public TikTok and Instagram URLs are supported." });
  const dir = await mkdtemp(path.join(os.tmpdir(), "drop-"));
  try {
    const raw = await runYtdlp(["--no-playlist", "--dump-single-json", "--no-warnings", "--skip-download", "--socket-timeout", "20", url], dir);
    const info = JSON.parse(raw);
    if (info.duration && Number(info.duration) > MAX_SECONDS) return res.status(400).json({ error: "This media is longer than the allowed limit." });
    const title = info.title || info.id || "Media";
    return res.json({ platform: info.extractor_key || info.extractor || "unknown", title, items: [{ title, url: `/api/download?url=${encodeURIComponent(url)}` }] });
  } catch {
    return res.status(502).json({ error: "The public media could not be resolved right now." });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

app.get("/api/download", async (req, res) => {
  const url = String(req.query.url || "").trim();
  if (!allowed(url)) return res.status(400).json({ error: "Unsupported URL." });
  const dir = await mkdtemp(path.join(os.tmpdir(), "drop-download-"));
  const id = crypto.randomBytes(8).toString("hex");
  const output = path.join(dir, `${id}.%(ext)s`);
  try {
    await runYtdlp(["--no-playlist", "--no-warnings", "--restrict-filenames", "--max-filesize", "200M", "--merge-output-format", "mp4", "-o", output, url], dir);
    const files = await readdir(dir);
    const file = files.find(f => f.startsWith(id + "."));
    if (!file) throw new Error("No output file");
    const full = path.join(dir, file);
    const info = await stat(full);
    const ext = path.extname(file) || ".mp4";
    res.setHeader("Content-Type", ext.toLowerCase() === ".mp4" ? "video/mp4" : "application/octet-stream");
    res.setHeader("Content-Length", String(info.size));
    res.setHeader("Content-Disposition", `attachment; filename="drop-${Date.now()}${ext}"`);
    const stream = createReadStream(full);
    const cleanup = () => rm(dir, { recursive: true, force: true }).catch(() => {});
    stream.on("close", cleanup); stream.on("error", cleanup); stream.pipe(res);
  } catch {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    if (!res.headersSent) res.status(502).json({ error: "Download failed. The public media may be unavailable." });
  }
});

app.listen(PORT, HOST, () => console.log(`Drop listening on ${HOST}:${PORT}`));
