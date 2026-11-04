'use strict';
/**
 * 奶龙桌宠 —— Electron 主进程
 *
 * 设计要点（沿用 DSH dsh-pet electron-helper 踩过的坑）：
 *  - 窗口只包住奶龙本体（局部小透明窗），不做全屏透明画布：
 *    铺满工作区的分层透明置顶窗会触发 Windows DWM 合成黑屏。
 *  - Windows 上关掉硬件加速：规避 WS_EX_LAYERED 在 DWM 下的黑边/内容丢失。
 *  - 点击穿透：默认 setIgnoreMouseEvents(true, {forward:true})；
 *    渲染端按当前帧的 alpha 命中测试翻转交互态，避免矩形窗口挡住桌面。
 *  - 窗口位置由主进程持有，渲染端只报增量位移，边界钳制在 workArea 内。
 *  - 页面走自定义协议 pet://app/（绝不走 file://）：
 *    file:// 下 canvas.getImageData 取每帧 alpha 掩码会被跨源污染拦住。
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const { app, BrowserWindow, ipcMain, Menu, screen, protocol } = require('electron');

const ROOT = __dirname;
const IS_WIN = process.platform === 'win32';
const SMOKE = !!process.env.NAILONG_SMOKE;
// 调试接口（/debug/*）只在显式打开时注册，正常使用不暴露
const DEBUG = !!process.env.NAILONG_DEBUG;

// 单元格尺寸（与 assets/manifest.json 的 meta 保持一致）
const CELL_W = 192;
const CELL_H = 208;
// 奶龙四周留白：走路时手脚会探出单格，留一点余量避免被裁
const MARGIN = { x: 26, top: 26, bottom: 26 };
// v1 的默认是 1.6；v2 砍半到 0.8；v3 再降到 0.6。
// v4：用户要求把尺寸**锁死**在小（60%），不再提供任何改大小的入口，
//     所以这里是一个常量 —— 全文件没有任何地方会给它重新赋值。
const LOCKED_SCALE = 0.6;
// 布局算法换了（尺寸锁死 + 旧位置的窗口尺寸都不对了），旧配置的位置一律重算
const CONFIG_VERSION = 4;
const EDGE_GAP = 40;

// 侧边动作面板的尺寸与贴边间距
const PANEL_W = 184;
const PANEL_H = 604;
const PANEL_GAP = 8;

if (IS_WIN) app.disableHardwareAcceleration();

protocol.registerSchemesAsPrivileged([{
  scheme: 'pet',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
}]);

let win = null;
let interactive = false;
// 尺寸锁死：这是个 const，运行期不会变。保留变量名是为了让下面所有
// windowSize(scale) / applyContentBounds(...) 的调用点不用改。
const scale = LOCKED_SCALE;
let cachedWorkArea = null;
let cachedWorkAreaAt = 0;
let lastHit = 0;
// pet:move 的亚像素余量（见 pet:move 处理里的说明）
let pendingX = 0;
let pendingY = 0;
let quitting = false;

// ---------------------------------------------------------------- 配置持久化
function configPath() {
  return path.join(app.getPath('userData'), 'nailong-pet.json');
}
function loadConfig() {
  // 冒烟模式不读配置：截图要的是确定性的初始状态，别被用户上次调的位置影响
  if (SMOKE) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    // 只认位置。大小已经锁死，配置里的 scale（不管是谁写的）一律忽略。
    if (raw.v !== CONFIG_VERSION) {
      // 旧布局是按别的窗口尺寸算出来的，位置也一并重算到右下角
      raw.x = NaN;
      raw.y = NaN;
    }
    return raw;
  } catch (_) {
    return {};
  }
}
let saveTimer = null;
let pendingPatch = {};
// 立刻落盘。退出路径必须用这个 —— 防抖版本在 app.quit() 之后根本没机会触发。
function writeConfigNow() {
  // 冒烟模式绝不落盘：冒烟会把窗口挪到 (60,60) 并跑动作，
  // 一旦写回去就把用户真实的右下角位置和大小覆盖掉了。
  if (SMOKE) return;
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch (_) { /* 首次运行 */ }
  const next = Object.assign({}, cur, pendingPatch, { v: CONFIG_VERSION });
  delete next.scale;   // 尺寸锁死了，别让历史遗留的 scale 留在配置文件里误导人
  pendingPatch = {};
  if (win && !win.isDestroyed()) {
    const b = contentBounds();
    next.x = b.x; next.y = b.y;
  }
  try { fs.writeFileSync(configPath(), JSON.stringify(next, null, 2)); } catch (_) { /* 忽略 */ }
}
function saveConfig(patch) {
  pendingPatch = Object.assign(pendingPatch, patch || {});
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(writeConfigNow, 400);
}

