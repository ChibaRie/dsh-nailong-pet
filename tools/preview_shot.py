# -*- coding: utf-8 -*-
"""把冒烟截图铺到棋盘格上放大，方便人工核对透明边缘与姿态。
用法: preview_shot.py in.png out.png [zoom]
"""
import os
import sys
from PIL import Image

src, dst = sys.argv[1], sys.argv[2]
zoom = float(sys.argv[3]) if len(sys.argv) > 3 else 2.0

im = Image.open(src).convert("RGBA")
w, h = im.size
w2, h2 = int(w * zoom), int(h * zoom)
im = im.resize((w2, h2), Image.NEAREST)

TILE = 16
bg = Image.new("RGBA", (w2, h2), (255, 255, 255, 255))
px = bg.load()
for y in range(h2):
    for x in range(w2):
        if ((x // TILE) + (y // TILE)) % 2 == 0:
            px[x, y] = (214, 214, 214, 255)
bg.alpha_composite(im)
os.makedirs(os.path.dirname(dst), exist_ok=True)
bg.convert("RGB").save(dst)
print("saved", dst, bg.size)
