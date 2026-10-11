FROM python:3.12-slim

# ffmpeg (con ffprobe) es necesario para leer/generar audio y video.
# libgomp1 es una libreria de hilos (OpenMP) que necesita ctranslate2 (usada
# por faster-whisper) para funcionar en una imagen "slim".
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app/backend

COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Descarga el modelo "small" de Whisper durante la construccion de la imagen,
# para que quede horneado dentro de ella: en el plan gratis de Render el
# disco no es persistente, asi que sin esto habria que volver a descargarlo
# (cientos de MB) cada vez que el contenedor se reinicia o se despierta.
RUN python -c "from faster_whisper import WhisperModel; WhisperModel('small', device='cpu', compute_type='int8')"

COPY backend/ .
COPY frontend/ /app/frontend/

ENV PORT=8008
EXPOSE 8008

CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT}"]