// ---------------------------------------------------------------- 几何计算
// 注意：窗口用 useContentSize:true 创建，窗口边界与"内容区"之间有一条不可见边框。
// 混用 getBounds() 与 setBounds() 会让每次调用把边框再加一遍 —— 走路时窗口会越走越宽。
// 因此这里一律走 getContentBounds()/setContentBounds()，两边严格对称。
function contentBounds() {
  try {
    return win.getContentBounds();
  } catch (_) {
    return { x: 0, y: 0, ...windowSize(scale) };
  }
}
/** 任意窗口的内容区（面板用；同样的 get/set 对称规则） */
function contentBoundsOf(w) {
  try {
    return w.getContentBounds();
  } catch (_) {
    return { x: 0, y: 0, width: PANEL_W, height: panelH };
  }
}
function windowSize(s) {
  return {
    width: Math.round(CELL_W * s) + MARGIN.x * 2,
    height: Math.round(CELL_H * s) + MARGIN.top + MARGIN.bottom,
  };
}
function workArea(force) {
  const now = Date.now();
  if (force || !cachedWorkArea || now - cachedWorkAreaAt > 4000) {
    const b = win && !win.isDestroyed() ? contentBounds() : { x: 0, y: 0, width: 1, height: 1 };
    cachedWorkArea = screen.getDisplayMatching(b).workArea;
    cachedWorkAreaAt = now;
  }
  return cachedWorkArea;
}
function clampToWorkArea(x, y, w, h) {
  const wa = workArea();
  let hit = 0;
  if (x <= wa.x) { x = wa.x; hit |= 1; }
  if (x + w >= wa.x + wa.width) { x = wa.x + wa.width - w; hit |= 2; }
  if (y <= wa.y) { y = wa.y; hit |= 4; }
  if (y + h >= wa.y + wa.height) { y = wa.y + wa.height - h; hit |= 8; }
  return { x, y, hit };
}
function applyContentBounds(x, y, w, h) {
  const c = clampToWorkArea(Math.round(x), Math.round(y), w, h);
  win.setContentBounds({ x: c.x, y: c.y, width: w, height: h });
  return c;
}

// ---------------------------------------------------------------- pet:// 协议
function registerPetProtocol() {
  protocol.registerFileProtocol('pet', (request, callback) => {
    try {
      const url = new URL(request.url);
      let rel = decodeURIComponent(url.pathname || '/');
      if (rel === '/' || rel === '') rel = '/src/index.html';
      const abs = path.normalize(path.join(ROOT, rel));
      if (!abs.startsWith(ROOT)) return callback({ error: -10 }); // 越界访问
      callback({ path: abs });
    } catch (err) {
      callback({ error: -6 });
    }
  });
}

