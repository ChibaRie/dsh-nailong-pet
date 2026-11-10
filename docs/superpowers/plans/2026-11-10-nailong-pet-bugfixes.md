# 奶龙桌宠 Bug 修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修掉审查确认的 P0/P1 与可验证的 P2：暂停状态所有权、进程控制、启动失败回退、输入法、多显示器夹取、独立启动聊天、残留端口文件、启动竞态、空转渲染。

**Architecture:** 主进程把 `hold` 从布尔改成 owner 集合；插件把 `stop/start` 从「只认 child」改成「先走控制通道探测」；启动失败时进入可交互错误态；其余为单点小修。渲染端只增加「画面没变就不重绘」。

**Tech Stack:** Electron 43（无框架渲染端 + 原生 IPC）、Node 24（`node:test`）、DSH cordis 插件。

## Global Constraints

- 仓库不是 git checkout：无 commit 步骤。
- 只改与 bug 清单直接对应的行；不动相邻格式/注释；不新增配置项。
- 每次改动前先有失败证据；改完后跑同一检查。
- E2E 用 `%TEMP%` 下的独立副本 + 独立 app 名（独立 userData），不碰用户配置/进程。
- 行为断言在 `plugin/test/`（插件侧）与一次性 CDP 脚本（Electron 侧）；一次性脚本跑完删除。

---

### Task 1: 暂停所有权（P0-1/P0-2）

**Files:**
- Modify: `plugin/runtime/app/main.js`（`showPanel`/`hidePanel`/`showChat`/`hideChat`、新增 `pausePet`/`resumePet`/`followDialogs`）

**Interfaces:**
- Produces: `pausePet(owner: 'panel'|'chat')`、`resumePet(owner)`、`followDialogs(): void`

- [x] **Step 1: 复现（红）** 独立副本 + CDP：面板→聊天→关聊天后 `S.hold === true` 且 stroll 不动；面板打开时 `S.hold` 可能为 false。
- [x] **Step 2: 实现** owner 集合；最后一个 owner 释放才 `send('resume')`；聊天关闭释放自己的 owner。
- [x] **Step 3: 跟随** `followDialogs()` 在 `pet:move` / `goHome` / `second-instance` 后重新贴面板与聊天窗。
- [x] **Step 4: 验证（绿）** `S.hold` 在聊天关后为 false 且 stroll 移动；面板打开时为 true 且不移动。

### Task 2: 插件进程控制（P0-3 + 启动竞态）

**Files:**
- Modify: `plugin/index.js`
- Test: `plugin/test/process-control.test.mjs`、`plugin/package.json`（`scripts.test`）

**Interfaces:**
- Produces: `async probe(): boolean`、`async waitForPet(ms): boolean`、`async stop(reason): boolean`、`async start(): {ok, already?, started?, ready}`

- [x] **Step 1: 写测试（红）** 假 ctx + 假控制服务器 + `NAILONG_ELECTRON_PATH` 指向不存在路径：
  - `/start` 应 `{ok:true, already:true}`（旧代码 `{ok:false}`）
  - `/stop` 应 `{ok:true}` 且假服务器收到 `/quit`（旧代码 `{ok:false}`）
  - 插件 dispose 后 `host-chat.json` 被删除（旧代码残留）
- [x] **Step 2: 实现** `control()` 加超时；`probe()`；`start()` 先探测再 spawn，spawn 后等 ready；`stop()` 杀 child 否则 `/quit`；删除 `reap` 并合并注释；dispose 删除属于本进程的 `host-chat.json`。
- [x] **Step 3: 命令/路由** `/toggle`、`/stop`、`/action`、`/start`、`/state`、`/nailong` 改为 await；未知动作先校验再启动。
- [x] **Step 4: 验证（绿）** `node --test` 全绿。

### Task 3: 启动失败回退（P1-4）

**Files:**
- Modify: `plugin/runtime/app/src/pet.js`、`plugin/runtime/app/src/panel.js`

