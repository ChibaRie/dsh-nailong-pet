# 奶龙桌宠 · Nailong Desktop Pet（自优化版）

一只住在 Windows 桌面上的小奶龙：随 **DeepSeek Harness (DSH)** 自动启动，会发呆、走路、大笑、敲代码，还能陪你聊天。

> **⚑ 本仓库是二次开发（fork）项目**
> 底座代码**拉取自 [zhangkk833-byte/dsh-nailong-pet](https://github.com/zhangkk833-byte/dsh-nailong-pet)**；
> **3D 精灵图素材来自 [kirintea/dsh-nailong-pet](https://github.com/kirintea/dsh-nailong-pet)**。
> 本人（ZZY-STACK）在别人的基础上做了下面这些「自优化」，不是从零写的。

---

## 自优化清单

### 1. 形象：2D 手绘 → 3D 光泽
原版用的是 2D 手绘描边帧；本仓库换成了 kirintea 仓库的 **3D 光泽渲染图集**（同为 8 列 × 11 行、单元格 192×208、图集 1536×2288），并用仓库自带工具链重新切帧、重建 runtime manifest：

```bash
python tools/extract_frames.py    # 切帧 + 地面线对齐（8×11 → 88 帧）
python tools/build_manifest.py    # 生成 plugin/runtime/app/assets/manifest.json
```

> 说明：3D 图集的动作语义和原 2D 图集不完全一致（3D 版以 idle / walk / laugh / failed / thinking / coding / review 为主）。切帧后按最贴合的行重新映射，例如「害羞」映射到托腮行，避免出现西装坐桌这种违和画面。

### 2. 新功能：和奶龙对话
- 输入框旁出现 **🐣** 按钮，点开是聊天浮窗，直接打字聊天；
- 宿主半用 DSH 的 `ctx.llm` + `agentDefaultModel` 生成回复（与官方宠物插件同一套 LLM 抽象层）；
- 最近 20 轮对话自动落盘到 `~/.dsh/nailong-pet/chat-memory.json`，下次接着聊；
- 内置「活泼小奶龙」人格，可在 `cordis.patch.yml` 的 `chatPersona` 里自定义；
- 每次回复后，桌面上的奶龙会笑一下回应。

> 对话 UI 做在网页端（DSH 页面里），因为 DSH Desktop 会拦截「插件自拉进程 → 宿主 webServer」的裸 HTTP 请求；桌面奶龙本体只负责表演动作。

### 3. 素材来源署名
manifest 的 `meta.source` 已明确标注「zhangkk833-byte/dsh-nailong-pet + kirintea/dsh-nailong-pet 3D spritesheet (CC BY 4.0)」。

---

## 来源与授权

| 部分 | 来源 | 授权 |
|---|---|---|
| 底座代码（Electron 主进程 / 切帧管线 / DSH 插件骨架 / 原 2D 素材） | [zhangkk833-byte/dsh-nailong-pet](https://github.com/zhangkk833-byte/dsh-nailong-pet) | MIT |
| 3D 精灵图素材 | [kirintea/dsh-nailong-pet](https://github.com/kirintea/dsh-nailong-pet)（其 README 注灵感来自 nailong-codex-pet 系列） | CC BY 4.0 |

**请保留署名**：二次分发时保留本 README 的署名段落与上游仓库链接；素材按 CC BY 4.0 署名使用。

---

## 功能

| 功能 | 说明 |
|---|---|
| 🐣 13 组动作 | 发呆 / 走一走 / 跑一跑 / 打招呼 / 大笑 / 睡觉 / 坐一会 / 东张西望 / 敲键盘 / 害羞 / 放空 / 打哈欠 / 悠闲散步 |
| 🎞️ 3D 帧动画 | 88 帧切图，关键帧 + 帧间交叉淡化 |
| 💬 对话 | 点 🐣 浮窗，接 DSH LLM，带记忆与人格 |
| 🖱️ 拖拽移动 | 拖动 + 4 角吸附 + 边界约束 |
| 👆 点击互动 | 点奶龙 → 侧边动作面板 |
| 🚶 空闲漫游 | 待机时缓慢走动 |
| ⚙️ 随 DSH 起停 | 随 DSH 启动，DSH 退出时收工 |

## 安装

### 方式一：源码 link 模式（推荐）

```powershell
git clone https://github.com/ZZY-STACK/dsh-nailong-pet.git
cd dsh-nailong-pet
dsh plugin --profile desktop add link:./plugin
```

重启 DSH Desktop 即可看到奶龙。

### 方式二：独立运行（不启动 DSH）

双击仓库里的 `启动奶龙桌宠.bat`，奶龙会直接出现在屏幕右下角。

> 插件依赖 `$DSH_HOME/electron/electron.exe`；若没有，独立启动器会从 PATH 里找 electron。

## 命令

在 DSH 输入框里：

- `/nailong` —— 开关（开着收工、关着出笼）
- `/nailong 打招呼` / `大笑` / `敲键盘` / `睡觉` / `走` / `随机` —— 换动作
- `/nailong 右下角` —— 叫回右下角

## 许可证

- 代码：MIT（沿用底座）
- 素材：CC BY 4.0（保留上游署名）

## 致谢

- [zhangkk833-byte/dsh-nailong-pet](https://github.com/zhangkk833-byte/dsh-nailong-pet) —— 底座代码与 2D 素材
- [kirintea/dsh-nailong-pet](https://github.com/kirintea/dsh-nailong-pet) —— 3D 精灵图素材
- [Tomorins/nailong-codex-pet](https://github.com/Tomorins/nailong-codex-pet) —— 灵感来源