// ---------------------------------------------------------------- 窗口
function createWindow() {
  const size = windowSize(scale);
  const wa = screen.getPrimaryDisplay().workArea;
  const cfg = loadConfig();
  let x = wa.x + wa.width - size.width - EDGE_GAP;
  let y = wa.y + wa.height - size.height - EDGE_GAP;
  if (Number.isFinite(cfg.x) && Number.isFinite(cfg.y)) {
    const c = clampToWorkArea(Math.round(cfg.x), Math.round(cfg.y), size.width, size.height);
    x = c.x; y = c.y;
  }

  win = new BrowserWindow({
    width: size.width,
    height: size.height,
    x: Math.round(x),
    y: Math.round(y),
    title: '奶龙桌宠',
    transparent: true,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    focusable: true,
    useContentSize: true,
    show: false,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true, { forward: true });
  win.webContents.on('context-menu', (e) => e.preventDefault());
  win.loadURL('pet://app/src/index.html');

  // 渲染端把 74 帧全部解码 + 建好 alpha 掩码后才报到，避免开窗先闪一下空白
  win.webContents.once('did-finish-load', () => {
    if (SMOKE) return;
    setTimeout(() => { if (!quitting) showPet(); }, 8000); // 兜底
  });

  win.on('closed', () => { win = null; });
  win.on('close', () => { writeConfigNow(); });
}

function showPet() {
  if (!win || win.isDestroyed() || win.isVisible()) return;
  win.showInactive(); // 不抢当前前台窗口的焦点
  startCursorPoll();
  // 调试开关：NAILONG_OPEN_PANEL=1 时开机就把动作面板弹出来（正常使用是靠点奶龙）
  if (process.env.NAILONG_OPEN_PANEL) setTimeout(() => showPanel(), 1200);
  // 调试开关：NAILONG_MOOD=stroll|sit|stand 强制指定开机后的第一个待机情绪
  const mood = process.env.NAILONG_MOOD;
  if (mood) {
    setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      win.webContents.executeJavaScript(
        'window.__nailong.selectIdleMood(' + JSON.stringify(mood) + ')'
      ).catch(() => {});
    }, 900);
  }
  // 调试开关：NAILONG_TRACE=<秒数> 每隔 1 秒打印一次行为状态，用来核对待机节奏
  const traceSecs = Number(process.env.NAILONG_TRACE || 0);
  if (traceSecs > 0) {
    const t0 = Date.now();
    const timer = setInterval(async () => {
      const el = (Date.now() - t0) / 1000;
      if (el > traceSecs || !win || win.isDestroyed()) { clearInterval(timer); return; }
      try {
        const s = await win.webContents.executeJavaScript(
          'JSON.stringify({m:window.__nailong.S.mode,k:window.__nailong.S.idleKind||"-",'
          + 'a:window.__nailong.S.anim.key,f:Math.round(window.__nailong.S.pos),'
          + 'ms:window.__nailong.S.moveSpeed,md:window.__nailong.S.moveDir,'
          + 'he:(window.__nailong.S.hitEdge.l?1:0)+(window.__nailong.S.hitEdge.r?2:0),'
          + 'mir:window.__nailong.S.mirrored?1:0})');
        console.log('[trace] t=%s x=%s %s', el.toFixed(0), contentBounds().x, s);
      } catch (_) { /* 忽略 */ }
    }, 1000);
  }
}

// ---------------------------------------------------------------- 全局光标轮询
// 踩坑（DSH 的 dsh-pet 也栽在同一处，见 dsh-pet-repair/patch-interaction.mjs）：
// Windows 上窗口一旦失去焦点，`setIgnoreMouseEvents(true, {forward:true})` 就不再投递
// mousemove 给渲染进程，命中测试会永远停在最后一次的结果 —— 表现为"奶龙突然点不动了"，
// 或反过来一直被判为可点击、挡住桌面。
//
// 所以交互判定不依赖 DOM 事件：主进程以 ~20Hz 轮询全局光标位置，换算成窗口内坐标后
// 推给渲染端，由渲染端拿当前帧的 alpha 掩码做命中测试再翻回来。
const CURSOR_POLL_MS = 50;
let cursorTimer = null;
let lastCursor = { x: -99999, y: -99999 };

function startCursorPoll() {
  if (cursorTimer || SMOKE) return;
  cursorTimer = setInterval(() => {
    try {
      if (!win || win.isDestroyed() || !win.isVisible()) return;
      const pt = screen.getCursorScreenPoint();
      const b = contentBounds();
      const lx = Math.round(pt.x - b.x);
      const ly = Math.round(pt.y - b.y);
      if (lx === lastCursor.x && ly === lastCursor.y) return;
      lastCursor = { x: lx, y: ly };
      const inside = lx >= 0 && ly >= 0 && lx < b.width && ly < b.height;
      win.webContents.send('pet:cursor', { x: lx, y: ly, inside });
    } catch (_) {
      // 定时器回调里抛异常会以未捕获异常的形式崩掉整个进程，必须吞掉
    }
  }, CURSOR_POLL_MS);
}

