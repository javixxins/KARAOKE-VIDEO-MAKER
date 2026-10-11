import shutil
from pathlib import Path

from . import storage, ffmpeg_utils, ass_builder, lyrics, jobs


def resolve_export_dims(export_cfg):
    preset = export_cfg.get("preset", "instagram_reel")
    if preset == "custom":
        w = int(export_cfg.get("width", 1080))
        h = int(export_cfg.get("height", 1920))
    else:
        p = storage.EXPORT_PRESETS.get(preset, storage.EXPORT_PRESETS["instagram_reel"])
        w, h = p["width"], p["height"]
    w = w if w % 2 == 0 else w + 1
    h = h if h % 2 == 0 else h + 1
    return w, h


def run_render(pid, job_id=None):
    project = storage.load_project(pid)
    if not project:
        raise RuntimeError("Proyecto no encontrado")
    if not project.get("audio"):
        raise RuntimeError("Falta subir el audio")
    if not project["media"].get("type"):
        raise RuntimeError("Falta subir video o imagenes")

    # La letra es opcional: si el usuario la desactivo en el paso 3 (porque
    # no quiere subtitulos en este video), el video se genera igualmente,
    # sin letra.
    lyrics_enabled = project["lyrics"].get("enabled", True)
    placed_words = []
    if lyrics_enabled:
        if not project["lyrics"].get("words"):
            raise RuntimeError("No hay letra para mostrar en el karaoke (o desactiva la letra en el paso 3 si no quieres subtitulos)")
        # las palabras que el usuario haya quitado de la linea de tiempo (pero
        # no borrado de la letra) no tienen start/end: se excluyen del
        # karaoke, pero siguen disponibles en el banco de palabras y la tabla.
        placed_words = [w for w in project["lyrics"]["words"] if w.get("start") is not None and w.get("end") is not None]
        if not placed_words:
            raise RuntimeError("No hay ninguna palabra colocada en la linea de tiempo para mostrar en el karaoke (o desactiva la letra en el paso 3 si no quieres subtitulos)")

    width, height = resolve_export_dims(project["export"])
    audio_path = project["audio"]["path"]
    audio_duration = project["audio"].get("duration") or ffmpeg_utils.media_duration(audio_path)

    out_dir = storage.project_output_dir(pid)
    work_dir = out_dir / "work"
    if work_dir.exists():
        shutil.rmtree(work_dir)
    work_dir.mkdir(parents=True, exist_ok=True)

    short_enabled = bool(project.get("short", {}).get("enabled"))
    # Reparto aproximado del progreso global entre las fases, para que la
    # barra de progreso avance de forma continua y realista en vez de
    # quedarse aparentemente "colgada" mientras ffmpeg trabaja.
    W_BASE, W_FINAL, W_SHORT = (40, 50, 10) if short_enabled else (45, 55, 0)

    def progress(stage_start, stage_weight):
        def cb(frac):
            if job_id:
                jobs.set_progress(job_id, percent=stage_start + frac * stage_weight)
        return cb

    if job_id:
        jobs.set_progress(job_id, "Preparando video base...", percent=0)
    base_video = ffmpeg_utils.build_base_video(
        project, work_dir, width, height, audio_duration,
        progress_cb=progress(0, W_BASE) if job_id else None,
    )

    ass_path = None
    if lyrics_enabled:
        if job_id:
            jobs.set_progress(job_id, "Generando subtitulos karaoke...", percent=W_BASE)
        lines = lyrics.group_into_lines(placed_words)
        ass_path = work_dir / "karaoke.ass"
        ass_builder.build_ass(lines, project["style"], width, height, ass_path)

    quality = storage.QUALITY_PRESETS.get(project["export"].get("quality", "media"), storage.QUALITY_PRESETS["media"])

    if job_id:
        jobs.set_progress(job_id, "Renderizando video final (esto puede tardar)...", percent=W_BASE)
    out_main = out_dir / "main.mp4"
    ffmpeg_utils.render_final(
        base_video, audio_path, ass_path, project.get("filter", "none"), quality, out_main,
        audio_duration=audio_duration,
        progress_cb=progress(W_BASE, W_FINAL) if job_id else None,
    )

    result = {"main_url": f"/api/download/{pid}/main.mp4", "main_file": "main.mp4"}

    short_cfg = project.get("short", {})
    if short_cfg.get("enabled"):
        if job_id:
            jobs.set_progress(job_id, "Generando short...", percent=W_BASE + W_FINAL)
        requested_start = max(0.0, float(short_cfg.get("start", 0)))
        requested_duration = float(short_cfg.get("duration", 30))
        final_dur = ffmpeg_utils.media_duration(out_main)
        # Si el inicio pedido ya esta mas alla (o casi) del final del video,
        # lo recolocamos para que siempre quede al menos 1s de short, en vez
        # de producir un clip casi vacio.
        start = min(requested_start, max(0.0, final_dur - 1))
        dur = max(1.0, min(requested_duration, final_dur - start))
        fade_duration = float(short_cfg.get("fade_duration", 1.0)) if short_cfg.get("fade_enabled") else 0
        out_short = out_dir / "short.mp4"
        ffmpeg_utils.extract_short(
            out_main, start, dur, quality, out_short,
            progress_cb=progress(W_BASE + W_FINAL, W_SHORT) if job_id else None,
            fade_duration=fade_duration,
        )
        result["short_url"] = f"/api/download/{pid}/short.mp4"
        result["short_file"] = "short.mp4"
        result["short_start"] = round(start, 2)
        result["short_duration"] = round(dur, 2)
        result["short_adjusted"] = (
            abs(start - requested_start) > 0.05 or abs(dur - requested_duration) > 0.05
        )
        result["short_requested_start"] = round(requested_start, 2)
        result["short_requested_duration"] = round(requested_duration, 2)
        result["main_duration"] = round(final_dur, 2)

    shutil.rmtree(work_dir, ignore_errors=True)

    if job_id:
        jobs.set_progress(job_id, "Completado", percent=100)
    return result
