// 奶龙桌宠 —— DSH 插件的 Web 半。
//
// 参照鲸鱼女仆（dsh-pet）的设计：把「奶龙对话」注册成 DSH 右侧栏标签页
// （sidebarRightTabs 服务 + sidebar.right.pane.tab 插槽），而不是输入框下方的浮窗。
// 右栏服务是可选能力：缺失时只告警，不影响桌宠本体（Electron 端照常跑）。
//
// DSH 硬性要求：
//   - 必须是副作用脚本，不能有顶层 import/export，靠 window.__ModuleLoader__.load 注册；
//   - id 必须等于包名 dsh-nailong-pet；
//   - 不能 require 任何 Harness 的 Client 包（抛错只会让槽位条目静默变空白）。
window.__ModuleLoader__.load({
  id: 'dsh-nailong-pet',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef } = React;
    const ROUTE = '/nailong-pet-7f3a';
    const TAB_ID = 'dsh-nailong-pet-chat';
    const TAB_KIND = 'nailong-pet-chat';
    const TAB_TITLE = '奶龙对话';

    const css = {
      wrap: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, fontSize: 13, color: 'inherit' },
      list: { flex: 1, overflowY: 'auto', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0 },
      user: { alignSelf: 'flex-end', background: 'rgba(249,115,22,.14)', border: '1px solid rgba(249,115,22,.35)', borderRadius: '12px 12px 2px 12px', padding: '6px 10px', maxWidth: '82%', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
      bot: { alignSelf: 'flex-start', background: 'rgba(128,128,128,.12)', border: '1px solid rgba(128,128,128,.25)', borderRadius: '12px 12px 12px 2px', padding: '6px 10px', maxWidth: '82%', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
      row: { display: 'flex', gap: 6, padding: '8px 10px', borderTop: '1px solid rgba(128,128,128,.2)' },
      input: { flex: 1, minWidth: 0, border: '1px solid rgba(128,128,128,.4)', borderRadius: 8, padding: '6px 8px', fontSize: 13, outline: 'none', background: 'transparent', color: 'inherit' },
      send: { border: 'none', borderRadius: 8, background: '#f97316', color: '#fff', padding: '6px 12px', cursor: 'pointer', fontSize: 13 },
      bar: { display: 'flex', gap: 6, padding: '4px 10px' },
      mini: { border: 'none', background: 'transparent', color: 'inherit', opacity: 0.7, cursor: 'pointer', fontSize: 12, padding: '2px 4px' },
    };

    function ChatPanel() {
      const [msgs, setMsgs] = useState([{ role: 'assistant', text: '嗨，我是奶龙～ 想聊点什么？🐣' }]);
      const [text, setText] = useState('');
      const [busy, setBusy] = useState(false);
      const listRef = useRef(null);
      const push = (m) => setMsgs((prev) => [...prev, m]);

      useEffect(() => {
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
          const res = await fetch(ROUTE + '/chat?text=' + encodeURIComponent(t), { cache: 'no-store' });
          const j = await res.json().catch(() => null);
          if (j && j.ok && j.text) push({ role: 'assistant', text: j.text });
          else push({ role: 'assistant', text: '（奶龙没听见：' + ((j && j.error) || ('HTTP ' + res.status)) + '）' });
        } catch (err) {
          push({ role: 'assistant', text: '（连不上奶龙：' + ((err && err.message) || err) + '）' });
        } finally {
          setBusy(false);
        }
      };

      const poke = () => { void fetch(ROUTE + '/action?key=random').catch(() => {}); };

      return h('div', { style: css.wrap },
        h('div', { style: css.list, ref: listRef },
          msgs.map((m, i) => h('div', { key: i, style: m.role === 'user' ? css.user : css.bot }, m.text)),
          busy ? h('div', { style: css.bot }, '奶龙正在想…') : null),
        h('div', { style: css.bar },
          h('button', { type: 'button', style: css.mini, title: '逗一下奶龙', onClick: poke }, '🐣 逗一下奶龙')),
        h('div', { style: css.row },
          h('input', {
            style: css.input, value: text, placeholder: '和奶龙说点什么…',
            onChange: (e) => setText(e.target.value),
            onKeyDown: (e) => {
              // 中文输入法选词时也会发 Enter；这次按键不是「发送」
              if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) { e.preventDefault(); send(); }
            },
          }),
          h('button', { type: 'button', style: css.send, disabled: busy, onClick: send }, '发送')));
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 右侧栏「奶龙对话」：可选能力，服务缺失时只告警，不影响桌宠本体。
        try {
          const tabs = ctx.get && ctx.get('sidebarRightTabs');
          if (!tabs || typeof tabs.register !== 'function') {
            console.warn('[nailong-pet] 右侧栏不可用：没有 sidebarRightTabs 服务，对话标签未注册');
            return;
          }
          tabs.register({
            id: TAB_ID,
            kind: TAB_KIND,
            priority: 'extension',
            title: () => TAB_TITLE,
            guide: [{ id: TAB_KIND, order: 400, title: () => TAB_TITLE, description: () => '和奶龙聊天' }],
          });
          ctx.slots.inject('sidebar.right.pane.tab', function* () {
            yield ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID, order: 100 }, () => h(ChatPanel, {}));
          });
        } catch (err) {
          console.warn('[nailong-pet] 右侧栏对话注册失败（已忽略）：', err);
        }
      },
    };
  },
});
