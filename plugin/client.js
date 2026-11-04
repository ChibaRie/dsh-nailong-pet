/**
 * 奶龙桌宠 —— DSH 插件的 Web 半。
 *
 * 在输入框下方挂 🐣 按钮：点开是聊天浮窗，和奶龙对话（宿主 /chat 用 DSH 的 LLM 生成，
 * 并记到本地 memory）；浮窗里另有一个「逗一下」，让奶龙随机表演。
 * 注意（DSH 的硬性要求）：
 *   - 必须是**副作用脚本**，不能有顶层 import/export，靠 window.__ModuleLoader__.load 注册；
 *   - `id` 必须等于包名 `dsh-nailong-pet`，否则客户端模块表对不上号；
 *   - 不能 require 任何 Harness 的 Client 包（抛错只会让槽位条目静默变空白）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-nailong-pet',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const ROUTE = '/nailong-pet-7f3a';

    const css = {
      column: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end' },
      btn: {
        border: '1px solid var(--dsw-alias-border, rgba(128,128,128,.4))',
        background: 'transparent',
        color: 'inherit',
        borderRadius: 8,
        padding: '2px 8px',
        fontSize: 14,
        lineHeight: '20px',
        cursor: 'pointer',
      },
      panel: {
        position: 'fixed', right: 16, bottom: 96, width: 320, maxHeight: 440,
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
        background: '#ffffff', color: '#222', borderRadius: 12,
        border: '1px solid rgba(0,0,0,.14)', boxShadow: '0 10px 30px rgba(0,0,0,.2)',
        zIndex: 9999, fontSize: 13,
      },
      head: {
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '8px 10px', borderBottom: '1px solid rgba(0,0,0,.08)', fontWeight: 600,
      },
      close: { border: 'none', background: 'transparent', color: '#666', cursor: 'pointer', fontSize: 14, marginLeft: 6 },
      poke: { border: 'none', background: 'transparent', color: '#666', cursor: 'pointer', fontSize: 12, padding: '2px 4px' },
      list: { flex: 1, overflowY: 'auto', padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6, minHeight: 120 },
      userMsg: { alignSelf: 'flex-end', background: '#dbeafe', borderRadius: '10px 10px 2px 10px', padding: '6px 9px', maxWidth: '82%', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
      botMsg: { alignSelf: 'flex-start', background: '#f3f4f6', borderRadius: '10px 10px 10px 2px', padding: '6px 9px', maxWidth: '82%', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
      inputRow: { display: 'flex', gap: 6, padding: 8, borderTop: '1px solid rgba(0,0,0,.08)' },
      input: { flex: 1, minWidth: 0, border: '1px solid rgba(0,0,0,.2)', borderRadius: 8, padding: '6px 8px', fontSize: 13, outline: 'none' },
      send: { border: 'none', borderRadius: 8, background: '#f97316', color: '#fff', padding: '6px 12px', cursor: 'pointer', fontSize: 13 },
    };

    function ChatPanel({ onClose }) {
      const [msgs, setMsgs] = React.useState([
        { role: 'assistant', text: '嗨，我是奶龙～ 想聊点什么？🐣' },
      ]);
      const [text, setText] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const listRef = React.useRef(null);
      const push = (m) => setMsgs((prev) => [...prev, m]);

      React.useEffect(() => {
        const el = listRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      }, [msgs, busy]);

      const send = async () => {
        const t = text.trim();
        if (!t || busy) return;
        setText('');
        push({ role: 'user', text: t });
        setBusy(true);
        try {
          const res = await fetch(ROUTE + '/chat?text=' + encodeURIComponent(t));
          const j = await res.json().catch(() => null);
          if (j && j.ok && j.text) push({ role: 'assistant', text: j.text });
          else push({ role: 'assistant', text: '（奶龙没听见：' + ((j && j.error) || ('HTTP ' + res.status)) + '）' });
        } catch (err) {
          push({ role: 'assistant', text: '（连不上奶龙：' + ((err && err.message) || err) + '）' });
        } finally {
          setBusy(false);
        }
      };

      return h('div', { style: css.panel },
        h('div', { style: css.head },
          h('span', null, '🐣 奶龙'),
          h('span', null,
            h('button', {
              type: 'button', style: css.poke, title: '逗一下奶龙',
              onClick: () => { void fetch(ROUTE + '/action?key=random').catch(() => {}); },
            }, '逗一下'),
            h('button', { type: 'button', style: css.close, title: '收起', onClick: onClose }, '✕'))),
        h('div', { style: css.list, ref: listRef },
          msgs.map((m, i) => h('div', {
            key: i, style: m.role === 'user' ? css.userMsg : css.botMsg,
          }, m.text)),
          busy ? h('div', { style: css.botMsg }, '奶龙正在想…') : null),
        h('div', { style: css.inputRow },
          h('input', {
            style: css.input, value: text, placeholder: '和奶龙说点什么…',
            onChange: (e) => setText(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); send(); } },
          }),
          h('button', { type: 'button', style: css.send, disabled: busy, onClick: send }, '发送')));
    }

    function NailongDock() {
      const [open, setOpen] = React.useState(false);
      return h('div', { style: css.column },
        open ? h(ChatPanel, { onClose: () => setOpen(false) }) : null,
        h('button', {
          type: 'button',
          title: '和奶龙聊两句',
          onClick: () => setOpen((v) => !v),
          style: css.btn,
        }, '🐣'));
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock', id: 'nailong-pet', order: 60,
        }, NailongDock));
      },
    };
  },
});
