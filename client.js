/**
 * Smriti-DSH 的 Client 半：在会话标题旁放一个「记忆」按钮，点开浮层展示
 * 当前会话最近一次注入的 `<memory_context>`。只读，不写入、不碰 DOM。
 *
 * 数据来自 Host 的只读路由 `GET /plugins/smriti/context?session=…`；没有
 * 客户端构建步骤（DSH 的模块表只要求 window.__ModuleLoader__.load 工厂）。
 */
window.__ModuleLoader__.load({
  id: 'smriti-dsh',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    let ReactDOM;
    try { ReactDOM = require('react-dom'); } catch { ReactDOM = undefined; }

    const buttonStyle = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '4px',
      height: '24px',
      padding: '0 8px',
      border: '1px solid var(--dsw-alias-border-l1)',
      borderRadius: '6px',
      background: 'transparent',
      color: 'var(--dsw-alias-label-secondary)',
      font: 'inherit',
      fontSize: '12px',
      cursor: 'pointer',
    };
    const overlayStyle = {
      position: 'fixed',
      inset: '0',
      zIndex: 1000,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '24px',
      background: 'rgba(0, 0, 0, 0.32)',
    };
    const panelStyle = {
      width: 'min(720px, 100%)',
      maxHeight: '72vh',
      display: 'flex',
      flexDirection: 'column',
      gap: '12px',
      padding: '16px',
      border: '1px solid var(--dsw-alias-border-l1)',
      borderRadius: '10px',
      background: 'var(--dsw-alias-bg-overlay)',
      color: 'var(--dsw-alias-label-primary)',
      boxShadow: '0 12px 40px rgba(0, 0, 0, 0.24)',
    };
    const headerStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      fontSize: '13px',
    };
    const hintStyle = {
      flex: '1',
      color: 'var(--dsw-alias-label-secondary)',
      fontSize: '12px',
    };
    const smallButtonStyle = {
      height: '24px',
      padding: '0 8px',
      border: '1px solid var(--dsw-alias-border-l1)',
      borderRadius: '6px',
      background: 'transparent',
      color: 'var(--dsw-alias-label-secondary)',
      font: 'inherit',
      fontSize: '12px',
      cursor: 'pointer',
    };
    const preStyle = {
      margin: '0',
      overflow: 'auto',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
      fontFamily: 'var(--dsw-font-family-code, ui-monospace, SFMono-Regular, Consolas, monospace)',
      fontSize: '12px',
      lineHeight: '1.6',
      color: 'var(--dsw-alias-label-primary)',
    };
    const errorStyle = {
      ...preStyle,
      color: 'var(--dsw-alias-state-error-primary)',
    };

    function MemoryAction(props) {
      const sessionId = props.sessionId;
      const [open, setOpen] = React.useState(false);
      const [text, setText] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [busy, setBusy] = React.useState(false);

      const load = React.useCallback(async () => {
        if (sessionId === undefined || sessionId === null) {
          setError('没有会话标识');
          return;
        }
        setBusy(true);
        setError(null);
        try {
          const response = await fetch(
            '/plugins/smriti/context?session=' + encodeURIComponent(String(sessionId)),
            { headers: { accept: 'application/json' } },
          );
          if (!response.ok) throw new Error('HTTP ' + response.status);
          const data = await response.json();
          setText(typeof data.context === 'string' ? data.context : '');
        } catch (failure) {
          setError(failure && failure.message ? failure.message : String(failure));
        } finally {
          setBusy(false);
        }
      }, [sessionId]);

      const openPanel = () => {
        setOpen(true);
        void load();
      };
      const close = () => setOpen(false);

      const trigger = h('button', {
        type: 'button',
        title: '记忆上下文',
        'aria-label': '记忆上下文',
        onClick: openPanel,
        style: buttonStyle,
      }, '记忆');

      if (!open) return trigger;

      const panel = h('div', {
        style: overlayStyle,
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': '记忆上下文',
        onClick: close,
      }, h('div', {
        style: panelStyle,
        onClick: (event) => event.stopPropagation(),
      },
        h('div', { style: headerStyle },
          h('strong', null, '记忆上下文'),
          h('span', { style: hintStyle }, busy ? '加载中…' : ''),
          h('button', {
            type: 'button',
            onClick: () => void load(),
            style: smallButtonStyle,
            disabled: busy,
          }, '刷新'),
          h('button', { type: 'button', onClick: close, style: smallButtonStyle }, '关闭'),
        ),
        error !== null
          ? h('div', { style: errorStyle }, error)
          : h('pre', { style: preStyle }, text === null ? '加载中…' : (text.length === 0 ? '当前会话还没有召回记忆。' : text)),
      ));

      const layer = ReactDOM !== undefined && typeof ReactDOM.createPortal === 'function'
        ? ReactDOM.createPortal(panel, document.body)
        : panel;
      return h(React.Fragment, null, trigger, layer);
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
          name: 'conversation.session.header.actions',
          id: 'smriti-memory',
          order: 30,
        }, MemoryAction));
      },
    };
  },
});
