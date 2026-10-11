import json
import subprocess
from pathlib import Path

FPS = 30
DEFAULT_TIMEOUT = 1800  # 30 min de margen de seguridad por llamada a ffmpeg


class FFmpegError(RuntimeError):
    pass


def run(cmd, progress_cb=None, total_duration=None, timeout=DEFAULT_TIMEOUT):
    """Ejecuta ffmpeg. Si se da progress_cb (fraccion 0..1) y total_duration,
    se añade `-progress` para leer el avance real en vivo en vez de esperar
    a que termine a ciegas. `stdin=DEVNULL` evita que un ffmpeg que por
    error pidiera confirmacion por teclado se quede colgado para siempre;
    `timeout` es una red de seguridad para que un cuelgue real falle con un
    error visible en vez de bloquear la app indefinidamente."""
    cmd = [str(c) for c in cmd]

    if progress_cb and total_duration and total_duration > 0:
        cmd = cmd + ["-progress", "pipe:1", "-nostats"]
        proc = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL, text=True, bufsize=1,
        )
        tail = []
        try:
            for line in proc.stdout:
                tail.append(line)
                if len(tail) > 200:
                    tail.pop(0)
                line = line.strip()
                if line.startswith("out_time_ms="):
                    try:
                        micros = int(line.split("=", 1)[1])
                        frac = max(0.0, min(1.0, (micros / 1_000_000) / total_duration))
                        progress_cb(frac)
                    except ValueError:
                        pass
            proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
            raise FFmpegError(f"ffmpeg no respondio a tiempo (timeout de {timeout}s): {' '.join(cmd[:4])}...")
        if proc.returncode != 0:
            raise FFmpegError(f"ffmpeg fallo ({' '.join(cmd[:3])}...):\n{''.join(tail[-40:])}")
        return "".join(tail)

    try:
        proc = subprocess.run(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL, text=True, timeout=timeout,
        )
    except subprocess.TimeoutExpired as e:
        raise FFmpegError(f"ffmpeg no respondio a tiempo (timeout de {timeout}s): {' '.join(cmd[:4])}...")
    if proc.returncode != 0:
        tail = "\n".join(proc.stdout.splitlines()[-40:])
        raise FFmpegError(f"ffmpeg fallo ({' '.join(cmd[:3])}...):\n{tail}")
    return proc.stdout


def probe(path):
    cmd = [
        "ffprobe", "-v", "error", "-print_format", "json",
        "-show_format", "-show_streams", str(path),
    ]
    out = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          stdin=subprocess.DEVNULL, text=True, timeout=60)
    data = json.loads(out.stdout or "{}")
    return data


def media_duration(path):
    data = probe(path)
    fmt = data.get("format", {})
    if "duration" in fmt:
        return float(fmt["duration"])
    for s in data.get("streams", []):
        if "duration" in s:
            return float(s["duration"])
    return 0.0


def escape_filter_path(path):
    p = str(path).replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")
    return p


def fit_frame_filter(width, height, zoom=1.0, focus_x=0.5, focus_y=0.5):
    """Encaja el contenido en el lienzo WxH de forma ajustable:
    - zoom=1.0: se ve todo el contenido sin recortar (puede dejar barras
      negras si el aspecto no coincide con el del lienzo).
    - zoom>1: lo agranda (recorta el sobrante que no entra en el lienzo).
    - zoom<1: lo reduce, dejando mas margen/barras alrededor.
    focus_x/focus_y (0..1) ancla el contenido dentro del lienzo (0.5,0.5 =
    centrado). Es el mismo filtro para vídeo e imagenes."""
    zoom = max(0.3, min(4.0, float(zoom)))
    focus_x = min(1.0, max(0.0, float(focus_x)))
    focus_y = min(1.0, max(0.0, float(focus_y)))
    zw = max(2, int(round(width * zoom)))
    zh = max(2, int(round(height * zoom)))
    zw += zw % 2
    zh += zh % 2
    pad_x = f"(ow-iw)*{focus_x:.4f}"
    pad_y = f"(oh-ih)*{focus_y:.4f}"
    crop_x = f"(in_w-{width})*{focus_x:.4f}"
    crop_y = f"(in_h-{height})*{focus_y:.4f}"
    return (
        f"scale={zw}:{zh}:force_original_aspect_ratio=decrease,"
        f"pad=max({width}\\,iw):max({height}\\,ih):{pad_x}:{pad_y}:color=black,"
        f"crop={width}:{height}:x='{crop_x}':y='{crop_y}'"
    )


