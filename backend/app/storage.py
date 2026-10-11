import json
import uuid
import threading
from datetime import datetime
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent / "data"
UPLOADS_DIR = BASE_DIR / "uploads"
PROJECTS_DIR = BASE_DIR / "projects"
OUTPUT_DIR = BASE_DIR / "output"

for d in (UPLOADS_DIR, PROJECTS_DIR, OUTPUT_DIR):
    d.mkdir(parents=True, exist_ok=True)

_lock = threading.Lock()

DEFAULT_STYLE = {
    "font": "Arial",
    "font_size": 68,
    "primary_color": "#FFE000",
    "secondary_color": "#FFFFFF",
    "outline_color": "#000000",
    "outline_width": 4,
    "position": "bottom",
    "margin_v": 160,
    "animation": "fill",
    "uppercase": False,
    "bold": True,
}

EXPORT_PRESETS = {
    "instagram_reel": {"label": "Instagram Reel / Story (9:16)", "width": 1080, "height": 1920},
    "instagram_square": {"label": "Instagram cuadrado (1:1)", "width": 1080, "height": 1080},
    "instagram_post": {"label": "Instagram post vertical (4:5)", "width": 1080, "height": 1350},
    "youtube": {"label": "YouTube (16:9)", "width": 1920, "height": 1080},
    "youtube_shorts": {"label": "YouTube Shorts (9:16)", "width": 1080, "height": 1920},
    "custom": {"label": "Personalizado", "width": 1080, "height": 1920},
}

FILTER_PRESETS = {
    "none": "Ninguno",
    "vivid": "Vívido",
    "warm": "Cálido",
    "cool": "Frío",
    "grayscale": "Blanco y negro",
    "sepia": "Sepia",
    "vintage": "Vintage",
    "vignette": "Viñeta",
}

QUALITY_PRESETS = {
    "alta": {"label": "Alta calidad", "crf": 18, "preset": "slow"},
    "media": {"label": "Equilibrada", "crf": 21, "preset": "medium"},
    "optimizada": {"label": "Optimizada (archivo ligero)", "crf": 26, "preset": "fast"},
}


def new_project():
    pid = uuid.uuid4().hex[:12]
    data = {
        "id": pid,
        "created_at": datetime.utcnow().isoformat(),
        "audio": None,
        "media": {"type": None, "video": None, "images": [], "ken_burns": True},
        "lyrics": {"words": [], "status": "none", "language": None, "error": None, "quality": "fast", "enabled": True},
        "style": dict(DEFAULT_STYLE),
        "filter": "none",
        "export": {"preset": "instagram_reel", "width": 1080, "height": 1920, "quality": "media"},
        "short": {"enabled": False, "duration": 30, "start": 0, "fade_enabled": False, "fade_duration": 1.0},
        "jobs": {},
    }
    save_project(data)
    return data


def project_path(pid):
    return PROJECTS_DIR / f"{pid}.json"


def save_project(data):
    with _lock:
        path = project_path(data["id"])
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False))
        tmp.replace(path)


def load_project(pid):
    path = project_path(pid)
    if not path.exists():
        return None
    with _lock:
        return json.loads(path.read_text())


def project_upload_dir(pid):
    d = UPLOADS_DIR / pid
    d.mkdir(parents=True, exist_ok=True)
    return d


def project_output_dir(pid):
    d = OUTPUT_DIR / pid
    d.mkdir(parents=True, exist_ok=True)
    return d
