# -*- coding: utf-8 -*-
"""按 8x11 网格切分精灵图，输出带 alpha 的逐帧 PNG。

对齐策略（关键）：
  x 方向 —— 每行用该行所有帧的并集 x 范围统一裁切，帧间左右相对位置不变；
  y 方向 —— 每帧裁到自己的内容范围，再让"内容底线"落在虚拟单格的地面线 y=203 上。

  为什么 y 要逐帧而 x 要整行：图集里 10 行的每帧内容底线都正好在 y=203（脚踩地），
  只有第 5 行（睡觉）的蜷缩帧比站立帧高 45~53px，整行统一裁切会让它悬空；
  而 x 方向逐帧裁会让走路循环左右抖动。

输出：
  assets/frames/<row>_<col>.png    逐帧 PNG
  work/frames.json                 每帧的 ox/oy/w/h（oy 已按地面线对齐）
  work/contact-sheet.png           带标签总览图，按地面线底对齐，供人工核对语义
"""
import json
import os
from PIL import Image, ImageDraw

ROOT = r"D:\娱乐\draft\nailong-pet"
APP = os.path.join(ROOT, "plugin", "runtime", "app")
SRC = os.path.join(APP, "assets", "raw", "spritesheet.webp")
OUT = os.path.join(APP, "assets", "frames")
WORK = os.path.join(ROOT, "work")
COLS, ROWS = 8, 11
ALPHA_MIN = 8
GROUND_Y = 203          # 单格内共用的地面线（0-based，行内所有角色脚底都在这一行）

os.makedirs(OUT, exist_ok=True)
os.makedirs(WORK, exist_ok=True)

im = Image.open(SRC).convert("RGBA")
W, H = im.size
cw, ch = W // COLS, H // ROWS
assert GROUND_Y < ch, "地面线超出单格高度"

hist = im.getchannel("A").histogram()
total = W * H
print("[alpha] 全透明 %d (%.2f%%)  全不透明 %d (%.2f%%)  半透明 %d (%.2f%%)" % (
    hist[0], hist[0] * 100.0 / total, hist[255], hist[255] * 100.0 / total,
    total - hist[0] - hist[255], (total - hist[0] - hist[255]) * 100.0 / total))

cells = [[im.crop((c * cw, r * ch, (c + 1) * cw, (r + 1) * ch)) for c in range(COLS)] for r in range(ROWS)]


def bbox_of(img):
    return img.getchannel("A").point(lambda v: 255 if v >= ALPHA_MIN else 0).getbbox()


manifest = []
for r in range(ROWS):
    boxes = [bbox_of(cells[r][c]) for c in range(COLS)]
    used = [i for i, b in enumerate(boxes) if b]
    if not used:
        print("row %2d: 空行，跳过" % r)
        continue
    x0 = min(boxes[i][0] for i in used)
    x1 = max(boxes[i][2] for i in used)

    frames = []
    for c in used:
        b = boxes[c]
        # x 用整行范围（保持帧间水平位置），y 用本帧内容范围
        frame = cells[r][c].crop((x0, b[1], x1, b[3]))
        name = "r%02d_c%02d" % (r, c)
        frame.save(os.path.join(OUT, name + ".png"))
        frames.append({
            "name": name,
            "oy": GROUND_Y - (b[3] - b[1]),   # 让内容底线落在虚拟单格 y=203
            "w": x1 - x0,
            "h": b[3] - b[1],
        })

    floats = [f["oy"] - (GROUND_Y - f["h"]) for f in frames]
    print("row %2d: %d 帧  x=[%d,%d) w=%d  高 %d~%d  地面线偏差 %s" % (
        r, len(frames), x0, x1, x1 - x0,
        min(f["h"] for f in frames), max(f["h"] for f in frames),
        sorted(set(floats))))
    manifest.append({"row": r, "count": len(frames), "cols": used,
                     "ox": x0, "w": x1 - x0, "groundY": GROUND_Y, "frames": frames})

with open(os.path.join(WORK, "frames.json"), "w", encoding="utf-8") as f:
    json.dump(manifest, f, ensure_ascii=False, indent=2)

# ---- 总览图：所有帧按地面线底对齐，一眼能看出谁在悬空 ----
SCALE_W = 150
pad = 8
label_h = 16
BASELINE_PAD = 14
sheet_w = 60 + (SCALE_W + pad) * COLS
rows_img = []
for m in manifest:
    imgs = []
    for fr in m["frames"]:
        g = Image.open(os.path.join(OUT, fr["name"] + ".png"))
        w = SCALE_W
        h = max(1, round(g.height * w / g.width))
        imgs.append(g.resize((w, h), Image.LANCZOS))
    rows_img.append((m, imgs))
    m["_rowh"] = max(g.height for g in imgs) + label_h + BASELINE_PAD

sheet_h = pad + sum(m["_rowh"] + pad for m, _ in rows_img)
sheet = Image.new("RGBA", (sheet_w, sheet_h), (250, 250, 250, 255))
d = ImageDraw.Draw(sheet)
y = pad
for m, imgs in rows_img:
    baseline = y + label_h + max(g.height for g in imgs) + BASELINE_PAD
    d.text((6, y + 6), "row %d\n%d frames\nw=%d" % (m["row"], m["count"], m["w"]), fill=(200, 0, 0, 255))
    d.line([(56, baseline), (sheet_w - pad, baseline)], fill=(230, 80, 80, 255))
    x = 60
    for g, fr in zip(imgs, m["frames"]):
        sheet.alpha_composite(g, (x, baseline - g.height))
        d.text((x, y), fr["name"], fill=(0, 0, 160, 255))
        d.rectangle([x - 1, y + label_h - 1, x + SCALE_W, baseline], outline=(222, 222, 222, 255))
        x += SCALE_W + pad
    y += m["_rowh"] + pad
for m, _ in rows_img:
    m.pop("_rowh", None)
sheet.convert("RGB").save(os.path.join(WORK, "contact-sheet.png"))
print("\n总览图: %s (%dx%d)" % (os.path.join(WORK, "contact-sheet.png"), sheet_w, sheet_h))
print("共 %d 行 / %d 帧" % (len(manifest), sum(m["count"] for m in manifest)))
