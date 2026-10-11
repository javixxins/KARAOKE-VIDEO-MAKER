"""Agrupacion de palabras transcritas en lineas de karaoke."""

MAX_LINE_CHARS = 36
MAX_LINE_WORDS = 7
PAUSE_GAP = 0.6
SENTENCE_END = (".", "?", "!", "...", "…")


def words_to_lines(words):
    """Asigna line_break_after a la lista plana de palabras con ids."""
    out = []
    line_len = 0
    line_words = 0
    for i, w in enumerate(words):
        text = w["text"]
        entry = {"id": i, "text": text, "start": w["start"], "end": w["end"], "line_break_after": False}
        line_len += len(text) + 1
        line_words += 1
        out.append(entry)

        is_last = i == len(words) - 1
        gap = (words[i + 1]["start"] - w["end"]) if not is_last else 0
        ends_sentence = text.endswith(SENTENCE_END)

        should_break = (
            is_last
            or ends_sentence
            or gap > PAUSE_GAP
            or line_len >= MAX_LINE_CHARS
            or line_words >= MAX_LINE_WORDS
        )
        if should_break and not is_last:
            entry["line_break_after"] = True
            line_len = 0
            line_words = 0
        if is_last:
            entry["line_break_after"] = True
    return out


def group_into_lines(flat_words):
    """A partir de la lista plana (con line_break_after) devuelve lista de lineas
    [{start,end,text,words:[...]}] para renderizado/edicion."""
    lines = []
    current = []
    for w in flat_words:
        current.append(w)
        if w.get("line_break_after"):
            if current:
                lines.append({
                    "start": current[0]["start"],
                    "end": current[-1]["end"],
                    "text": " ".join(x["text"] for x in current),
                    "words": current,
                })
            current = []
    if current:
        lines.append({
            "start": current[0]["start"],
            "end": current[-1]["end"],
            "text": " ".join(x["text"] for x in current),
            "words": current,
        })
    return lines
