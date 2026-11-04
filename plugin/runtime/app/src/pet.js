'use strict';
/**
 * 奶龙桌宠 —— 渲染端
 *
 * 职责：
 *  1. 载入 assets/manifest.json 与逐帧 PNG，为每帧建 1/2 分辨率的 alpha 掩码；
 *  2. 把当前帧画进 canvas 的"192x208 虚拟单格"里（跨行共用同一地面线，播放不抖）；
 *     v2 起在相邻两帧之间做交叉淡化，显示端是 60fps 的连续过渡；
 *     v3 起每帧还会按当前缩放预重采样成"目标物理像素尺寸"的 ImageBitmap：
 *     原画是像素风、描边带硬台阶，而旧版 DPR 1.25 × scale 0.8 恰好 = 1.0，
 *     浏览器会把原图 1:1 直接 blit、完全不做重采样，台阶就原样露出来了；
 *  3. 行为状态机：待机情绪（发呆 / 坐着 / 悠闲散步）持续 ~30s → 表演一个动作 → 回到待机；
 *  4. 按掩码做像素级命中测试，只在奶龙身体上把窗口切成可交互（其余时候点击穿透）；
 *  5. 单击奶龙 → 让主进程在侧边弹出动作面板。
 */
const host = window.petHost;

const CELL_W = 192;
const CELL_H = 208;
const GROUND_Y = 203;      // 图集里所有行共用的脚底线
const MASK_DIV = 2;        // alpha 掩码降采样倍数
const ALPHA_HIT = 40;      // 掩码阈值
const DRAG_SLOP = 4;       // 超过这个位移才算拖拽，否则算点击
const BLEND_MIN = 0.02;    // 淡化权重低于此值就跳过第二张，省一次绘制
// 交叉淡化只占帧间隔的中间一段，前后各留 BLEND_HOLD 的时间**保持这一帧的清晰姿势**。
// 线性/整段淡化在低帧率下（v4 每帧 200~290ms）会让画面长期停在"两张各一半"的
// 重影上，看着糊；改成"亮姿势 → 平滑滑过去 → 亮姿势"既保住平滑，又每张姿势都
// 认得出来。0.18 表示每帧前后各 18% 是清晰的，中间 64% 走 smoothstep。
const BLEND_HOLD = 0.18;
// 待机时"站着不动"的几个变体（坐在 / 散步 另算）
const STAND_KEYS = ['idle', 'idle2', 'idle3', 'idle4'];
// 到点自动表演的动作池
const ACTION_KEYS = ['walk', 'run', 'wave', 'laugh', 'work', 'shy', 'sleep'];
// 待机情绪持续多久换一次（用户要求：大约 30s）
const IDLE_MIN = 25000;
const IDLE_MAX = 35000;

const canvas = document.getElementById('stage');
// 注意：主画布从不 getImageData，不能带 willReadFrequently——那会把画布降到
// CPU 后备缓冲，每帧一次大尺寸 drawImage 就会被拖慢（v1 卡顿的主因）。
const ctx = canvas.getContext('2d', { alpha: true });
const bootEl = document.getElementById('boot');
const errEl = document.getElementById('err');

const S = {
  scale: 0.6,           // 由主进程的 pet:geometry 覆盖；尺寸已锁死，值不会变
  margin: { x: 26, top: 26, bottom: 26 },
  anims: [],            // manifest.animations
  byKey: {},
  /** name -> { img, mask, mw, mh } */
  frames: {},
  /** name -> { w, h }（该帧在原图里的像素尺寸，重采样时要用） */
  defs: {},
  /** name -> { key, bmp, w, h }：按当前缩放重采样好的位图缓存 */
  resample: new Map(),
  layout: { scale: 0.6, cellX: 0, cellY: 0, cellW: CELL_W, cellH: CELL_H },
  idleRange: [25000, 35000],
  blendMax: 72,         // 相邻帧差异小于它才做交叉淡化（阈值随 manifest 走）

  anim: null,           // 当前动画对象
  pos: 0,               // 浮点帧下标（整数部分是当前帧，小数部分是淡化权重）
  acc: 0,               // 帧计时累加器
  repeatsLeft: 1,       // 非 loop 动画剩余重复次数
  finished: false,      // 非 loop 动画是否播完
  mirrored: false,

  mode: 'boot',         // boot | idle | act | drag
  endAt: 0,             // 当前行为的截止时间戳（0 = 由动画播完决定）
  idleUntil: 0,         // 当前待机情绪结束的时间戳（到点就表演一个动作）
  idleKind: '',         // stand | sit | stroll
  moveDir: 0,           // -1 左 / 0 不动 / +1 右
  moveSpeed: 0,         // px/s
  hold: false,          // true = 侧边面板开着，原地站住
  lastActionKey: '',    // 避免连续抽到同一个动作
  interactive: false,
  hitEdge: { l: false, r: false },
};

