'use strict';
/**
 * 奶龙桌面聊天窗口 —— 贴着奶龙的小对话框。
 * 请求由主进程转发到宿主另开的 127.0.0.1 聊天服务（见 plugin/index.js），
 * 渲染端不直接联网（CSP connect-src 只放行 pet:）。
 */
const api = window.petChat;
const listEl = document.getElementById('list');
const inputEl = document.getElementById('input');
const sendBtn = document.getElementById('send');
let busy = false;

function add(role, text) {
  const div = document.createElement('div');
  div.className = 'msg ' + (role === 'user' ? 'user' : 'bot');
  div.textContent = text;
  listEl.appendChild(div);
  listEl.scrollTop = listEl.scrollHeight;
}

async function send() {
  const t = inputEl.value.trim();
  if (!t || busy) return;
  inputEl.value = '';
  add('user', t);
  busy = true;
  sendBtn.disabled = true;
  const thinking = document.createElement('div');
  thinking.className = 'msg bot';
  thinking.textContent = '奶龙正在想…';
  listEl.appendChild(thinking);
  listEl.scrollTop = listEl.scrollHeight;
  try {
    const reply = await api.send(t);
    thinking.remove();
    if (reply && reply.ok && reply.text) add('bot', reply.text);
    else add('bot', '（奶龙没听见：' + ((reply && reply.error) || '未知错误') + '）');
  } catch (err) {
    thinking.remove();
    add('bot', '（连不上奶龙：' + ((err && err.message) || err) + '）');
  } finally {
    busy = false;
    sendBtn.disabled = false;
    inputEl.focus();
  }
}

document.getElementById('close').addEventListener('click', () => api.close());
document.getElementById('poke').addEventListener('click', () => api.poke());
sendBtn.addEventListener('click', send);
// 中文输入法选词时也会发 Enter；这次按键不是「发送」
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); send(); }
});
window.addEventListener('contextmenu', (e) => e.preventDefault());
api.ready();
add('bot', '嗨，我是奶龙～ 想聊点什么？');