def color_filter_chain(name):
    chains = {
        "none": None,
        "vivid": "eq=contrast=1.15:saturation=1.45:brightness=0.02",
        "warm": "colorbalance=rs=0.10:gs=0.02:bs=-0.10,eq=saturation=1.1",
        "cool": "colorbalance=rs=-0.08:bs=0.10,eq=saturation=1.05",
        "grayscale": "hue=s=0",
        "sepia": "colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131:0",
        "vintage": "eq=contrast=0.92:saturation=0.72:brightness=-0.02,vignette=PI/4.3",
        "vignette": "vignette=PI/4",
    }
    return chains.get(name)


def build_video_segment(out_path, width, height, duration,
                         source_video=None, trim_start=0, source_image=None,
                         ken_burns=False, focus_x=0.5, focus_y=0.5, zoom=1.0,
                         progress_cb=None):
    """Crea un segmento mp4 mudo de `duration` segundos a resolucion WxH."""
    out_path = str(out_path)
    if source_video:
        src_dur = media_duration(source_video)
        needs_loop = src_dur > 0 and (src_dur - trim_start) < duration
        vf = f"{fit_frame_filter(width, height, zoom, focus_x, focus_y)},format=yuv420p,setsar=1,fps={FPS}"
        cmd = ["ffmpeg", "-y"]
        if needs_loop:
            cmd += ["-stream_loop", "-1"]
        cmd += ["-ss", str(trim_start), "-i", str(source_video)]
        cmd += ["-t", str(duration), "-vf", vf, "-an", "-c:v", "libx264", "-preset", "veryfast",
                "-crf", "20", "-pix_fmt", "yuv420p", out_path]
        run(cmd, progress_cb=progress_cb, total_duration=duration)
        return out_path

    if source_image:
        if ken_burns:
            # IMPORTANTE sobre zoompan: genera "d" fotogramas de SALIDA por
            # CADA fotograma de ENTRADA que recibe (no son fotogramas de
            # salida en total). Si la entrada llega a un framerate bajo para
            # ahorrar trabajo (ver mas abajo) pero "d" se calcula como si
            # fuera "duracion*fps total", el resultado se MULTIPLICA por el
            # numero de fotogramas de entrada que lleguen durante `duration`
            # segundos, produciendo un segmento muchas veces mas largo de lo
            # pedido (p.ej. 6.7s pedidos -> 87s reales). d debe ser siempre
            # FPS/input_framerate (independiente de la duracion).
            input_fps = 6
            d = max(1, FPS // input_fps)
            # El encuadre (foco/zoom) ya se aplica aqui mismo, sobre el
            # tamaño final (no uno ampliado): zoompan solo anima un zoom
            # extra pequeño (hasta 1.15x) sobre ese fotograma ya encuadrado.
            vf = (
                f"{fit_frame_filter(width, height, zoom, focus_x, focus_y)},"
                f"zoompan=z='min(zoom+0.0012,1.15)':d={d}:"
                f"x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s={width}x{height}:fps={FPS},"
                f"format=yuv420p,setsar=1"
            )
        else:
            input_fps = 2
            vf = f"{fit_frame_filter(width, height, zoom, focus_x, focus_y)},format=yuv420p,setsar=1,fps={FPS}"
        # framerate bajo en la entrada: la imagen es estatica, un framerate alto
        # por defecto (25fps) obliga a re-escalar la misma imagen docenas de
        # veces por segundo sin necesidad, siendo el principal cuello de botella.
        cmd = [
            "ffmpeg", "-y", "-loop", "1", "-framerate", str(input_fps), "-t", str(duration), "-i", str(source_image),
            "-vf", vf, "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
            "-pix_fmt", "yuv420p", out_path,
        ]
        run(cmd, progress_cb=progress_cb, total_duration=duration)
        return out_path

    raise FFmpegError("No se proporciono video ni imagen para el segmento")


def concat_segments(segment_paths, out_path, work_dir):
    list_file = Path(work_dir) / "concat_list.txt"
    lines = [f"file '{Path(p).resolve()}'" for p in segment_paths]
    list_file.write_text("\n".join(lines), encoding="utf-8")
    cmd = ["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(list_file),
           "-c", "copy", str(out_path)]
    run(cmd, timeout=300)
    return out_path


def build_base_video(project, work_dir, width, height, audio_duration, progress_cb=None):
    """progress_cb (opcional): recibe una fraccion 0..1 del avance de ESTA
    fase (preparar el video base), ya repartida proporcionalmente entre los
    distintos segmentos (uno por imagen, o el unico de video)."""
    media = project["media"]
    work_dir = Path(work_dir)
    segments = []

    if media["type"] == "video":
        v = media["video"]
        trim_start = v.get("trim_start", 0)
        seg_path = work_dir / "seg_video.mp4"
        build_video_segment(seg_path, width, height, audio_duration,
                             source_video=v["path"], trim_start=trim_start,
                             focus_x=v.get("focus_x", 0.5), focus_y=v.get("focus_y", 0.5),
                             zoom=v.get("zoom", 1.0), progress_cb=progress_cb)
        segments.append(seg_path)

    elif media["type"] == "images":
        images = media["images"]
        if not images:
            raise FFmpegError("No hay imagenes en el proyecto")
        total_set = sum(im.get("duration", 3.0) for im in images)
        scale_factor = (audio_duration / total_set) if total_set > 0 else 1.0
        ken_burns = media.get("ken_burns", True)
        remaining = audio_duration
        n = len(images)
        durations = []
        for idx, im in enumerate(images):
            if idx == n - 1:
                durations.append(max(0.2, remaining))
            else:
                d = max(0.2, im.get("duration", 3.0) * scale_factor)
                durations.append(d)
                remaining -= d
        total_dur_for_progress = sum(durations) or 1.0
        done_so_far = 0.0
        for idx, (im, dur) in enumerate(zip(images, durations)):
            seg_path = work_dir / f"seg_img_{idx}.mp4"

            def seg_progress(frac, _done=done_so_far, _dur=dur, _total=total_dur_for_progress):
                if progress_cb:
                    progress_cb((_done + frac * _dur) / _total)

            build_video_segment(seg_path, width, height, dur,
                                 source_image=im["path"], ken_burns=ken_burns,
                                 focus_x=im.get("focus_x", 0.5), focus_y=im.get("focus_y", 0.5),
                                 zoom=im.get("zoom", 1.0),
                                 progress_cb=seg_progress if progress_cb else None)
            done_so_far += dur
            segments.append(seg_path)
    else:
        raise FFmpegError("Proyecto sin medio (video/imagenes) definido")

    if len(segments) == 1:
        return segments[0]
    base_path = work_dir / "base.mp4"
    concat_segments(segments, base_path, work_dir)
    return base_path


def render_final(base_video, audio_path, ass_path, filter_name, quality, out_path,
                  audio_duration=None, progress_cb=None):
    # ass_path es opcional: si el usuario desactivo la letra, se renderiza
    # igual pero sin quemar subtitulos.
    filt = color_filter_chain(filter_name)
    sub_filter = f"subtitles='{escape_filter_path(ass_path)}'" if ass_path else None
    vf_parts = [p for p in (filt, sub_filter) if p]

    crf = quality.get("crf", 21)
    preset = quality.get("preset", "medium")

    cmd = ["ffmpeg", "-y", "-i", str(base_video), "-i", str(audio_path)]
    if vf_parts:
        vf = ",".join(vf_parts)
        cmd += ["-filter_complex", f"[0:v]{vf}[v]", "-map", "[v]", "-map", "1:a"]
    else:
        cmd += ["-map", "0:v", "-map", "1:a"]
    cmd += [
        "-c:v", "libx264", "-crf", str(crf), "-preset", preset,
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k",
        "-shortest",
        "-movflags", "+faststart",
        str(out_path),
    ]
    run(cmd, progress_cb=progress_cb, total_duration=audio_duration)
    return out_path


def extract_short(main_output, start, duration, quality, out_path, progress_cb=None, fade_duration=0):
    crf = quality.get("crf", 21)
    preset = quality.get("preset", "medium")
    cmd = [
        "ffmpeg", "-y", "-ss", str(start), "-i", str(main_output), "-t", str(duration),
        "-c:v", "libx264", "-crf", str(crf), "-preset", preset, "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart",
    ]
    if fade_duration > 0:
        # No mas de la mitad del clip por fundido, para que el fade-in y el
        # fade-out no se superpongan en un short muy corto.
        fd = min(fade_duration, duration / 2)
        fade_out_st = max(0, duration - fd)
        cmd += [
            "-vf", f"fade=t=in:st=0:d={fd},fade=t=out:st={fade_out_st}:d={fd}",
            "-af", f"afade=t=in:st=0:d={fd},afade=t=out:st={fade_out_st}:d={fd}",
        ]
    cmd.append(str(out_path))
    run(cmd, progress_cb=progress_cb, total_duration=duration)
    return out_path
