'use strict';
/**
 * 奶龙动作面板 —— 点一下奶龙就在它旁边弹出来的小卡片。
 * 面板只负责"选"，真正的播放由主进程转成 pet:command 发回渲染端。
 */
const host = window.petPanel;

const EMO = {
  wave: '👋', laugh: '😄', shy: '😳', work: '⌨️', sleep: '😴',
  walk: '🚶', run: '🏃', stroll: '🌿',
  idle: '🫧', idle2: '👀', idle3: '💭', idle4: '🥱', sit: '🪑',
};

// 面板里的排列顺序与分组（key 必须存在于 manifest.animations 里）
const GROUPS = [
  { title: '', keys: ['wave', 'laugh', 'shy', 'work', 'sleep'] },
  { title: '溜达', keys: ['walk', 'run', 'stroll'] },
  { title: '闲着', keys: ['idle', 'idle2', 'idle3', 'idle4', 'sit'] },
];

const actsEl = document.getElementById('acts');
const cardEl = document.getElementById('card');
const errEl = document.getElementById('err');

let byKey = {};

function fail(msg) {
  errEl.style.display = 'block';
  errEl.textContent = msg;
  console.error(msg);
}

/**
 * 把卡片量出来的高度告诉主进程。
 * #card 是 top 锚定 + height:auto，所以 offsetHeight 就是内容真正需要的高度；
 * 主进程据此调整窗口大小（并受工作区高度钳制），面板就不会被截断。
 * 上下各留 6px 是 .card 的 inset，给投影用。
 */
async function fit() {
  try {
    await host.resize(Math.ceil(cardEl.offsetHeight) + 12);
  } catch (_) { /* 主进程还没准备好就算了，保持上一次高度 */ }
}

function makeRow(key, label) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'row';
  b.dataset.key = key;

  const emo = document.createElement('span');
  emo.className = 'emo';
  emo.textContent = EMO[key] || '🐣';

  const txt = document.createElement('span');
  txt.className = 'txt';
  txt.textContent = label;

  b.append(emo, txt);
  b.addEventListener('click', () => host.act(key));
  return b;
}

function renderActs() {
  actsEl.textContent = '';
  for (const g of GROUPS) {
    const keys = g.keys.filter((k) => byKey[k]);
    if (!keys.length) continue;
    if (g.title) {
      const t = document.createElement('div');
      t.className = 'sect';
      t.textContent = g.title;
      actsEl.appendChild(t);
    }
    for (const k of keys) actsEl.appendChild(makeRow(k, byKey[k].label));
  }
}

async function boot() {
  const res = await fetch(new URL('../assets/manifest.json', location.href).href);
  if (!res.ok) throw new Error('manifest 读取失败: HTTP ' + res.status);
  const manifest = await res.json();
  for (const a of manifest.animations) byKey[a.key] = a;

  renderActs();
  await fit();
  host.ready();
}

document.getElementById('close').addEventListener('click', () => host.close());
document.getElementById('home').addEventListener('click', () => host.home());
document.getElementById('quit').addEventListener('click', () => host.quit());

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') host.close();
});

window.addEventListener('contextmenu', (e) => e.preventDefault());
window.addEventListener('dragstart', (e) => e.preventDefault());

// 主进程只会推「面板是否可见」，没有别的状态要同步；重排一次高度就够了。
host.onState(() => { fit(); });

boot().catch((err) => fail('面板加载失败：' + (err && err.message ? err.message : String(err))));