// ---------------------------------------------------------------- 侧边动作面板
// 点一下奶龙就在它旁边弹出一张动作面板；做成独立窗口，不把主窗口撑大：
// 主窗口能一直保持"刚好包住奶龙"的小尺寸，实践证明窗越小越不会干扰桌面合成。
let panel = null;
let panelH = PANEL_H;      // 面板实测高度（内容量出来的，见 panel:resize）
let panelReady = false;    // 页面已经量好高度
let panelWanted = false;   // 用户点了奶龙，等面板准备好就显示

function panelPlacement(height) {
  const b = contentBounds();
  const wa = workArea();
  const h = Math.min(height, wa.height - 40);
  let x;
  if (b.x + b.width + PANEL_GAP + PANEL_W <= wa.x + wa.width) {
    x = b.x + b.width + PANEL_GAP;          // 优先放右边
  } else {
    x = b.x - PANEL_GAP - PANEL_W;          // 右边放不下就放左边
  }
  x = Math.max(wa.x, Math.min(x, wa.x + wa.width - PANEL_W));
  // 面板的底边对齐奶龙的地面线，让它从奶龙旁边往上展开，而不是浮在离奶龙很远的地方
  const petBottom = b.y + b.height - MARGIN.bottom;
  let y = petBottom - h;
  y = Math.max(wa.y, Math.min(y, wa.y + wa.height - h));
  return { x: Math.round(x), y: Math.round(y), h };
}

function createPanel() {
  const p = panelPlacement(panelH);
  panelReady = false;
  panel = new BrowserWindow({
    width: PANEL_W,
    height: p.h,
    x: p.x,
    y: p.y,
    title: '奶龙动作面板',
    transparent: true,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    focusable: true,
    useContentSize: true,
    show: false,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });
  panel.setAlwaysOnTop(true, 'screen-saver');
  panel.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  panel.webContents.on('context-menu', (e) => e.preventDefault());
  panel.loadURL('pet://app/src/panel.html');
  // 点到别处就收起来（面板是拿焦点的弹出层，blur = 用户走开了）。
  //
  // 但**不能见到 blur 就收**：实机里 show()/focus() 之后经常立刻收到一次
  // 纯焦点抖动的 blur（另一只置顶窗重画、输入法抢焦点都会触发），
  // 结果面板刚弹出来就自己消失了 —— 表现就是"面板里的按钮点了没用"。
  // 所以只在"鼠标确实已经不在面板矩形内"时才当成用户走开。
  // 冒烟模式完全不装：自检过程窗口会失焦，拍出来是空的。
  if (!SMOKE) {
    panel.on('blur', () => {
      if (!panel || panel.isDestroyed()) return;
      try {
        const pt = screen.getCursorScreenPoint();
        const b = contentBoundsOf(panel);
        const inside = pt.x >= b.x && pt.x < b.x + b.width
          && pt.y >= b.y && pt.y < b.y + b.height;
        if (inside) return;
      } catch (_) { /* 量不到就按走开处理 */ }
      hidePanel('blur');
    });
  }
  panel.on('closed', () => { panel = null; panelReady = false; });
  panel.on('close', (e) => { if (!quitting) { e.preventDefault(); hidePanel('close-event'); } });
}

function showPanelNow() {
  if (!panel || panel.isDestroyed()) return;
  const p = panelPlacement(panelH);
  panel.setContentBounds({ x: p.x, y: p.y, width: PANEL_W, height: p.h });
  panel.show();
  panel.focus();
  panel.webContents.send('panel:state', panelState());
}

function showPanel() {
  if (quitting) return;
  panelWanted = true;
  // 让奶龙先站住，面板才有一个稳定的锚点
  send('pause');
  if (!panel || panel.isDestroyed()) { createPanel(); return; } // 页面 ready 后会回调
  if (panelReady) showPanelNow();
}

/** 奶龙挪过位置之后，把已经开着的面板重新贴回它旁边（不抢焦点） */
function repositionPanel() {
  if (!panel || panel.isDestroyed() || !panel.isVisible()) return;
  const p = panelPlacement(panelH);
  panel.setContentBounds({ x: p.x, y: p.y, width: PANEL_W, height: p.h });
}

