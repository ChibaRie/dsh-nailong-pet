# -*- coding: utf-8 -*-
"""分析原始精灵图：网格、每格内容量、背景色、透明通道情况。"""
import sys
from PIL import Image

SRC = r"D:\娱乐\draft\nailong-pet\plugin\runtime\app\assets\raw\spritesheet.webp"

im = Image.open(SRC)
print("mode:", im.mode, "size:", im.size, "frames:", getattr(im, "n_frames", 1))
rgba = im.convert("RGBA")
W, H = rgba.size

cols, rows = 8, 11
cw, ch = W // cols, H // rows
print("cell:", cw, "x", ch, "-> grid", cols, "x", rows, "residual:", W - cols * cw, H - rows * ch)

px = rgba.load()

# 采样四角与中心，判断背景
print("corners:", px[0, 0], px[W - 1, 0], px[0, H - 1], px[W - 1, H - 1])
print("corner alpha all 255?", all(px[x, y][3] == 255 for x, y in [(0, 0), (W - 1, 0), (0, H - 1), (W - 1, H - 1)]))


def is_bg(p):
    r, g, b, a = p
    if a < 16:
        return True
    return r > 244 and g > 244 and b > 244


print("\n每格非背景像素数（行 x 列）:")
for r in range(rows):
    line = []
    for c in range(cols):
        x0, y0 = c * cw, r * ch
        box = rgba.crop((x0, y0, x0 + cw, y0 + ch))
        bpx = box.load()
        n = 0
        for y in range(0, ch, 2):
            for x in range(0, cw, 2):
                if not is_bg(bpx[x, y]):
                    n += 1
        line.append(n)
    print("row %2d: %s" % (r, " ".join("%5d" % v for v in line)))

print("\n每行内容边界（列区间内所有非背景像素的 bbox）:")
for r in range(rows):
    minx, miny, maxx, maxy = cw, ch, -1, -1
    for c in range(cols):
        x0, y0 = c * cw, r * ch
        bpx = rgba.crop((x0, y0, x0 + cw, y0 + ch)).load()
        for y in range(ch):
            for x in range(cw):
                if not is_bg(bpx[x, y]):
                    if x < minx:
                        minx = x
                    if y < miny:
                        miny = y
                    if x > maxx:
                        maxx = x
                    if y > maxy:
                        maxy = y
    print("row %2d bbox: x %3d..%3d  y %3d..%3d" % (r, minx, maxx, miny, maxy))
