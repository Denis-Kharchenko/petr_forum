// Фото с Петром: камера → вырезаем человека по силуэту (MediaPipe) →
// ставим его передним планом рядом с Петром, под его вытянутую руку.
import { FilesetResolver, ImageSegmenter } from "./lib/mediapipe/vision_bundle.mjs";

/* =========================================================
   НАСТРОЙКИ ФОТО
   Фон и Пётр — две картинки одного размера (2752×1536).
   Координаты Петра и человека — в пикселях картинки Петра,
   до сдвига пары в центр кадра.
   ========================================================= */

const BG_SRC   = "photo/shipyard.jpg";   // верфь (неподвижна)
const PETR_SRC = "photo/petr.png";       // Пётр с прозрачным фоном

// Пётр на своей картинке
const PETR = {
  headTop: 327,   // макушка
  head: 265,      // высота головы: от макушки до подбородка
};

// Где встаёт человек
const PERSON = {
  below: 0.45,     // макушка ниже, чем у Петра, на столько голов (0.5 — полголовы, 1 — голова)
  headScale: 0.95, // голова человека относительно головы Петра
  x: 1180,         // центр лица по горизонтали: рука Петра уходит за шею,
                   // кисть (x 1290–1449) видна с дальней стороны
  xPortrait: 1040, // то же на вертикальном экране: кадр узкий, человек ближе к Петру
};

// Середина пары «Пётр + человек»: она встаёт в центр кадра
const PAIR_CENTER = 900;
const PAIR_CENTER_PORTRAIT = 860;

const PERSON_FILTER = "sepia(0.15) saturate(0.9) contrast(1.04) brightness(0.96)"; // под тёплый свет сцены
const EDGE_SOFTNESS = 1.5;               // мягкость края вырезки, px камеры
const MASK_LOW = 0.3, MASK_HIGH = 0.65;  // уверенность нейросети: ниже — фон, выше — человек
const SMOOTH = 0.25;                     // сглаживание движения (0…1, меньше — плавнее)

// Вырезка: нейросеть смотрит не на весь кадр камеры, а на область вокруг
// человека — так на него приходится больше точек её маски 256×256
const CROP_MARGIN = 0.25;   // запас вокруг человека, доля его размера
const CROP_SMOOTH = 0.3;    // как быстро область сжимается за человеком (расширяется сразу)
const MASK_SMOOTH = 0.35;   // сглаживание маски между кадрами: меньше — меньше дрожит край,
                            // но при резком движении маска догоняет медленнее
const GRID = 2;             // маска хранится с шагом в столько px камеры
// Остаётся только один силуэт — тот, где лицо; пятна фона и других людей отбрасываются
// Облако для фото (cloud/ на Railway). Если киоск открыт не через
// локальный сервер (например, с GitHub Pages), браузер шлёт фото туда сам.
// Ключ вводится один раз: откройте forum.html#key=<UPLOAD_TOKEN> —
// он запомнится в этом браузере и сразу пропадёт из адреса.
const CLOUD_URL = "https://petrforum-production.up.railway.app";
const KEY_STORAGE = "petr-cloud-key";
// Выбранная кнопкой «Камера» вебка запоминается в этом браузере
const CAMERA_STORAGE = "petr-camera";

const COUNTDOWN = 6;                     // секунд обратного отсчёта
const LIVE_TIMEOUT = 45;                 // без касаний в превью → на экран ожидания, с
const RESULT_TIMEOUT = 60;               // сколько показывать готовое фото и QR, с


/* =========================================================
   DOM
   ========================================================= */

const $ = id => document.getElementById(id);
const canvas = $("photoCanvas");
const ctx = canvas.getContext("2d");
const hint = $("photoHint");
const count = $("photoCount");
const flash = $("photoFlash");
const shootBtn = $("photoShoot");
const qrBox = $("photoQr");
const qrCode = $("photoQrCode");
const qrText = $("photoQrText");
const cameraBtn = $("photoCamera");

const bg = new Image();
bg.src = BG_SRC;
const petr = new Image();
petr.src = PETR_SRC;

const cam = document.createElement("video");
cam.muted = true;
cam.playsInline = true;

