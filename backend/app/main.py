import io
import json
import zipfile
from pathlib import Path

from fastapi import FastAPI, Request, UploadFile, File, Form, HTTPException
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import storage, transcribe, lyrics, lyrics_align, jobs, render, ffmpeg_utils
from .range_response import range_file_response

app = FastAPI(title="Karaoke Video Maker")

FRONTEND_DIR = Path(__file__).resolve().parent.parent.parent / "frontend"

ALLOWED_AUDIO_EXT = {".mp3", ".wav", ".m4a", ".aac", ".ogg"}
ALLOWED_VIDEO_EXT = {".mp4", ".mov", ".m4v", ".webm", ".avi", ".mkv"}
ALLOWED_IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}

AVAILABLE_FONTS = [
    "Arial", "Helvetica Neue", "Impact", "Georgia", "Futura",
    "Avenir Next", "Marker Felt", "Chalkboard SE", "Courier New", "Verdana",
]


def err(msg, code=400):
    raise HTTPException(status_code=code, detail=msg)


# ---------- presets / meta ----------

@app.get("/api/presets")
def get_presets():
    return {
        "export_presets": storage.EXPORT_PRESETS,
        "filter_presets": storage.FILTER_PRESETS,
        "quality_presets": storage.QUALITY_PRESETS,
        "fonts": AVAILABLE_FONTS,
        "default_style": storage.DEFAULT_STYLE,
    }


# ---------- project lifecycle ----------

@app.post("/api/projects")
def create_project():
    return storage.new_project()


@app.get("/api/projects/{pid}")
def get_project(pid: str):
    p = storage.load_project(pid)
    if not p:
        err("Proyecto no encontrado", 404)
    return p


# ---------- guardar / cargar proyecto como archivo portatil ----------
# Permite retomar el trabajo mas adelante: el .kvmproj es un zip con el JSON
# del proyecto mas una copia de los archivos subidos (audio, video/fotos),
# para que no dependa de que sigan existiendo en data/uploads de este server.

@app.get("/api/projects/{pid}/save-bundle")
def save_bundle(pid: str):
    project = storage.load_project(pid)
    if not project:
        err("Proyecto no encontrado", 404)
    updir = storage.project_upload_dir(pid)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("project.json", json.dumps(project, indent=2, ensure_ascii=False))
        if updir.exists():
            for f in sorted(updir.iterdir()):
                if f.is_file():
                    zf.write(f, f"uploads/{f.name}")
    buf.seek(0)
    return StreamingResponse(
        buf, media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="proyecto.kvmproj"'},
    )


@app.post("/api/projects/load-bundle")
async def load_bundle(file: UploadFile = File(...)):
    content = await file.read()
    try:
        zf = zipfile.ZipFile(io.BytesIO(content))
    except zipfile.BadZipFile:
        err("El archivo no es un proyecto valido (.kvmproj)")
    try:
        project = json.loads(zf.read("project.json").decode("utf-8"))
    except KeyError:
        err("El archivo no contiene un proyecto valido")

    fresh = storage.new_project()
    new_pid = fresh["id"]
    updir = storage.project_upload_dir(new_pid)
    for name in zf.namelist():
        if name.startswith("uploads/") and not name.endswith("/"):
            (updir / Path(name).name).write_bytes(zf.read(name))

    def relocate(path_str):
        return str(updir / Path(path_str).name) if path_str else path_str

    if project.get("audio"):
        project["audio"]["path"] = relocate(project["audio"].get("path"))
    media = project.get("media") or {}
    if media.get("video"):
        media["video"]["path"] = relocate(media["video"].get("path"))
    for im in media.get("images", []) or []:
        im["path"] = relocate(im.get("path"))

    project["id"] = new_pid
    project["created_at"] = fresh["created_at"]
    project["jobs"] = {}
    storage.save_project(project)
    return project


# ---------- audio upload + transcription ----------

def _transcribe_job(pid, job_id=None, quality="fast"):
    project = storage.load_project(pid)
    msg = "Transcribiendo audio con el modelo preciso (más lento, puede tardar varios minutos)..." \
        if quality == "precise" else "Transcribiendo audio (puede tardar segun la duracion)..."
    jobs.set_progress(job_id, msg)
    words, lang = transcribe.transcribe_audio(project["audio"]["path"], quality=quality)
    flat = lyrics.words_to_lines(words)
    project = storage.load_project(pid)
    project["lyrics"]["words"] = flat
    project["lyrics"]["status"] = "done"
    project["lyrics"]["language"] = lang
    project["lyrics"]["error"] = None
    project["lyrics"]["quality"] = quality
    storage.save_project(project)
    return {"count": len(flat), "language": lang}


