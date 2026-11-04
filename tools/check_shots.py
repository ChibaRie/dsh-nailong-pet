# -*- coding: utf-8 -*-
"""核对每张冒烟截图里不透明像素的包围盒，确认"脚底线"在所有动作里一致、且不被窗口裁切。

预期（窗口高 390 CSS px，scale=1.6，margin.bottom=26，图集地面线 y=203/208）：
  脚底线 = 390 - 26 - (208-203)*1.6 = 356 CSS px  ->  物理像素 = 356 * dpr(1.25) = 445
"""
import os
import sys
from PIL import Image

SHOTS = r"D:\娱乐\draft\nailong-pet\work\shots"
names = sys.argv[1:] or sorted(
    f[:-4] for f in os.listdir(SHOTS) if f.endswith(".png"))

print("%-8s %-9s %-22s %-22s %s" % ("anim", "size", "alpha bbox", "bottom/top gap", "left/right gap"))
for n in names:
    p = os.path.join(SHOTS, n + ".png")
    if not os.path.exists(p):
        continue
    im = Image.open(p).convert("RGBA")
    a = im.getchannel("A").point(lambda v: 255 if v >= 40 else 0)
    bb = a.getbbox()
    W, H = im.size
    if not bb:
        print("%-8s %-9s EMPTY" % (n, "%dx%d" % (W, H)))
        continue
    x0, y0, x1, y1 = bb
    print("%-8s %-9s %-22s bottom=%3d top=%3d         left=%3d right=%3d" % (
        n, "%dx%d" % (W, H), "(%d,%d,%d,%d)" % bb,
        H - y1, y0, x0, W - x1))