const person = document.createElement("canvas");   // кадр камеры с прозрачным фоном
const pctx = person.getContext("2d");
const maskCv = document.createElement("canvas");   // маска человека
const mctx = maskCv.getContext("2d");
let maskData = null;
const crop = document.createElement("canvas");     // область вокруг человека — вход нейросети
crop.width = crop.height = 512;
const cropCtx = crop.getContext("2d");
let roi = null;                  // эта область в px камеры; null — весь кадр
let alpha = null, label = null, queue = null, part = null;   // маска на сетке GRID

let state = "off";          // off | live | countdown | result
let stream = null, raf = 0, idleTimer = 0, lastCamTime = -1;
let target = null, cur = null;   // человек в сцене: {x, y, s}
let view = null;                 // видимая часть фона и сдвиг пары (неподвижны)
let shot = 0;                    // номер снимка: ответ облака на старый снимок не показываем


/* =========================================================
   НЕЙРОСЕТЬ (грузится заранее, чтобы фото открывалось сразу)
   Классы модели: 0 фон, 1 волосы, 2 кожа тела, 3 лицо, 4 одежда, 5 прочее
   ========================================================= */

let segmenter = null;
let segmenterReady = null;

function loadSegmenter() {
  if (segmenterReady) return segmenterReady;
  segmenterReady = (async () => {
    const fileset = await FilesetResolver.forVisionTasks(new URL("lib/mediapipe/wasm", location.href).href);
    const options = delegate => ({
      baseOptions: { modelAssetPath: "lib/models/selfie_multiclass_256x256.tflite", delegate },
      runningMode: "VIDEO",
      outputCategoryMask: false,
      outputConfidenceMasks: true,
    });
    try { segmenter = await ImageSegmenter.createFromOptions(fileset, options("GPU")); }
    catch { segmenter = await ImageSegmenter.createFromOptions(fileset, options("CPU")); }
  })();
  segmenterReady.catch(e => console.error("Сегментация не загрузилась:", e));
  return segmenterReady;
}


/* =========================================================
   ВЫРЕЗКА ЧЕЛОВЕКА
   ========================================================= */

function segment() {
  const r = roi || { x: 0, y: 0, w: cam.videoWidth, h: cam.videoHeight };
  cropCtx.drawImage(cam, r.x, r.y, r.w, r.h, 0, 0, crop.width, crop.height);
  segmenter.segmentForVideo(crop, performance.now(), result => {
    const m = result.confidenceMasks;
    buildCutout(m[0].getAsFloat32Array(), m[1].getAsFloat32Array(), m[3].getAsFloat32Array(), m[0].width, m[0].height, r);
  });
}

// новая камера или новый гость — маску и область собираем заново
function resetCutout() {
  roi = null;
  if (alpha) alpha.fill(0);
}

