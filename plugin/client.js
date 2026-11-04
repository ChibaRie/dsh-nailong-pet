/**
 * 奶龙桌宠 —— DSH 插件的 Web 半。
 *
 * 只在输入框下方挂一个小按钮：点一下让奶龙随便动一动，右键/长按不用管。
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

    function NailongButton() {
      const onClick = (e) => {
        e.preventDefault();
        void fetch(ROUTE + '/action?key=random').catch(() => {});
      };
      return h('button', {
        type: 'button',
        title: '逗一下奶龙',
        onClick,
        style: {
          border: '1px solid var(--dsw-alias-border, rgba(128,128,128,.4))',
          background: 'transparent',
          color: 'inherit',
          borderRadius: 8,
          padding: '2px 8px',
          fontSize: 14,
          lineHeight: '20px',
          cursor: 'pointer',
        },
      }, '🐣');
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock', id: 'nailong-pet', order: 60,
        }, NailongButton));
      },
    };
  },
});