// ------------------------------------------------------------------ 工具
const rand = (a, b) => a + Math.random() * (b - a);
const randInt = (a, b) => Math.floor(rand(a, b + 1));
const now = () => performance.now();

function pickWeighted(list, excludeKey) {
  const pool = list.filter((a) => a.key !== excludeKey);
  const use = pool.length ? pool : list;
  const total = use.reduce((s, a) => s + (a.weight || 1), 0);
  let r = Math.random() * total;
  for (const a of use) {
    r -= (a.weight || 1);
    if (r <= 0) return a;
  }
  return use[use.length - 1];
}

function fail(msg) {
  bootEl.hidden = true;
  errEl.hidden = false;
  errEl.textContent = msg;
  console.error(msg);
}

// ------------------------------------------------------------------ 载入
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片载入失败: ' + src));
    img.src = src;
  });
}

/** 把一帧画到离屏 canvas 上取 alpha，降采样成 1/2 的 0/1 掩码（供像素级命中测试） */
function buildMask(img) {
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0);
  const data = g.getImageData(0, 0, w, h).data;
  const mw = Math.ceil(w / MASK_DIV);
  const mh = Math.ceil(h / MASK_DIV);
  const mask = new Uint8Array(mw * mh);
  for (let y = 0; y < mh; y++) {
    for (let x = 0; x < mw; x++) {
      let a = 0;
      for (let dy = 0; dy < MASK_DIV; dy++) {
        const py = y * MASK_DIV + dy;
        if (py >= h) continue;
        for (let dx = 0; dx < MASK_DIV; dx++) {
          const px = x * MASK_DIV + dx;
          if (px >= w) continue;
          const v = data[(py * w + px) * 4 + 3];
          if (v > a) a = v;
        }
      }
      mask[y * mw + x] = a >= ALPHA_HIT ? 1 : 0;
    }
  }
  return { mask, mw, mh };
}

async function boot() {
  const geo = await host.geometry();
  S.scale = geo.scale;
  S.margin = geo.margin;

  const res = await fetch(new URL('../assets/manifest.json', location.href).href);
  if (!res.ok) throw new Error('manifest 读取失败: HTTP ' + res.status);
  const manifest = await res.json();
  S.anims = manifest.animations;
  for (const a of S.anims) S.byKey[a.key] = a;
  if (manifest.meta && manifest.meta.idleMs) S.idleRange = manifest.meta.idleMs;
  if (manifest.meta && Number.isFinite(manifest.meta.blendMax)) S.blendMax = manifest.meta.blendMax;

  const names = [];
  for (const a of S.anims) for (const fr of a.frames) {
    S.defs[fr.name] = { w: fr.w, h: fr.h };
    if (!names.includes(fr.name)) names.push(fr.name);
  }
  let done = 0;
  await Promise.all(names.map(async (n) => {
    const img = await loadImage(`pet://app/assets/frames/${n}.png`);
    S.frames[n] = Object.assign({ img }, buildMask(img));
    done += 1;
    if (done % 10 === 0) bootEl.textContent = `奶龙正在起床… ${done}/${names.length}`;
  }));

  resizeCanvas();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  // 先等第一轮重采样做完再报到：这样窗口第一次显示出来就是平滑的
  await refreshResample();
  bootEl.hidden = true;
  startIdle();
  // 刚起来先站一小会儿，别一上来就定格在坐着
  if (S.idleKind !== 'stand') selectIdleMood('stand');
  host.ready();
  requestAnimationFrame(tick);
}

// ------------------------------------------------------------------ 布局
function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const w = window.innerWidth;
  const h = window.innerHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  const s = S.scale;
  S.layout.scale = s;
  S.layout.cellW = CELL_W * s;
  S.layout.cellH = CELL_H * s;
  S.layout.cellX = (w - S.layout.cellW) / 2;
  S.layout.cellY = h - S.margin.bottom - S.layout.cellH;
}
window.addEventListener('resize', () => { resizeCanvas(); refreshResample(); });

