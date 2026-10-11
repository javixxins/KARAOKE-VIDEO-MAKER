"""Alinea una letra 'real' escrita a mano (.txt) con los tiempos que detecto
la IA, dando prioridad al texto del .txt para el contenido de cada palabra y
usando los tiempos de la IA como referencia (ayuda) para la sincronizacion."""
import re
import difflib

MIN_WORD_DUR = 0.05
PAUSE_GAP = 0.6
MIN_ANCHOR_COVERAGE = 0.25


def normalize(text):
    text = text.lower()
    text = re.sub(r"[^0-9a-záéíóúñü]+", "", text)
    return text


def _is_junk(token):
    # Palabras de 1-2 letras (la, el, de, en, se, tu, mi, un, lo, su, y, a...)
    # son extremadamente frecuentes y, cuando la IA transcribe mal una
    # cancion, pueden "coincidir" con la letra real por pura casualidad en
    # un punto del todo equivocado. Tratarlas como "junk" evita que una
    # coincidencia casual de una palabra tan corta ancle mal el resto de la
    # letra — exactamente el fallo que hacia que la letra importada no se
    # pareciera en nada a lo que realmente suena.
    return len(token) <= 2


def parse_txt_lyrics(raw_text):
    """Devuelve una lista de lineas; cada linea es una lista de palabras tal
    como las escribio el usuario (se preservan mayusculas/acentos/puntuacion)."""
    lines = []
    for raw_line in raw_text.splitlines():
        words = [w for w in raw_line.strip().split() if normalize(w)]
        if words:
            lines.append(words)
    return lines


def distribute_proportional(start_t, end_t, texts):
    n = len(texts)
    if n == 0:
        return []
    total_dur = end_t - start_t
    if total_dur < MIN_WORD_DUR * n:
        total_dur = MIN_WORD_DUR * n
        end_t = start_t + total_dur
    weights = [max(1, len(t)) for t in texts]
    total_w = sum(weights) or 1
    spans = []
    cur = start_t
    for w in weights:
        dur = total_dur * (w / total_w)
        spans.append((cur, cur + dur))
        cur += dur
    return spans


def _group_by_pause(whisper_words):
    """Agrupa las palabras detectadas en 'frases' separadas por pausas
    (> PAUSE_GAP), igual que al generar las lineas automaticas."""
    groups = []
    cur = [whisper_words[0]]
    for prev, w in zip(whisper_words, whisper_words[1:]):
        if w["start"] - prev["end"] > PAUSE_GAP:
            groups.append(cur)
            cur = []
        cur.append(w)
    if cur:
        groups.append(cur)
    return groups


