'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// 奶龙本体（src/index.html）用这一组
contextBridge.exposeInMainWorld('petHost', {
  /** 加载完成，可以显示窗口了 */
  ready: () => ipcRenderer.send('pet:ready'),
  /** 打开/关闭鼠标交互（关掉 = 点击穿透） */
  setInteractive: (v) => ipcRenderer.send('pet:set-interactive', v),
  /** 增量移动窗口（走路 / 拖拽）；用 send，避免每帧一次 Promise 往返 */
  move: (dx, dy) => ipcRenderer.send('pet:move', { dx, dy }),
  /** 撞到屏幕边界时回调 */
  onEdge: (cb) => ipcRenderer.on('pet:edge', (_e, info) => cb(info)),
  /** 主进程轮询到的全局光标位置（窗口内坐标）；命中测试不依赖 DOM mousemove */
  onCursor: (cb) => ipcRenderer.on('pet:cursor', (_e, p) => cb(p)),
  geometry: () => ipcRenderer.invoke('pet:geometry'),
  home: () => ipcRenderer.invoke('pet:home'),
  quit: () => ipcRenderer.send('pet:quit'),
  contextMenu: () => ipcRenderer.send('pet:context-menu'),
  onCommand: (cb) => ipcRenderer.on('pet:command', (_e, cmd) => cb(cmd)),
  /** 点一下奶龙 → 侧边弹出动作面板 */
  openPanel: () => ipcRenderer.send('pet:open-panel'),
  closePanel: () => ipcRenderer.send('pet:close-panel'),
});

// 侧边动作面板（src/panel.html）用这一组
contextBridge.exposeInMainWorld('petPanel', {
  ready: () => ipcRenderer.send('panel:ready'),
  state: () => ipcRenderer.invoke('panel:state'),
  onState: (cb) => ipcRenderer.on('panel:state', (_e, s) => cb(s)),
  act: (key) => ipcRenderer.send('panel:act', key),
  home: () => ipcRenderer.send('panel:home'),
  quit: () => ipcRenderer.send('panel:quit'),
  close: () => ipcRenderer.send('panel:close'),
  /** 把卡片量出来的内容高度回报主进程，由主进程调整窗口高度 */
  resize: (h) => ipcRenderer.invoke('panel:resize', h),
});
