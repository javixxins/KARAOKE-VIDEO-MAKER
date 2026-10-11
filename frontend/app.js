// Si alguien abre este archivo directamente desde el Finder (file://...) en
// vez de a traves del icono/servidor, no hay ningun backend escuchando y
// todas las llamadas fetch() fallarian con un confuso "Failed to fetch".
// Mostramos en su lugar un aviso claro con los pasos correctos.
if (window.location.protocol === "file:") {
  document.documentElement.innerHTML = `
    <head><meta charset="UTF-8"><title>Karaoke Video Maker</title></head>
    <body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
      background:#0f1117;color:#eef0f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
      <div style="max-width:520px;padding:32px;text-align:center">
        <div style="font-size:40px;margin-bottom:10px">🎤</div>
        <h1 style="font-size:20px;margin:0 0 14px">Esta pagina necesita el servidor en marcha</h1>
        <p style="color:#9aa1b2;font-size:14px;line-height:1.6">
          Has abierto este archivo directamente desde el Finder, pero esta
          pagina necesita hablar con el servidor de Karaoke Video Maker, que
          no esta escuchando en <code>file://</code>.
        </p>
        <p style="color:#9aa1b2;font-size:14px;line-height:1.6">
          Para usar la app:<br>
          1) Haz doble clic en <b>Karaoke Video Maker.app</b> (en la carpeta del proyecto), o<br>
          2) Ejecuta <code>./backend/run.sh</code> desde la terminal<br>
          y luego entra en
          <a href="http://127.0.0.1:8008" style="color:#ffcc00">http://127.0.0.1:8008</a>.
        </p>
      </div>
    </body>`;
  throw new Error("Abierto como file:// — mostrando aviso en vez de inicializar la app.");
}

const STEPS = ["audio", "media", "lyrics", "style", "timeline", "export"];

const state = {
  pid: null,
  project: null,
  presets: null,
  mediaKind: "video",
  unlocked: new Set(["audio"]),
  current: "audio",
  bgImages: {}, // path -> HTMLImageElement
  bgVideoEl: null,
  previewing: [], // controladores de previsualizacion activos (ver makePreviewController)
  frameAdjusters: [], // {box, mediaEl, fxInp, fyInp, zoomInp} de los ajustadores de encuadre del paso 2
  dragTooltipEl: null, // tooltip flotante con el tiempo exacto al arrastrar/redimensionar palabras
  wordTimeline: {
    pxPerSec: 90, dragging: null, resizing: null, rafId: null, selected: new Set(), autoSaveTimer: null, marquee: null,
    spaceArmed: false, spaceDidPan: false, panning: null,
    clipboard: null, // palabra(s) copiadas con clic derecho, listas para pegar con clic izquierdo
  },
};

// Calcula como queda el contenido (foto o video) dentro de un lienzo
// boxW x boxH: zoom=1 ajusta todo el contenido sin recortar (puede dejar
// barras si el aspecto no coincide), zoom>1 lo agranda/recorta, zoom<1 lo
// reduce dejando mas margen. focusX/focusY (0..1) ancla el contenido dentro
// del lienzo. La MISMA formula se usa en el lienzo canvas de previsualizacion
// y en las cajas DOM de ajuste, y coincide con fit_frame_filter en el backend.
function computeFitLayout(srcW, srcH, boxW, boxH, focusX, focusY, zoom) {
  zoom = Math.max(0.3, Math.min(4, zoom || 1));
  focusX = focusX ?? 0.5;
  focusY = focusY ?? 0.5;
  const containScale = Math.min(boxW / srcW, boxH / srcH);
  const scaledW = srcW * containScale * zoom;
  const scaledH = srcH * containScale * zoom;
  const padW = Math.max(scaledW, boxW);
  const padH = Math.max(scaledH, boxH);
  const padX = (padW - scaledW) * focusX;
  const padY = (padH - scaledH) * focusY;
  const cropX = (padW - boxW) * focusX;
  const cropY = (padH - boxH) * focusY;
  return { x: padX - cropX, y: padY - cropY, w: scaledW, h: scaledH };
}

function layoutFrameAdjustBox(boxEl, mediaEl, focusX, focusY, zoom) {
  const boxW = boxEl.clientWidth, boxH = boxEl.clientHeight;
  const naturalW = mediaEl.naturalWidth || mediaEl.videoWidth;
  const naturalH = mediaEl.naturalHeight || mediaEl.videoHeight;
  if (!boxW || !boxH || !naturalW || !naturalH) return;
  const { x, y, w, h } = computeFitLayout(naturalW, naturalH, boxW, boxH, focusX, focusY, zoom);
  mediaEl.style.left = `${x}px`;
  mediaEl.style.top = `${y}px`;
  mediaEl.style.width = `${w}px`;
  mediaEl.style.height = `${h}px`;
}

function $(sel) { return document.querySelector(sel); }
function $all(sel) { return Array.from(document.querySelectorAll(sel)); }

async function api(path, opts = {}) {
  const headers = opts.body && !(opts.body instanceof FormData) ? { "Content-Type": "application/json" } : {};
  const res = await fetch(path, {
    method: opts.method || "GET",
    headers: { ...headers, ...(opts.headers || {}) },
    body: opts.body && !(opts.body instanceof FormData) ? JSON.stringify(opts.body) : opts.body,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail || detail; } catch (e) {}
    throw new Error(detail);
  }
  return res.json();
}

function mediaUrl(path) {
  const name = path.split("/").pop();
  return `/media/${state.pid}/${name}`;
}

// ---------------- navigation ----------------

function buildStepNav() {
  const nav = $("#stepNav");
  nav.innerHTML = "";
  const labels = { audio: "Audio", media: "Vídeo/Foto", lyrics: "Letra", style: "Estilo", timeline: "Timeline", export: "Exportar" };
  STEPS.forEach((s) => {
    const el = document.createElement("span");
    el.className = "navitem";
    el.textContent = labels[s];
    el.dataset.step = s;
    el.onclick = () => { if (state.unlocked.has(s)) showStep(s); };
    nav.appendChild(el);
  });
  refreshStepNav();
}

function refreshStepNav() {
  $all(".navitem").forEach((el) => {
    el.classList.toggle("active", el.dataset.step === state.current);
    el.classList.toggle("done", state.unlocked.has(el.dataset.step) && el.dataset.step !== state.current);
  });
}

function showStep(name) {
  // Al cambiar de pagina se detiene cualquier previsualizacion o reproduccion
  // de audio en marcha (tanto la de los lienzos de previsualizacion como la
  // de los reproductores nativos del paso 1 y del paso 3), en vez de dejarla
  // sonando de fondo en una pantalla que ya no se ve.
  state.previewing.forEach((ctrl) => ctrl.stop());
  $("#audioPlayer").pause();
  $("#audioPlayerLyrics").pause();
  state.current = name;
  STEPS.forEach((s) => $(`#step-${s}`).classList.toggle("hidden", s !== name));
  refreshStepNav();
  if (name === "timeline") renderTimelineStep();
  if (name === "export") renderExportStep();
  if (name === "style" && previewCtrlStyle) previewCtrlStyle.refresh();
  if (name === "timeline" && previewCtrlTimeline) previewCtrlTimeline.refresh();
  if (name === "export" && previewCtrlExport) previewCtrlExport.refresh();
}

function unlock(name) {
  state.unlocked.add(name);
  refreshStepNav();
}

$all("[data-back]").forEach((btn) => btn.addEventListener("click", () => showStep(btn.dataset.back)));

// ---------------- init ----------------

async function init() {
  buildStepNav();
  state.presets = await api("/api/presets");
  const proj = await api("/api/projects", { method: "POST" });
  state.pid = proj.id;
  state.project = proj;
  populateStyleControls();
  populateFilterSelect();
  populateExportSelects();
  setupPreviewControllers();
  syncExportUI();
  showStep("audio");
}

// ---------------- Cargar / guardar proyecto ----------------
// El proyecto se guarda como un .kvmproj (un zip con el JSON del proyecto
// mas una copia del audio y el video/fotos subidos) para poder retomarlo mas
// adelante sin depender de que esos archivos sigan en el servidor.

$("#btnLoadProject").addEventListener("click", () => $("#loadProjectInput").click());
$("#loadProjectInput").addEventListener("change", () => {
  const file = $("#loadProjectInput").files[0];
  if (file) loadProjectFromFile(file);
  $("#loadProjectInput").value = "";
});

async function loadProjectFromFile(file) {
  setStatus("#loadProjectStatus", "Cargando proyecto...", "working");
  try {
    const fd = new FormData();
    fd.append("file", file);
    const project = await api("/api/projects/load-bundle", { method: "POST", body: fd });
    await restoreProjectUI(project);
    setStatus("#loadProjectStatus", "✓ Proyecto cargado correctamente.", "ok");
  } catch (e) {
    setStatus("#loadProjectStatus", "Error cargando el proyecto: " + e.message, "error");
  }
}

// Vuelca un proyecto ya cargado (o recien restaurado desde un .kvmproj) en
// toda la interfaz, sin volver a registrar los listeners de los controles
// (eso ya lo hizo init() una vez) para no duplicarlos.
async function restoreProjectUI(project) {
  state.pid = project.id;
  state.project = project;

  if (project.audio) {
    $("#audioInfo").textContent = `Archivo: ${project.audio.filename} — Duración: ${fmtTime(project.audio.duration)}`;
    $("#audioInfo").classList.remove("hidden");
    const player = $("#audioPlayer");
    player.src = mediaUrl(project.audio.path);
    player.classList.remove("hidden");
    const playerLyrics = $("#audioPlayerLyrics");
    playerLyrics.src = mediaUrl(project.audio.path);
    playerLyrics.classList.remove("hidden");
    $("#btnToMedia").disabled = false;
    unlock("media");
  }

  if (project.media && project.media.type) {
    renderMediaFrameAdjust();
    $("#btnToLyrics").disabled = false;
    unlock("lyrics");
    unlock("style");
    unlock("timeline");
    unlock("export");
  }

  const st = project.style;
  $("#styleFont").value = st.font;
  $("#styleFontSize").value = st.font_size;
  $("#fontSizeVal").textContent = st.font_size;
  $("#stylePrimary").value = st.primary_color;
  $("#styleSecondary").value = st.secondary_color;
  $("#styleOutline").value = st.outline_color;
  $("#styleOutlineWidth").value = st.outline_width;
  $("#outlineWidthVal").textContent = st.outline_width;
  $("#stylePosition").value = st.position;
  $("#styleAnimation").value = st.animation;
  $("#styleUppercase").checked = st.uppercase;
  $("#styleBold").checked = st.bold;
  $("#filterSelect").value = project.filter;

  renderLyricsTable();
  renderTimelineStep();
  renderExportStep();
  prepareBgAssets();

  // Se aterriza en el paso mas avanzado posible segun lo que ya tenia el
  // proyecto, para seguir justo donde se dejo.
  if (project.media && project.media.type) showStep("style");
  else if (project.audio) showStep("media");
  else showStep("audio");
}

$("#btnSaveProject").addEventListener("click", () => saveProjectAs());

