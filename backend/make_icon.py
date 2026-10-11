"""Genera el icono de la app (PNG 1024x1024): diseno minimalista — un
microfono solido mas dos barras de subtitulo, sin rejillas ni ondas de
sonido, para que se lea de un vistazo incluso en tamano pequeno (Dock,
Finder)."""
from PIL import Image, ImageDraw

SIZE = 1024
SS = 4  # se dibuja a 4x y se reduce al final, para que los bordes salgan suaves
S = SIZE * SS

# --- 1) fondo: degradado diagonal sutil, oscuro (coherente con el tema de la app) ---
c1 = (15, 17, 23)     # #0f1117 esquina sup-izq (--bg)
c2 = (37, 24, 46)     # #25182e esquina inf-dcha (morado oscuro, discreto)

bg = Image.new("RGB", (SIZE, SIZE))
px = bg.load()
for y in range(SIZE):
    ty = y / SIZE
    for x in range(SIZE):
        t = (x / SIZE + ty) / 2
        px[x, y] = (
            int(c1[0] + (c2[0] - c1[0]) * t),
            int(c1[1] + (c2[1] - c1[1]) * t),
            int(c1[2] + (c2[2] - c1[2]) * t),
        )

img = bg.resize((S, S), Image.LANCZOS).convert("RGBA")
draw = ImageDraw.Draw(img, "RGBA")

gold = (255, 204, 0, 255)       # --accent
gold_soft = (255, 255, 255, 40)  # brillo sutil sobre el microfono
caption_pink = (255, 95, 162, 255)  # --accent2
white = (240, 242, 248, 255)

cx = S * 0.5

# --- 2) microfono: una sola capsula solida, sin rejilla ---
mic_w, mic_h = S * 0.32, S * 0.36
mic_top = S * 0.145
mic_box = [cx - mic_w / 2, mic_top, cx + mic_w / 2, mic_top + mic_h]
draw.rounded_rectangle(mic_box, radius=mic_w / 2, fill=gold)

# brillo diagonal muy sutil (una sola franja, da volumen sin ensuciar la forma)
highlight = Image.new("RGBA", (S, S), (0, 0, 0, 0))
hd = ImageDraw.Draw(highlight)
hw = mic_w * 0.26
hd.rounded_rectangle(
    [cx - mic_w / 2 + mic_w * 0.16, mic_top + mic_h * 0.09,
     cx - mic_w / 2 + mic_w * 0.16 + hw, mic_top + mic_h * 0.86],
    radius=hw / 2, fill=gold_soft,
)
img.alpha_composite(highlight)
draw = ImageDraw.Draw(img, "RGBA")

# soporte: un arco fino y limpio, sin vastago ni base (se deja minimo)
arc_r = mic_w * 0.58
arc_cy = mic_top + mic_h + S * 0.012
arc_box = [cx - arc_r, arc_cy, cx + arc_r, arc_cy + arc_r * 1.15]
draw.arc(arc_box, start=20, end=160, fill=white, width=int(S * 0.018))

# --- 3) subtitulo karaoke: dos barras, la activa resaltada en rosa ---
bar_h = S * 0.052
bar_gap = S * 0.034
bar_y = arc_cy + arc_r * 1.15 + S * 0.075

bar1_w = S * 0.46
draw.rounded_rectangle(
    [cx - bar1_w / 2, bar_y, cx + bar1_w / 2, bar_y + bar_h],
    radius=bar_h / 2, fill=white,
)

bar2_w = S * 0.30
bar2_y = bar_y + bar_h + bar_gap
draw.rounded_rectangle(
    [cx - bar2_w / 2, bar2_y, cx + bar2_w / 2, bar2_y + bar_h],
    radius=bar_h / 2, fill=caption_pink,
)

final = img.resize((SIZE, SIZE), Image.LANCZOS)
final.convert("RGB").save("/tmp/app_icon_master.png")
print("OK")
