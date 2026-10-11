# Karaoke Video Maker

Aplicación web local para convertir una canción (MP3) + un vídeo o fotos en un
vídeo musical tipo karaoke: detecta automáticamente la letra con IA (Whisper),
la sincroniza con la música, permite corregirla a mano, personalizar el estilo
visual, recortar el timeline, aplicar filtros y exportar en MP4 en formatos
para Instagram y YouTube (incluyendo un Short/Reel opcional).

## Requisitos (ya comprobados en este Mac)

- Python 3.10+ (se usa `python3.12` vía Homebrew)
- `ffmpeg` (ya instalado en tu sistema, con soporte de subtítulos `libass`)

No hace falta Node ni ningún otro programa adicional.

## Cómo arrancar la aplicación

**Forma más rápida:** haz doble clic en **`Karaoke Video Maker.app`** (en la
carpeta del proyecto). Arranca el servidor en segundo plano y abre
automáticamente `http://127.0.0.1:8008` en tu navegador — no hace falta
terminal ni recordar comandos. La primera vez, macOS puede avisar de que es
una app de un desarrollador no identificado: haz clic derecho → "Abrir" para
confirmarlo una sola vez.

**Alternativa manual** (terminal):

```bash
cd "backend"
./run.sh
```

y abre en el navegador `http://127.0.0.1:8008`.

La primera vez que subas un audio, se descargará automáticamente el modelo de
IA de transcripción (faster-whisper, modelo "small", ~500 MB) — necesita
conexión a internet solo esa primera vez. A partir de ahí funciona sin
conexión.

## Flujo de la app (paso a paso)

1. **Audio**: sube el MP3. Se detecta la letra automáticamente en segundo
   plano (con los tiempos exactos de cada palabra).
2. **Vídeo o imágenes**: sube un único vídeo de fondo, o una o varias fotos
   (se muestran en secuencia, tipo slideshow, con efecto Ken Burns opcional).
3. **Letra**: revisa/corrige manualmente el texto y los tiempos detectados
   (por si la IA se equivoca en alguna palabra), añade o borra palabras, y
   marca los saltos de línea donde quieras.
4. **Estilo**: elige fuente, tamaño, color del texto cantado/no cantado,
   borde, posición en pantalla y el efecto de animación del karaoke:
   - *Barrido suave*: la palabra se rellena de color progresivamente.
   - *Resaltado directo*: cambia de color de golpe al cantarse.
   - *Rebote (pop)*: además de cambiar de color, la palabra "salta" al
     cantarse.
   Hay una vista previa en vivo sincronizada con el audio.
5. **Timeline y filtros**: recorta el vídeo (inicio/fin) o ajusta la
   duración de cada foto, activa/desactiva Ken Burns, y aplica un filtro de
   color (vívido, cálido, frío, blanco y negro, sepia, vintage, viñeta...).
6. **Exportar**: elige el formato de salida (Instagram Reel/Story 9:16,
   Instagram cuadrado, Instagram post 4:5, YouTube 16:9, YouTube Shorts, o un
   tamaño personalizado), la calidad/optimización del archivo, y si quieres
   generar además un Short/Reel corto indicando desde qué segundo y cuánto
   debe durar. Pulsa "Generar vídeo final" y descarga el resultado en MP4.

## Notas técnicas

- Backend: Python (FastAPI) + `faster-whisper` (transcripción con
  timestamps por palabra) + `ffmpeg`/`libass` (composición de vídeo y
  subtítulos karaoke quemados con tags `\k`/`\kf`).
- Frontend: HTML/CSS/JS sin dependencias ni paso de compilación.
- Cada proyecto se guarda en `backend/data/` (subidas, estado del proyecto en
  JSON y vídeos exportados). Puedes borrar esa carpeta para empezar de cero.
