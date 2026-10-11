"""Respuestas de archivo con soporte de peticiones de rango HTTP
(Range / 206 Partial Content), imprescindible para poder buscar ("seek")
posiciones en audio/video desde el navegador. FileResponse de
Starlette/FastAPI NO implementa esto por defecto: sin ello, el navegador no
puede saltar a un punto concreto del audio y currentTime se queda en 0."""
import mimetypes
import re
from pathlib import Path

from fastapi import Request
from fastapi.responses import Response, StreamingResponse

CHUNK_SIZE = 256 * 1024
RANGE_RE = re.compile(r"bytes=(\d*)-(\d*)")


def range_file_response(request: Request, path: Path, filename: str = None, download: bool = False):
    file_size = path.stat().st_size
    media_type = mimetypes.guess_type(str(path))[0] or "application/octet-stream"

    headers = {"Accept-Ranges": "bytes"}
    if filename:
        disposition = "attachment" if download else "inline"
        headers["Content-Disposition"] = f'{disposition}; filename="{filename}"'

    def read_range(start, end):
        with open(path, "rb") as f:
            f.seek(start)
            remaining = end - start + 1
            while remaining > 0:
                chunk = f.read(min(CHUNK_SIZE, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                yield chunk

    range_header = request.headers.get("range")
    if range_header:
        m = RANGE_RE.match(range_header.strip())
        if m:
            start_s, end_s = m.groups()
            start = int(start_s) if start_s else 0
            end = int(end_s) if end_s else file_size - 1
            end = min(end, file_size - 1)
            if start > end or start >= file_size:
                return Response(
                    status_code=416,
                    headers={"Content-Range": f"bytes */{file_size}", "Accept-Ranges": "bytes"},
                )
            headers["Content-Range"] = f"bytes {start}-{end}/{file_size}"
            headers["Content-Length"] = str(end - start + 1)
            return StreamingResponse(
                read_range(start, end), status_code=206, media_type=media_type, headers=headers
            )

    headers["Content-Length"] = str(file_size)
    return StreamingResponse(read_range(0, file_size - 1), status_code=200, media_type=media_type, headers=headers)