function buildCutout(bgConf, hairConf, faceConf, mw, mh, r) {
  const pw = cam.videoWidth, ph = cam.videoHeight;
  const gw = Math.ceil(pw / GRID), gh = Math.ceil(ph / GRID), n = gw * gh;
  if (maskCv.width !== gw || maskCv.height !== gh) {
    maskCv.width = gw; maskCv.height = gh;
    maskData = mctx.createImageData(gw, gh);
    alpha = new Float32Array(n);
    label = new Int32Array(n);
    queue = new Int32Array(n);
    part = new Uint8Array(n);     // 1 — лицо, 2 — волосы
  }
  if (person.width !== pw || person.height !== ph) { person.width = pw; person.height = ph; }

  // 1. маска области → сетка всего кадра, плавно от прошлого кадра:
  // мелкое дрожание гасится, крупные изменения (движение) проходят сразу
  const kx = mw / r.w, ky = mh / r.h;
  for (let gy = 0, i = 0; gy < gh; gy++) {
    const my = ((gy + 0.5) * GRID - r.y) * ky - 0.5;
    const y0 = Math.floor(my), fy = my - y0;
    const ya = Math.max(0, y0) * mw, yb = Math.min(mh - 1, y0 + 1) * mw;
    const yn = Math.min(mh - 1, Math.max(0, Math.round(my))) * mw;
    const inY = my >= -0.5 && my <= mh - 0.5;
    for (let gx = 0; gx < gw; gx++, i++) {
      const mx = ((gx + 0.5) * GRID - r.x) * kx - 0.5;
      let a = 0, p = 0;
      if (inY && mx >= -0.5 && mx <= mw - 0.5) {
        const x0 = Math.floor(mx), fx = mx - x0;
        const xa = Math.max(0, x0), xb = Math.min(mw - 1, x0 + 1);
        const b = (bgConf[ya + xa] * (1 - fx) + bgConf[ya + xb] * fx) * (1 - fy)
                + (bgConf[yb + xa] * (1 - fx) + bgConf[yb + xb] * fx) * fy;
        // контрастная маска: неуверенные пиксели не становятся «призрачными»
        a = Math.min(1, Math.max(0, (1 - b - MASK_LOW) / (MASK_HIGH - MASK_LOW)));
        const j = yn + Math.min(mw - 1, Math.max(0, Math.round(mx)));
        p = faceConf[j] > 0.5 ? 1 : faceConf[j] + hairConf[j] > 0.5 ? 2 : 0;
      }
      const s = alpha[i];
      alpha[i] = s + (a - s) * (MASK_SMOOTH + (1 - MASK_SMOOTH) * Math.abs(a - s));
      part[i] = p;
    }
  }

  // 2. связные пятна силуэта; человек — пятно, где больше всего лица
  label.fill(0);
  let id = 0, tail = 0, best = 0, bestFace = 0, bestArea = 0;
  const push = k => { if (!label[k] && alpha[k] >= 0.15) { label[k] = id; queue[tail++] = k; } };
  for (let i = 0; i < n; i++) {
    if (label[i] || alpha[i] < 0.15) continue;
    id++; tail = 0;
    push(i);
    let face = 0;
    for (let head = 0; head < tail; head++) {
      const j = queue[head], x = j % gw;
      if (part[j] === 1) face++;
      if (x > 0) push(j - 1);
      if (x < gw - 1) push(j + 1);
      if (j >= gw) push(j - gw);
      if (j < n - gw) push(j + gw);
    }
    if (face > bestFace || (face === bestFace && tail > bestArea)) { best = id; bestFace = face; bestArea = tail; }
  }

  // 3. маска человека + голова (волосы и лицо) + границы силуэта
  const d = maskData.data;
  let headTop = gh, chin = -1, bottom = -1, faceX = 0, faceN = 0, minX = gw, maxX = -1, minY = gh;
  for (let gy = 0, i = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++, i++) {
      const a = best && label[i] === best ? alpha[i] : 0;
      d[i * 4 + 3] = a * 255;
      if (!a) continue;
      if (a > 0.5) {
        bottom = gy;
        if (gy < minY) minY = gy;
        if (gx < minX) minX = gx;
        if (gx > maxX) maxX = gx;
      }
      if (part[i] === 1) { chin = gy; faceX += gx; faceN++; }
      if (part[i] && gy < headTop) headTop = gy;
    }
  }
  mctx.putImageData(maskData, 0, 0);

  pctx.globalCompositeOperation = "copy";
  pctx.drawImage(cam, 0, 0, pw, ph);
  pctx.globalCompositeOperation = "destination-in";
  pctx.filter = `blur(${EDGE_SOFTNESS}px)`;
  pctx.drawImage(maskCv, 0, 0, pw, ph);
  pctx.filter = "none";
  pctx.globalCompositeOperation = "source-over";

  // лица не видно — человека не показываем, нейросеть снова смотрит на весь кадр
  if (faceN < n * 0.002 || chin <= headTop) { target = null; roi = null; return; }

  updateRoi(minX * GRID, minY * GRID, (maxX + 1) * GRID, (bottom + 1) * GRID, pw, ph);

  // голова в пикселях камеры; по горизонтали — зеркально
  const faceCx = pw - (faceX / faceN + 0.5) * GRID;
  const headCam = (chin + 1 - headTop) * GRID;

  const top = PETR.headTop + PERSON.below * PETR.head;   // макушка человека в сцене
  let s = PETR.head * PERSON.headScale / headCam;
  // силуэт обрезан нижним краем камеры — увеличиваем человека от макушки,
  // чтобы он доставал до низа кадра, а не висел в воздухе
  if (bottom >= gh - 2) s = Math.max(s, (view.y + view.h - top) / (ph - headTop * GRID));

  target = {
    x: view.personX + view.shift - faceCx * s,
    y: top - headTop * GRID * s,
    s,
  };
  if (!cur) cur = { ...target };
}