@app.post("/api/projects/{pid}/audio")
async def upload_audio(pid: str, file: UploadFile = File(...), quality: str = Form("fast")):
    project = storage.load_project(pid)
    if not project:
        err("Proyecto no encontrado", 404)
    ext = Path(file.filename).suffix.lower()
    if ext not in ALLOWED_AUDIO_EXT:
        err(f"Formato de audio no soportado: {ext}")
    dest = storage.project_upload_dir(pid) / f"audio{ext}"
    content = await file.read()
    dest.write_bytes(content)

    duration = ffmpeg_utils.media_duration(dest)
    if duration <= 0:
        err("No se pudo leer el audio subido")

    if quality not in transcribe.MODEL_SIZES:
        quality = "fast"

    project["audio"] = {"filename": file.filename, "path": str(dest), "duration": duration}
    project["lyrics"] = {"words": [], "status": "processing", "language": None, "error": None, "quality": quality}
    storage.save_project(project)

    job_id = jobs.start_job("transcribe", _transcribe_job, pid, pass_job_id=True, quality=quality)
    project["jobs"]["transcribe"] = job_id
    storage.save_project(project)
    return {"project": project, "job_id": job_id}


@app.post("/api/projects/{pid}/retranscribe")
def retranscribe(pid: str, quality: str = "fast"):
    project = storage.load_project(pid)
    if not project or not project.get("audio"):
        err("No hay audio subido todavia")
    if quality not in transcribe.MODEL_SIZES:
        quality = "fast"
    project["lyrics"]["status"] = "processing"
    project["lyrics"]["quality"] = quality
    storage.save_project(project)
    job_id = jobs.start_job("transcribe", _transcribe_job, pid, pass_job_id=True, quality=quality)
    project["jobs"]["transcribe"] = job_id
    storage.save_project(project)
    return {"job_id": job_id}


# ---------- media upload (video or images) ----------

@app.post("/api/projects/{pid}/media")
async def upload_media(pid: str, kind: str = Form(...), files: list[UploadFile] = File(...)):
    project = storage.load_project(pid)
    if not project:
        err("Proyecto no encontrado", 404)
    if kind not in ("video", "images"):
        err("kind debe ser 'video' o 'images'")

    updir = storage.project_upload_dir(pid)

    if kind == "video":
        f = files[0]
        ext = Path(f.filename).suffix.lower()
        if ext not in ALLOWED_VIDEO_EXT:
            err(f"Formato de video no soportado: {ext}")
        dest = updir / f"video{ext}"
        dest.write_bytes(await f.read())
        dur = ffmpeg_utils.media_duration(dest)
        if dur <= 0:
            err("No se pudo leer el video subido")
        project["media"] = {
            "type": "video",
            "video": {
                "path": str(dest), "duration": dur, "trim_start": 0, "trim_end": dur,
                "focus_x": 0.5, "focus_y": 0.5, "zoom": 1.0,
            },
            "images": [],
            "ken_burns": False,
        }
    else:
        images = []
        for i, f in enumerate(files):
            ext = Path(f.filename).suffix.lower()
            if ext not in ALLOWED_IMAGE_EXT:
                err(f"Formato de imagen no soportado: {ext}")
            dest = updir / f"img_{i}{ext}"
            dest.write_bytes(await f.read())
            images.append({"path": str(dest), "duration": 3.0, "focus_x": 0.5, "focus_y": 0.5, "zoom": 1.0})
        if not images:
            err("No se recibieron imagenes")
        project["media"] = {"type": "images", "video": None, "images": images, "ken_burns": True}

    storage.save_project(project)
    return project


# ---------- lyrics editing ----------

def _opt_float(v):
    """Como float(), pero None/''/ausente se queda en None en vez de dar
    error: representa una palabra detectada que todavia no tiene un hueco
    asignado en la linea de tiempo (se quito de ahi sin borrarla de la
    letra ni del banco de palabras)."""
    if v is None or v == "":
        return None
    return float(v)


