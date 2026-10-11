"""Transcripcion de audio a letra con marcas de tiempo por palabra, usando faster-whisper."""
import threading

_models = {}
_model_lock = threading.Lock()
DEFAULT_MODEL_SIZE = "small"
MODEL_SIZES = {
    "fast": "small",
    "precise": "medium",
}


def get_model(model_size=DEFAULT_MODEL_SIZE):
    with _model_lock:
        if model_size not in _models:
            from faster_whisper import WhisperModel
            _models[model_size] = WhisperModel(model_size, device="cpu", compute_type="int8")
        return _models[model_size]


def transcribe_audio(audio_path, language=None, quality="fast"):
    """Devuelve (words, detected_language). words = [{text, start, end}].
    quality: "fast" (modelo small, rapido) o "precise" (modelo medium, mas
    lento pero puede detectar mejor canciones dificiles)."""
    model_size = MODEL_SIZES.get(quality, DEFAULT_MODEL_SIZE)
    model = get_model(model_size)
    segments, info = model.transcribe(
        str(audio_path),
        word_timestamps=True,
        language=language,
        # VAD (detector de voz) mas permisivo de lo normal: el umbral por
        # defecto (0.5) esta calibrado para habla clara, y en canciones
        # suele descartar fragmentos realmente cantados (notas sostenidas,
        # vibrato, voz con reverb/musica de fondo) tratandolos como "no es
        # voz" — eso hace que la letra detectada se salte trozos enteros,
        # pareciendo que "no sincroniza bien". Bajar el umbral y ampliar el
        # margen (speech_pad_ms) reduce muchisimo ese falso negativo, a
        # cambio de ser un poco mas permisivo con silencios cortos.
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 300, "threshold": 0.3, "speech_pad_ms": 500},
        # Por defecto Whisper usa el texto ya transcrito como contexto para
        # decodir el siguiente tramo. En canciones (musica + voz, estribillos
        # repetidos) eso hace que, si un tramo se transcribe mal, el error
        # se propague y el modelo puede quedarse "pegado" repitiendo la
        # misma frase durante el resto del audio — el sintoma de que la
        # letra "se queda colgada" en audios largos. Desactivarlo hace que
        # cada tramo se transcriba de forma independiente.
        condition_on_previous_text=False,
    )
    words = []
    for seg in segments:
        if not seg.words:
            continue
        for w in seg.words:
            text = w.word.strip()
            if not text:
                continue
            words.append({"text": text, "start": round(w.start, 3), "end": round(w.end, 3)})
    return words, info.language
