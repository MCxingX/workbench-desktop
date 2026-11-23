"""生成应用图标：build/icon.ico（多尺寸）+ build/icon.png + build/tray.png"""
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "build"
OUT.mkdir(parents=True, exist_ok=True)

ACCENT = (76, 141, 255, 255)
INK = (232, 236, 241, 255)
SIZE = 512


def draw_icon(size: int) -> Image.Image:
    s = size * 4  # 超采样后缩小，边缘更干净
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    pad = int(s * 0.06)
    d.rounded_rectangle([pad, pad, s - pad, s - pad], radius=int(s * 0.22), fill=ACCENT)
    # 时钟指针
    cx = cy = s / 2
    lw = int(s * 0.052)
    d.line([cx, cy, cx, cy - s * 0.235], fill=INK, width=lw)
    d.line([cx, cy, cx + s * 0.185, cy + s * 0.08], fill=INK, width=lw)
    d.ellipse([cx - s * 0.042, cy - s * 0.042, cx + s * 0.042, cy + s * 0.042], fill=INK)
    return img.resize((size, size), Image.LANCZOS)


icon_256 = draw_icon(256)
icon_256.save(OUT / "icon.png")

sizes = [256, 128, 64, 48, 32, 16]
images = [draw_icon(x) for x in sizes]
images[0].save(OUT / "icon.ico", format="ICO", sizes=[(x, x) for x in sizes], append_images=images[1:])

draw_icon(32).save(OUT / "tray.png")
print("icons written to", OUT)
