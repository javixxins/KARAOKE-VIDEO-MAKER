"""Generador de subtitulos .ass con efecto karaoke a partir de la letra editada."""
from pathlib import Path

ALIGN_MAP = {"bottom": 2, "center": 5, "top": 8}


def hex_to_ass_color(hexcolor, alpha=0):
    hexcolor = (hexcolor or "#FFFFFF").lstrip("#")
    if len(hexcolor) != 6:
        hexcolor = "FFFFFF"
    r, g, b = hexcolor[0:2], hexcolor[2:4], hexcolor[4:6]
    return f"&H{alpha:02X}{b}{g}{r}".upper()


def escape_ass_text(text):
    return text.replace("\\", "\\\\").replace("{", "(").replace("}", ")")


def format_ass_time(t):
    t = max(0.0, t)
    h = int(t // 3600)
    m = int((t % 3600) // 60)
    s = t % 60
    cs = int(round((s - int(s)) * 100))
    s = int(s)
    if cs >= 100:
        cs -= 100
        s += 1
    return f"{h:01d}:{m:02d}:{s:02d}.{cs:02d}"


def build_ass(lines, style, width, height, out_path):
    """lines: lista de {start, end, words:[{text,start,end}]} ya agrupadas.
    style: dict con font, font_size, primary_color, secondary_color, outline_color,
           outline_width, position, margin_v, animation, uppercase, bold.
    """
    align = ALIGN_MAP.get(style.get("position", "bottom"), 2)
    primary = hex_to_ass_color(style.get("primary_color", "#FFE000"))
    secondary = hex_to_ass_color(style.get("secondary_color", "#FFFFFF"))
    outline = hex_to_ass_color(style.get("outline_color", "#000000"))
    bold = -1 if style.get("bold", True) else 0
    font = style.get("font", "Arial")
    font_size = int(style.get("font_size", 68))
    outline_w = int(style.get("outline_width", 4))
    margin_v = int(style.get("margin_v", 160))
    animation = style.get("animation", "fill")
    uppercase = style.get("uppercase", False)

    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {width}
PlayResY: {height}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Karaoke,{font},{font_size},{primary},{secondary},{outline},&H00000000,{bold},0,0,0,100,100,0,0,1,{outline_w},0,{align},40,40,{margin_v},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""

    events = []
    for line in lines:
        words = line["words"]
        if not words:
            continue
        line_start = words[0]["start"]
        line_end = words[-1]["end"]
        if line_end <= line_start:
            continue

        parts = []
        cum_ms = 0.0
        for i, w in enumerate(words):
            text = w["text"].upper() if uppercase else w["text"]
            text = escape_ass_text(text)
            if i < len(words) - 1:
                dur = words[i + 1]["start"] - w["start"]
            else:
                dur = max(w["end"] - w["start"], 0.05)
            dur = max(dur, 0.01)
            k_cs = max(1, round(dur * 100))

            if animation == "pop":
                t1 = int(cum_ms)
                peak = t1 + min(80, int(dur * 1000 * 0.5))
                t2 = t1 + min(160, int(dur * 1000 * 0.9))
                parts.append(
                    f"{{\\k{k_cs}\\t({t1},{peak},\\fscx128\\fscy128)\\t({peak},{t2},\\fscx100\\fscy100)}}{text} "
                )
            elif animation == "hard":
                parts.append(f"{{\\k{k_cs}}}{text} ")
            else:  # fill
                parts.append(f"{{\\kf{k_cs}}}{text} ")

            cum_ms += dur * 1000

        text_line = "".join(parts).strip()
        events.append(
            f"Dialogue: 0,{format_ass_time(line_start)},{format_ass_time(line_end)},Karaoke,,0,0,0,,{text_line}"
        )

    content = header + "\n".join(events) + "\n"
    Path(out_path).write_text(content, encoding="utf-8")
    return out_path
