# -*- coding: utf-8 -*-
"""比较各行是否重复（同一动作被画了两遍），用于决定动画归类。"""
import json
import os
from PIL import Image, ImageChops
import numpy as np

ROOT = r"D:\娱乐\draft\nailong-pet"
APP = os.path.join(ROOT, "plugin", "runtime", "app")
OUT = os.path.join(APP, "assets", "frames")
man = json.load(open(os.path.join(ROOT, "work", "frames.json"), encoding="utf-8"))

# 每行取中间帧的多帧平均，缩到同一尺寸后比较
profiles = {}
for m in man:
    imgs = []
    for n in m["frames"]:
        g = Image.open(os.path.join(OUT, n + ".png")).convert("RGBA").resize((96, 104), Image.LANCZOS)
        imgs.append(np.asarray(g, dtype=np.float32) / 255.0)
    profiles[m["row"]] = np.mean(np.stack(imgs), axis=0)

rows = sorted(profiles)
print("行间平均绝对差（越小越像，<0.03 视为重复）:")
print("     " + "".join("%7d" % r for r in rows))
for a in rows:
    cells = []
    for b in rows:
        d = float(np.mean(np.abs(profiles[a] - profiles[b])))
        cells.append("%7.3f" % d)
    print("r%02d: %s" % (a, "".join(cells)))