function hidePanel(reason) {
  if (DEBUG) {
    console.log('[panel] hide (%s) wanted=%s visible=%s', reason || '?', panelWanted,
      !!(panel && !panel.isDestroyed() && panel.isVisible()));
  }
  panelWanted = false;
  if (panel && !panel.isDestroyed() && panel.isVisible()) panel.hide();
  send('resume');   // 面板收起来了，奶龙可以继续自己的节奏
}

function panelState() {
  return { visible: !!(panel && !panel.isDestroyed() && panel.isVisible()) };
}

// ---------------------------------------------------------------- IPC
function registerIpc() {
  ipcMain.on('pet:set-interactive', (_e, v) => {
    if (!win || win.isDestroyed()) return;
    v = !!v;
    if (v === interactive) return;
    interactive = v;
    win.setIgnoreMouseEvents(!v, { forward: true });
  });

  ipcMain.on('pet:ready', () => {
    if (SMOKE) return;
    showPet();
  });

  // 走路/拖拽用的增量位移。用 send 而不是 invoke：每帧一次，省掉 Promise 往返。
  //
  // 位移必须**累加**再取整：渲染端每帧只走零点几像素（34 px/s ÷ 120Hz ≈ 0.28px），
  // 如果每帧各自 Math.round 一次再读回整数值，小数部分每帧都被丢掉 ——
  // 慢速散步就会永远卡在原地（96 px/s 的走路因为每帧 >0.5px 反而不受影响）。
  ipcMain.on('pet:move', (_e, msg) => {
    if (!win || win.isDestroyed()) return;
    // 面板开着的时候奶龙必须站住：一边散步一边把面板顶掉的话，
    // 用户根本来不及点里面的按钮（这是"面板点不动"的真凶之一）。
    if (panelWanted) return;
    pendingX += Number(msg && msg.dx) || 0;
    pendingY += Number(msg && msg.dy) || 0;
    const dx = Math.trunc(pendingX);
    const dy = Math.trunc(pendingY);
    if (!dx && !dy) return;
    pendingX -= dx;
    pendingY -= dy;
    const b = contentBounds();
    const c = applyContentBounds(b.x + dx, b.y + dy, b.width, b.height);
    // 走路时每帧都调，防抖会一直顺延；停下 400ms 后才真正落盘一次。
    // 这样即使进程被强杀，位置也基本是新的。
    saveConfig({});
    // 只在"撞墙状态发生变化"时回推，避免每帧 IPC
    if (c.hit !== lastHit) {
      lastHit = c.hit;
      win.webContents.send('pet:edge', { hit: c.hit, bounds: contentBounds() });
    }
  });

  ipcMain.handle('pet:geometry', () => {
    const b = contentBounds();
    return {
      scale,
      margin: MARGIN,
      cell: { w: CELL_W, h: CELL_H },
      bounds: b,
      workArea: workArea(true),
      screen: screen.getDisplayMatching(b).workArea,
    };
  });

  ipcMain.handle('pet:home', () => goHome());

  ipcMain.handle('pet:set-ignore-pointer', (_e, v) => {
    if (!win || win.isDestroyed()) return false;
    interactive = !!v;
    win.setIgnoreMouseEvents(!interactive, { forward: true });
    return interactive;
  });

  ipcMain.on('pet:quit', () => quitPet());

  ipcMain.on('pet:open-panel', () => { showPanel(); });
  ipcMain.on('pet:close-panel', () => { hidePanel('pet-close'); });

  // ---- 面板侧
  ipcMain.handle('panel:state', () => panelState());
  ipcMain.handle('panel:resize', (_e, h) => {
    const wa = workArea();
    const next = Math.max(180, Math.min(Math.round(Number(h) || PANEL_H), wa.height - 40));
    // 只有高度真的变了才重排窗口。
    // 面板页在 onState 里也会 fit()，如果这里无条件 showPanelNow()，
    // showPanelNow → panel:state → fit → panel:resize → showPanelNow 就成了死循环。
    const changed = next !== panelH;
    panelH = next;
    if (changed && panelWanted && panelReady) showPanelNow();
    return panelH;
  });
  ipcMain.on('panel:ready', () => {
    panelReady = true;
    if (panelWanted) showPanelNow();
  });
  ipcMain.on('panel:act', (_e, key) => {
    if (typeof key !== 'string' || !key) return;
    send('action:' + key);
    hidePanel('panel-act');
  });
  ipcMain.on('panel:home', () => { send('home'); hidePanel('panel-home'); });
  ipcMain.on('panel:quit', () => quitPet());
  ipcMain.on('panel:close', () => { hidePanel('panel-close'); });

  ipcMain.on('pet:context-menu', () => {
    if (!win || win.isDestroyed()) return;
    Menu.buildFromTemplate(buildMenuTemplate()).popup({ window: win });
  });
}

