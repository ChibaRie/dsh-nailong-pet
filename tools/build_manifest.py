# -*- coding: utf-8 -*-
"""把 work/frames.json + 人工确认的动作语义表，编译成运行时用的 assets/manifest.json。

语义表来自逐行放大目视核对（tools/zoom.py）与行间相似度分析（tools/compare_rows.py）。
facing 指该行动作里角色的"天然朝向"：walk 行朝右、run 行朝左，其余为正面。

kind 字段决定运行时的用法：
  idle   —— 待机时"闲着"的表现（站着发呆 / 坐在地上），慢节奏长时间播放
  stroll —— 待机时"悠闲散步"，带一点点位移
  action —— 到点自动表演 / 点击菜单里可选的动作

interp=True 表示渲染端在相邻两帧之间做交叉淡化，把 60fps 的显示平滑度叠在
10~20fps 的关键帧上。不引入任何新像素，只是把相邻两张原图按时间混合。
"""
import json
import os

import numpy as np
from PIL import Image

ROOT = r"D:\娱乐\draft\nailong-pet"
APP = os.path.join(ROOT, "plugin", "runtime", "app")
WORK = os.path.join(ROOT, "work")
ASSETS = os.path.join(APP, "assets")
OUT = os.path.join(ASSETS, "manifest.json")

# 相邻帧差异超过这个值就不再交叉淡化。
# 依据：原画有描边，两张差别极大的姿势按 50% 混合会在轮廓外留一圈灰边。
# v2 用的是 32（只混待机呼吸这类微小差异），实测下来"动起来还是顿" ——
# 因为真正需要平滑的走路/挥手全被硬切了。v3 把阈值抬到 72：
# 走路/散步（~63）、挥手（67.5）、大笑（69.3）都会交叉淡化，
# 只有睡姿翻滚（117.6，两个姿势完全对不上）保持硬切。
BLEND_MAX = 72.0

# === 播放速度总开关 ===================================================
# 表里 fps / move 是 v3 的基准值，实际写进 manifest 的是它们乘以这个系数。
# 调快慢只改这一个数，不用碰下面那张表。
#   1.00 = v3（用户反馈"还是太快"）
#   0.50 = v4 当前值：整体再放慢一半
# 位移速度跟着 fps 一起缩放，是为了让"一步迈多远"保持不变
# （px/循环 = move ÷ (fps/帧数)），否则会变成脚在原地滑。
SLOWDOWN = 0.50

# 注意 fps 列：v1 是 6/12/14 的原图档位；v2 上提到 10/16/20 之后用户反馈
# "动作做的太快了"。v3 在 v2 的基础上整体放缓约 35%，同时靠 interp 交叉淡化
# 保证 144Hz 屏上的平滑度 —— 关键帧更少、每帧之间的过渡更长，观感是"从容"。
# v4 再乘 SLOWDOWN=0.5，并配合 pet.js 里"两头保持清晰、中间平滑过渡"的
# 淡化曲线，避免慢速播放变成一层糊在一起的重影。
ANIMS = [
    # key,     label,       row, fps, loop, repeat, hold, facing,  move, kind,     weight, pick
    dict(key="idle",   label="发呆",     row=0,  fps=7,  loop=True,  repeat=1, hold=False, facing="front", move=0,   kind="idle",   weight=10, pick=None),
    dict(key="walk",   label="走一走",   row=1,  fps=11, loop=True,  repeat=1, hold=False, facing="right", move=66,  kind="action", weight=4,  pick=None),
    dict(key="run",    label="跑一跑",   row=2,  fps=13, loop=True,  repeat=1, hold=False, facing="left",  move=130, kind="action", weight=2,  pick=None),
    dict(key="wave",   label="打招呼",   row=3,  fps=7,  loop=False, repeat=3, hold=False, facing="front", move=0,   kind="action", weight=5,  pick=None),
    dict(key="laugh",  label="大笑",     row=4,  fps=9,  loop=False, repeat=2, hold=False, facing="front", move=0,   kind="action", weight=5,  pick=None),
    dict(key="sleep",  label="睡觉",     row=5,  fps=6,  loop=False, repeat=1, hold=True,  facing="front", move=0,   kind="action", weight=2,  pick=None),
    dict(key="sit",    label="坐一会",   row=5,  fps=2,  loop=True,  repeat=1, hold=False, facing="front", move=0,   kind="idle",   weight=8,  pick=[3]),
    dict(key="idle2",  label="东张西望", row=6,  fps=7,  loop=True,  repeat=1, hold=False, facing="front", move=0,   kind="idle",   weight=8,  pick=None),
    dict(key="work",   label="敲键盘",   row=7,  fps=7,  loop=False, repeat=3, hold=False, facing="front", move=0,   kind="action", weight=5,  pick=None),
    dict(key="shy",    label="害羞",     row=8,  fps=7,  loop=False, repeat=2, hold=False, facing="front", move=0,   kind="action", weight=4,  pick=None),
    dict(key="idle3",  label="放空",     row=9,  fps=7,  loop=True,  repeat=1, hold=False, facing="front", move=0,   kind="idle",   weight=8,  pick=None),
    dict(key="idle4",  label="打哈欠",   row=10, fps=6,  loop=True,  repeat=1, hold=False, facing="front", move=0,   kind="idle",   weight=6,  pick=None),
    dict(key="stroll", label="悠闲散步", row=1,  fps=6,  loop=True,  repeat=1, hold=False, facing="right", move=26,  kind="stroll", weight=0,  pick=None),
]


