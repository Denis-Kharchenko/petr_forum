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
//   Для организаторов (пароль браузера = UPLOAD_TOKEN, логин любой):
//   GET  /admin             все снимки сеткой, новые сверху
//   GET  /admin/all.zip     все снимки одним архивом
//   POST /admin/delete/<id> удалить снимок
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

// Вход организатора: обычное окно логина браузера (HTTP Basic), пароль — UPLOAD_TOKEN
function isAdmin(req) {
  const m = /^Basic\s+(.+)$/i.exec(req.headers.authorization || "");
  if (!m) return false;
  const pass = Buffer.from(m[1], "base64").toString().replace(/^[^:]*:/, "");
  return sameToken(pass);
}

function askLogin(res) {
  res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Petr photos", charset="UTF-8"', "Content-Type": "text/plain; charset=utf-8" });
  res.end("Нужен пароль организатора");
}

// Снимки, новые сверху: [{ id, time, size }]
function listPhotos() {
  return fs.readdirSync(DIR)
    .filter(n => n.endsWith(".jpg") && ID_RE.test(n.slice(0, -4)))
    .map(n => { const st = fs.statSync(path.join(DIR, n)); return { id: n.slice(0, -4), time: st.mtime, size: st.size }; })
    .sort((a, b) => b.time - a.time);
}

const stamp = d => d.toISOString().replace(/[:T]/g, "-").slice(0, 19);

function adminPage(res) {
  const photos = listPhotos();
  const mb = (photos.reduce((s, p) => s + p.size, 0) / 1048576).toFixed(1);
  const fmt = new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
  const cards = photos.map(p => `
    <figure data-id="${p.id}">
      <a href="/p/${p.id}.jpg" target="_blank"><img src="/p/${p.id}.jpg" loading="lazy" alt=""></a>
      <figcaption>
        <span>${fmt.format(p.time)}</span>
        <a href="/p/${p.id}.jpg?download">Скачать</a>
        <button type="button">Удалить</button>
      </figcaption>
    </figure>`).join("");

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(`<!doctype html>
<html lang="ru"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Фото с Петром — организаторам</title>
<style>${STYLE}
  body { align-items:stretch; max-width:1400px; margin:0 auto; }
  header { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:12px 24px; }
  header h1 { text-align:left; }
  header p { margin:4px 0 0; text-align:left; max-width:none; }
  header .btn { margin:0; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(240px, 1fr)); gap:16px; margin-top:24px; }
  figure { border:1px solid var(--line); border-radius:3px; overflow:hidden; background:#140e0b; }
  figure img { margin:0; border:0; border-radius:0; aspect-ratio:16/9; object-fit:cover; }
  figcaption { display:flex; align-items:center; gap:12px; padding:10px 12px; font-size:14px; color:var(--muted); }
  figcaption span { flex:1; }
  figcaption a, figcaption button { color:var(--gold); background:none; border:0; font:inherit; cursor:pointer; text-decoration:none; }
  figcaption button { color:#d98a7a; }
  .empty { margin-top:40px; }
</style>
</head><body>
  <header>
    <div>
      <h1>Фото с Петром I</h1>
      <p>Снимков: ${photos.length} (${mb} МБ). Снимки удаляются через ${RETENTION_DAYS} дней после съёмки.</p>
    </div>
    ${photos.length ? `<a class="btn" href="/admin/all.zip">Скачать всё (ZIP)</a>` : ""}
  </header>
  ${photos.length ? `<div class="grid">${cards}</div>` : `<p class="empty">Снимков пока нет.</p>`}
<script>
  document.addEventListener("click", async e => {
    const btn = e.target.closest("figcaption button");
    if (!btn) return;
    const fig = btn.closest("figure");
    if (!confirm("Удалить этот снимок? Ссылка у гостя перестанет работать.")) return;
    const r = await fetch("/admin/delete/" + fig.dataset.id, { method: "POST" });
    if (r.ok) fig.remove(); else alert("Не удалось удалить");
  });
</script>
</body></html>`);
}

// ZIP без сжатия (JPEG уже сжат): по одному файлу, без лишней памяти
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function dosTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

async function adminZip(res) {
  const photos = listPhotos();
  res.writeHead(200, {
    "Content-Type": "application/zip",
    "Content-Disposition": `attachment; filename="petr-photos-${stamp(new Date()).slice(0, 10)}.zip"`,
    "Cache-Control": "no-store",
  });
  const write = buf => res.write(buf) ? null : new Promise(r => res.once("drain", r));
  const central = [];
  let offset = 0;

  for (const p of photos) {
    let data;
    try { data = await fs.promises.readFile(fileOf(p.id)); } catch { continue; }   // успел удалиться
    const name = Buffer.from(`petr-${stamp(p.time)}-${p.id.slice(0, 6)}.jpg`);
    const crc = crc32(data), { time, date } = dosTime(p.time);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
    local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    await write(local); await write(name); await write(data);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(time, 12); entry.writeUInt16LE(date, 14);
    entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(data.length, 20); entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28); entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += local.length + name.length + data.length;
  }

  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  await write(dir);
  res.end(end);
}

function adminDelete(req, res, id) {
  // удаление только со страницы /admin этого же сервиса
  if (req.headers.origin !== PUBLIC_URL) return send(res, 403, "forbidden");
  fs.unlink(fileOf(id), err => send(res, err ? 404 : 200, err ? "not found" : "ok"));
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

  if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
    if (!isAdmin(req)) return askLogin(res);
    const del = /^\/admin\/delete\/([^/]+)$/.exec(url.pathname);
    if (req.method === "GET" && url.pathname === "/admin") return adminPage(res);
    if (req.method === "GET" && url.pathname === "/admin/all.zip") return adminZip(res).catch(e => { console.error(e); res.destroy(); });
    if (req.method === "POST" && del && ID_RE.test(del[1])) return adminDelete(req, res, del[1]);
    return notFound(res);
  }
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