- [x] **Step 1: 复现（红）** 副本删 `assets/manifest.json`：宠物窗不显示/不可交互；面板打开后宠物 `S.hold=true` 且 `panelWanted` 不清。
- [x] **Step 2: 实现** pet：`errorState` 标记 + `setInteractive` 强制 true + `host.ready()`；panel：`fail()` 调 `host.ready()`（显示可关闭的错误面板）。
- [x] **Step 3: 验证（绿）** 失败页可见；`setInteractive(false)` 后仍为 true；面板失败后可关闭并恢复 `hold=false`。

### Task 4: 输入法 Enter（P1-5）

**Files:**
- Modify: `plugin/client.js`、`plugin/runtime/app/src/chat.js`

- [x] **Step 1: 复现（红）** 桌面聊天输入框派发 `keydown`（`key:'Enter'`, `isComposing:true`）→ 消息被发出。
- [x] **Step 2: 实现** `e.isComposing || e.keyCode === 229` 时 return（React 用 `e.nativeEvent`）。
- [x] **Step 3: 验证（绿）** 组合态 Enter 不发；普通 Enter 照发。

### Task 5: 多显示器夹取（P1-6）

**Files:**
- Modify: `plugin/runtime/app/main.js`（`clampToWorkArea`）

- [x] **Step 1: 实现** 用「目标矩形中心所属显示器」的 workArea 夹取（`screen.getDisplayNearestPoint(center)`），不再依赖当前窗口的 4s 缓存。
- [x] **Step 2: 验证** 单屏 smoke 不回归；跨屏无法实机（仅一屏），代码审查 + 单屏等价性。

### Task 6: 独立启动聊天 + 残留文件（P2）

**Files:**
- Modify: `plugin/runtime/app/main.js`（`hostChatUrl`）、`plugin/index.js`（dispose）

- [x] **Step 1: 复现（红）** 不设 `NAILONG_HOST_CHAT_FILE`、`DSH_HOME` 下有 `host-chat.json` → 聊天报「服务未就绪」。
- [x] **Step 2: 实现** 默认读取 `$DSH_HOME/nailong-pet/host-chat.json`；env 覆盖仍优先。
- [x] **Step 3: 验证（绿）** 假聊天服务返回文本，桌面聊天窗显示该文本。

### Task 7: 空转渲染（P2）

**Files:**
- Modify: `plugin/runtime/app/src/pet.js`（`render`/`tick`/`S.painted`）

- [x] **Step 1: 复现（红）** 单帧动作（`sit`）下 `S.painted` 每秒 +180。
- [x] **Step 2: 实现** 以「实际绘制结果」为 key（帧对、混合权重、镜像、布局、位图版本），相同则跳过绘制；`S.painted` 只统计真实绘制。
- [x] **Step 3: 验证（绿）** 单帧动作下 1s 内绘制数接近 0；正常动画/镜像/缩放仍重绘。

### Task 8: 全量验证与清理

- [x] `node --check` 全部改动文件
- [x] `node --test plugin/test`
- [x] Electron E2E（红→绿）全场景通过
- [x] `NAILONG_SMOKE=1` 截图 smoke 正常
- [x] 删除 `%TEMP%` 副本、一次性脚本、测试 userData

## 验证结果

- 插件回归 `node --test`：6/6 通过（修复前 2/6）。
- Electron E2E（独立副本 + CDP，`%TEMP%` 一次性脚本）：修复前 5/15 → 修复后 **15/15**。
  - 暂停所有权：面板打开 hold=true；聊天打开 hold=true；关聊天 hold=false 且 stroll 能移动。
  - 跟随：聊天窗随奶龙 `(-200,-100)` 同步位移。
  - 输入法：组合态 Enter 不发、普通 Enter 收到 `E2E-OK`。
  - 启动失败：宠物错误窗可见且 `setInteractive(false)` 仍被强制为可交互；面板错误页可见、可关闭并恢复。
  - 独立启动聊天：未设 `NAILONG_HOST_CHAT_FILE` 也能收到回复。
  - 空转渲染：单帧动作 1s 内真实重绘 +0（修复前 +182/s）。
- `NAILONG_SMOKE=1`：绘制 3.3/s（rAF 180/s），命中率 0.192、四角 false、截图正常。
- 限制：本机只有一块显示器，跨屏夹取未实机验证；仓库不是 git checkout，无 commit。