// ------------------------------------------------------------------ 缩放重采样
/**
 * 把每帧按"当前 scale × DPR"预重采样成目标物理尺寸的 ImageBitmap。
 *
 * 为什么要自己重采样：drawImage 的缩放比恰好是 1.0 时，浏览器不会做任何过滤，
 * 原画的硬像素台阶会原样呈现（旧版 DPR 1.25 × scale 0.8 就正好落在 1.0）。
 * createImageBitmap({resizeQuality:'high'}) 无论如何都会走一次高质量重采样，
 * 之后渲染循环里贴的是现成位图，既平滑又省掉每帧的缩放开销。
 */
let resampleKey = '';   // 当前位图缓存对应的 "scale@dpr"
let resampling = false;
let resampleAgain = false;

function resampleKeyOf() {
  const dpr = window.devicePixelRatio || 1;
  return S.layout.scale.toFixed(4) + '@' + dpr.toFixed(3);
}
function closeBitmap(b) { try { if (b && b.close) b.close(); } catch (_) {} }

async function refreshResample() {
  if (resampling) { resampleAgain = true; return; }
  const names = Object.keys(S.defs);
  if (!names.length) return;
  resampling = true;
  resampleAgain = false;
  const key = resampleKeyOf();
  const dpr = window.devicePixelRatio || 1;
  try {
    for (const name of names) {
      if (resampleAgain) break;
      const d = S.defs[name];
      const f = S.frames[name];
      if (!d || !f || !f.img) continue;
      const cur = S.resample.get(name);
      if (cur && cur.key === key) continue;
      const w = Math.max(1, Math.round(d.w * S.layout.scale * dpr));
      const h = Math.max(1, Math.round(d.h * S.layout.scale * dpr));
      const bmp = await createImageBitmap(f.img, {
        resizeWidth: w, resizeHeight: h, resizeQuality: 'high',
      });
      S.resample.set(name, { key, bmp, w, h });
      if (cur) closeBitmap(cur.bmp);
    }
    if (!resampleAgain) resampleKey = key;
  } catch (_) {
    // 重采样失败就退回原图直绘，不影响功能
  } finally {
    resampling = false;
    if (resampleAgain) refreshResample();
  }
}

// ------------------------------------------------------------------ 帧推进
/** 当前"主导帧"（淡化权重较大的一张），命中测试与调试都用它 */
function currentFrameDef() {
  const n = S.anim.frames.length;
  let i = Math.round(S.pos);
  if (i < 0) i = 0;
  if (i > n - 1) i = n - 1;
  return S.anim.frames[i];
}
function currentFrame() {
  return S.frames[currentFrameDef().name];
}

/**
 * 这对相邻帧能不能混。原画有描边，姿势差别大的两帧按 50% 混会在轮廓外
 * 留一圈灰边，所以阈值由 manifest 的 pairs/blendMax 数据决定：
 * v3 把阈值抬到 72，走路/挥手/大笑也都走淡化，只有睡姿翻滚保持硬切。
 */
function blendOk(a, i) {
  if (a.interp === false) return false;
  if (!a.pairs || !a.pairs.length) return false;
  return a.pairs[i % a.pairs.length] <= S.blendMax;
}

/**
 * 返回到渲染用的帧对：d0 完整绘制，d1 以 frac 的不透明度叠上去。
 * 结果等价于 d0*(1-frac) + d1*frac —— 没有引入任何新像素。
 *
 * frac 的曲线分两段：
 *   帧间隔的前后各 BLEND_HOLD 段 —— frac 恒为 0，画面是这一帧的清晰姿势；
 *   中间那段 —— 走 smoothstep（3t²-2t³）滑到下一帧。
 * 这样既有连续的过渡（不会一格一格跳），又不会长时间悬在"两张各 50%"的
 * 重影上。帧率越低，这个设计越重要（v4 每帧 200~290ms）。
 */
function frameBlend() {
  const a = S.anim;
  const n = a.frames.length;
  if (n === 1) return { d0: a.frames[0], d1: null, frac: 0 };
  let i0 = Math.floor(S.pos);
  if (i0 < 0) i0 = 0;
  if (i0 > n - 1) i0 = n - 1;
  let frac = S.pos - i0;
  if (frac < 0) frac = 0; else if (frac > 1) frac = 1;
  const i1 = a.loop ? (i0 + 1) % n : Math.min(i0 + 1, n - 1);
  let d1 = null;
  let out = 0;
  if (frac > BLEND_MIN && i1 !== i0 && blendOk(a, i0)) {
    let t = (frac - BLEND_HOLD) / (1 - 2 * BLEND_HOLD);
    if (t < 0) t = 0; else if (t > 1) t = 1;
    if (t > 0) {
      d1 = a.frames[i1];
      out = t * t * (3 - 2 * t);
    }
  }
  return { d0: a.frames[i0], d1, frac: out };
}

