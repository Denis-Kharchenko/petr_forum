// Локальный сервер киоска: раздаёт файлы проекта и сохраняет фото в папку photos/.
// Нужен потому, что браузер даёт доступ к камере только на http://localhost (не file://).
// Запуск: node server.js  →  http://localhost:8080

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = 8080;
const ROOT = __dirname;
const PHOTOS = path.join(ROOT, "photos");

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
  req.on("end", () => {
    fs.mkdirSync(PHOTOS, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
    const file = path.join(PHOTOS, `petr-${stamp}.jpg`);
    fs.writeFile(file, Buffer.concat(chunks), err => {
      res.writeHead(err ? 500 : 200, { "Content-Type": "text/plain" });
      res.end(err ? "error" : path.basename(file));
    });
  });
}

function serveFile(req, res) {
  let rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (rel === "/") rel = "/index.html";
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT) || file.startsWith(PHOTOS)) {
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
  // адреса для телефона/планшета в той же Wi-Fi сети
  for (const list of Object.values(require("os").networkInterfaces()))
    for (const a of list)
      if (a.family === "IPv4" && !a.internal) console.log(`С телефона:              http://${a.address}:${PORT}`);
});