function send(cmd) {
  if (win && !win.isDestroyed()) win.webContents.send('pet:command', cmd);
}

function goHome() {
  if (!win || win.isDestroyed()) return null;
  const b = contentBounds();
  const wa = workArea(true);
  applyContentBounds(
    wa.x + wa.width - b.width - EDGE_GAP,
    wa.y + wa.height - b.height - EDGE_GAP,
    b.width, b.height);
  lastHit = 0;
  return contentBounds();
}

function quitPet() {
  quitting = true;
  app.quit();
}

// ---------------------------------------------------------------- 本地控制通道
// DSH 插件（plugin/index.js）需要在奶龙**已经跑起来之后**继续控制它 ——
// 换动作、叫回家。做法：启动时开一个只监听 127.0.0.1、端口由系统分配的
// HTTP 服务，把端口写进 userData/control.json，插件读那个文件再发请求。
// 不用 stdin：Electron 的 main 进程读不到被 pipe 的 stdin（electron#4218）。
let controlServer = null;

function controlFilePath() {
  return path.join(app.getPath('userData'), 'control.json');
}

function startControlServer() {
  if (controlServer || SMOKE) return;
  controlServer = http.createServer(async (req, res) => {
    const reply = (obj, code) => {
      const body = JSON.stringify(obj);
      res.writeHead(code || 200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
      });
      res.end(body);
    };
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      switch (url.pathname) {
        case '/state':
          return reply({
            ok: true,
            scale,
            bounds: contentBounds(),
            visible: !!(win && !win.isDestroyed() && win.isVisible()),
          });
        case '/action': {
          const key = url.searchParams.get('key');
          if (!key) return reply({ ok: false, error: 'missing key' }, 400);
          send('action:' + key);
          return reply({ ok: true, key });
        }
        case '/home':
          return goHome() ? reply({ ok: true }) : reply({ ok: false }, 409);
        case '/panel':
          if (url.searchParams.get('close')) { hidePanel('http'); return reply({ ok: true, open: false }); }
          showPanel();
          return reply({ ok: true, open: true });
        // ---- 调试接口（仅在 NAILONG_DEBUG=1 时开放）
        case '/debug/panel': {
          if (!DEBUG) return reply({ ok: false, error: 'debug off' }, 403);
          if (!panel || panel.isDestroyed()) return reply({ ok: true, panel: null });
          const pb = contentBoundsOf(panel);
          const info = await panel.webContents.executeJavaScript(`(() => {
            const r = (el) => { const b = el.getBoundingClientRect(); return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]; };
            return { dpr: devicePixelRatio, card: r(document.getElementById('card')),
              rows: document.querySelectorAll('#acts .row').length };
          })()`).catch((err) => ({ error: String(err && err.message) }));
          return reply({ ok: true, panel: pb, visible: panel.isVisible(), ...info });
        }
        case '/quit':
          reply({ ok: true });
          return setTimeout(() => quitPet(), 50);
        default:
          return reply({ ok: false, error: 'not found' }, 404);
      }
    } catch (err) {
      try { reply({ ok: false, error: String((err && err.message) || err) }, 500); } catch (_) {}
    }
  });
  controlServer.on('error', () => { controlServer = null; });
  controlServer.listen(0, '127.0.0.1', () => {
    try {
      fs.writeFileSync(controlFilePath(), JSON.stringify({
        v: 1, port: controlServer.address().port, pid: process.pid,
      }));
    } catch (_) { /* 写不进去也不影响启动 */ }
  });
}

function stopControlServer() {
  try { fs.unlinkSync(controlFilePath()); } catch (_) {}
  if (controlServer) { try { controlServer.close(); } catch (_) {} controlServer = null; }
}