def _fallback_by_line_order(whisper_words, txt_lines):
    """Respaldo para cuando la letra detectada por la IA no se parece casi
    nada, textualmente, a la letra real (tipico en canciones dificiles): en
    vez de fiarse de que las PALABRAS coincidan, se asume que el NUMERO y
    el ORDEN de frases/pausas que detecto la IA es una referencia razonable
    de 'cuando se canta algo' (eso lo gobierna el detector de voz, no el
    reconocimiento de texto), y se reparte cada LINEA real, en orden, sobre
    esas mismas zonas de canto detectadas. Si hay mas lineas reales que
    zonas detectadas, varias lineas comparten una zona, subdividiendola
    proporcionalmente (por caracteres) en vez de solaparse entre si."""
    groups = _group_by_pause(whisper_words)
    n_groups = len(groups)
    n_lines = len(txt_lines)
    line_to_group = [min(n_groups - 1, (li * n_groups) // max(1, n_lines)) for li in range(n_lines)]

    out = []
    for gi, group in enumerate(groups):
        line_idxs = [li for li, g in enumerate(line_to_group) if g == gi]
        if not line_idxs:
            continue
        group_start, group_end = group[0]["start"], group[-1]["end"]
        total_words = sum(len(txt_lines[li]) for li in line_idxs)
        total_chars = sum(sum(len(w) for w in txt_lines[li]) for li in line_idxs) or 1
        total_dur = max(MIN_WORD_DUR * total_words, group_end - group_start)
        cur = group_start
        for li in line_idxs:
            line = txt_lines[li]
            line_chars = sum(len(w) for w in line) or 1
            line_dur = total_dur * (line_chars / total_chars)
            spans = distribute_proportional(cur, cur + line_dur, line)
            for k, (s, e) in enumerate(spans):
                start = round(max(0.0, s), 3)
                end = round(max(start + 0.01, e), 3)
                out.append({
                    "text": line[k], "start": start, "end": end,
                    "line_break_after": k == len(line) - 1,
                })
            cur += line_dur
    return out


def align_with_whisper(whisper_words, txt_lines):
    """whisper_words: [{text,start,end}, ...] ya detectado por la IA.
    txt_lines: lista de lineas (lista de palabras) del .txt subido.
    Devuelve una lista plana [{text,start,end,line_break_after}] con el TEXTO
    tomado del .txt y los TIEMPOS alineados a lo detectado por la IA."""
    txt_words = []  # (line_idx, texto_tal_cual)
    for li, line in enumerate(txt_lines):
        for w in line:
            txt_words.append((li, w))
    if not txt_words:
        return []
    if not whisper_words:
        return _fallback_by_line_order([{"start": 0.0, "end": max(1.0, len(txt_words) * 0.4)}], txt_lines)

    norm_w = [normalize(w["text"]) for w in whisper_words]
    norm_t = [normalize(t) for (_, t) in txt_words]

    sm = difflib.SequenceMatcher(a=norm_w, b=norm_t, isjunk=_is_junk, autojunk=False)
    result = []  # (j, texto, start, end)
    anchored_words = 0

    def append_direct(j1, j2, whisper_idxs):
        for j, wi in zip(range(j1, j2), whisper_idxs):
            result.append((j, txt_words[j][1], whisper_words[wi]["start"], whisper_words[wi]["end"]))

    def append_distributed(j1, j2, start_t, end_t):
        texts = [txt_words[j][1] for j in range(j1, j2)]
        for j, (s, e) in zip(range(j1, j2), distribute_proportional(start_t, end_t, texts)):
            result.append((j, txt_words[j][1], s, e))

    prev_end = 0.0
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            # solo cuenta como "anclaje real" si la palabra no es junk (muy
            # corta): una coincidencia de "la" o "de" no es prueba fiable de
            # que esa sea realmente la posicion correcta.
            anchored_words += sum(1 for j in range(j1, j2) if not _is_junk(norm_t[j]))
            append_direct(j1, j2, range(i1, i2))
            prev_end = whisper_words[i2 - 1]["end"]
        elif tag == "replace":
            if (i2 - i1) == (j2 - j1):
                append_direct(j1, j2, range(i1, i2))
            else:
                append_distributed(j1, j2, whisper_words[i1]["start"], whisper_words[i2 - 1]["end"])
            prev_end = whisper_words[i2 - 1]["end"]
        elif tag == "insert":
            n_words = j2 - j1
            next_start = whisper_words[i1]["start"] if i1 < len(whisper_words) else prev_end + 0.3 * n_words
            if next_start <= prev_end:
                next_start = prev_end + 0.3 * n_words
            append_distributed(j1, j2, prev_end, next_start)
            prev_end = next_start
        elif tag == "delete":
            if i2 - 1 < len(whisper_words):
                prev_end = whisper_words[i2 - 1]["end"]

    coverage = anchored_words / max(1, len(txt_words))
    if coverage < MIN_ANCHOR_COVERAGE:
        # muy pocas palabras reales de verdad "ancladas" con confianza: la
        # letra detectada no se parece casi nada a la real. Mejor repartir
        # por orden de frases que forzar un anclaje de baja confianza que
        # puede dejar la letra "en cualquier punto, sin parecerse a nada".
        return _fallback_by_line_order(whisper_words, txt_lines)

    result.sort(key=lambda r: r[0])
    out = []
    n = len(result)
    for idx, (j, text, s, e) in enumerate(result):
        line_idx = txt_words[j][0]
        next_line_idx = txt_words[result[idx + 1][0]][0] if idx + 1 < n else None
        line_break = next_line_idx is None or next_line_idx != line_idx
        start = round(max(0.0, s), 3)
        end = round(max(start + 0.01, e), 3)
        out.append({"text": text, "start": start, "end": end, "line_break_after": line_break})
    return out