// Область для нейросети: силуэт с запасом, по возможности квадрат
// (нейросеть видит её как 256×256). Расширяется сразу, сжимается плавно.
function updateRoi(l, t, r, b, pw, ph) {
  const side = Math.max(r - l, b - t) * (1 + 2 * CROP_MARGIN);
  const w = Math.min(pw, side), h = Math.min(ph, side);
  const x = Math.min(pw - w, Math.max(0, (l + r - w) / 2));
  const y = Math.min(ph - h, Math.max(0, (t + b - h) / 2));
  if (!roi) { roi = { x, y, w, h }; return; }
  const ease = (from, to) => from + (to - from) * CROP_SMOOTH;
  const nl = Math.min(x, ease(roi.x, x)), nt = Math.min(y, ease(roi.y, y));
  const nr = Math.max(x + w, ease(roi.x + roi.w, x + w)), nb = Math.max(y + h, ease(roi.y + roi.h, y + h));
  roi = { x: nl, y: nt, w: nr - nl, h: nb - nt };
}


/* =========================================================
   СБОРКА КАДРА
   ========================================================= */

// Холст в пропорциях экрана; фон заполняет его целиком, по центру.
// Пара «Пётр + человек» сдвигается в центр кадра.
function sizeCanvas() {
  const SW = bg.naturalWidth || 2752, SH = bg.naturalHeight || 1536;
  canvas.height = SH;
  canvas.width = Math.round(SH * innerWidth / innerHeight);
  const aspect = canvas.width / canvas.height;
  const w = Math.min(SW, SH * aspect), h = w / aspect;
  view = { x: (SW - w) / 2, y: (SH - h) / 2, w, h };
  const portrait = aspect < 1;
  view.personX = portrait ? PERSON.xPortrait : PERSON.x;
  view.shift = view.x + w / 2 - (portrait ? PAIR_CENTER_PORTRAIT : PAIR_CENTER);
  target = cur = null;
}

function render() {
  if (!bg.naturalWidth || !view) return;
  if (target && cur) for (const k of ["x", "y", "s"]) cur[k] += (target[k] - cur[k]) * SMOOTH;

  const k = canvas.height / view.h;
  ctx.setTransform(k, 0, 0, k, -view.x * k, -view.y * k);
  ctx.drawImage(bg, 0, 0);
  if (petr.naturalWidth) ctx.drawImage(petr, view.shift, 0);

  if (!target || !cur) return;
  ctx.save();
  ctx.filter = PERSON_FILTER;
  ctx.shadowColor = "rgba(0,0,0,0.35)";
  ctx.shadowBlur = 30;
  ctx.shadowOffsetY = 10;
  ctx.translate(cur.x + person.width * cur.s, cur.y);
  ctx.scale(-cur.s, cur.s);                           // зеркалим, как в зеркале
  ctx.drawImage(person, 0, 0);
  ctx.restore();
}

function loop() {
  if (state !== "live" && state !== "countdown") return;
  raf = requestAnimationFrame(loop);
  if (cam.readyState >= 2 && segmenter && cam.currentTime !== lastCamTime) {
    lastCamTime = cam.currentTime;                     // новый кадр камеры
    segment();
  }
  shootBtn.disabled = !target;                         // пустой кадр не снимаем
  render();
}

const HINT_LIVE = "Встаньте перед камерой — вы появитесь рядом с Петром";


/* =========================================================
   РЕЖИМЫ
   ========================================================= */

function setMode(mode) {
  state = mode;
  document.body.dataset.photo = mode;
  resetIdle();
}

function resetIdle() {
  clearTimeout(idleTimer);
  if (state === "live")   idleTimer = setTimeout(closePhoto, LIVE_TIMEOUT * 1000);
  if (state === "result") idleTimer = setTimeout(closePhoto, RESULT_TIMEOUT * 1000);
}