function buildMenuTemplate() {
  return [
    { label: '奶龙', enabled: false },
    { type: 'separator' },
    { label: '动作面板…', click: () => showPanel() },
    { type: 'separator' },
    { label: '打个招呼', click: () => send('action:wave') },
    { label: '开怀大笑', click: () => send('action:laugh') },
    { label: '害羞一下', click: () => send('action:shy') },
    { label: '敲键盘', click: () => send('action:work') },
    { label: '坐一会', click: () => send('action:sit') },
    { label: '去睡觉', click: () => send('action:sleep') },
    { type: 'separator' },
    { label: '走一走', click: () => send('action:walk') },
    { label: '跑一跑', click: () => send('action:run') },
    { label: '悠闲散步', click: () => send('action:stroll') },
    { label: '随便动一动', click: () => send('action:random') },
    { type: 'separator' },
    { label: '回到右下角', click: () => send('home') },
    { type: 'separator' },
    { label: '退出奶龙', click: () => { quitting = true; app.quit(); } },
  ];
}

// ---------------------------------------------------------------- 冒烟自检
// 在渲染端跑一段探针：核对 alpha 命中测试的覆盖率与位置是否合理
const SMOKE_PROBE_JS = `(async () => {
  const N = window.__nailong;
  if (!N) return JSON.stringify({ error: 'no __nailong' });
  const S = N.S, L = S.layout;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // 先量一段真实绘制帧率：渲染端每帧会自增 S.painted
  const p0 = S.painted || 0, fpsT0 = performance.now();
  let raf = 0;
  await new Promise(res => {
    const stop = performance.now() + 1500;
    const tick = () => { raf++; if (performance.now() < stop) requestAnimationFrame(tick); else res(); };
    requestAnimationFrame(tick);
  });
  const realFps = +(((S.painted || 0) - p0) / ((performance.now() - fpsT0) / 1000)).toFixed(1);
  const rafFps = +(raf / ((performance.now() - fpsT0) / 1000)).toFixed(1);
  const hr = N.currentFrameDef();
  const out = {
    anim: S.anim.key, pos: +S.pos.toFixed(2), frame: hr.name, oy: hr.oy, h: hr.h, w: hr.w,
    ox: S.anim.ox, mirrored: S.mirrored, blend: +(N.frameBlend().frac || 0).toFixed(2),
    fps: realFps, rafFps,
    inner: [innerWidth, innerHeight],
    cell: [Math.round(L.cellX), Math.round(L.cellY), Math.round(L.cellW), Math.round(L.cellH)],
  };
  let hit = 0, total = 0, hits = [];
  const GX = 48, GY = 54;
  for (let gy = 0; gy < GY; gy++) for (let gx = 0; gx < GX; gx++) {
    const x = (gx + 0.5) * innerWidth / GX, y = (gy + 0.5) * innerHeight / GY;
    total++;
    if (N.hitTest(x, y)) { hit++; hits.push([x, y]); }
  }
  out.hitRatio = +(hit / total).toFixed(3);
  out.corners = [N.hitTest(1,1), N.hitTest(innerWidth-2,1), N.hitTest(1,innerHeight-2), N.hitTest(innerWidth-2,innerHeight-2)];
  out.center = N.hitTest(L.cellX + L.cellW/2, L.cellY + L.cellH*0.65);
  if (hits.length) {
    out.hitBBox = [
      Math.round(Math.min(...hits.map(p => p[0]))), Math.round(Math.min(...hits.map(p => p[1]))),
      Math.round(Math.max(...hits.map(p => p[0]))), Math.round(Math.max(...hits.map(p => p[1]))),
    ];
  }
  return JSON.stringify(out);
})()`;

// 面板自检：把侧边动作面板拍成一张 PNG，顺便数一数按钮有没有渲染出来
function setupPanelSmoke(out, delay) {
  win.webContents.once('did-finish-load', () => {
    win.showInactive();
    setTimeout(() => {
      showPanel();
      if (!panel || panel.isDestroyed()) {
        console.error('[smoke] panel 没建起来');
        quitting = true;
        return app.quit();
      }
      setTimeout(async () => {
        const js = (s) => panel.webContents.executeJavaScript(s);
        try {
          const probe = await js(
            'JSON.stringify({rows: document.querySelectorAll("#acts .row").length,' +
            ' sects: document.querySelectorAll("#acts .sect").length,' +
            ' hasSizes: !!document.getElementById("sizes")})');
          console.log('[smoke] panel probe=%s', probe);
        } catch (err) {
          console.log('[smoke] panel probe failed: %s', err && err.message);
        }
        try {
          const img = await panel.webContents.capturePage();
          fs.mkdirSync(path.dirname(out), { recursive: true });
          fs.writeFileSync(out, img.toPNG());
          console.log('[smoke] panel captured ->', out);
        } catch (err) {
          console.error('[smoke] panel capture failed:', err && err.message);
        }
        quitting = true;
        app.quit();
      }, delay);
    }, 700);
  });
}