async function saveProjectAs() {
  const btn = $("#btnSaveProject");
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Preparando...";
  try {
    const resp = await fetch(`/api/projects/${state.pid}/save-bundle`);
    if (!resp.ok) throw new Error("No se pudo preparar el archivo del proyecto");
    const blob = await resp.blob();
    const suggestedName = "proyecto.kvmproj";
    if (window.showSaveFilePicker) {
      const handle = await window.showSaveFilePicker({
        suggestedName,
        types: [{ description: "Proyecto Karaoke Video Maker", accept: { "application/zip": [".kvmproj"] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      setStatus("#saveProjectStatus", "✓ Proyecto guardado.", "ok");
    } else {
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = suggestedName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(blobUrl);
      setStatus("#saveProjectStatus", "✓ Proyecto descargado.", "ok");
    }
  } catch (e) {
    if (e && e.name === "AbortError") {
      // el usuario cancelo el dialogo de guardado: no es un error real
    } else {
      setStatus("#saveProjectStatus", "Error guardando el proyecto: " + e.message, "error");
    }
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

// ---------------- PASO 1: audio ----------------

const audioDrop = $("#audioDrop");
const audioInput = $("#audioInput");
audioDrop.addEventListener("click", () => audioInput.click());
["dragover", "dragleave", "drop"].forEach((evt) => {
  audioDrop.addEventListener(evt, (e) => {
    e.preventDefault();
    audioDrop.classList.toggle("dragover", evt === "dragover");
  });
});
audioDrop.addEventListener("drop", (e) => {
  const f = e.dataTransfer.files[0];
  if (f) uploadAudio(f);
});
audioInput.addEventListener("change", () => { if (audioInput.files[0]) uploadAudio(audioInput.files[0]); });

// Hay dos reproductores (paso 1 y paso 3, para poder escuchar mientras se
// edita la letra) apuntando al mismo audio: al reproducir uno se pausa el
// otro para que no suenen a la vez.
$("#audioPlayer").addEventListener("play", () => { $("#audioPlayerLyrics").pause(); });
$("#audioPlayerLyrics").addEventListener("play", () => { $("#audioPlayer").pause(); });

async function uploadAudio(file) {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("quality", $("#transcribeQuality").value);
  setStatus("#transcribeStatus", "Subiendo audio...", "working");
  try {
    const res = await api(`/api/projects/${state.pid}/audio`, { method: "POST", body: fd });
    state.project = res.project;
    $("#audioInfo").textContent = `Archivo: ${file.name} — Duración: ${fmtTime(state.project.audio.duration)}`;
    $("#audioInfo").classList.remove("hidden");
    const player = $("#audioPlayer");
    player.src = mediaUrl(state.project.audio.path);
    player.classList.remove("hidden");
    const playerLyrics = $("#audioPlayerLyrics");
    playerLyrics.src = mediaUrl(state.project.audio.path);
    playerLyrics.classList.remove("hidden");
    $("#btnToMedia").disabled = false;
    unlock("media");
    pollJob(res.job_id, "#transcribeStatus", "Detectando la letra...", onTranscribeDone);
  } catch (e) {
    setStatus("#transcribeStatus", "Error: " + e.message, "error");
  }
}

function onTranscribeDone(result) {
  refreshProject().then(() => {
    if (state.current === "lyrics") renderLyricsTable();
  });
}

$("#btnToMedia").addEventListener("click", () => showStep("media"));

// ---------------- PASO 2: media ----------------

$all(".tab[data-mediakind]").forEach((tab) => {
  tab.addEventListener("click", () => {
    $all(".tab[data-mediakind]").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    state.mediaKind = tab.dataset.mediakind;
    const input = $("#mediaInput");
    if (state.mediaKind === "video") {
      input.accept = ".mp4,.mov,.m4v,.webm";
      input.multiple = false;
      $("#mediaDropText").textContent = "Arrastra tu vídeo aquí o haz clic para elegir el archivo";
    } else {
      input.accept = ".jpg,.jpeg,.png,.webp";
      input.multiple = true;
      $("#mediaDropText").textContent = "Arrastra una o varias fotos aquí o haz clic para elegirlas";
    }
  });
});

const mediaDrop = $("#mediaDrop");
const mediaInput = $("#mediaInput");
mediaDrop.addEventListener("click", () => mediaInput.click());
["dragover", "dragleave", "drop"].forEach((evt) => {
  mediaDrop.addEventListener(evt, (e) => {
    e.preventDefault();
    mediaDrop.classList.toggle("dragover", evt === "dragover");
  });
});
mediaDrop.addEventListener("drop", (e) => { if (e.dataTransfer.files.length) uploadMedia(e.dataTransfer.files); });
mediaInput.addEventListener("change", () => { if (mediaInput.files.length) uploadMedia(mediaInput.files); });

async function uploadMedia(fileList) {
  const fd = new FormData();
  fd.append("kind", state.mediaKind);
  Array.from(fileList).forEach((f) => fd.append("files", f));
  try {
    const project = await api(`/api/projects/${state.pid}/media`, { method: "POST", body: fd });
    state.project = project;
    renderMediaFrameAdjust();
    $("#btnToLyrics").disabled = false;
    unlock("lyrics");
  } catch (e) {
    alert("Error subiendo el medio: " + e.message);
  }
}

function registerFrameAdjuster(box, mediaEl, fxInp, fyInp, zoomInp) {
  state.frameAdjusters.push({ box, mediaEl, fxInp, fyInp, zoomInp });
}

function relayoutAllFrameAdjusters() {
  const { width: ew, height: eh } = state.project.export;
  state.frameAdjusters.forEach(({ box, mediaEl, fxInp, fyInp, zoomInp }) => {
    box.style.aspectRatio = `${ew} / ${eh}`;
    requestAnimationFrame(() => layoutFrameAdjustBox(box, mediaEl, parseFloat(fxInp.value), parseFloat(fyInp.value), parseFloat(zoomInp.value)));
  });
}

function buildFrameAdjustMarkup(title, mediaTag) {
  return `
    <h3 style="margin-top:0">${title}</h3>
    <div class="frame-adjust-row">
      <div class="frame-adjust-box">${mediaTag}</div>
      <div class="frame-adjust-controls">
        <label>Tamaño (zoom) — agranda o reduce lo que ves en el lienzo
          <input type="range" class="fa-zoom" min="0.3" max="4" step="0.05" value="1">
        </label>
        <label>Posición horizontal <input type="range" class="fa-fx" min="0" max="1" step="0.01" value="0.5"></label>
        <label>Posición vertical <input type="range" class="fa-fy" min="0" max="1" step="0.01" value="0.5"></label>
      </div>
    </div>`;
}

function renderMediaFrameAdjust() {
  const wrap = $("#mediaFrameAdjust");
  wrap.innerHTML = "";
  state.frameAdjusters = [];
  const media = state.project.media;
  if (!media || !media.type) return;
  const { width: ew, height: eh } = state.project.export;

  if (media.type === "video") {
    const v = media.video;
    const item = document.createElement("div");
    item.className = "frame-adjust-item panel";
    item.innerHTML = buildFrameAdjustMarkup(
      "Ajustar encuadre del vídeo",
      `<video muted loop playsinline autoplay></video>`
    );
    wrap.appendChild(item);
    const box = item.querySelector(".frame-adjust-box");
    box.style.aspectRatio = `${ew} / ${eh}`;
    const videoEl = item.querySelector("video");
    videoEl.src = mediaUrl(v.path);
    const fxInp = item.querySelector(".fa-fx"), fyInp = item.querySelector(".fa-fy"), zoomInp = item.querySelector(".fa-zoom");
    fxInp.value = v.focus_x ?? 0.5; fyInp.value = v.focus_y ?? 0.5; zoomInp.value = v.zoom ?? 1.0;
    const relayout = () => layoutFrameAdjustBox(box, videoEl, parseFloat(fxInp.value), parseFloat(fyInp.value), parseFloat(zoomInp.value));
    videoEl.addEventListener("loadedmetadata", relayout);
    videoEl.play().catch(() => {});
    [fxInp, fyInp, zoomInp].forEach((inp) => {
      inp.addEventListener("input", relayout);
      inp.addEventListener("change", () => saveVideoFrame(fxInp, fyInp, zoomInp));
    });
    registerFrameAdjuster(box, videoEl, fxInp, fyInp, zoomInp);
  } else if (media.type === "images") {
    media.images.forEach((im, idx) => {
      const item = document.createElement("div");
      item.className = "frame-adjust-item panel";
      item.innerHTML = buildFrameAdjustMarkup(`Imagen #${idx + 1}: ajustar encuadre`, `<img>`);
      wrap.appendChild(item);
      const box = item.querySelector(".frame-adjust-box");
      box.style.aspectRatio = `${ew} / ${eh}`;
      const imgEl = item.querySelector("img");
      imgEl.src = mediaUrl(im.path);
      const fxInp = item.querySelector(".fa-fx"), fyInp = item.querySelector(".fa-fy"), zoomInp = item.querySelector(".fa-zoom");
      fxInp.value = im.focus_x ?? 0.5; fyInp.value = im.focus_y ?? 0.5; zoomInp.value = im.zoom ?? 1.0;
      const relayout = () => layoutFrameAdjustBox(box, imgEl, parseFloat(fxInp.value), parseFloat(fyInp.value), parseFloat(zoomInp.value));
      imgEl.addEventListener("load", relayout);
      [fxInp, fyInp, zoomInp].forEach((inp) => {
        inp.addEventListener("input", relayout);
        inp.addEventListener("change", () => saveImageFrame(im.path, fxInp, fyInp, zoomInp));
      });
      registerFrameAdjuster(box, imgEl, fxInp, fyInp, zoomInp);
    });
  }
}

async function saveVideoFrame(fxInp, fyInp, zoomInp) {
  const payload = { focus_x: parseFloat(fxInp.value), focus_y: parseFloat(fyInp.value), zoom: parseFloat(zoomInp.value) };
  state.project = await api(`/api/projects/${state.pid}/timeline`, { method: "PUT", body: payload });
}

async function saveImageFrame(path, fxInp, fyInp, zoomInp) {
  const images = state.project.media.images.map((im) => {
    if (im.path !== path) return { path: im.path };
    return { path, focus_x: parseFloat(fxInp.value), focus_y: parseFloat(fyInp.value), zoom: parseFloat(zoomInp.value) };
  });
  state.project = await api(`/api/projects/${state.pid}/timeline`, { method: "PUT", body: { images } });
}

$("#btnToLyrics").addEventListener("click", () => { showStep("lyrics"); renderLyricsTable(); });

// ---------------- PASO 3: lyrics ----------------

async function refreshProject() {
  state.project = await api(`/api/projects/${state.pid}`);
  return state.project;
}

// Si el usuario no quiere letra en este video, se oculta todo el editor
// (linea de tiempo, banco de palabras, tabla) y se deja constancia visible
// de que el video se generara sin subtitulos — sin borrar nada de lo ya
// detectado/editado, por si luego cambia de opinion y vuelve a activarla.
function syncLyricsEnabledUI() {
  const enabled = state.project.lyrics.enabled !== false;
  $("#lyricsDisabled").checked = !enabled;
  $("#lyricsEditArea").classList.toggle("hidden", !enabled);
  $("#lyricsNoneNotice").classList.toggle("hidden", enabled);
}

$("#lyricsDisabled").addEventListener("change", async () => {
  const enabled = !$("#lyricsDisabled").checked;
  state.project.lyrics.enabled = enabled;
  syncLyricsEnabledUI();
  try {
    state.project = await api(`/api/projects/${state.pid}/lyrics/enabled`, { method: "PUT", body: { enabled } });
  } catch (e) {
    setStatus("#lyricsStatus", "No se pudo guardar: " + e.message, "error");
  }
});

function renderLyricsTable() {
  syncLyricsEnabledUI();
  const lyr = state.project.lyrics;
  if (lyr.status === "processing") {
    setStatus("#lyricsStatus", "Transcribiendo audio, un momento...", "working");
  } else if (lyr.status === "error") {
    setStatus("#lyricsStatus", "Error al transcribir: " + (lyr.error || ""), "error");
  } else {
    setStatus("#lyricsStatus", `Letra detectada (${lyr.words.length} palabras, idioma: ${lyr.language || "?"}). Puedes corregir texto y tiempos.`, "ok");
  }
  const body = $("#lyricsBody");
  body.innerHTML = "";
  lyr.words.forEach((w, idx) => body.appendChild(buildLyricsRow(w, idx)));
  renderWordTimeline();
}

// ----- Linea de tiempo de palabras: arrastrar para re-sincronizar -----

function isPlaced(w) {
  return !!w && w.start != null && w.end != null;
}

function placedWords() {
  return state.project.lyrics.words.filter(isPlaced);
}

function timelineDuration() {
  const placed = placedWords();
  const audioDur = state.project.audio ? state.project.audio.duration : 0;
  // El orden del array no garantiza que la ultima palabra sea la que termina
  // mas tarde (p.ej. al arrastrar/pegar una palabra mas alla del final): se
  // busca el fin real mas tardio entre todas las colocadas.
  const maxWordEnd = placed.reduce((m, w) => Math.max(m, w.end), 0);
  return Math.max(audioDur, maxWordEnd, 5);
}

function niceTickInterval(pxPerSec) {
  const candidates = [1, 2, 5, 10, 15, 30, 60, 120];
  for (const c of candidates) {
    if (c * pxPerSec >= 55) return c;
  }
  return 120;
}

function fmtClock(s) {
  s = Math.max(0, s);
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

// Igual que fmtClock pero con centesimas, para la etiqueta flotante que
// aparece al arrastrar o redimensionar una palabra en la linea de tiempo
// (ahi la precision de segundo entero no basta para afinar la sincronizacion).
function fmtClockMs(s) {
  s = Math.max(0, s);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toFixed(2).padStart(5, "0")}`;
}

// Tooltip flotante con el tiempo exacto, mostrado junto al cursor mientras
// se arrastra o redimensiona una palabra en la linea de tiempo.
function showDragTooltip(clientX, clientY, text) {
  let el = state.dragTooltipEl;
  if (!el) {
    el = document.createElement("div");
    el.className = "drag-time-tooltip hidden";
    document.body.appendChild(el);
    state.dragTooltipEl = el;
  }
  el.textContent = text;
  el.style.left = `${clientX}px`;
  el.style.top = `${clientY}px`;
  el.classList.remove("hidden");
}
function hideDragTooltip() {
  if (state.dragTooltipEl) state.dragTooltipEl.classList.add("hidden");
}

function renderWordTimeline() {
  const words = state.project.lyrics.words;
  const px = state.wordTimeline.pxPerSec;
  const duration = timelineDuration();
  const totalWidth = Math.max(600, duration * px);

  // una palabra puede haber sido borrada: limpia selecciones que ya no existen
  state.wordTimeline.selected = new Set(
    Array.from(state.wordTimeline.selected).filter((i) => i < words.length)
  );

  const inner = $("#wordTimelineInner");
  inner.style.width = `${totalWidth}px`;

  const ruler = $("#timelineRuler");
  ruler.innerHTML = "";
  const interval = niceTickInterval(px);
  for (let t = 0; t <= duration; t += interval) {
    const tick = document.createElement("div");
    tick.className = "tick";
    tick.style.left = `${t * px}px`;
    tick.textContent = fmtClock(t);
    ruler.appendChild(tick);
  }

  const track = $("#timelineWordsTrack");
  track.innerHTML = "";
  words.forEach((w, idx) => {
    if (!isPlaced(w)) return; // quitada de la linea de tiempo: sigue en la letra/banco, pero no se dibuja aqui
    const chip = document.createElement("div");
    chip.className = "word-chip" + (idx === 0 || words[idx - 1].line_break_after ? " line-start" : "");
    if (state.wordTimeline.selected.has(idx)) chip.classList.add("selected");
    chip.title = `${w.text}  (${w.start.toFixed(2)}s - ${w.end.toFixed(2)}s)`;
    chip.style.left = `${w.start * px}px`;
    chip.style.width = `${Math.max(16, (w.end - w.start) * px)}px`;
    chip.dataset.idx = idx;

    const label = document.createElement("span");
    label.className = "word-chip-label";
    label.textContent = w.text;
    chip.appendChild(label);

    // Tiradores en los bordes para alargar/acortar la palabra (ajustar su
    // inicio o su fin por separado) arrastrando con el raton, sin mover la
    // palabra entera de sitio.
    const leftHandle = document.createElement("div");
    leftHandle.className = "word-chip-handle word-chip-handle-left";
    leftHandle.title = "Arrastra para ajustar el inicio de la palabra";
    leftHandle.addEventListener("pointerdown", (e) => onChipResizePointerDown(e, idx, "start"));
    chip.appendChild(leftHandle);

    const rightHandle = document.createElement("div");
    rightHandle.className = "word-chip-handle word-chip-handle-right";
    rightHandle.title = "Arrastra para ajustar el fin de la palabra";
    rightHandle.addEventListener("pointerdown", (e) => onChipResizePointerDown(e, idx, "end"));
    chip.appendChild(rightHandle);

    chip.addEventListener("pointerdown", (e) => onChipPointerDown(e, idx));
    track.appendChild(chip);
  });

  renderWordBank();
  updateTimelinePlayhead();
  updateSelectionInfo();
}

function updateSelectionInfo() {
  const n = state.wordTimeline.selected.size;
  $("#timelineSelectionInfo").textContent = n > 0 ? `${n} palabra${n > 1 ? "s" : ""} seleccionada${n > 1 ? "s" : ""}` : "";
}

function applySelectionVisuals() {
  const sel = state.wordTimeline.selected;
  $all(".word-chip").forEach((chip) => {
    chip.classList.toggle("selected", sel.has(parseInt(chip.dataset.idx, 10)));
  });
  $all(".word-bank-tile").forEach((tile) => {
    tile.classList.toggle("selected", sel.has(parseInt(tile.dataset.idx, 10)));
  });
  $all(".word-bank-row-num").forEach((num) => {
    const lineIdxs = JSON.parse(num.dataset.idxs || "[]");
    num.classList.toggle("selected", lineIdxs.length > 0 && lineIdxs.every((i) => sel.has(i)));
  });
  updateSelectionInfo();
}

// ----- Arrastre (individual o de toda la seleccion) -----

function onChipPointerDown(e, idx) {
  if (e.button !== 0) return; // el boton derecho se reserva para copiar (ver el listener "contextmenu")
  e.preventDefault();
  const sel = state.wordTimeline.selected;
  const alreadySelected = sel.has(idx);
  if (e.shiftKey || e.metaKey || e.ctrlKey) {
    if (alreadySelected) sel.delete(idx); else sel.add(idx);
    applySelectionVisuals();
    return; // clic de seleccion, sin iniciar arrastre
  }
  if (!alreadySelected) {
    state.wordTimeline.selected = new Set([idx]);
    applySelectionVisuals();
  }
  const origins = {};
  state.wordTimeline.selected.forEach((i) => {
    const w = state.project.lyrics.words[i];
    origins[i] = { start: w.start, end: w.end };
  });
  state.wordTimeline.dragging = { startX: e.clientX, origins, moved: false, primaryIdx: idx };
  $all(".word-chip.selected").forEach((c) => c.classList.add("dragging"));
  document.addEventListener("pointermove", onTimelinePointerMove);
  document.addEventListener("pointerup", onTimelinePointerUp, { once: true });
  document.addEventListener("pointercancel", onTimelinePointerUp, { once: true });
}

function onTimelinePointerMove(e) {
  const d = state.wordTimeline.dragging;
  if (!d) return;
  const deltaX = e.clientX - d.startX;
  if (Math.abs(deltaX) > 2) d.moved = true;
  const deltaT = deltaX / state.wordTimeline.pxPerSec;
  const totalDur = timelineDuration();
  const px = state.wordTimeline.pxPerSec;
  Object.entries(d.origins).forEach(([iStr, o]) => {
    const i = parseInt(iStr, 10);
    const wdur = o.end - o.start;
    const maxStart = Math.max(0, totalDur - wdur);
    const newStart = Math.min(maxStart, Math.max(0, o.start + deltaT));
    const word = state.project.lyrics.words[i];
    word.start = Math.round(newStart * 1000) / 1000;
    word.end = Math.round((newStart + wdur) * 1000) / 1000;
    const chip = $(`.word-chip[data-idx="${i}"]`);
    if (chip) chip.style.left = `${word.start * px}px`;
  });
  if (d.moved) {
    const primary = state.project.lyrics.words[d.primaryIdx];
    if (primary) showDragTooltip(e.clientX, e.clientY, `${fmtClockMs(primary.start)} → ${fmtClockMs(primary.end)}`);
  }
}

function onTimelinePointerUp() {
  const d = state.wordTimeline.dragging;
  document.removeEventListener("pointermove", onTimelinePointerMove);
  document.removeEventListener("pointerup", onTimelinePointerUp);
  document.removeEventListener("pointercancel", onTimelinePointerUp);
  state.wordTimeline.dragging = null;
  $all(".word-chip.dragging").forEach((c) => c.classList.remove("dragging"));
  hideDragTooltip();
  if (!d) return;
  if (d.moved) {
    renderLyricsTable(); // refleja los nuevos tiempos tambien en la tabla y el banco
    scheduleAutoSaveLyrics();
  } else {
    // clic simple (sin arrastrar): saltar el audio a esa palabra
    const w = state.project.lyrics.words[d.primaryIdx];
    if (w) $("#audioPlayerLyrics").currentTime = w.start;
  }
}

// ----- Redimensionar (alargar/acortar) una palabra ya colocada, arrastrando
// el borde izquierdo o derecho de su rectangulo en la linea de tiempo -----

const MIN_WORD_DUR = 0.05;

function onChipResizePointerDown(e, idx, edge) {
  if (e.button !== 0) return; // el boton derecho se reserva para copiar (ver el listener "contextmenu")
  e.preventDefault();
  e.stopPropagation(); // evita que tambien se dispare onChipPointerDown (mover) en el chip
  state.wordTimeline.selected = new Set([idx]);
  applySelectionVisuals();
  const w = state.project.lyrics.words[idx];
  if (!isPlaced(w)) return;
  state.wordTimeline.resizing = { idx, edge, startX: e.clientX, origin: { start: w.start, end: w.end } };
  $(`.word-chip[data-idx="${idx}"]`)?.classList.add("dragging");
  document.addEventListener("pointermove", onChipResizePointerMove);
  document.addEventListener("pointerup", onChipResizePointerUp, { once: true });
  document.addEventListener("pointercancel", onChipResizePointerUp, { once: true });
}

function onChipResizePointerMove(e) {
  const r = state.wordTimeline.resizing;
  if (!r) return;
  const px = state.wordTimeline.pxPerSec;
  const deltaT = (e.clientX - r.startX) / px;
  const w = state.project.lyrics.words[r.idx];
  const totalDur = timelineDuration();
  if (r.edge === "start") {
    const newStart = Math.min(r.origin.end - MIN_WORD_DUR, Math.max(0, r.origin.start + deltaT));
    w.start = Math.round(newStart * 1000) / 1000;
  } else {
    const newEnd = Math.max(r.origin.start + MIN_WORD_DUR, Math.min(totalDur, r.origin.end + deltaT));
    w.end = Math.round(newEnd * 1000) / 1000;
  }
  const chip = $(`.word-chip[data-idx="${r.idx}"]`);
  if (chip) {
    chip.style.left = `${w.start * px}px`;
    chip.style.width = `${Math.max(16, (w.end - w.start) * px)}px`;
  }
  showDragTooltip(e.clientX, e.clientY, `${fmtClockMs(w.start)} → ${fmtClockMs(w.end)}`);
}

function onChipResizePointerUp() {
  document.removeEventListener("pointermove", onChipResizePointerMove);
  document.removeEventListener("pointerup", onChipResizePointerUp);
  document.removeEventListener("pointercancel", onChipResizePointerUp);
  hideDragTooltip();
  const r = state.wordTimeline.resizing;
  state.wordTimeline.resizing = null;
  if (!r) return;
  $all(".word-chip.dragging").forEach((c) => c.classList.remove("dragging"));
  renderLyricsTable();
  scheduleAutoSaveLyrics();
}

// Guarda automaticamente los cambios de la linea de tiempo/banco unos
// milisegundos despues del ultimo ajuste (evita golpear el servidor en cada
// pixel de arrastre, pero no exige pulsar un boton para que quede guardado).
function scheduleAutoSaveLyrics() {
  setStatus("#autoSaveIndicator", "Guardando...", "working");
  clearTimeout(state.wordTimeline.autoSaveTimer);
  state.wordTimeline.autoSaveTimer = setTimeout(async () => {
    const words = state.project.lyrics.words;
    try {
      state.project = await api(`/api/projects/${state.pid}/lyrics`, { method: "PUT", body: { words } });
      renderWordTimeline();
      setStatus("#autoSaveIndicator", "✓ Guardado automáticamente.", "ok");
    } catch (e) {
      setStatus("#autoSaveIndicator", "No se pudo guardar automáticamente: " + e.message, "error");
    }
  }, 600);
}

// ----- Banco de palabras: lista ordenada, arrastrable a la linea de tiempo -----

// El banco de palabras se organiza en filas horizontales, una por cada
// linea de la canción (separadas por line_break_after), para que se lea
// como la letra real y sea facil encontrar y arrastrar una palabra concreta.
function dragSelectedIdxs(idx) {
  // Si la palabra arrastrada ya formaba parte de una seleccion de varias
  // (Shift/Ctrl+clic, o toda una fila via su numero), se arrastran TODAS
  // juntas de golpe; si no, solo esta.
  if (state.wordTimeline.selected.has(idx) && state.wordTimeline.selected.size > 1) {
    return Array.from(state.wordTimeline.selected).sort((a, b) => a - b);
  }
  state.wordTimeline.selected = new Set([idx]);
  applySelectionVisuals();
  return [idx];
}

function renderWordBank() {
  const words = state.project.lyrics.words;
  const bank = $("#wordBank");
  bank.innerHTML = "";

  // Agrupa los indices de palabras por linea (igual que line_break_after),
  // para poder seleccionar y arrastrar una fila ENTERA de una vez desde su
  // numero de linea, en vez de tener que ir palabra por palabra.
  const lines = [];
  let curLine = [];
  words.forEach((w, idx) => {
    curLine.push(idx);
    if (w.line_break_after) { lines.push(curLine); curLine = []; }
  });
  if (curLine.length) lines.push(curLine);

  lines.forEach((lineIdxs, lineNum) => {
    const row = document.createElement("div");
    row.className = "word-bank-row";

    const num = document.createElement("span");
    num.className = "word-bank-row-num";
    num.textContent = lineNum + 1;
    num.draggable = true;
    num.dataset.idxs = JSON.stringify(lineIdxs);
    num.title = "Clic para seleccionar toda la línea; arrástrala para colocarla entera en la línea de tiempo";
    if (lineIdxs.length && lineIdxs.every((i) => state.wordTimeline.selected.has(i))) {
      num.classList.add("selected");
    }
    num.addEventListener("click", (e) => {
      const allSelected = lineIdxs.every((i) => state.wordTimeline.selected.has(i));
      if (e.shiftKey || e.metaKey || e.ctrlKey) {
        lineIdxs.forEach((i) => {
          if (allSelected) state.wordTimeline.selected.delete(i);
          else state.wordTimeline.selected.add(i);
        });
      } else {
        state.wordTimeline.selected = allSelected ? new Set() : new Set(lineIdxs);
      }
      applySelectionVisuals();
    });
    num.addEventListener("dragstart", (e) => {
      state.wordTimeline.selected = new Set(lineIdxs);
      applySelectionVisuals();
      e.dataTransfer.setData("text/plain", JSON.stringify(lineIdxs));
      e.dataTransfer.effectAllowed = "move";
      num.classList.add("dragging-source");
      lineIdxs.forEach((i) => $(`.word-bank-tile[data-idx="${i}"]`)?.classList.add("dragging-source"));
    });
    num.addEventListener("dragend", () => {
      num.classList.remove("dragging-source");
      $all(".word-bank-tile.dragging-source").forEach((t) => t.classList.remove("dragging-source"));
      hideDragTooltip();
    });
    row.appendChild(num);

    lineIdxs.forEach((idx) => {
      const w = words[idx];
      const tile = document.createElement("div");
      tile.className = "word-bank-tile";
      const placed = isPlaced(w);
      if (!placed) tile.classList.add("unplaced");
      if (state.wordTimeline.selected.has(idx)) tile.classList.add("selected");
      tile.textContent = w.text;
      tile.draggable = true;
      tile.dataset.idx = idx;
      tile.title = placed
        ? "Arrástrala a la línea de tiempo para fijar su posición"
        : "Palabra sin colocar en la línea de tiempo: arrástrala hasta ahí para añadirla";
      tile.addEventListener("dragstart", (e) => {
        const idxs = dragSelectedIdxs(idx);
        e.dataTransfer.setData("text/plain", JSON.stringify(idxs));
        e.dataTransfer.effectAllowed = "move";
        idxs.forEach((i) => $(`.word-bank-tile[data-idx="${i}"]`)?.classList.add("dragging-source"));
      });
      tile.addEventListener("dragend", () => {
        $all(".word-bank-tile.dragging-source").forEach((t) => t.classList.remove("dragging-source"));
        hideDragTooltip();
      });
      tile.addEventListener("click", (e) => {
        if (e.shiftKey || e.metaKey || e.ctrlKey) {
          if (state.wordTimeline.selected.has(idx)) state.wordTimeline.selected.delete(idx);
          else state.wordTimeline.selected.add(idx);
        } else {
          state.wordTimeline.selected = new Set([idx]);
          if (placed) {
            const player = $("#audioPlayerLyrics");
            if (player.src) player.currentTime = w.start;
          }
        }
        applySelectionVisuals();
        scrollWordChipIntoView(idx);
      });
      row.appendChild(tile);
    });

    bank.appendChild(row);
  });
}

function scrollWordChipIntoView(idx) {
  const w = state.project.lyrics.words[idx];
  if (!isPlaced(w)) return;
  const chip = $(`.word-chip[data-idx="${idx}"]`);
  const scroller = $("#wordTimelineScroll");
  if (!chip || !scroller) return;
  const px = state.wordTimeline.pxPerSec;
  scroller.scrollLeft = Math.max(0, w.start * px - scroller.clientWidth / 2);
}

function parseDraggedIdxs(raw) {
  if (!raw) return [];
  let idxs;
  try {
    idxs = JSON.parse(raw);
  } catch (e) {
    idxs = [parseInt(raw, 10)];
  }
  if (!Array.isArray(idxs)) idxs = [idxs];
  return idxs
    .map((i) => parseInt(i, 10))
    .filter((i) => Number.isInteger(i) && state.project.lyrics.words[i]);
}

$("#timelineWordsTrack").addEventListener("dragover", (e) => {
  e.preventDefault();
  const rect = $("#timelineWordsTrack").getBoundingClientRect();
  const px = state.wordTimeline.pxPerSec;
  const t = Math.max(0, (e.clientX - rect.left) / px);
  showDragTooltip(e.clientX, e.clientY, fmtClockMs(t));
});
$("#timelineWordsTrack").addEventListener("dragleave", () => hideDragTooltip());
$("#timelineWordsTrack").addEventListener("drop", (e) => {
  e.preventDefault();
  hideDragTooltip();
  const idxs = parseDraggedIdxs(e.dataTransfer.getData("text/plain"));
  if (!idxs.length) return;
  const rect = $("#timelineWordsTrack").getBoundingClientRect();
  const px = state.wordTimeline.pxPerSec;
  const dropT = Math.max(0, (e.clientX - rect.left) / px);
  // Si se arrastran varias palabras de golpe, se colocan una detras de otra
  // a partir del punto donde se suelta, en el mismo orden en que aparecen en
  // la letra — asi se puede colocar de un tiron un tramo entero sin que las
  // palabras se superpongan entre si. Sin limite superior: si la serie no
  // cabe en la duracion actual, la linea de tiempo sencillamente se alarga.
  let cursor = dropT;
  idxs.forEach((idx) => {
    const word = state.project.lyrics.words[idx];
    // Si la palabra no estaba colocada (se habia quitado de la linea de tiempo
    // sin borrarla), no tiene una duracion previa de la que partir: se le da
    // una duracion razonable por defecto en vez de calcular end-start con null.
    const dur = isPlaced(word) ? Math.max(0.15, word.end - word.start) : 0.4;
    const start = Math.round(cursor * 1000) / 1000;
    word.start = start;
    word.end = Math.round((start + dur) * 1000) / 1000;
    cursor = word.end;
  });
  renderLyricsTable();
  scheduleAutoSaveLyrics();
});

$("#btnTimelineSelectAll").addEventListener("click", () => {
  state.wordTimeline.selected = new Set(state.project.lyrics.words.map((_, i) => i));
  applySelectionVisuals();
});

$("#btnTimelineClearSelection").addEventListener("click", () => {
  state.wordTimeline.selected = new Set();
  applySelectionVisuals();
});

$("#btnTimelineDeleteSelected").addEventListener("click", () => {
  const sel = state.wordTimeline.selected;
  if (sel.size === 0) {
    setStatus("#autoSaveIndicator", "No hay ninguna palabra seleccionada. Haz clic sobre una (o varias con Shift/Ctrl) primero.", "error");
    return;
  }
  if (sel.size > 8 && !confirm(`¿Quitar ${sel.size} palabras seleccionadas de la línea de tiempo? Seguirán disponibles en el banco de palabras y en la tabla de letra para volver a colocarlas. Esta acción solo se aplica al pulsar aquí; no se quita nada por el mero hecho de seleccionar.`)) {
    return;
  }
  // Quitar de la linea de tiempo NO borra la palabra: solo se le quitan sus
  // tiempos (start/end -> null), para que siga disponible en el banco de
  // palabras y en la tabla de letra detectada, y se pueda volver a arrastrar
  // a la linea de tiempo mas tarde.
  state.project.lyrics.words.forEach((w, i) => {
    if (sel.has(i)) {
      w.start = null;
      w.end = null;
    }
  });
  state.wordTimeline.selected = new Set();
  renderLyricsTable();
  scheduleAutoSaveLyrics();
});

function updateTimelinePlayhead() {
  const player = $("#audioPlayerLyrics");
  const t = player && player.src ? player.currentTime : 0;
  const px = state.wordTimeline.pxPerSec;
  $("#timelinePlayhead").style.left = `${t * px}px`;
  $("#timelineClock").textContent = `${fmtClock(t)} / ${fmtClock(timelineDuration())}`;

  $all(".word-chip").forEach((chip) => {
    const idx = parseInt(chip.dataset.idx, 10);
    const w = state.project.lyrics.words[idx];
    chip.classList.toggle("current", !!w && t >= w.start && t <= w.end);
  });
  $all(".word-bank-tile").forEach((tile) => {
    const idx = parseInt(tile.dataset.idx, 10);
    const w = state.project.lyrics.words[idx];
    tile.classList.toggle("current", isPlaced(w) && t >= w.start && t <= w.end);
  });

  const scroller = $("#wordTimelineScroll");
  if (!state.wordTimeline.panning) {
    const playheadX = t * px;
    if (playheadX < scroller.scrollLeft + 40 || playheadX > scroller.scrollLeft + scroller.clientWidth - 40) {
      scroller.scrollLeft = Math.max(0, playheadX - scroller.clientWidth / 2);
    }
  }
}

function timelineLoop() {
  updateTimelinePlayhead();
  const player = $("#audioPlayerLyrics");
  if (player && !player.paused) {
    state.wordTimeline.rafId = requestAnimationFrame(timelineLoop);
  } else {
    state.wordTimeline.rafId = null;
    $("#btnTimelinePlay").textContent = "▶ Reproducir";
  }
}

$("#btnTimelinePlay").addEventListener("click", () => {
  const player = $("#audioPlayerLyrics");
  if (!player.src) { alert("Sube primero el audio en el paso 1."); return; }
  if (player.paused) {
    player.play();
    $("#btnTimelinePlay").textContent = "⏸ Pausar";
    if (!state.wordTimeline.rafId) state.wordTimeline.rafId = requestAnimationFrame(timelineLoop);
  } else {
    player.pause();
    $("#btnTimelinePlay").textContent = "▶ Reproducir";
  }
});

// El zoom va de un extremo "minimizado" (ver toda la cancion, aunque sea
// larga, de un vistazo) a uno muy ampliado (ajustar palabra a palabra con
// precision de milisegundos). Con un rango tan amplio (2 a 400 px/segundo)
// un control lineal seria muy brusco en el centro, asi que el <input range>
// usa una posicion 0..1000 que se traduce a pxPerSec de forma logaritmica.
const ZOOM_PXSEC_MIN = 0.5;
const ZOOM_PXSEC_MAX = 400;
function zoomRawToPxPerSec(raw) {
  const t = Math.max(0, Math.min(1000, raw)) / 1000;
  return ZOOM_PXSEC_MIN * Math.pow(ZOOM_PXSEC_MAX / ZOOM_PXSEC_MIN, t);
}
function zoomPxPerSecToRaw(px) {
  const clamped = Math.max(ZOOM_PXSEC_MIN, Math.min(ZOOM_PXSEC_MAX, px));
  return Math.round(1000 * Math.log(clamped / ZOOM_PXSEC_MIN) / Math.log(ZOOM_PXSEC_MAX / ZOOM_PXSEC_MIN));
}
function setZoomPxPerSec(px) {
  state.wordTimeline.pxPerSec = Math.max(ZOOM_PXSEC_MIN, Math.min(ZOOM_PXSEC_MAX, px));
  $("#timelineZoom").value = zoomPxPerSecToRaw(state.wordTimeline.pxPerSec);
  renderWordTimeline();
}

$("#timelineZoom").addEventListener("input", (e) => {
  state.wordTimeline.pxPerSec = zoomRawToPxPerSec(parseInt(e.target.value, 10));
  renderWordTimeline();
});

$("#btnTimelineFitAll").addEventListener("click", () => {
  const scroller = $("#wordTimelineScroll");
  const width = scroller.clientWidth || 700;
  setZoomPxPerSec(width / timelineDuration());
});

$("#btnTimelineZoomDetail").addEventListener("click", () => setZoomPxPerSec(220));

// ----- Espacio de trabajo ampliado a pantalla completa -----

function setTimelineExpanded(expanded) {
  $("#timelineWorkspace").classList.toggle("expanded", expanded);
  $("#btnTimelineCollapse").classList.toggle("hidden", !expanded);
  $("#btnTimelineExpand").textContent = expanded ? "⤢ Reducir" : "⛶ Ampliar espacio de trabajo";
  document.body.style.overflow = expanded ? "hidden" : "";
}
$("#btnTimelineExpand").addEventListener("click", () => setTimelineExpanded(true));
$("#btnTimelineCollapse").addEventListener("click", () => setTimelineExpanded(false));

// ----- Barra espaciadora: pulsacion simple = play/pause; mantenida +
// arrastre con el boton derecho del raton = desplazar la vista -----

function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

document.addEventListener("keydown", (e) => {
  if (e.code !== "Space" || state.current !== "lyrics" || isTypingTarget(document.activeElement)) return;
  if (state.wordTimeline.spaceArmed) { e.preventDefault(); return; } // evita repeticion por tecla mantenida
  e.preventDefault();
  state.wordTimeline.spaceArmed = true;
  state.wordTimeline.spaceDidPan = false;
  $("#wordTimelineScroll").classList.add("space-armed");
});

document.addEventListener("keydown", (e) => {
  if (e.code !== "Escape" || state.current !== "lyrics" || !state.wordTimeline.clipboard) return;
  state.wordTimeline.clipboard = null;
  $("#timelineWordsTrack").classList.remove("clipboard-armed");
  setStatus("#autoSaveIndicator", "Copia cancelada.", "ok");
});

document.addEventListener("keyup", (e) => {
  if (e.code !== "Space" || !state.wordTimeline.spaceArmed) return;
  state.wordTimeline.spaceArmed = false;
  $("#wordTimelineScroll").classList.remove("space-armed");
  if (!state.wordTimeline.spaceDidPan) {
    // pulsacion simple, sin arrastrar: play/pause de la musica
    $("#btnTimelinePlay").click();
  }
});

// ----- Desplazar la vista (pan) con boton derecho + espaciadora mantenida -----

const timelineScroller = $("#wordTimelineScroll");
timelineScroller.addEventListener("contextmenu", (e) => {
  if (state.wordTimeline.spaceArmed || state.wordTimeline.panning) e.preventDefault();
});
timelineScroller.addEventListener("pointerdown", (e) => {
  if (e.button !== 2 || !state.wordTimeline.spaceArmed) return; // solo boton derecho + espaciadora
  e.preventDefault();
  state.wordTimeline.spaceDidPan = true;
  state.wordTimeline.panning = { startX: e.clientX, startScrollLeft: timelineScroller.scrollLeft };
  timelineScroller.classList.add("panning");
  document.addEventListener("pointermove", onTimelinePan);
  document.addEventListener("pointerup", onTimelinePanEnd, { once: true });
});
function onTimelinePan(e) {
  const p = state.wordTimeline.panning;
  if (!p) return;
  timelineScroller.scrollLeft = Math.max(0, p.startScrollLeft - (e.clientX - p.startX));
}
function onTimelinePanEnd() {
  document.removeEventListener("pointermove", onTimelinePan);
  state.wordTimeline.panning = null;
  timelineScroller.classList.remove("panning");
}

// ----- Zoom con la rueda del raton, centrado en la posicion del cursor -----

timelineScroller.addEventListener("wheel", (e) => {
  e.preventDefault();
  const rect = timelineScroller.getBoundingClientRect();
  const cursorX = e.clientX - rect.left;
  const timeAtCursor = (timelineScroller.scrollLeft + cursorX) / state.wordTimeline.pxPerSec;
  const factor = Math.pow(1.0015, -e.deltaY);
  const newPx = Math.max(ZOOM_PXSEC_MIN, Math.min(ZOOM_PXSEC_MAX, state.wordTimeline.pxPerSec * factor));
  setZoomPxPerSec(newPx);
  timelineScroller.scrollLeft = Math.max(0, timeAtCursor * state.wordTimeline.pxPerSec - cursorX);
}, { passive: false });

$("#audioPlayerLyrics").addEventListener("seeked", updateTimelinePlayhead);
$("#audioPlayerLyrics").addEventListener("play", () => {
  if (!state.wordTimeline.rafId) state.wordTimeline.rafId = requestAnimationFrame(timelineLoop);
});

// Coloca el cursor de reproduccion exactamente donde se haga clic en la
// linea de tiempo (regla o zona vacia de la pista), para poder arrancar el
// audio justo ahi y comprobar que la palabra etiquetada en ese punto es la
// que realmente se oye.
function seekTimelineAt(clientX) {
  const player = $("#audioPlayerLyrics");
  if (!player.src) return;
  const track = $("#timelineWordsTrack");
  const rect = track.getBoundingClientRect();
  const t = Math.max(0, (clientX - rect.left) / state.wordTimeline.pxPerSec);
  player.currentTime = Math.min(t, timelineDuration());
  updateTimelinePlayhead();
}

// Seleccion por arrastre ("rubber band"): pulsar el boton izquierdo sobre una
// zona vacia de la linea de tiempo y arrastrar dibuja un rectangulo; todas
// las palabras que ese rectangulo toque quedan seleccionadas al soltar, y a
// partir de ahi se pueden arrastrar todas juntas (ver onChipPointerDown/
// onTimelinePointerMove) hasta soltarlas donde se quiera.
$("#timelineWordsTrack").addEventListener("pointerdown", (e) => {
  if (e.target.closest(".word-chip")) return; // una palabra gestiona su propio pointerdown
  if (e.button !== 0) return; // solo el boton izquierdo inicia la seleccion por arrastre
  e.preventDefault();
  const track = $("#timelineWordsTrack");
  const rect = track.getBoundingClientRect();
  const startX = e.clientX - rect.left;
  const box = document.createElement("div");
  box.className = "timeline-marquee";
  box.style.left = `${startX}px`;
  box.style.width = "0px";
  track.appendChild(box);
  const additive = e.shiftKey || e.metaKey || e.ctrlKey;
  state.wordTimeline.marquee = {
    startX, box, moved: false, additive, baseSelection: new Set(state.wordTimeline.selected), clientX: e.clientX,
  };
  document.addEventListener("pointermove", onMarqueePointerMove);
  document.addEventListener("pointerup", onMarqueePointerUp, { once: true });
  document.addEventListener("pointercancel", onMarqueePointerUp, { once: true });
});

function onMarqueePointerMove(e) {
  const m = state.wordTimeline.marquee;
  if (!m) return;
  const track = $("#timelineWordsTrack");
  const rect = track.getBoundingClientRect();
  const curX = e.clientX - rect.left;
  if (Math.abs(curX - m.startX) > 3) m.moved = true;
  m.clientX = e.clientX;
  const left = Math.min(m.startX, curX);
  const width = Math.abs(curX - m.startX);
  m.box.style.left = `${left}px`;
  m.box.style.width = `${width}px`;

  const px = state.wordTimeline.pxPerSec;
  const tStart = left / px;
  const tEnd = (left + width) / px;
  const overlapped = new Set();
  state.project.lyrics.words.forEach((w, i) => {
    if (isPlaced(w) && w.end >= tStart && w.start <= tEnd) overlapped.add(i);
  });
  state.wordTimeline.selected = m.additive
    ? new Set([...m.baseSelection, ...overlapped])
    : overlapped;
  applySelectionVisuals();
}

function onMarqueePointerUp(e) {
  const m = state.wordTimeline.marquee;
  document.removeEventListener("pointermove", onMarqueePointerMove);
  document.removeEventListener("pointerup", onMarqueePointerUp);
  document.removeEventListener("pointercancel", onMarqueePointerUp);
  state.wordTimeline.marquee = null;
  if (!m) return;
  m.box.remove();
  if (!m.moved) {
    const clientX = e ? e.clientX : m.clientX;
    // Si hay algo copiado (clic derecho sobre una palabra), un clic izquierdo
    // simple en la linea de tiempo lo pega ahi en vez de solo buscar esa
    // posicion — asi se pueden duplicar palabras rapidamente en varios puntos.
    if (state.wordTimeline.clipboard && !m.additive) {
      pasteClipboardAt(clientX);
      return;
    }
    // clic simple, sin arrastre real: comportamiento habitual (buscar esa posicion)
    seekTimelineAt(clientX);
    if (!m.additive && state.wordTimeline.selected.size) {
      state.wordTimeline.selected = new Set();
      applySelectionVisuals();
    }
  }
}

// ----- Copiar/pegar palabras ya colocadas: clic derecho copia, clic
// izquierdo pega una (o varias, si habia mas de una seleccionada) duplicado
// en el punto donde se hace clic — util para repetir una palabra o un coro
// sin tener que volver a escribirla o arrastrarla letra por letra. -----

$("#timelineWordsTrack").addEventListener("contextmenu", (e) => {
  const chipEl = e.target.closest(".word-chip");
  if (!chipEl) return; // clic derecho fuera de una palabra: menu nativo normal
  e.preventDefault();
  const idx = parseInt(chipEl.dataset.idx, 10);
  let idxs;
  if (state.wordTimeline.selected.has(idx) && state.wordTimeline.selected.size > 1) {
    idxs = Array.from(state.wordTimeline.selected).sort((a, b) => a - b);
  } else {
    idxs = [idx];
    state.wordTimeline.selected = new Set([idx]);
    applySelectionVisuals();
  }
  const clip = idxs
    .map((i) => state.project.lyrics.words[i])
    .filter(isPlaced)
    .map((w) => ({ text: w.text, dur: Math.max(0.1, w.end - w.start) }));
  if (!clip.length) return;
  state.wordTimeline.clipboard = clip;
  $("#timelineWordsTrack").classList.add("clipboard-armed");
  const n = clip.length;
  setStatus(
    "#autoSaveIndicator",
    `${n} palabra${n > 1 ? "s" : ""} copiada${n > 1 ? "s" : ""}. Haz clic con el botón izquierdo en la línea de tiempo para pegarla${n > 1 ? "s" : ""} (Esc para cancelar).`,
    "ok"
  );
});

function pasteClipboardAt(clientX) {
  const clip = state.wordTimeline.clipboard;
  if (!clip || !clip.length) return;
  const rect = $("#timelineWordsTrack").getBoundingClientRect();
  const px = state.wordTimeline.pxPerSec;
  // Igual que al arrastrar varias palabras de golpe: se colocan una detras
  // de otra sin limite superior, para que una serie pegada cerca del final
  // de la linea de tiempo se reparta en fila en vez de apilarse en un punto.
  let cursor = Math.max(0, (clientX - rect.left) / px);
  const words = state.project.lyrics.words;
  if (words.length) words[words.length - 1].line_break_after = true;
  const newIdxs = [];
  clip.forEach((c, i) => {
    const start = Math.round(cursor * 1000) / 1000;
    const end = Math.round((start + c.dur) * 1000) / 1000;
    words.push({ text: c.text, start, end, line_break_after: i === clip.length - 1 });
    newIdxs.push(words.length - 1);
    cursor = end;
  });
  state.wordTimeline.selected = new Set(newIdxs);
  renderLyricsTable();
  scheduleAutoSaveLyrics();
}

$("#timelineRuler").addEventListener("click", (e) => seekTimelineAt(e.clientX));

$("#btnTimelineStop").addEventListener("click", () => {
  const player = $("#audioPlayerLyrics");
  if (!player.src) return;
  player.pause();
  player.currentTime = 0;
  $("#btnTimelinePlay").textContent = "▶ Reproducir";
  updateTimelinePlayhead();
});

$("#btnTimelineBack").addEventListener("click", () => {
  const player = $("#audioPlayerLyrics");
  if (!player.src) return;
  player.currentTime = Math.max(0, player.currentTime - 2);
  updateTimelinePlayhead();
});

$("#btnTimelineForward").addEventListener("click", () => {
  const player = $("#audioPlayerLyrics");
  if (!player.src) return;
  player.currentTime = Math.min(timelineDuration(), player.currentTime + 2);
  updateTimelinePlayhead();
});

function buildLyricsRow(w, idx) {
  const tr = document.createElement("tr");
  const placed = isPlaced(w);
  if (!placed) tr.classList.add("unplaced-row");
  tr.innerHTML = `
    <td><input type="text" class="w-text" value="${escapeHtml(w.text)}"></td>
    <td><input type="number" class="w-start" step="0.01" value="${placed ? w.start : ""}" placeholder="sin colocar"></td>
    <td><input type="number" class="w-end" step="0.01" value="${placed ? w.end : ""}" placeholder="sin colocar"></td>
    <td><input type="checkbox" class="w-break" ${w.line_break_after ? "checked" : ""}></td>
    <td><button class="btn small danger w-del">✕</button></td>
  `;
  tr.querySelector(".w-del").addEventListener("click", () => { tr.remove(); saveLyrics(); });
  tr.querySelectorAll("input").forEach((inp) => inp.addEventListener("change", saveLyrics));
  return tr;
}

async function saveLyrics(showConfirmation) {
  const rows = $all("#lyricsBody tr");
  const words = rows.map((tr) => {
    const startRaw = tr.querySelector(".w-start").value.trim();
    const endRaw = tr.querySelector(".w-end").value.trim();
    return {
      text: tr.querySelector(".w-text").value,
      start: startRaw === "" ? null : parseFloat(startRaw),
      end: endRaw === "" ? null : parseFloat(endRaw),
      line_break_after: tr.querySelector(".w-break").checked,
    };
  });
  try {
    state.project = await api(`/api/projects/${state.pid}/lyrics`, { method: "PUT", body: { words } });
    renderWordTimeline();
    if (showConfirmation) setStatus("#lyricsStatus", "✓ Cambios guardados correctamente.", "ok");
  } catch (e) {
    setStatus("#lyricsStatus", "Error guardando letra: " + e.message, "error");
  }
}

$("#btnSaveLyrics").addEventListener("click", () => saveLyrics(true));

$("#btnImportTxt").addEventListener("click", () => $("#lyricsTxtInput").click());
$("#lyricsTxtInput").addEventListener("change", async () => {
  const file = $("#lyricsTxtInput").files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append("file", file);
  setStatus("#importTxtStatus", "Analizando y alineando el texto con los tiempos detectados...", "working");
  try {
    const res = await api(`/api/projects/${state.pid}/lyrics/import-txt`, { method: "POST", body: fd });
    state.project = res.project;
    renderLyricsTable();
    setStatus("#importTxtStatus", `✓ Letra importada (${res.word_count} palabras) y alineada con los tiempos detectados por la IA.`, "ok");
  } catch (e) {
    setStatus("#importTxtStatus", "Error importando el .txt: " + e.message, "error");
  }
  $("#lyricsTxtInput").value = "";
});

$("#btnImportPastedText").addEventListener("click", async () => {
  const text = $("#lyricsPasteText").value;
  if (!text.trim()) { setStatus("#importTxtStatus", "Pega primero la letra en el cuadro de texto.", "error"); return; }
  setStatus("#importTxtStatus", "Analizando y alineando el texto con los tiempos detectados...", "working");
  try {
    const res = await api(`/api/projects/${state.pid}/lyrics/import-text`, { method: "POST", body: { text } });
    state.project = res.project;
    renderLyricsTable();
    setStatus("#importTxtStatus", `✓ Letra importada (${res.word_count} palabras) y alineada con los tiempos detectados por la IA.`, "ok");
  } catch (e) {
    setStatus("#importTxtStatus", "Error analizando el texto: " + e.message, "error");
  }
});

$("#btnShiftMinus").addEventListener("click", () => { $("#shiftAmount").value = (parseFloat($("#shiftAmount").value) || 0) - 0.5; });
$("#btnShiftPlus").addEventListener("click", () => { $("#shiftAmount").value = (parseFloat($("#shiftAmount").value) || 0) + 0.5; });

$("#btnApplyShift").addEventListener("click", async () => {
  const offset = parseFloat($("#shiftAmount").value) || 0;
  if (offset === 0) { setStatus("#lyricsStatus", "El desplazamiento es 0, no hay nada que aplicar.", "error"); return; }
  try {
    state.project = await api(`/api/projects/${state.pid}/lyrics/shift`, { method: "PUT", body: { offset } });
    renderLyricsTable();
    setStatus("#lyricsStatus", `✓ Letra desplazada ${offset > 0 ? "+" : ""}${offset}s en todos sus tiempos.`, "ok");
    $("#shiftAmount").value = 0;
  } catch (e) {
    setStatus("#lyricsStatus", "Error aplicando el desplazamiento: " + e.message, "error");
  }
});

$("#btnAddWord").addEventListener("click", () => {
  const body = $("#lyricsBody");
  const last = body.lastElementChild;
  const lastEnd = last ? parseFloat(last.querySelector(".w-end").value) || 0 : 0;
  body.appendChild(buildLyricsRow({ text: "nueva", start: lastEnd, end: lastEnd + 0.4, line_break_after: false }, body.children.length));
  saveLyrics();
});

// Añade un texto suelto (p.ej. un titulo) en el punto exacto de la linea de
// tiempo que se quiera, con su propia duracion — independiente de la letra
// detectada. Si tiene varias palabras, se repliega proporcionalmente (por
// longitud) dentro de esa duracion, igual que al pegar/duplicar palabras, y
// queda como una fila nueva mas en la tabla y en el banco, totalmente
// editable despues (arrastrable, redimensionable, borrable) igual que
// cualquier otra palabra.
$("#btnAddTitle").addEventListener("click", () => {
  const text = $("#titleText").value.trim();
  if (!text) {
    setStatus("#lyricsStatus", "Escribe primero el texto del título.", "error");
    return;
  }
  const start = Math.max(0, parseFloat($("#titleStart").value) || 0);
  const duration = Math.max(0.2, parseFloat($("#titleDuration").value) || 2);
  const parts = text.split(/\s+/).filter(Boolean);
  const weights = parts.map((w) => Math.max(1, w.length));
  const totalWeight = weights.reduce((a, b) => a + b, 0) || 1;
  const words = state.project.lyrics.words;
  const insertAt = words.length;
  if (words.length) words[words.length - 1].line_break_after = true;
  let cursor = start;
  parts.forEach((w, i) => {
    const dur = duration * (weights[i] / totalWeight);
    const wStart = Math.round(cursor * 1000) / 1000;
    const wEnd = Math.round((cursor + dur) * 1000) / 1000;
    words.push({ text: w, start: wStart, end: wEnd, line_break_after: i === parts.length - 1 });
    cursor = wEnd;
  });
  state.wordTimeline.selected = new Set(Array.from({ length: parts.length }, (_, i) => insertAt + i));
  $("#titleText").value = "";
  renderLyricsTable();
  scheduleAutoSaveLyrics();
  scrollWordChipIntoView(insertAt);
});

// Borra TODA la letra de golpe (tabla, banco de palabras y linea de tiempo)
// en vez de tener que quitar las palabras una por una.
$("#btnDeleteAllWords").addEventListener("click", () => {
  if (!state.project.lyrics.words.length) return;
  if (!confirm("¿Borrar TODA la letra? Se quitan todas las palabras de la tabla, del banco de palabras y de la línea de tiempo. No se puede deshacer.")) {
    return;
  }
  state.project.lyrics.words = [];
  state.wordTimeline.selected = new Set();
  renderLyricsTable();
  scheduleAutoSaveLyrics();
});

$("#btnRetranscribe").addEventListener("click", async () => {
  const quality = $("#retranscribeQuality").value;
  try {
    const res = await api(`/api/projects/${state.pid}/retranscribe?quality=${quality}`, { method: "POST" });
    setStatus("#lyricsStatus", quality === "precise" ? "Volviendo a transcribir con el modelo preciso (puede tardar varios minutos)..." : "Volviendo a transcribir...", "working");
    pollJob(res.job_id, "#lyricsStatus", "Detectando la letra...", () => refreshProject().then(renderLyricsTable));
  } catch (e) {
    setStatus("#lyricsStatus", "Error: " + e.message, "error");
  }
});

$("#btnToStyle").addEventListener("click", () => showStep("style"));

// ---------------- PASO 4: style ----------------

function populateStyleControls() {
  const fontSel = $("#styleFont");
  fontSel.innerHTML = state.presets.fonts.map((f) => `<option value="${f}">${f}</option>`).join("");
  const st = state.project.style;
  fontSel.value = st.font;
  $("#styleFontSize").value = st.font_size;
  $("#fontSizeVal").textContent = st.font_size;
  $("#stylePrimary").value = st.primary_color;
  $("#styleSecondary").value = st.secondary_color;
  $("#styleOutline").value = st.outline_color;
  $("#styleOutlineWidth").value = st.outline_width;
  $("#outlineWidthVal").textContent = st.outline_width;
  $("#stylePosition").value = st.position;
  $("#styleAnimation").value = st.animation;
  $("#styleUppercase").checked = st.uppercase;
  $("#styleBold").checked = st.bold;

  const liveInputs = ["#styleFont", "#styleFontSize", "#stylePrimary", "#styleSecondary", "#styleOutline",
    "#styleOutlineWidth", "#stylePosition", "#styleAnimation", "#styleUppercase", "#styleBold"];
  liveInputs.forEach((sel) => $(sel).addEventListener("input", onStyleChange));
}

let styleSaveTimer = null;
function onStyleChange() {
  $("#fontSizeVal").textContent = $("#styleFontSize").value;
  $("#outlineWidthVal").textContent = $("#styleOutlineWidth").value;
  const payload = {
    font: $("#styleFont").value,
    font_size: parseInt($("#styleFontSize").value),
    primary_color: $("#stylePrimary").value,
    secondary_color: $("#styleSecondary").value,
    outline_color: $("#styleOutline").value,
    outline_width: parseInt($("#styleOutlineWidth").value),
    position: $("#stylePosition").value,
    animation: $("#styleAnimation").value,
    uppercase: $("#styleUppercase").checked,
    bold: $("#styleBold").checked,
  };
  state.project.style = { ...state.project.style, ...payload };
  clearTimeout(styleSaveTimer);
  styleSaveTimer = setTimeout(async () => {
    try { await api(`/api/projects/${state.pid}/style`, { method: "PUT", body: payload }); } catch (e) {}
  }, 300);
}

$("#btnToTimeline").addEventListener("click", () => showStep("timeline"));

// ----- canvas preview -----
// El mismo motor de dibujo se reutiliza en dos lienzos: el del paso 4
// (Estilo, para ajustar tipografia/animacion) y el del paso 6 (Exportar,
// vista previa final con encuadre/filtro ya aplicados antes de exportar).

// seekSel es la barra de progreso (input range) que permite reproducir o
// saltar a cualquier punto de la cancion directamente desde la previsualizacion.
function makePreviewController(canvasSel, buttonSel, idleLabel, seekSel) {
  const ctrl = { playing: false };
  const seek = $(seekSel);

  function drawAt(t) {
    const canvas = $(canvasSel);
    renderPreviewFrame(canvas.getContext("2d"), canvas.width, canvas.height, t);
  }
  function syncSeek(t) {
    if (!seek) return;
    const dur = state.project.audio ? state.project.audio.duration : 0;
    seek.max = Math.max(0.01, dur);
    seek.value = t;
  }
  function loop() {
    if (!ctrl.playing) return;
    const player = $("#audioPlayer");
    drawAt(player.currentTime);
    syncSeek(player.currentTime);
    requestAnimationFrame(loop);
  }
  ctrl.toggle = function () {
    const player = $("#audioPlayer");
    if (!player.src) { alert("Sube primero el audio en el paso 1."); return; }
    if (ctrl.playing) {
      player.pause();
      ctrl.playing = false;
      $(buttonSel).textContent = idleLabel;
      return;
    }
    state.previewing.forEach((other) => other !== ctrl && other.stop());
    ctrl.playing = true;
    $(buttonSel).textContent = "⏸ Pausar";
    prepareBgAssets();
    // Reproduce desde donde ya estuviera el audio (por una pausa anterior o
    // por haber arrastrado la barra de progreso), en vez de reiniciar a 0.
    player.play();
    requestAnimationFrame(loop);
    player.onended = () => { ctrl.playing = false; $(buttonSel).textContent = idleLabel; };
  };
  ctrl.stop = function () {
    if (!ctrl.playing) return;
    $("#audioPlayer").pause();
    ctrl.playing = false;
    $(buttonSel).textContent = idleLabel;
  };
  // Se llama al entrar en el paso: dibuja un fotograma estatico con el
  // encuadre/estilo actuales y prepara la barra de progreso, para que la
  // previsualizacion no se vea en negro hasta pulsar "Reproducir".
  ctrl.refresh = function () {
    if (!state.project.audio) return;
    prepareBgAssets();
    const player = $("#audioPlayer");
    const t = player.src ? player.currentTime : 0;
    drawAt(t);
    syncSeek(t);
  };
  if (seek) {
    seek.addEventListener("input", () => {
      const player = $("#audioPlayer");
      if (!player.src) return;
      const t = parseFloat(seek.value) || 0;
      player.currentTime = t;
      prepareBgAssets();
      drawAt(t);
    });
  }
  state.previewing.push(ctrl);
  return ctrl;
}

let previewCtrlStyle, previewCtrlTimeline, previewCtrlExport;
function setupPreviewControllers() {
  previewCtrlStyle = makePreviewController("#previewCanvas", "#btnPreviewPlay", "▶ Previsualizar", "#previewSeek");
  previewCtrlTimeline = makePreviewController("#previewCanvasTimeline", "#btnPreviewPlayTimeline", "▶ Previsualizar", "#previewSeekTimeline");
  previewCtrlExport = makePreviewController("#previewCanvasExport", "#btnPreviewPlayExport", "▶ Previsualizar cómo quedará", "#previewSeekExport");
  $("#btnPreviewPlay").addEventListener("click", () => previewCtrlStyle.toggle());
  $("#btnPreviewPlayTimeline").addEventListener("click", () => previewCtrlTimeline.toggle());
  $("#btnPreviewPlayExport").addEventListener("click", () => previewCtrlExport.toggle());
}

function prepareBgAssets() {
  const media = state.project.media;
  if (!media || !media.type) return;
  if (media.type === "video") {
    if (!state.bgVideoEl) {
      state.bgVideoEl = document.createElement("video");
      state.bgVideoEl.src = mediaUrl(media.video.path);
      state.bgVideoEl.muted = true;
      state.bgVideoEl.loop = true;
      state.bgVideoEl.play().catch(() => {});
    }
  } else if (media.type === "images") {
    media.images.forEach((im) => {
      if (!state.bgImages[im.path]) {
        const img = new Image();
        img.src = mediaUrl(im.path);
        state.bgImages[im.path] = img;
      }
    });
  }
}

// Replica en el canvas la misma logica de encuadre (computeFitLayout) que
// usa ffmpeg al exportar (ver fit_frame_filter en ffmpeg_utils.py), para que
// la previsualizacion coincida con el ajuste elegido en el paso 2.
function drawFitFocused(ctx, srcW, srcH, cw, ch, focusX, focusY, zoom, drawFn) {
  const { x, y, w, h } = computeFitLayout(srcW, srcH, cw, ch, focusX, focusY, zoom);
  drawFn(x, y, w, h);
}

function currentImageForTime(t) {
  const media = state.project.media;
  const images = media.images;
  const audioDur = state.project.audio ? state.project.audio.duration : 0;
  const totalSet = images.reduce((a, im) => a + im.duration, 0) || 1;
  const factor = audioDur / totalSet;
  let acc = 0;
  for (const im of images) {
    const dur = im.duration * factor;
    if (t < acc + dur) return im;
    acc += dur;
  }
  return images[images.length - 1];
}

function applyCanvasFilter(ctx) {
  const map = {
    none: "none",
    vivid: "contrast(1.2) saturate(1.5)",
    warm: "sepia(0.15) saturate(1.15)",
    cool: "saturate(1.05) hue-rotate(10deg)",
    grayscale: "grayscale(1)",
    sepia: "sepia(0.8)",
    vintage: "contrast(0.9) saturate(0.7) brightness(0.95)",
    vignette: "contrast(1.05)",
  };
  ctx.filter = map[state.project.filter] || "none";
}

function renderPreviewFrame(ctx, cw, ch, t) {
  ctx.filter = "none";
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, cw, ch);

  applyCanvasFilter(ctx);
  const media = state.project.media;
  if (media && media.type === "video" && state.bgVideoEl) {
    const v = state.bgVideoEl;
    const vid = media.video;
    const trimStart = vid.trim_start || 0;
    if (v.readyState >= 2 && v.videoWidth) {
      const targetT = trimStart + t;
      if (Math.abs(v.currentTime - targetT) > 0.3) v.currentTime = Math.min(targetT, vid.trim_end || v.duration);
      drawFitFocused(ctx, v.videoWidth, v.videoHeight, cw, ch, vid.focus_x, vid.focus_y, vid.zoom,
        (x, y, w, h) => ctx.drawImage(v, x, y, w, h));
    }
  } else if (media && media.type === "images") {
    const im = currentImageForTime(t);
    if (im) {
      const imgEl = state.bgImages[im.path];
      if (imgEl && imgEl.complete && imgEl.naturalWidth) {
        drawFitFocused(ctx, imgEl.naturalWidth, imgEl.naturalHeight, cw, ch, im.focus_x, im.focus_y, im.zoom,
          (x, y, w, h) => ctx.drawImage(imgEl, x, y, w, h));
      }
    }
  }
  ctx.filter = "none";

  drawKaraokeLine(ctx, cw, ch, t);
  drawClockOverlay(ctx, cw, ch, t);
}

// Reloj (tiempo actual / duracion total) superpuesto en la esquina de toda
// previsualizacion, para saber siempre en que punto exacto de la cancion
// esta el fotograma mostrado.
function drawClockOverlay(ctx, cw, ch, t) {
  const dur = state.project.audio ? state.project.audio.duration : 0;
  const text = `${fmtClock(t)} / ${fmtClock(dur)}`;
  const fontSize = Math.max(12, Math.round(cw * 0.042));
  ctx.save();
  ctx.filter = "none";
  ctx.font = `700 ${fontSize}px monospace`;
  ctx.textBaseline = "middle";
  const padX = 8, padY = 5;
  const textW = ctx.measureText(text).width;
  const boxW = textW + padX * 2;
  const boxH = fontSize + padY * 2;
  const margin = 10;
  const x = cw - boxW - margin;
  const y = margin;
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  if (ctx.roundRect) {
    ctx.beginPath();
    ctx.roundRect(x, y, boxW, boxH, 6);
    ctx.fill();
  } else {
    ctx.fillRect(x, y, boxW, boxH);
  }
  ctx.fillStyle = "#fff";
  ctx.fillText(text, x + padX, y + boxH / 2);
  ctx.restore();
}

function getLinesForPreview() {
  // Igual que el backend al renderizar: si el usuario desactivo la letra, no
  // se dibuja ninguna (ni aqui en la vista previa ni en el video final); y
  // las palabras quitadas de la linea de tiempo (sin start/end) tampoco.
  if (state.project.lyrics.enabled === false) return [];
  const words = placedWords();
  const lines = [];
  let cur = [];
  words.forEach((w) => {
    cur.push(w);
    if (w.line_break_after) { lines.push(cur); cur = []; }
  });
  if (cur.length) lines.push(cur);
  return lines;
}

function wrapLineIntoRows(ctx, line, texts, maxWidth) {
  const rows = [];
  let cur = [];
  let curWidth = 0;
  line.forEach((w, i) => {
    const wordW = ctx.measureText(texts[i] + " ").width;
    if (cur.length && curWidth + wordW > maxWidth) {
      rows.push(cur);
      cur = [];
      curWidth = 0;
    }
    cur.push(i);
    curWidth += wordW;
  });
  if (cur.length) rows.push(cur);
  return rows;
}

function drawKaraokeLine(ctx, cw, ch, t) {
  const lines = getLinesForPreview();
  const line = lines.find((l) => t >= l[0].start - 0.3 && t <= l[l.length - 1].end + 0.15);
  if (!line) return;
  const st = state.project.style;
  const refWidth = state.project.export.width || 1080;
  const fontSize = Math.round(st.font_size * (cw / refWidth));
  const weight = st.bold ? "bold" : "normal";
  ctx.font = `${weight} ${fontSize}px ${st.font}, sans-serif`;
  ctx.textBaseline = "middle";

  let anchorY;
  if (st.position === "top") anchorY = ch * 0.12;
  else if (st.position === "center") anchorY = ch * 0.5;
  else anchorY = ch * 0.85;

  const texts = line.map((w) => (st.uppercase ? w.text.toUpperCase() : w.text));
  const maxWidth = cw * 0.9;
  const rows = wrapLineIntoRows(ctx, line, texts, maxWidth);
  const rowHeight = fontSize * 1.25;
  const nRows = rows.length;

  rows.forEach((rowIdxs, rowIdx) => {
    let y;
    if (st.position === "top") y = anchorY + rowIdx * rowHeight;
    else if (st.position === "center") y = anchorY - ((nRows - 1) / 2) * rowHeight + rowIdx * rowHeight;
    else y = anchorY - (nRows - 1 - rowIdx) * rowHeight;

    const widths = rowIdxs.map((i) => ctx.measureText(texts[i] + " ").width);
    const totalWidth = widths.reduce((a, b) => a + b, 0);
    let x = cw / 2 - totalWidth / 2;

    rowIdxs.forEach((i, k) => {
      const w = line[i];
      const text = texts[i];
      const wordW = ctx.measureText(text).width;
      const nextStart = i < line.length - 1 ? line[i + 1].start : w.end;
      const dur = Math.max(0.01, nextStart - w.start);
      const progress = Math.min(1, Math.max(0, (t - w.start) / dur));

      let scale = 1;
      if (st.animation === "pop" && progress > 0 && progress < 0.35) {
        scale = 1 + 0.28 * Math.sin(progress / 0.35 * Math.PI);
      }

      ctx.save();
      ctx.translate(x + wordW / 2, y);
      ctx.scale(scale, scale);
      ctx.translate(-wordW / 2, 0);

      if (st.outline_width > 0) {
        ctx.lineWidth = st.outline_width * (cw / refWidth) * 2;
        ctx.strokeStyle = st.outline_color;
        ctx.strokeText(text, 0, 0);
      }

      if (st.animation === "fill") {
        ctx.fillStyle = st.secondary_color;
        ctx.fillText(text, 0, 0);
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, -fontSize, wordW * progress, fontSize * 2);
        ctx.clip();
        ctx.fillStyle = st.primary_color;
        ctx.fillText(text, 0, 0);
        ctx.restore();
      } else {
        ctx.fillStyle = progress > 0 ? st.primary_color : st.secondary_color;
        ctx.fillText(text, 0, 0);
      }
      ctx.restore();
      x += widths[k];
    });
  });
}

// ---------------- PASO 5: timeline ----------------

function renderTimelineStep() {
  const media = state.project.media;
  $("#timelineVideoPanel").classList.toggle("hidden", media.type !== "video");
  $("#timelineImagesPanel").classList.toggle("hidden", media.type !== "images");

  if (media.type === "video") {
    const v = media.video;
    $("#trimStart").value = v.trim_start;
    $("#trimEnd").value = v.trim_end;
  } else if (media.type === "images") {
    $("#kenBurns").checked = media.ken_burns;
    const list = $("#imagesTimelineList");
    list.innerHTML = "";
    media.images.forEach((im, idx) => {
      const row = document.createElement("div");
      row.className = "imgrow";
      row.dataset.path = im.path;
      row.innerHTML = `
        <img src="${mediaUrl(im.path)}" style="width:60px;height:60px;object-fit:cover;border-radius:6px">
        <span style="width:22px;color:var(--muted)">#${idx + 1}</span>
        <label>Duración (s) <input type="number" min="0.3" step="0.1" class="img-dur" value="${im.duration}"></label>`;
      row.querySelector(".img-dur").addEventListener("change", saveTimelineImages);
      list.appendChild(row);
    });
  }
  $("#filterSelect").value = state.project.filter;
}

async function saveTimelineVideo() {
  const payload = { trim_start: parseFloat($("#trimStart").value) || 0, trim_end: parseFloat($("#trimEnd").value) || 0 };
  state.project = await api(`/api/projects/${state.pid}/timeline`, { method: "PUT", body: payload });
}
$("#trimStart").addEventListener("change", saveTimelineVideo);
$("#trimEnd").addEventListener("change", saveTimelineVideo);

async function saveTimelineImages() {
  const rows = $all("#imagesTimelineList .imgrow");
  const images = rows.map((row) => ({
    path: row.dataset.path,
    duration: parseFloat(row.querySelector(".img-dur").value) || 1,
  }));
  state.project = await api(`/api/projects/${state.pid}/timeline`, { method: "PUT", body: { images } });
}
$("#kenBurns").addEventListener("change", async () => {
  state.project = await api(`/api/projects/${state.pid}/timeline`, { method: "PUT", body: { ken_burns: $("#kenBurns").checked } });
});

function populateFilterSelect() {
  const sel = $("#filterSelect");
  sel.innerHTML = Object.entries(state.presets.filter_presets).map(([k, v]) => `<option value="${k}">${v}</option>`).join("");
  sel.addEventListener("change", async () => {
    state.project = await api(`/api/projects/${state.pid}/filter`, { method: "PUT", body: { filter: sel.value } });
  });
}

$("#btnToExport").addEventListener("click", () => showStep("export"));

// ---------------- PASO 6: export ----------------

function populateExportSelects() {
  const presetOptions = Object.entries(state.presets.export_presets).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join("");
  $("#exportPreset").innerHTML = presetOptions;
  $("#formatPresetSelect").innerHTML = presetOptions;
  $("#exportQuality").innerHTML = Object.entries(state.presets.quality_presets).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join("");

  $("#exportPreset").addEventListener("change", () => onExportChange("export"));
  $("#exportQuality").addEventListener("change", () => onExportChange("export"));
  $("#customWidth").addEventListener("change", () => onExportChange("export"));
  $("#customHeight").addEventListener("change", () => onExportChange("export"));

  $("#formatPresetSelect").addEventListener("change", () => onExportChange("format"));
  $("#formatCustomWidth").addEventListener("change", () => onExportChange("format"));
  $("#formatCustomHeight").addEventListener("change", () => onExportChange("format"));

  $("#shortEnabled").addEventListener("change", onShortChange);
  $("#shortStart").addEventListener("change", onShortChange);
  $("#shortDuration").addEventListener("change", onShortChange);
  $("#shortFadeEnabled").addEventListener("change", onShortChange);
  $("#shortFadeDuration").addEventListener("change", onShortChange);
}

function renderExportStep() {
  syncExportUI();
  const sh = state.project.short;
  $("#shortEnabled").checked = sh.enabled;
  $("#shortOptions").classList.toggle("hidden", !sh.enabled);
  $("#shortStart").value = sh.start;
  $("#shortDuration").value = sh.duration;
  $("#shortFadeEnabled").checked = !!sh.fade_enabled;
  $("#shortFadeDurationWrap").classList.toggle("hidden", !sh.fade_enabled);
  $("#shortFadeDuration").value = sh.fade_duration ?? 1;
  updateShortRangeHint();
}

// Muestra en todo momento, en texto llano, que tramo EXACTO va a recortarse
// (inicio -> fin real) para el short, incluyendo un aviso si lo pedido no
// cabe en la duracion del audio y por tanto se va a recortar mas corto de
// lo solicitado (p.ej. pedir 30s de short con una canción de 20s).
function updateShortRangeHint() {
  const audioDur = state.project.audio ? state.project.audio.duration : 0;
  const start = Math.max(0, parseFloat($("#shortStart").value) || 0);
  const reqDur = Math.max(0, parseFloat($("#shortDuration").value) || 0);
  if (!audioDur) { $("#shortRangeHint").textContent = ""; return; }
  const maxDur = Math.max(0, audioDur - start);
  $("#shortDuration").max = Math.max(1, Math.ceil(maxDur));
  const actualDur = Math.min(reqDur, maxDur);
  const endT = start + actualDur;
  let msg = `El vídeo final dura ${fmtTime(audioDur)}. Con estos valores, el short irá de ${fmtTime(start)} a ${fmtTime(endT)} (${actualDur.toFixed(1)}s reales).`;
  if (reqDur > maxDur + 0.05) {
    msg += ` ⚠ Pediste ${reqDur}s pero desde ese inicio solo quedan ${maxDur.toFixed(1)}s de vídeo — se recortará a ${actualDur.toFixed(1)}s. Reduce el inicio o la duración si quieres más.`;
  }
  $("#shortRangeHint").textContent = msg;
}

// Mantiene sincronizados los dos selectores de formato (el del paso 2 y el
// del paso 6, que comparten el mismo estado) y ajusta el tamaño/aspecto de
// los lienzos de previsualizacion y de ajuste de encuadre.
function syncExportUI() {
  const exp = state.project.export;
  $("#exportPreset").value = exp.preset;
  $("#exportQuality").value = exp.quality;
  $("#customWidth").value = exp.width;
  $("#customHeight").value = exp.height;
  $("#customDims").classList.toggle("hidden", exp.preset !== "custom");

  $("#formatPresetSelect").value = exp.preset;
  $("#formatCustomWidth").value = exp.width;
  $("#formatCustomHeight").value = exp.height;
  $("#formatCustomDims").classList.toggle("hidden", exp.preset !== "custom");

  resizePreviewCanvases();
  relayoutAllFrameAdjusters();
}

function resizePreviewCanvases() {
  const { width, height } = state.project.export;
  const maxDim = 420;
  let cw, ch;
  if (width >= height) { cw = maxDim; ch = Math.round((maxDim * height) / width); }
  else { ch = maxDim; cw = Math.round((maxDim * width) / height); }
  [$("#previewCanvas"), $("#previewCanvasTimeline"), $("#previewCanvasExport")].forEach((canvas) => {
    if (!canvas) return;
    canvas.width = cw;
    canvas.height = ch;
  });
  // Redimensionar el lienzo lo deja en blanco: redibuja de inmediato con lo
  // que ya se tuviera (en vez de esperar a volver a entrar en el paso).
  if (previewCtrlStyle) previewCtrlStyle.refresh();
  if (previewCtrlTimeline) previewCtrlTimeline.refresh();
  if (previewCtrlExport) previewCtrlExport.refresh();
}

async function onExportChange(source) {
  const widthEl = source === "format" ? "#formatCustomWidth" : "#customWidth";
  const heightEl = source === "format" ? "#formatCustomHeight" : "#customHeight";
  const presetEl = source === "format" ? "#formatPresetSelect" : "#exportPreset";
  const payload = {
    preset: $(presetEl).value,
    width: parseInt($(widthEl).value) || 1080,
    height: parseInt($(heightEl).value) || 1920,
    quality: $("#exportQuality").value,
  };
  state.project = await api(`/api/projects/${state.pid}/export`, { method: "PUT", body: payload });
  syncExportUI();
}

async function onShortChange() {
  $("#shortOptions").classList.toggle("hidden", !$("#shortEnabled").checked);
  $("#shortFadeDurationWrap").classList.toggle("hidden", !$("#shortFadeEnabled").checked);
  updateShortRangeHint();
  const payload = {
    enabled: $("#shortEnabled").checked,
    start: parseFloat($("#shortStart").value) || 0,
    duration: parseFloat($("#shortDuration").value) || 30,
    fade_enabled: $("#shortFadeEnabled").checked,
    fade_duration: parseFloat($("#shortFadeDuration").value) || 1,
  };
  state.project = await api(`/api/projects/${state.pid}/short`, { method: "PUT", body: payload });
}

$("#shortStart").addEventListener("input", updateShortRangeHint);
$("#shortDuration").addEventListener("input", updateShortRangeHint);

$("#btnRender").addEventListener("click", async () => {
  $("#renderResult").classList.add("hidden");
  $("#btnRender").disabled = true;
  setStatus("#renderStatus", "Iniciando render...", "working");
  showProgressBar(true);
  setProgressBar(0);
  try {
    const res = await api(`/api/projects/${state.pid}/render`, { method: "POST" });
    pollJob(res.job_id, "#renderStatus", "Renderizando...", onRenderDone, true);
  } catch (e) {
    setStatus("#renderStatus", "Error: " + e.message, "error");
    $("#btnRender").disabled = false;
    showProgressBar(false);
  }
});

function showProgressBar(show) {
  $("#renderProgressWrap").classList.toggle("hidden", !show);
}

function setProgressBar(pct) {
  pct = Math.max(0, Math.min(100, Math.round(pct)));
  $("#renderProgressBar").style.width = `${pct}%`;
  $("#renderProgressPct").textContent = `${pct}%`;
}

function onRenderDone(result) {
  $("#btnRender").disabled = false;
  showProgressBar(false);
  const box = $("#renderResult");
  box.classList.remove("hidden");
  box.innerHTML = "";

  const addVideoBlock = (title, url, filename, noteText) => {
    const wrap = document.createElement("div");
    const h = document.createElement("h3");
    h.textContent = title;
    const video = document.createElement("video");
    video.src = url;
    video.controls = true;
    const dlRow = document.createElement("div");
    dlRow.className = "dl-row";
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.textContent = "⬇ Descargar (carpeta de Descargas)";
    const saveAsBtn = document.createElement("button");
    saveAsBtn.className = "btn secondary";
    saveAsBtn.textContent = "📁 Guardar como...";
    saveAsBtn.addEventListener("click", () => saveVideoAs(url, filename, saveAsBtn));
    dlRow.appendChild(link);
    dlRow.appendChild(saveAsBtn);
    wrap.appendChild(h);
    if (noteText) {
      const note = document.createElement("p");
      note.className = "hint";
      note.style.marginTop = "-4px";
      note.textContent = noteText;
      wrap.appendChild(note);
    }
    wrap.appendChild(video);
    wrap.appendChild(dlRow);
    box.appendChild(wrap);
  };

  addVideoBlock("¡Listo! Vídeo final", result.main_url, "karaoke_video.mp4");
  if (result.short_url) {
    let note = `Recortado de ${fmtTime(result.short_start)} a ${fmtTime(result.short_start + result.short_duration)} (${result.short_duration}s).`;
    if (result.short_adjusted) {
      note += ` Pediste empezar en ${fmtTime(result.short_requested_start)} con ${result.short_requested_duration}s, pero el vídeo final solo dura ${fmtTime(result.main_duration)}, así que se ajustó automáticamente.`;
    }
    addVideoBlock("Short / Reel corto", result.short_url, "karaoke_short.mp4", note);
  }
}

// Permite elegir la carpeta/nombre exacto donde guardar el vídeo (File
// System Access API, disponible en Chrome/Edge). Si el navegador no la
// soporta (p.ej. Safari), recurre a la descarga normal del navegador, que
// el propio usuario puede configurar para preguntar siempre donde guardar.
async function saveVideoAs(url, suggestedName, btn) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Descargando...";
  try {
    const resp = await fetch(url);
    const blob = await resp.blob();
    if (window.showSaveFilePicker) {
      const handle = await window.showSaveFilePicker({
        suggestedName,
        types: [{ description: "Vídeo MP4", accept: { "video/mp4": [".mp4"] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      btn.textContent = "✓ Guardado";
    } else {
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = suggestedName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(blobUrl);
      btn.textContent = "✓ Descargado";
    }
  } catch (e) {
    if (e && e.name === "AbortError") {
      btn.textContent = original; // el usuario cancelo el dialogo de guardado
    } else {
      btn.textContent = "Error al guardar";
      console.error(e);
    }
  } finally {
    setTimeout(() => { btn.disabled = false; btn.textContent = original; }, 2500);
  }
}

// ---------------- helpers ----------------

function setStatus(sel, text, kind) {
  const el = $(sel);
  el.textContent = text;
  el.className = "status" + (kind ? " " + kind : "");
  el.classList.remove("hidden");
}

function fmtTime(s) {
  s = Math.round(s);
  const m = Math.floor(s / 60), sec = s % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function pollJob(jobId, statusSel, workingMsg, onDone, isRender) {
  setStatus(statusSel, workingMsg, "working");
  let misses = 0;
  const interval = setInterval(async () => {
    try {
      const job = await api(`/api/jobs/${jobId}`);
      misses = 0;
      if (job.status === "running") {
        setStatus(statusSel, job.progress || workingMsg, "working");
        if (isRender && typeof job.percent === "number") setProgressBar(job.percent);
      } else if (job.status === "done") {
        clearInterval(interval);
        if (isRender) setProgressBar(100);
        setStatus(statusSel, isRender ? "¡Vídeo generado correctamente!" : "¡Letra detectada correctamente!", "ok");
        onDone(job.result);
      } else if (job.status === "error") {
        clearInterval(interval);
        setStatus(statusSel, "Error: " + job.error, "error");
        if (isRender) { $("#btnRender").disabled = false; showProgressBar(false); }
      }
    } catch (e) {
      // un fallo puntual de red no debe cortar el sondeo del progreso;
      // solo abandonamos si fallan varias veces seguidas.
      misses += 1;
      if (misses >= 5) {
        clearInterval(interval);
        setStatus(statusSel, "Error consultando estado: " + e.message, "error");
        if (isRender) { $("#btnRender").disabled = false; showProgressBar(false); }
      }
    }
  }, 1500);
}

init();
