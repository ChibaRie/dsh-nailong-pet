# -*- coding: utf-8 -*-
"""放大预览指定帧，用于确认朝向与动作细节。用法: zoom.py out.png r01_c00 r01_c02 ..."""
import os
import sys
from PIL import Image, ImageDraw

ROOT = r"D:\娱乐\draft\nailong-pet"
OUT = os.path.join(ROOT, "plugin", "runtime", "app", "assets", "frames")

out = sys.argv[1]
names = sys.argv[2:]
W = 300
imgs = []
for n in names:
    g = Image.open(os.path.join(OUT, n + ".png"))
    imgs.append(g.resize((W, round(g.height * W / g.width)), Image.LANCZOS))

H = max(g.height for g in imgs) + 20
sheet = Image.new("RGBA", (W * len(imgs), H), (255, 255, 255, 255))
d = ImageDraw.Draw(sheet)
for i, (g, n) in enumerate(zip(imgs, names)):
    sheet.alpha_composite(g, (i * W, 20))
    d.text((i * W + 4, 4), n, fill=(0, 0, 0, 255))
sheet.convert("RGB").save(out)
print("saved", out, sheet.size)