function setupSmoke() {
  const out = process.env.NAILONG_SMOKE_OUT || path.join(ROOT, 'work', 'smoke.png');
  const delay = Number(process.env.NAILONG_SMOKE_DELAY || 1600);
  const force = process.env.NAILONG_FORCE || '';
  const moveTo = process.env.NAILONG_SMOKE_POS;
  // 面板自检：不走奶龙本体截图，改成把侧边动作面板拍下来
  if (process.env.NAILONG_SMOKE_PANEL) return setupPanelSmoke(out, delay);
  win.webContents.once('did-finish-load', () => {
    win.setBounds({ x: 60, y: 60, width: win.getBounds().width, height: win.getBounds().height });
    win.showInactive();
    if (moveTo) {
      const [mx, my] = moveTo.split(',').map(Number);
      win.setBounds({ x: mx, y: my, width: win.getBounds().width, height: win.getBounds().height });
    }
    setTimeout(() => {
      const d = screen.getPrimaryDisplay();
      console.log('[smoke] bounds=%j scaleFactor=%s workArea=%j',
        win.getBounds(), d.scaleFactor, d.workArea);
      win.webContents.executeJavaScript(
        'JSON.stringify({iw:innerWidth,ih:innerHeight,dpr:devicePixelRatio})')
        .then((s) => console.log('[smoke] renderer=%s', s)).catch(() => {});
    }, 100);
    setTimeout(() => { if (force) send('action:' + force); }, 300);
    if (process.env.NAILONG_SMOKE_TRACE) {
      const t = setInterval(() => {
        if (!win || win.isDestroyed()) return clearInterval(t);
        const b = win.getBounds();
        const cb = win.getContentBounds();
        console.log('[trace] bounds=%j contentBounds=%j contentSize=%j',
          b, cb, win.getContentSize());
      }, 400);
      setTimeout(() => clearInterval(t), 6000);
    }
    setTimeout(async () => {
      try {
        console.log('[smoke] before-capture bounds=%j anim=%s',
          win.getBounds(),
          await win.webContents.executeJavaScript('window.__nailong && window.__nailong.S.anim.key + "/" + window.__nailong.S.pos.toFixed(2) + " mirror=" + window.__nailong.S.mirrored'));
      } catch (_) { /* 忽略 */ }
      if (process.env.NAILONG_SMOKE_PROBE) {
        try {
          const r = await win.webContents.executeJavaScript(SMOKE_PROBE_JS);
          console.log('[smoke] probe=%s', r);
        } catch (err) {
          console.log('[smoke] probe failed: %s', err && err.message);
        }
      }
      try {
        const img = await win.webContents.capturePage();
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, img.toPNG());
        console.log('[smoke] captured ->', out);
      } catch (err) {
        console.error('[smoke] capture failed:', err && err.message);
      }
      quitting = true;
      app.quit();
    }, delay);
  });
}

// ---------------------------------------------------------------- 启动
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // 再次双击启动 = "把我的奶龙叫回来"：显示 + 回到右下角
  app.on('second-instance', () => {
    if (!win || win.isDestroyed()) return;
    win.showInactive();
    const b = contentBounds();
    const wa = workArea(true);
    applyContentBounds(
      wa.x + wa.width - b.width - EDGE_GAP,
      wa.y + wa.height - b.height - EDGE_GAP,
      b.width, b.height);
    lastHit = 0;
  });

  app.whenReady().then(() => {
    registerPetProtocol();
    registerIpc();
    createWindow();
    startControlServer();
    if (SMOKE) setupSmoke();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => { quitting = true; writeConfigNow(); stopControlServer(); });
}