function setAnim(a, opts) {
  const o = opts || {};
  S.anim = a;
  S.pos = 0;
  S.acc = 0;
  S.repeatsLeft = Math.max(1, a.repeat || 1);
  S.finished = false;
  S.endAt = o.endAt || 0;
  S.moveDir = o.dir === undefined ? 0 : o.dir;
  S.moveSpeed = o.dir ? (a.move || 0) : 0;
  applyFacing();
}

function applyFacing() {
  const a = S.anim;
  if (!a || S.moveDir === 0) { S.mirrored = false; return; }
  if (a.facing === 'right') S.mirrored = S.moveDir < 0;
  else if (a.facing === 'left') S.mirrored = S.moveDir > 0;
  else S.mirrored = false;
}

/** 浮点帧推进；整数部分是帧号，小数部分留给渲染端做交叉淡化 */
function stepFrames(dt) {
  const a = S.anim;
  const n = a.frames.length;
  const step = 1 / (a.fps || 8);
  S.acc += dt;
  let guard = 0;
  while (S.acc >= step && guard++ < 16) {
    if (S.finished) { S.acc = 0; break; }
    S.acc -= step;
    S.pos += 1;
    if (S.pos < n) continue;
    if (a.loop) { S.pos -= n; continue; }
    S.repeatsLeft -= 1;
    if (S.repeatsLeft > 0) { S.pos -= n; continue; }
    S.pos = n - 1;
    S.finished = true;
  }
  if (S.pos > n - 1) S.pos = n - 1;
}

// ------------------------------------------------------------------ 行为状态机
/** 某个动作该持续多久（毫秒）；0 = 由动画播完决定 */
function durationFor(a) {
  if (a.key === 'sleep') return rand(8000, 16000);   // 睡一觉，末帧定格
  if (a.move > 0) return rand(1800, 4200);           // 走/跑一段
  if (a.loop) return rand(2800, 6500);               // 循环动作演一会儿
  return 0;
}

/** 挑一个待机情绪并播放：站着发呆 / 坐在地上 / 悠闲散步 */
function selectIdleMood(forceKind) {
  const r = Math.random();
  let kind = forceKind;
  if (!kind) kind = r < 0.28 ? 'stroll' : (r < 0.56 ? 'sit' : 'stand');

  let a, dir = 0;
  if (kind === 'stroll' && S.byKey.stroll) {
    a = S.byKey.stroll;
    dir = Math.random() < 0.5 ? -1 : 1;
    if (dir < 0 && S.hitEdge.l) dir = 1;
    else if (dir > 0 && S.hitEdge.r) dir = -1;
  } else if (kind === 'sit' && S.byKey.sit) {
    a = S.byKey.sit;
  } else {
    kind = 'stand';
    a = S.byKey[STAND_KEYS[randInt(0, STAND_KEYS.length - 1)]] || S.byKey[STAND_KEYS[0]];
  }
  if (!a) return;
  setAnim(a, { dir: a.move > 0 ? dir : 0 });
  S.mode = 'idle';
  S.idleKind = kind;
  S.idleUntil = now() + rand(S.idleRange[0], S.idleRange[1]);
}

function startIdle() { selectIdleMood(); }

function playAction(a, dir) {
  if (!a) return;
  let d = dir;
  if (a.move > 0 && !d) d = Math.random() < 0.5 ? -1 : 1;
  // 贴着屏幕边就别再往外走了
  if (a.move > 0) {
    if (d < 0 && S.hitEdge.l) d = 1;
    else if (d > 0 && S.hitEdge.r) d = -1;
  }
  const dur = durationFor(a);
  setAnim(a, { dir: a.move > 0 ? d : 0, endAt: dur ? now() + dur : 0 });
  S.mode = 'act';
  S.idleKind = '';
  S.lastActionKey = a.key;
}

function randomAction(opts) {
  const o = opts || {};
  const pool = ACTION_KEYS.map((k) => S.byKey[k]).filter(Boolean);
  const exclude = o.allowSame ? '' : S.lastActionKey;
  let a = pickWeighted(pool, exclude);
  // 睡觉很占时间，别太频繁
  if (a.key === 'sleep' && Math.random() < 0.65) a = pickWeighted(pool.filter((x) => x.key !== 'sleep'), exclude);
  return a;
}