@app.put("/api/projects/{pid}/lyrics")
async def update_lyrics(pid: str, payload: dict):
    project = storage.load_project(pid)
    if not project:
        err("Proyecto no encontrado", 404)
    words = payload.get("words")
    if not isinstance(words, list):
        err("Formato invalido: se espera 'words' como lista")
    clean = []
    for i, w in enumerate(words):
        try:
            start = _opt_float(w.get("start"))
            end = _opt_float(w.get("end"))
            clean.append({
                "id": i,
                "text": str(w["text"]),
                "start": start,
                "end": end,
                "line_break_after": bool(w.get("line_break_after", False)),
            })
        except (KeyError, TypeError, ValueError):
            err(f"Palabra invalida en indice {i}")
    project["lyrics"]["words"] = clean
    project["lyrics"]["status"] = "done"
    storage.save_project(project)
    return project


@app.put("/api/projects/{pid}/lyrics/enabled")
async def update_lyrics_enabled(pid: str, payload: dict):
    """Activa/desactiva los subtitulos de karaoke para este proyecto. Al
    desactivarlos, la previsualizacion y el video final se generan sin
    letra, aunque siga habiendo palabras detectadas/editadas guardadas (por
    si el usuario cambia de opinion mas adelante)."""
    project = storage.load_project(pid)
    if not project:
        err("Proyecto no encontrado", 404)
    project["lyrics"]["enabled"] = bool(payload.get("enabled", True))
    storage.save_project(project)
    return project


@app.put("/api/projects/{pid}/lyrics/shift")
async def shift_lyrics(pid: str, payload: dict):
    """Desplaza TODOS los tiempos de la letra por un offset constante (en
    segundos, puede ser negativo). Util cuando la letra detectada por la IA
    va sistematicamente adelantada o retrasada respecto al audio real."""
    project = storage.load_project(pid)
    if not project:
        err("Proyecto no encontrado", 404)
    try:
        offset = float(payload.get("offset", 0))
    except (TypeError, ValueError):
        err("offset invalido")
    words = project["lyrics"].get("words", [])
    shifted = []
    for w in words:
        if w.get("start") is None or w.get("end") is None:
            shifted.append(dict(w))  # palabra sin hueco en la linea de tiempo: no hay nada que desplazar
            continue
        start = max(0.0, round(w["start"] + offset, 3))
        end = max(start + 0.01, round(w["end"] + offset, 3))
        shifted.append({**w, "start": start, "end": end})
    project["lyrics"]["words"] = shifted
    storage.save_project(project)
    return project


def _import_and_align_lyrics(project, raw_text):
    if not project["lyrics"].get("words"):
        err("Primero sube el audio y espera a que se detecte la letra, antes de importar texto")
    txt_lines = lyrics_align.parse_txt_lyrics(raw_text)
    if not txt_lines:
        err("El texto esta vacio o no contiene palabras reconocibles")
    aligned = lyrics_align.align_with_whisper(project["lyrics"]["words"], txt_lines)
    if not aligned:
        err("No se pudo alinear el texto con el audio")
    project["lyrics"]["words"] = aligned
    project["lyrics"]["status"] = "done"
    storage.save_project(project)
    return {"project": project, "word_count": len(aligned)}


@app.post("/api/projects/{pid}/lyrics/import-txt")
async def import_lyrics_txt(pid: str, file: UploadFile = File(...)):
    project = storage.load_project(pid)
    if not project:
        err("Proyecto no encontrado", 404)
    raw = (await file.read()).decode("utf-8", errors="ignore")
    return _import_and_align_lyrics(project, raw)


@app.post("/api/projects/{pid}/lyrics/import-text")
async def import_lyrics_text(pid: str, payload: dict):
    project = storage.load_project(pid)
    if not project:
        err("Proyecto no encontrado", 404)
    raw = payload.get("text", "")
    if not isinstance(raw, str):
        err("Formato invalido: se espera 'text' como cadena")
    return _import_and_align_lyrics(project, raw)


# ---------- style / filter / timeline / export / short ----------

@app.put("/api/projects/{pid}/style")
async def update_style(pid: str, payload: dict):
    project = storage.load_project(pid)
    if not project:
        err("Proyecto no encontrado", 404)
    project["style"].update(payload)
    storage.save_project(project)
    return project


@app.put("/api/projects/{pid}/filter")
async def update_filter(pid: str, payload: dict):
    project = storage.load_project(pid)
    if not project:
        err("Proyecto no encontrado", 404)
    name = payload.get("filter", "none")
    if name not in storage.FILTER_PRESETS:
        err("Filtro no reconocido")
    project["filter"] = name
    storage.save_project(project)
    return project