def frame_cell(anim_row, defn, cache):
    """把一帧按虚拟单格的坐标拼出来，供帧间差异度量用。"""
    name = defn["name"]
    if name in cache:
        return cache[name]
    im = Image.open(os.path.join(ASSETS, "frames", name + ".png")).convert("RGBA")
    cv = Image.new("RGBA", (anim_row["w"], 208), (0, 0, 0, 0))
    cv.paste(im, (anim_row["ox"], defn["oy"]), im)
    arr = np.asarray(cv).astype(np.float32)
    cache[name] = arr
    return arr


def pair_diffs(row_meta, frames):
    """每对相邻帧的差异（0~255，按 union alpha 掩码上的预乘 RGB 平均绝对差）。"""
    if len(frames) < 2:
        return []
    cache = {}
    out = []
    n = len(frames)
    for i in range(n):
        a = frame_cell(row_meta, frames[i], cache)
        b = frame_cell(row_meta, frames[(i + 1) % n], cache)
        aa = a[:, :, 3:4] / 255.0
        ba = b[:, :, 3:4] / 255.0
        pa = a[:, :, :3] * aa
        pb = b[:, :, :3] * ba
        m = np.maximum(aa, ba)[:, :, 0] > 0.15
        if not m.any():
            out.append(0.0)
            continue
        out.append(round(float(np.abs(pa - pb).mean(axis=2)[m].mean()), 1))
    return out


def main():
    with open(os.path.join(WORK, "frames.json"), encoding="utf-8") as f:
        rows = {m["row"]: m for m in json.load(f)}

    anims = []
    for spec in ANIMS:
        m = rows[spec["row"]]
        src = m["frames"]
        frames = src if spec["pick"] is None else [src[i] for i in spec["pick"]]
        anims.append({
            "key": spec["key"],
            "label": spec["label"],
            "row": spec["row"],
            # 整行统一的 x 偏移与宽度（保证帧间水平不抖）
            "ox": m["ox"],
            "w": m["w"],
            "facing": spec["facing"],
            # 每帧带自己的 oy/h：内容底线已对齐到虚拟单格地面线
            "frames": frames,
            # 基准值 × SLOWDOWN；位移也按同一个系数缩，保证 px/循环不变
            "fps": round(spec["fps"] * SLOWDOWN, 2),
            "loop": spec["loop"],
            # 非 loop 动作重复几遍（1 = 只播一遍）
            "repeat": spec["repeat"],
            # 非 loop 动作播完后是否定格在最后一帧（睡觉）
            "hold": spec["hold"],
            "move": round(spec["move"] * SLOWDOWN, 1),
            "kind": spec["kind"],
            "weight": spec["weight"],
            # 相邻帧差异：渲染端据此决定这对帧要不要交叉淡化（见 BLEND_MAX）
            "pairs": pair_diffs(m, frames),
        })

    manifest = {
        "meta": {
            "name": "奶龙",
            "cellW": 192,
            "cellH": 208,
            "cols": 8,
            "rows": 11,
            "totalFrames": sum(len(a["frames"]) for a in anims),
            "idleMs": [25000, 35000],
            "blendMax": BLEND_MAX,
            "source": "Maple498/nai-wa-codex-pet (spritesheet.webp, CC BY 4.0)",
        },
        "animations": anims,
    }
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    print("wrote %s  (%d animations, %d frames, %d bytes)" % (
        OUT, len(anims), manifest["meta"]["totalFrames"], os.path.getsize(OUT)))
    for a in anims:
        blend = sum(1 for d in a["pairs"] if d <= BLEND_MAX)
        span = len(a["frames"]) / a["fps"] if a["fps"] else 0
        print("   %-7s %-8s row%-3d fps%-6s %-6s frames=%d move=%-6s %-6s blend=%d/%d  周期%.2fs" % (
            a["key"], a["label"], a["row"], a["fps"],
            "loop" if a["loop"] else "once", len(a["frames"]), a["move"],
            a["kind"], blend, len(a["pairs"]), span))


if __name__ == "__main__":
    main()
