# -*- coding: utf-8 -*-
"""把一批冒烟截图铺棋盘格后拼成一张总览，标注文件名，便于一次性核对。

用法: montage.py out.png a.png b.png ...
"""
import os
import sys
from PIL import Image, ImageDraw

out = sys.argv[1]
files = sys.argv[2:]
TILE = 8
ZOOM = 1.0
PAD = 8
LBL = 16

cells = []
for f in files:
    im = Image.open(f).convert("RGBA")
    w, h = int(im.width * ZOOM), int(im.height * ZOOM)
    im = im.resize((w, h), Image.LANCZOS)
    bg = Image.new("RGBA", (w, h), (255, 255, 255, 255))
    px = bg.load()
    for y in range(h):
        for x in range(w):
            if ((x // TILE) + (y // TILE)) % 2 == 0:
                px[x, y] = (208, 208, 208, 255)
    bg.alpha_composite(im)
    cells.append((os.path.basename(f), bg.convert("RGB")))

COLS = 4
CW = max(c.width for _, c in cells) + PAD
CH = max(c.height for _, c in cells) + LBL + PAD
rows = (len(cells) + COLS - 1) // COLS
sheet = Image.new("RGB", (CW * COLS + PAD, CH * rows + PAD), (245, 245, 245))
d = ImageDraw.Draw(sheet)
for i, (name, c) in enumerate(cells):
    cx = PAD + (i % COLS) * CW
    cy = PAD + (i // COLS) * CH
    d.text((cx + 2, cy + 2), name, fill=(160, 0, 0))
    sheet.paste(c, (cx, cy + LBL))
sheet.save(out)
print("saved", out, sheet.size)
