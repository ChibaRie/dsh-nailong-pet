# -*- coding: utf-8 -*-
"""对每个动作各跑一次 Electron 冒烟截图，输出 work/shots/<key>.png。

用法: smoke_all.py [key ...]     不带参数则跑全部
"""
import json
import os
import subprocess
import sys

ROOT = r"D:\娱乐\draft\nailong-pet"
APP = os.path.join(ROOT, "plugin", "runtime", "app")
ELECTRON = r"C:\Users\19725\.dsh\electron\electron.exe"
OUT = os.path.join(ROOT, "work", "shots")


def manifest_keys():
    """动作清单直接从 assets/manifest.json 读，避免和语义表脱节"""
    with open(os.path.join(APP, "assets", "manifest.json"), encoding="utf-8") as f:
        return [a["key"] for a in json.load(f)["animations"]]


keys = sys.argv[1:] or manifest_keys()
os.makedirs(OUT, exist_ok=True)

env = dict(os.environ)
env.pop("ELECTRON_RUN_AS_NODE", None)
env["NAILONG_SMOKE"] = "1"
# 强制动作在 t=300ms 发出，这里 1300ms 截图 —— 落在动作正在播的区间里。
# 之前用 2400ms，走的动作（1.8~4.2s 随机时长）有时已经播完回到待机，截出来像待机。
env["NAILONG_SMOKE_DELAY"] = "1300"

for k in keys:
    target = os.path.join(OUT, k + ".png")
    # 先删掉上一次的产物：否则"文件已存在"会把失败误报成成功
    if os.path.exists(target):
        os.remove(target)
    env["NAILONG_SMOKE_OUT"] = target
    env["NAILONG_FORCE"] = k
    try:
        p = subprocess.run([ELECTRON, APP], env=env, capture_output=True, timeout=90)
        log = (p.stdout + p.stderr).decode("utf-8", "replace").strip()
    except subprocess.TimeoutExpired:
        log = "TIMEOUT"
    ok = os.path.exists(target)
    print("[%s] %s  %s" % ("OK " if ok else "FAIL", k, log.replace("\n", " | ")[:200]))
