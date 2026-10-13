// Облако для фото с Петром (Railway).
// Киоск присылает снимок → сервис хранит его на Volume и отдаёт ссылку,
// которую киоск показывает гостю QR-кодом.
//
//   POST /upload        тело — JPEG, заголовок Authorization: Bearer <UPLOAD_TOKEN>
//                       → { "id": "...", "url": "https://.../p/<id>" }
//   GET  /p/<id>        страница с фото и кнопкой «Скачать»
//   GET  /p/<id>.jpg    сам снимок (?download — сохранить файлом)
//   GET  /health        проверка для Railway
//
// Переменные окружения:
//   UPLOAD_TOKEN    секрет киоска (обязательно)
//   RETENTION_DAYS  сколько дней хранить снимки (по умолчанию 30)
//   ALLOWED_ORIGINS сайты, с которых браузер киоска может слать фото напрямую,
//                   через запятую (по умолчанию GitHub Pages киоска)
//   PUBLIC_URL      адрес сервиса; по умолчанию берётся домен Railway
//   PORT, RAILWAY_VOLUME_MOUNT_PATH, RAILWAY_PUBLIC_DOMAIN — задаёт Railway

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.UPLOAD_TOKEN || "";
const RETENTION_DAYS = +process.env.RETENTION_DAYS || 30;
const DIR = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, "data"), "photos");
const PUBLIC_URL = (process.env.PUBLIC_URL
  || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : `http://localhost:${PORT}`)
).replace(/\/$/, "");
const MAX_SIZE = 15 * 1024 * 1024;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "https://denis-kharchenko.github.io")
  .split(",").map(s => s.trim()).filter(Boolean);

// Киоск, открытый с GitHub Pages, шлёт фото из браузера — разрешаем это его сайту
function cors(req, res) {
  const origin = req.headers.origin;
  if (!ALLOWED_ORIGINS.includes(origin)) return;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
  res.setHeader("Vary", "Origin");
}

if (!TOKEN) console.warn("UPLOAD_TOKEN не задан — загрузка фото отключена");
fs.mkdirSync(DIR, { recursive: true });

const ID_RE = /^[A-Za-z0-9_-]{16}$/;   // 12 случайных байт в base64url — не подобрать перебором
const fileOf = id => path.join(DIR, id + ".jpg");

function sameToken(header) {
  const got = Buffer.from((header || "").replace(/^Bearer\s+/i, ""));
  const want = Buffer.from(TOKEN);
  return TOKEN && got.length === want.length && crypto.timingSafeEqual(got, want);
}

function upload(req, res) {
  if (!sameToken(req.headers.authorization)) return send(res, 401, "unauthorized");

  const chunks = [];
  let size = 0;
  req.on("data", c => {
    size += c.length;
    if (size > MAX_SIZE) { send(res, 413, "too large"); req.destroy(); }
    else chunks.push(c);
  });
  req.on("end", () => {
    if (res.headersSent) return;
    const body = Buffer.concat(chunks);
    if (body[0] !== 0xff || body[1] !== 0xd8) return send(res, 400, "not a jpeg");

    const id = crypto.randomBytes(12).toString("base64url");
    fs.writeFile(fileOf(id), body, err => {
      if (err) { console.error(err); return send(res, 500, "error"); }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id, url: `${PUBLIC_URL}/p/${id}` }));
    });
  });
}

function photo(res, id, download) {
  const file = fileOf(id);
  fs.stat(file, (err, st) => {
    if (err) return notFound(res);
    res.writeHead(200, {
      "Content-Type": "image/jpeg",
      "Content-Length": st.size,
      "Cache-Control": "private, max-age=86400",
      ...(download && { "Content-Disposition": `attachment; filename="petr-${id.slice(0, 6)}.jpg"` }),
    });
    fs.createReadStream(file).pipe(res);
  });
}

function page(res, id) {
  fs.access(fileOf(id), err => {
    if (err) return notFound(res);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(PAGE.replaceAll("{{ID}}", id));
  });
}

function notFound(res) {
  res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
  res.end(PAGE_404);
}

function send(res, code, text) {
  res.writeHead(code, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

// Удаляем снимки старше RETENTION_DAYS
function cleanup() {
  const limit = Date.now() - RETENTION_DAYS * 86400e3;
  for (const name of fs.readdirSync(DIR)) {
    const file = path.join(DIR, name);
    try { if (fs.statSync(file).mtimeMs < limit) fs.unlinkSync(file); } catch {}
  }
}
cleanup();
setInterval(cleanup, 3600e3);

http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const m = /^\/p\/([^/.]+)(\.jpg)?$/.exec(url.pathname);

  if (url.pathname === "/upload") {
    cors(req, res);
    if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
    if (req.method === "POST") return upload(req, res);
  }
  if (req.method === "GET" && url.pathname === "/health") return send(res, 200, "ok");
  if (req.method === "GET" && m && ID_RE.test(m[1])) {
    return m[2] ? photo(res, m[1], url.searchParams.has("download")) : page(res, m[1]);
  }
  notFound(res);
}).listen(PORT, () => console.log(`Фото-облако: ${PUBLIC_URL} (хранение ${RETENTION_DAYS} дн., ${DIR})`));


/* =========================================================
   СТРАНИЦЫ ДЛЯ ГОСТЯ (открываются на телефоне по QR)
   ========================================================= */

const STYLE = `
  :root { --ink:#0a0706; --gold:#d6ad55; --paper:#f3ead7; --muted:#c4b597; --line:rgba(214,173,85,.42); }
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body { background:var(--ink); color:var(--paper); }
  body { min-height:100vh; display:flex; flex-direction:column; align-items:center;
         padding:28px 16px 40px; font-family:"Segoe UI", system-ui, -apple-system, sans-serif; }
  h1 { font-family:Georgia, "Times New Roman", serif; font-weight:600; font-size:32px; color:var(--gold); text-align:center; }
  p  { margin-top:8px; font-size:16px; line-height:1.45; color:var(--muted); text-align:center; max-width:34ch; }
  img { display:block; width:100%; max-width:960px; margin-top:22px; border:1px solid var(--line); border-radius:3px; }
  .btn { display:inline-flex; align-items:center; justify-content:center; margin-top:22px; min-height:54px;
         padding:0 28px; border-radius:3px; background:var(--gold); color:var(--ink);
         font-size:18px; font-weight:600; text-decoration:none; }
  .note { margin-top:14px; font-size:14px; }
`;

const PAGE = `<!doctype html>
<html lang="ru"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Фото с Петром I</title>
<style>${STYLE}</style>
</head><body>
  <h1>Фото с Петром I</h1>
  <p>Спасибо, что заглянули к государю!</p>
  <img src="/p/{{ID}}.jpg" alt="Ваше фото с Петром I">
  <a class="btn" href="/p/{{ID}}.jpg?download" download>Скачать фото</a>
  <p class="note">Если кнопка не сработала — нажмите на фото и удерживайте, затем «Сохранить». Ссылка действует ${RETENTION_DAYS} дней.</p>
</body></html>`;

const PAGE_404 = `<!doctype html>
<html lang="ru"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Фото не найдено</title>
<style>${STYLE} body { justify-content:center; }</style>
</head><body>
  <h1>Фото не найдено</h1>
  <p>Возможно, срок хранения (${RETENTION_DAYS} дней) истёк или ссылка набрана с ошибкой.</p>
</body></html>`;
