// Локальный сервер киоска: раздаёт файлы проекта и сохраняет фото в папку photos/.
// Нужен потому, что браузер даёт доступ к камере только на http://localhost (не file://).
// Если есть cloud.json — копия фото уходит в облако (cloud/ на Railway),
// а киоск показывает гостю QR-код со ссылкой.
// Запуск: node server.js  →  http://localhost:8080

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = 8080;
const ROOT = __dirname;
const PHOTOS = path.join(ROOT, "photos");
const CLOUD_CONFIG = path.join(ROOT, "cloud.json");   // { "url": "https://…", "token": "…" }, в git не попадает

function readCloud() {
  try {
    // Блокнот Windows может сохранить файл с BOM — убираем его
    const c = JSON.parse(fs.readFileSync(CLOUD_CONFIG, "utf8").replace(/^﻿/, ""));
    if (c.url && c.token) return { url: c.url.replace(/\/$/, ""), token: c.token };
  } catch {}
  return null;
}
const cloud = readCloud();

// Отправляет снимок в облако; ссылка для гостя или null
async function uploadToCloud(body) {
  if (!cloud) return null;
  try {
    const r = await fetch(cloud.url + "/upload", {
      method: "POST",
      headers: { "Authorization": "Bearer " + cloud.token, "Content-Type": "image/jpeg" },
      body,
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return (await r.json()).url;
  } catch (e) {
    console.error("Не удалось отправить фото в облако:", e.message);
    return null;
  }
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".tflite": "application/octet-stream",
  ".mp4": "video/mp4",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

function savePhoto(req, res) {
  const chunks = [];
  req.on("data", c => chunks.push(c));
  req.on("end", async () => {
    const body = Buffer.concat(chunks);
    // архив у организаторов: photos/<день>/petr-<время>.jpg
    const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
    const dir = path.join(PHOTOS, stamp.slice(0, 10));
    const file = path.join(dir, `petr-${stamp}.jpg`);
    let saved = true;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, body);
    } catch (e) {
      console.error("Не удалось сохранить фото:", e.message);
      saved = false;
    }
    const url = await uploadToCloud(body);
    res.writeHead(saved || url ? 200 : 500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ file: saved ? path.basename(file) : null, url }));
  });
}

function serveFile(req, res) {
  let rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (rel === "/") rel = "/index.html";
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT) || file.startsWith(PHOTOS) || file === CLOUD_CONFIG) {
    res.writeHead(403); return res.end();
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end(); }
    const type = MIME[path.extname(file).toLowerCase()] || "application/octet-stream";

    // Range-запросы: видео нужно для перемотки и зацикливания
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || "");
    if (range) {
      const start = range[1] ? +range[1] : 0;
      const end = range[2] ? Math.min(+range[2], st.size - 1) : st.size - 1;
      res.writeHead(206, {
        "Content-Type": type,
        "Content-Range": `bytes ${start}-${end}/${st.size}`,
        "Content-Length": end - start + 1,
        "Accept-Ranges": "bytes",
      });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { "Content-Type": type, "Content-Length": st.size, "Accept-Ranges": "bytes" });
    fs.createReadStream(file).pipe(res);
  });
}

http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/save") return savePhoto(req, res);
  serveFile(req, res);
}).listen(PORT, "0.0.0.0", () => {
  console.log(`Киоск на этом компьютере: http://localhost:${PORT}`);
  console.log(cloud ? `Фото уходят в облако: ${cloud.url}` : "cloud.json не найден — фото только в photos/, без QR");
  // адреса для телефона/планшета в той же Wi-Fi сети
  for (const list of Object.values(require("os").networkInterfaces()))
    for (const a of list)
      if (a.family === "IPv4" && !a.internal) console.log(`С телефона:              http://${a.address}:${PORT}`);
});
