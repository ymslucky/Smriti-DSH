/**
 * Smriti-DSH 的 Client 半：在会话标题旁放一个「记忆」按钮，点开原生 <dialog>
 * 展示当前会话最近一次注入的 `<memory_context>`。只读，不写入、不读其他插件 DOM。
 *
 * 用原生 dialog + showModal 而不是 React 浮层：标题栏有 overflow 裁剪，
 * dialog 的 top layer 不受影响，也不需要依赖 react-dom 的 createPortal。
 *
 * 数据来自 Host 的只读路由 `GET /plugins/smriti/context?session=…`。
 */
window.__ModuleLoader__.load({
  id: 'smriti-dsh',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

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

    let styleInstalled = false;
    function installStyle() {
      if (styleInstalled) return;
      styleInstalled = true;
      const style = document.createElement('style');
      style.dataset.plugin = 'smriti-dsh';
      style.textContent = [
        'dialog[data-smriti-memory] { padding: 0; border: 0; background: transparent; }',
        'dialog[data-smriti-memory]::backdrop { background: rgba(0, 0, 0, 0.32); }',
      ].join('\n');
      document.head.appendChild(style);
    }

    function buildDialog(sessionId) {
      installStyle();
      const dialog = document.createElement('dialog');
      dialog.dataset.smritiMemory = 'true';
      dialog.setAttribute('aria-label', '记忆上下文');
      dialog.style.width = 'min(720px, calc(100vw - 48px))';
      dialog.style.maxHeight = 'calc(100vh - 48px)';

      const panel = document.createElement('div');
      panel.style.display = 'flex';
      panel.style.flexDirection = 'column';
      panel.style.gap = '12px';
      panel.style.maxHeight = '72vh';
      panel.style.padding = '16px';
      panel.style.border = '1px solid var(--dsw-alias-border-l1)';
      panel.style.borderRadius = '10px';
      panel.style.background = 'var(--dsw-alias-bg-overlay)';
      panel.style.color = 'var(--dsw-alias-label-primary)';
      panel.style.boxShadow = '0 12px 40px rgba(0, 0, 0, 0.24)';

      const header = document.createElement('div');
      header.style.display = 'flex';
      header.style.alignItems = 'center';
      header.style.gap = '8px';
      header.style.fontSize = '13px';

      const title = document.createElement('strong');
      title.textContent = '记忆上下文';
      const status = document.createElement('span');
      status.style.flex = '1';
      status.style.fontSize = '12px';
      status.style.color = 'var(--dsw-alias-label-secondary)';

      const refresh = document.createElement('button');
      refresh.type = 'button';
      refresh.textContent = '刷新';
      Object.assign(refresh.style, smallButtonStyle);

      const close = document.createElement('button');
      close.type = 'button';
      close.textContent = '关闭';
      Object.assign(close.style, smallButtonStyle);

      const body = document.createElement('pre');
      body.style.margin = '0';
      body.style.overflow = 'auto';
      body.style.whiteSpace = 'pre-wrap';
      body.style.wordBreak = 'break-word';
      body.style.fontFamily = 'var(--dsw-font-family-code, ui-monospace, SFMono-Regular, Consolas, monospace)';
      body.style.fontSize = '12px';
      body.style.lineHeight = '1.6';
      body.style.color = 'var(--dsw-alias-label-primary)';

      header.append(title, status, refresh, close);
      panel.append(header, body);
      dialog.append(panel);
      document.body.appendChild(dialog);

      const load = async () => {
        if (sessionId === undefined || sessionId === null) {
          status.textContent = '没有会话标识';
          body.textContent = '';
          return;
        }
        status.textContent = '加载中…';
        refresh.disabled = true;
        try {
          const response = await fetch(
            '/plugins/smriti/context?session=' + encodeURIComponent(String(sessionId)),
            { headers: { accept: 'application/json' } },
          );
          if (!response.ok) throw new Error('HTTP ' + response.status);
          const data = await response.json();
          const text = typeof data.context === 'string' ? data.context : '';
          status.textContent = text.length === 0 ? '暂无召回' : '';
          body.textContent = text.length === 0 ? '当前会话还没有召回记忆。' : text;
        } catch (failure) {
          status.textContent = '';
          body.textContent = '读取失败：' + (failure && failure.message ? failure.message : String(failure));
        } finally {
          refresh.disabled = false;
        }
      };

      refresh.addEventListener('click', () => { void load(); });
      close.addEventListener('click', () => dialog.close());
      dialog.addEventListener('click', (event) => {
        if (event.target === dialog) dialog.close();
      });
      dialog.addEventListener('close', () => {
        body.textContent = '';
        status.textContent = '';
      });
      dialog.smritiLoad = load;
      return dialog;
    }

    function MemoryAction(props) {
      const sessionId = props.sessionId;
      const dialogRef = React.useRef(null);
      React.useEffect(() => () => {
        if (dialogRef.current !== null) {
          dialogRef.current.remove();
          dialogRef.current = null;
        }
      }, []);
      const open = () => {
        if (dialogRef.current === null) dialogRef.current = buildDialog(sessionId);
        const dialog = dialogRef.current;
        if (!dialog.open) dialog.showModal();
        void dialog.smritiLoad();
      };
      return h('button', {
        type: 'button',
        title: '记忆上下文',
        'aria-label': '记忆上下文',
        onClick: open,
        style: buttonStyle,
      }, '记忆');
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