@app.put("/api/projects/{pid}/timeline")
async def update_timeline(pid: str, payload: dict):
    project = storage.load_project(pid)
    if not project:
        err("Proyecto no encontrado", 404)
    media = project["media"]

    def clamp01(v, default=0.5):
        try:
            return min(1.0, max(0.0, float(v)))
        except (TypeError, ValueError):
            return default

    def clamp_zoom(v, default=1.0):
        try:
            return min(4.0, max(0.3, float(v)))
        except (TypeError, ValueError):
            return default

    if media["type"] == "video":
        if "trim_start" in payload:
            media["video"]["trim_start"] = max(0.0, float(payload["trim_start"]))
        if "trim_end" in payload:
            media["video"]["trim_end"] = float(payload["trim_end"])
        if "focus_x" in payload:
            media["video"]["focus_x"] = clamp01(payload["focus_x"])
        if "focus_y" in payload:
            media["video"]["focus_y"] = clamp01(payload["focus_y"])
        if "zoom" in payload:
            media["video"]["zoom"] = clamp_zoom(payload["zoom"])
    elif media["type"] == "images":
        if "images" in payload:
            existing = {im["path"]: im for im in media["images"]}
            new_list = []
            for im in payload["images"]:
                path = im.get("path")
                if path not in existing:
                    err("Ruta de imagen no valida")
                prev = existing[path]
                new_list.append({
                    "path": path,
                    "duration": max(0.3, float(im.get("duration", prev.get("duration", 3.0)))),
                    "focus_x": clamp01(im.get("focus_x", prev.get("focus_x", 0.5))),
                    "focus_y": clamp01(im.get("focus_y", prev.get("focus_y", 0.5))),
                    "zoom": clamp_zoom(im.get("zoom", prev.get("zoom", 1.0))),
                })
            media["images"] = new_list
        if "ken_burns" in payload:
            media["ken_burns"] = bool(payload["ken_burns"])
    else:
        err("No hay medio definido todavia")
    storage.save_project(project)
    return project


@app.put("/api/projects/{pid}/export")
async def update_export(pid: str, payload: dict):
    project = storage.load_project(pid)
    if not project:
        err("Proyecto no encontrado", 404)
    preset = payload.get("preset", project["export"]["preset"])
    if preset not in storage.EXPORT_PRESETS:
        err("Preset de exportacion no reconocido")
    project["export"]["preset"] = preset
    if preset == "custom":
        project["export"]["width"] = int(payload.get("width", project["export"]["width"]))
        project["export"]["height"] = int(payload.get("height", project["export"]["height"]))
    else:
        dims = storage.EXPORT_PRESETS[preset]
        project["export"]["width"] = dims["width"]
        project["export"]["height"] = dims["height"]
    quality = payload.get("quality", project["export"]["quality"])
    if quality not in storage.QUALITY_PRESETS:
        err("Calidad no reconocida")
    project["export"]["quality"] = quality
    storage.save_project(project)
    return project


@app.put("/api/projects/{pid}/short")
async def update_short(pid: str, payload: dict):
    project = storage.load_project(pid)
    if not project:
        err("Proyecto no encontrado", 404)
    project["short"]["enabled"] = bool(payload.get("enabled", project["short"]["enabled"]))
    project["short"]["duration"] = float(payload.get("duration", project["short"]["duration"]))
    project["short"]["start"] = float(payload.get("start", project["short"]["start"]))
    project["short"]["fade_enabled"] = bool(payload.get("fade_enabled", project["short"].get("fade_enabled", False)))
    project["short"]["fade_duration"] = float(payload.get("fade_duration", project["short"].get("fade_duration", 1.0)))
    storage.save_project(project)
    return project


# ---------- render ----------

@app.post("/api/projects/{pid}/render")
def start_render(pid: str):
    project = storage.load_project(pid)
    if not project:
        err("Proyecto no encontrado", 404)
    job_id = jobs.start_job("render", render.run_render, pid, pass_job_id=True)
    project["jobs"]["render"] = job_id
    storage.save_project(project)
    return {"job_id": job_id}


@app.get("/api/jobs/{job_id}")
def job_status(job_id: str):
    j = jobs.get_job(job_id)
    if not j:
        err("Job no encontrado", 404)
    return j


# ---------- downloads & media previews ----------

@app.get("/api/download/{pid}/{filename}")
def download(request: Request, pid: str, filename: str):
    path = storage.project_output_dir(pid) / filename
    if not path.exists():
        err("Archivo no encontrado", 404)
    return range_file_response(request, path, filename=filename, download=True)


@app.get("/media/{pid}/{filename}")
def media_preview(request: Request, pid: str, filename: str):
    path = storage.project_upload_dir(pid) / filename
    if not path.exists():
        err("Archivo no encontrado", 404)
    return range_file_response(request, path)


if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