function doRandomAction() { playAction(randomAction()); }

function endAction() {
  if (S.mode === 'act') startIdle();
}

// ------------------------------------------------------------------ 交互
function setInteractive(v) {
  if (v === S.interactive) return;
  S.interactive = v;
  host.setInteractive(v);
}

function hitTest(clientX, clientY) {
  const a = S.anim;
  if (!a) return false;
  // 交叉淡化期间两张帧都算命中，边缘才不会闪
  const b = frameBlend();
  const L = S.layout;
  let vx = (clientX - L.cellX) / L.scale;
  const vy = (clientY - L.cellY) / L.scale;
  if (S.mirrored) vx = CELL_W - vx;
  const defs = b.d1 ? [b.d0, b.d1] : [b.d0];
  for (const def of defs) {
    const f = S.frames[def.name];
    if (!f) continue;
    const fx = Math.floor(vx - a.ox);
    const fy = Math.floor(vy - def.oy);
    if (fx < 0 || fy < 0 || fx >= def.w || fy >= def.h) continue;
    const mx = fx / MASK_DIV | 0;
    const my = fy / MASK_DIV | 0;
    if (mx < 0 || my < 0 || mx >= f.mw || my >= f.mh) continue;
    if (f.mask[my * f.mw + mx] === 1) return true;
  }
  return false;
}

let drag = null;

window.addEventListener('mousemove', (e) => {
  if (drag) {
    const dx = e.screenX - drag.lastX;
    const dy = e.screenY - drag.lastY;
    drag.lastX = e.screenX;
    drag.lastY = e.screenY;
    if (!drag.moved && Math.abs(e.screenX - drag.sx) + Math.abs(e.screenY - drag.sy) > DRAG_SLOP) {
      drag.moved = true;
      // 被拎起来了：蹬腿
      setAnim(S.byKey.run, { dir: 1 });
      S.mode = 'drag';
      S.endAt = 0;
    }
    if (drag.moved) host.move(dx, dy);
    return;
  }
  setInteractive(hitTest(e.clientX, e.clientY));
});

window.addEventListener('mouseleave', () => {
  if (!drag) setInteractive(false);
});

// 交互判定的权威来源：主进程的全局光标轮询（见 main.js 的 startCursorPoll）。
// Windows 上窗口失焦后 DOM 就收不到 mousemove 了，只靠上面那个监听会卡在最后一次结果。
host.onCursor((p) => {
  if (drag) return;
  setInteractive(!!p.inside && hitTest(p.x, p.y));
});

window.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  if (!hitTest(e.clientX, e.clientY)) return;
  e.preventDefault();
  drag = { sx: e.screenX, sy: e.screenY, lastX: e.screenX, lastY: e.screenY, moved: false };
  setInteractive(true);
});

window.addEventListener('mouseup', (e) => {
  if (!drag || e.button !== 0) return;
  const moved = drag.moved;
  drag = null;
  if (moved) {
    // 落地：害羞一下
    playAction(S.byKey.shy);
  } else {
    // 单击 = 点奶龙 → 侧边弹出动作面板
    host.openPanel();
  }
});

window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  host.contextMenu();
});

window.addEventListener('dragstart', (e) => e.preventDefault());
window.addEventListener('wheel', (e) => e.preventDefault(), { passive: false });

// ------------------------------------------------------------------ 主进程指令
host.onEdge((info) => {
  S.hitEdge.l = (info.hit & 1) !== 0;
  S.hitEdge.r = (info.hit & 2) !== 0;
  // 走到屏幕边就掉头，让循环看起来自然
  if (S.moveSpeed > 0) {
    if ((S.hitEdge.l && S.moveDir < 0) || (S.hitEdge.r && S.moveDir > 0)) {
      S.moveDir = -S.moveDir;
      applyFacing();
    }
  }
});