function muteBackground(on) {
  for (const v of document.querySelectorAll(".stage video")) v.muted = on;
}

async function openPhoto() {
  if (state !== "off") return;
  target = cur = null;
  resetCutout();
  lastCamTime = -1;
  kiosk.setView("photo");
  muteBackground(true);
  sizeCanvas();
  setMode("live");
  shootBtn.disabled = true;
  // при первом открытии сайта нейросеть (~25 МБ) может ещё догружаться
  hint.textContent = segmenter ? HINT_LIVE : "Готовим камеру…";
  render();

  try {
    // камеру браузер даёт только на https или http://localhost
    if (!navigator.mediaDevices) throw new Error("insecure context");
    await startCamera(savedCamera());
    if (state === "off") return stopCamera();          // успели нажать «Назад»
    await loadSegmenter();
  } catch (e) {
    console.error(e);
    hint.textContent = window.isSecureContext
      ? "Камера недоступна"
      : "Браузер блокирует камеру: откройте киоск через start.bat (http://localhost)";
    setTimeout(closePhoto, 5000);
    return;
  }
  if (state === "off") return stopCamera();
  hint.textContent = HINT_LIVE;
  loop();
}

// deviceId — конкретная вебка; если её нет (отключили), берём камеру по умолчанию
async function startCamera(deviceId) {
  const video = { width: { ideal: 1280 }, height: { ideal: 720 } };
  let s;
  try {
    s = await navigator.mediaDevices.getUserMedia({
      video: deviceId ? { ...video, deviceId: { exact: deviceId } } : { ...video, facingMode: "user" },
      audio: false,
    });
  } catch (e) {
    if (!deviceId) throw e;
    s = await navigator.mediaDevices.getUserMedia({ video: { ...video, facingMode: "user" }, audio: false });
  }
  if (state === "off") { s.getTracks().forEach(t => t.stop()); return; }
  stopCamera();
  stream = s;
  cam.srcObject = stream;
  lastCamTime = -1;
  await cam.play();
  listCameras();
}

function stopCamera() {
  if (stream) stream.getTracks().forEach(t => t.stop());
  stream = null;
  cam.srcObject = null;
}

// Названия и id камер браузер отдаёт только после разрешения на камеру
let cameras = [];
async function listCameras() {
  const all = await navigator.mediaDevices.enumerateDevices();
  cameras = all.filter(d => d.kind === "videoinput");
  cameraBtn.hidden = cameras.length < 2;
}

async function switchCamera() {
  if (state !== "live" || cameras.length < 2) return;
  const curId = stream && stream.getVideoTracks()[0].getSettings().deviceId;
  const next = cameras[(cameras.findIndex(d => d.deviceId === curId) + 1) % cameras.length];
  cameraBtn.disabled = true;
  try {
    await startCamera(next.deviceId);
    try { localStorage.setItem(CAMERA_STORAGE, next.deviceId); } catch {}
    target = cur = null;                               // человек из старой камеры не нужен
    resetCutout();
  } catch (e) {
    console.error("Камера не переключилась:", e);
  }
  cameraBtn.disabled = false;
}

function savedCamera() {
  try { return localStorage.getItem(CAMERA_STORAGE); } catch { return null; }
}

function closePhoto() {
  if (state === "off") return;
  state = "off";
  cancelAnimationFrame(raf);
  clearTimeout(idleTimer);
  stopCamera();
  delete document.body.dataset.photo;
  count.textContent = "";
  muteBackground(false);
  kiosk.showIdle();
}

function shoot() {
  if (state !== "live" || !target) return;
  setMode("countdown");
  hint.textContent = "Улыбайтесь!";
  let n = COUNTDOWN;
  const tick = () => {
    if (state !== "countdown") return;
    if (n > 0) {
      count.textContent = n--;
      count.classList.remove("pop"); void count.offsetWidth; count.classList.add("pop");
      setTimeout(tick, 1000);
    } else {
      count.textContent = "";
      capture();
    }
  };
  tick();
}

