# -*- coding: utf-8 -*-
"""把"相邻两帧的交叉淡化"在整段帧间隔上的样子画成一条胶片，用来目视比较
   旧曲线（整段线性/smoothstep 混合）和新曲线（两头保持清晰、中间过渡）。

用法：
    python tools/blend_strip.py [动作key] [i0] [out.png]
默认 walk 的第 0→1 帧。

合成公式和渲染端完全一致：先整张画 d0，再把 d1 以 alpha=frac 叠上去，
所以结果就是 d0*(1-frac) + d1*frac。
"""
import json
import os
import sys

import numpy as np
from PIL import Image, ImageDraw

ROOT = r"D:\娱乐\draft\nailong-pet"
ASSETS = os.path.join(ROOT, "plugin", "runtime", "app", "assets")
WORK = os.path.join(ROOT, "work")

BLEND_HOLD = 0.18   # 必须与 plugin/runtime/app/src/pet.js 里的 BLEND_HOLD 一致
BLEND_MIN = 0.02
STEPS = 9           # 一条胶片画几张


def cell(anim, fname, cache):
    if fname in cache:
        return cache[fname]
    meta = anim["_row"]
    im = Image.open(os.path.join(ASSETS, "frames", fname + ".png")).convert("RGBA")
    cv = Image.new("RGBA", (anim["w"], 208), (0, 0, 0, 0))
    cv.paste(im, (anim["ox"], meta[fname]["oy"]), im)
    cache[fname] = cv
    return cv


def mix(a, b, frac):
    """a*(1-frac) + b*frac，按预乘 alpha 合成，等价于 canvas 的 globalAlpha 叠加。"""
    aa = np.asarray(a).astype(np.float32)
    ba = np.asarray(b).astype(np.float32)
    pa = aa[:, :, 3:4] / 255.0
    pb = ba[:, :, 3:4] / 255.0
    # 源色预乘
    ca = aa[:, :, :3] * pa
    cb = ba[:, :, :3] * pb
    # d1 以 frac 叠在 d0 上：out_a = f + a0*(1-f)，out_c = f*cb + (1-f)*ca
    oa = frac * pb + (1 - frac) * pa
    oc = frac * cb + (1 - frac) * ca
    rgb = np.where(oa > 1e-6, oc / np.maximum(oa, 1e-6), 0)
    out = np.zeros_like(aa)
    out[:, :, :3] = np.clip(rgb, 0, 255)
    out[:, :, 3:4] = np.clip(oa * 255.0, 0, 255)
    return Image.fromarray(out.astype(np.uint8), "RGBA")


def smoothstep(t):
    return t * t * (3 - 2 * t)


def old_curve(u):
    """v3：整段 smoothstep（除 BLEND_MIN 以下跳过）。"""
    if u <= BLEND_MIN:
        return 0.0, False
    return smoothstep(u), True


def new_curve(u):
    """v4：两头 BLEND_HOLD 保持清晰，中间 smoothstep。"""
    if u <= BLEND_MIN:
        return 0.0, False
    t = (u - BLEND_HOLD) / (1 - 2 * BLEND_HOLD)
    t = 0.0 if t < 0 else (1.0 if t > 1 else t)
    if t <= 0:
        return 0.0, False
    return smoothstep(t), True


def strip(anim, i0, curve, cache, zoom):
    n = len(anim["frames"])
    i1 = (i0 + 1) % n
    a = cell(anim, anim["frames"][i0]["name"], cache)
    b = cell(anim, anim["frames"][i1]["name"], cache)
    tiles = []
    for k in range(STEPS):
        u = k / (STEPS - 1)
        frac, used = curve(u)
        im = mix(a, b, frac) if used else a
        lbl = Image.new("RGBA", (im.width, im.height + 18), (0, 0, 0, 0))
        lbl.paste(im, (0, 18), im)
        d = ImageDraw.Draw(lbl)
        d.text((3, 3), "u=%.2f  mix=%.2f%s" % (u, frac, "" if used else "  (硬)"),
               fill=(20, 20, 20, 255))
        tiles.append(lbl)
    W = sum(t.width for t in tiles) + 6 * (len(tiles) - 1)
    H = tiles[0].height
    sheet = Image.new("RGBA", (W, H), (255, 255, 255, 255))
    x = 0
    for t in tiles:
        sheet.alpha_composite(t, (x, 0))
        x += t.width + 6
    return sheet.resize((W * zoom, H * zoom), Image.NEAREST)


def main():
    key = sys.argv[1] if len(sys.argv) > 1 else "walk"
    i0 = int(sys.argv[2]) if len(sys.argv) > 2 else 0
    out = sys.argv[3] if len(sys.argv) > 3 else os.path.join(WORK, "blend-v4.png")
    zoom = 2

    with open(os.path.join(ASSETS, "manifest.json"), encoding="utf-8") as f:
        man = json.load(f)
    anim = next(a for a in man["animations"] if a["key"] == key)
    with open(os.path.join(WORK, "frames.json"), encoding="utf-8") as f:
        rows = json.load(f)
    anim["_row"] = {fr["name"]: fr for r in rows for fr in r["frames"]}

    cache = {}
    top = strip(anim, i0, new_curve, cache, zoom)
    bot = strip(anim, i0, old_curve, cache, zoom)
    W = max(top.width, bot.width)
    label_h = 58
    sheet = Image.new("RGBA", (W, label_h + top.height + 26 + bot.height), (255, 255, 255, 255))
    d = ImageDraw.Draw(sheet)
    d.text((8, 6), "%s  frame %d -> %d   v4 新曲线（两头清晰 + 中间 smoothstep）" % (key, i0, (i0 + 1) % len(anim["frames"])),
           fill=(0, 0, 0, 255))
    sheet.alpha_composite(top, (0, label_h - 18))
    y = label_h - 18 + top.height + 6
    d.text((8, y), "v3 旧曲线（整段 smoothstep，低帧率下长时间停在一半一半的重影上）", fill=(0, 0, 0, 255))
    sheet.alpha_composite(bot, (0, y + 20))
    sheet.convert("RGB").save(out)
    print("wrote %s  (%dx%d)" % (out, sheet.width, sheet.height))


if __name__ == "__main__":
    main()