host.onCommand((cmd) => {
  if (typeof cmd !== 'string') return;
  if (cmd.startsWith('action:')) {
    const key = cmd.slice(7);
    if (key === 'random') { playAction(randomAction({ allowSame: true })); return; }
    const a = S.byKey[key];
    if (a && a.kind === 'idle') {
      // 面板里直接点了"坐着 / 发呆"这类待机表现
      setAnim(a, { dir: 0 });
      S.mode = 'idle';
      S.idleKind = key === 'sit' ? 'sit' : 'stand';
      S.idleUntil = now() + rand(S.idleRange[0], S.idleRange[1]);
      return;
    }
    if (a) playAction(a, 0);
    return;
  }
  if (cmd === 'home') {
    host.home().then(() => { S.hitEdge.l = S.hitEdge.r = false; });
    return;
  }
  if (cmd === 'pause') {
    // 侧边面板打开了：站住别动。否则它一边悠闲散步一边把面板甩在身后，
    // 用户还没点到面板上的按钮面板就已经跟丢了。
    S.hold = true;
    S.moveSpeed = 0;
    S.moveDir = 0;
    S.mirrored = false;
    S.hitEdge.l = S.hitEdge.r = false;
    if (S.mode === 'idle' && S.idleKind === 'stroll' && S.byKey.idle) {
      setAnim(S.byKey.idle, { dir: 0 });
      S.idleKind = 'stand';
      S.idleUntil = now() + rand(S.idleRange[0], S.idleRange[1]);
    }
    return;
  }
  if (cmd === 'resume') {
    S.hold = false;
  }
});

// ------------------------------------------------------------------ 主循环
let last = 0;

function update(dt) {
  const a = S.anim;
  if (!a) return;

  stepFrames(dt);

  // 走路位移（S.hold = 侧边面板开着，必须先站着别动）
  if (!S.hold && S.moveSpeed > 0 && S.moveDir !== 0 && S.mode !== 'drag') {
    host.move(S.moveSpeed * S.moveDir * dt, 0);
  }

  const t = now();

  if (S.mode === 'idle') {
    if (t >= S.idleUntil) doRandomAction();
    return;
  }

  if (S.mode === 'act') {
    const timeUp = S.endAt > 0 && t >= S.endAt;
    const animOver = S.endAt === 0 && S.finished;
    if (timeUp || animOver) endAction();
    return;
  }

  // drag: 保持循环播放 run，不自动结束
}

function drawFrame(def, alpha) {
  if (!def) return;
  const f = S.frames[def.name];
  if (!f) return;
  const a = S.anim;
  const L = S.layout;
  const dpr = window.devicePixelRatio || 1;
  const r = S.resample.get(def.name);
  if (alpha < 1) ctx.globalAlpha = alpha;
  if (r && r.key === resampleKey) {
    // 位图已经是目标物理尺寸，按等价的 CSS 尺寸贴上去 ≈ 设备像素 1:1
    ctx.drawImage(
      r.bmp,
      a.ox * L.scale - L.cellW / 2,
      def.oy * L.scale,
      r.w / dpr,
      r.h / dpr
    );
  } else {
    // 重采样还没跟上（刚换过缩放）就先用原图顶着
    ctx.drawImage(
      f.img,
      a.ox * L.scale - L.cellW / 2,
      def.oy * L.scale,
      def.w * L.scale,
      def.h * L.scale
    );
  }
  if (alpha < 1) ctx.globalAlpha = 1;
}

function render() {
  const a = S.anim;
  if (!a) return;
  const b = frameBlend();
  const L = S.layout;
  const dpr = window.devicePixelRatio || 1;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  ctx.save();
  // 把"192x208 虚拟单格"摆进窗口：水平居中，地面线离底边留 margin.bottom
  ctx.translate(L.cellX + L.cellW / 2, L.cellY);
  if (S.mirrored) ctx.scale(-1, 1);
  drawFrame(b.d0, 1);
  if (b.d1) drawFrame(b.d1, b.frac);
  ctx.restore();
}

function tick(ts) {
  requestAnimationFrame(tick);
  if (!last) last = ts;
  const dt = Math.min(0.1, Math.max(0, (ts - last) / 1000));
  last = ts;
  try {
    update(dt);
    render();
  } catch (err) {
    console.error(err);
  }
  // 只给自检用的绘制计数（统计真实帧率，见 main.js 的 SMOKE_PROBE_JS）
  S.painted = (S.painted || 0) + 1;
}

// ------------------------------------------------------------------ 启动
// 调试出口：smoke 自检与手动排查用
window.__nailong = {
  S, hitTest, playAction, randomAction, doRandomAction,
  startIdle, selectIdleMood, frameBlend, currentFrameDef, setInteractive,
  refreshResample,
};

boot().catch((err) => fail('奶龙启动失败：\n' + (err && err.message ? err.message : String(err))));