function capture() {
  cancelAnimationFrame(raf);
  render();                                           // последний кадр остаётся на экране
  flash.classList.remove("on"); void flash.offsetWidth; flash.classList.add("on");
  setMode("result");
  hint.textContent = "Ваш портрет с Петром Великим";
  showQr("wait");

  const my = ++shot;
  canvas.toBlob(async blob => {
    const res = await savePhoto(blob);
    if (my !== shot || state !== "result") return;
    if (res.url) showQr("ready", res.url);
    else if (res.saved) showQr("off");
    else showQr("download", URL.createObjectURL(blob));   // сохранить некуда — отдаём файлом
  }, "image/jpeg", 0.92);
}

// 1) локальный сервер киоска (server.js): архив в photos/ + копия в облако;
// 2) без него — прямо в облако, если в этом браузере сохранён ключ.
// Ответ: { saved, url } — url для QR или null
async function savePhoto(blob) {
  try {
    const r = await fetch("save", { method: "POST", body: blob });
    if (r.ok && (r.headers.get("content-type") || "").includes("json")) {
      const { file, url } = await r.json();
      return { saved: !!file, url };
    }
  } catch {}

  const key = cloudKey();
  if (!key) return { saved: false, url: null };
  try {
    const r = await fetch(CLOUD_URL + "/upload", {
      method: "POST",
      headers: { "Authorization": "Bearer " + key, "Content-Type": "image/jpeg" },
      body: blob,
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return { saved: true, url: (await r.json()).url };
  } catch (e) {
    console.error("Фото не отправлено в облако:", e);
    return { saved: false, url: null };
  }
}

function cloudKey() {
  try { return localStorage.getItem(KEY_STORAGE); } catch { return null; }
}

// Ключ из адреса (#key=…) запоминаем и убираем из адресной строки
(function takeKeyFromUrl() {
  const m = /[#&]key=([^&]+)/.exec(location.hash);
  if (!m) return;
  try { localStorage.setItem(KEY_STORAGE, decodeURIComponent(m[1])); } catch {}
  history.replaceState(null, "", location.pathname + location.search);
})();

// Карточка со ссылкой на фото: wait — загружается, ready — QR,
// off — сохранено только у организаторов, download — кнопка «Скачать»
let downloadUrl = null;
function showQr(mode, url) {
  if (downloadUrl) { URL.revokeObjectURL(downloadUrl); downloadUrl = null; }
  qrBox.classList.toggle("is-off", mode === "off" || mode === "download");
  qrCode.textContent = "";
  qrText.textContent = "";
  if (mode === "download") {
    downloadUrl = url;
    const a = document.createElement("a");
    a.className = "photo-main";
    a.href = url;
    a.download = "foto-s-petrom.jpg";
    a.textContent = "Скачать фото";
    qrText.appendChild(a);
  } else if (mode === "wait") {
    qrCode.textContent = "Загружаем фото…";
    qrText.textContent = "Сейчас здесь появится QR-код";
  } else if (mode === "ready") {
    const qr = qrcode(0, "M");
    qr.addData(url);
    qr.make();
    const img = new Image();
    img.src = qr.createDataURL(8, 2);
    img.alt = "QR-код со ссылкой на фото";
    qrCode.appendChild(img);
    qrText.textContent = "Наведите камеру телефона, чтобы забрать фото";
  } else {
    qrText.textContent = "Не удалось выдать ссылку. Фото сохранено у организаторов";
  }
}

function retake() {
  if (state !== "result") return;
  shot++;
  setMode("live");
  hint.textContent = HINT_LIVE;
  loop();
}


/* =========================================================
   УПРАВЛЕНИЕ
   ========================================================= */

$("photoOpen").addEventListener("click", openPhoto);
$("photoShoot").addEventListener("click", shoot);
cameraBtn.addEventListener("click", switchCamera);
$("photoBack").addEventListener("click", closePhoto);
$("photoRetake").addEventListener("click", retake);
$("photoDone").addEventListener("click", closePhoto);

document.addEventListener("pointerdown", () => { if (state !== "off") resetIdle(); }, { passive: true });
document.addEventListener("keydown", e => { if (e.key === "Escape") closePhoto(); });
// повернули экран во время съёмки — перестраиваем кадр
addEventListener("resize", () => { if (state === "live" || state === "countdown") sizeCanvas(); });

// Нейросеть грузим сразу: из интернета это до минуты
loadSegmenter();
