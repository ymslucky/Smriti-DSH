/**
 * Smriti-DSH 的 Client 半：会话标题旁的「记忆」按钮。点开原生 <dialog>，分两页：
 *  - 上下文：当前会话最近一次注入的 <memory_context>
 *  - 状态与日志：插件运行状态、召回/捕获结果、跳过原因
 *
 * 数据来自 Host 的只读路由：
 *   GET /plugins/smriti/context?session=…
 *   GET /plugins/smriti/status?since=…&limit=…
 *
 * 用原生 dialog.showModal()：标题栏有 overflow 裁剪，dialog 的 top layer 不受影响，
 * 也不需要 react-dom。
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

    const LEVEL_COLORS = {
      debug: 'var(--dsw-alias-label-secondary)',
      info: 'var(--dsw-alias-label-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
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
        '.smriti-tab { border: 0; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; padding: 4px 8px; border-radius: 6px; cursor: pointer; }',
        '.smriti-tab[data-active="true"] { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }',
        '.smriti-log { font-family: var(--dsw-font-family-code, ui-monospace, Consolas, monospace); font-size: 11px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; }',
      ].join('\n');
      document.head.appendChild(style);
    }

    function element(tag, style, text) {
      const node = document.createElement(tag);
      if (style) Object.assign(node.style, style);
      if (text !== undefined) node.textContent = text;
      return node;
    }

    function buildDialog(sessionId) {
      installStyle();
      const dialog = document.createElement('dialog');
      dialog.dataset.smritiMemory = 'true';
      dialog.setAttribute('aria-label', '记忆');
      dialog.style.width = 'min(760px, calc(100vw - 48px))';
      dialog.style.maxHeight = 'calc(100vh - 48px)';

      const panel = element('div', {
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        maxHeight: '76vh',
        padding: '16px',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '10px',
        background: 'var(--dsw-alias-bg-overlay)',
        color: 'var(--dsw-alias-label-primary)',
        boxShadow: '0 12px 40px rgba(0, 0, 0, 0.24)',
      });

      const header = element('div', {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        fontSize: '13px',
      });
      const title = element('strong', null, '记忆');
      const stateLine = element('span', {
        flex: '1',
        fontSize: '11px',
        color: 'var(--dsw-alias-label-secondary)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      });
      const refresh = element('button', smallButtonStyle, '刷新');
      refresh.type = 'button';
      const close = element('button', smallButtonStyle, '关闭');
      close.type = 'button';
      header.append(title, stateLine, refresh, close);

      const tabs = element('div', { display: 'flex', gap: '4px' });
      const tabContext = element('button', { padding: '4px 8px' }, '上下文');
      const tabLogs = element('button', { padding: '4px 8px' }, '状态与日志');
      for (const tab of [tabContext, tabLogs]) {
        tab.type = 'button';
        tab.className = 'smriti-tab';
      }
      tabs.append(tabContext, tabLogs);

      const contextView = element('pre', {
        margin: '0',
        overflow: 'auto',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        fontFamily: 'var(--dsw-font-family-code, ui-monospace, Consolas, monospace)',
        fontSize: '12px',
        lineHeight: '1.6',
        color: 'var(--dsw-alias-label-primary)',
      });
      contextView.textContent = '加载中…';

      const logsView = element('div', {
        display: 'none',
        overflow: 'auto',
        maxHeight: '52vh',
        padding: '8px',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '8px',
        background: 'var(--dsw-alias-bg-layer-1)',
      });

      const footer = element('div', {
        fontSize: '11px',
        color: 'var(--dsw-alias-label-secondary)',
      });
      footer.textContent = '状态每 2 秒自动刷新；日志只保留本进程最近 500 条。';

      panel.append(header, tabs, contextView, logsView, footer);
      dialog.append(panel);
      document.body.appendChild(dialog);

      let activeTab = 'context';
      let lastSeq = 0;
      let pollTimer = null;

      const renderTab = () => {
        contextView.style.display = activeTab === 'context' ? 'block' : 'none';
        logsView.style.display = activeTab === 'logs' ? 'block' : 'none';
        tabContext.dataset.active = String(activeTab === 'context');
        tabLogs.dataset.active = String(activeTab === 'logs');
      };

      const loadContext = async () => {
        contextView.textContent = '加载中…';
        if (sessionId === undefined || sessionId === null) {
          contextView.textContent = '没有会话标识';
          return;
        }
        try {
          const response = await fetch(
            '/plugins/smriti/context?session=' + encodeURIComponent(String(sessionId)),
            { headers: { accept: 'application/json' } },
          );
          if (!response.ok) throw new Error('HTTP ' + response.status);
          const data = await response.json();
          const text = typeof data.context === 'string' ? data.context : '';
          contextView.textContent = text.length === 0 ? '当前会话还没有召回记忆。' : text;
        } catch (failure) {
          contextView.textContent = '读取失败：' + (failure && failure.message ? failure.message : String(failure));
        }
      };

      const appendLogs = (entries) => {
        for (const entry of entries) {
          const line = element('div', {
            color: LEVEL_COLORS[entry.level] || LEVEL_COLORS.info,
          });
          const time = new Date(entry.time).toLocaleTimeString();
          const detail = entry.detail === undefined ? '' : ' · ' + JSON.stringify(entry.detail);
          line.textContent = `${time} [${entry.level}] [${entry.area}] ${entry.message}${detail}`;
          line.className = 'smriti-log';
          logsView.append(line);
        }
        while (logsView.childElementCount > 400) logsView.firstElementChild.remove();
      };

      const formatState = (state) => {
        if (!state) return '';
        const parts = [];
        const daily = state.daily || {};
        parts.push(`捕获 ${daily.count ?? 0}/${daily.limit ?? 0}`);
        if (state.lastRecall) {
          parts.push(state.lastRecall.error
            ? `召回失败 ${state.lastRecall.ms}ms`
            : `召回 ${state.lastRecall.items} 条/${state.lastRecall.ms}ms`);
        }
        if (state.lastCapture) {
          parts.push(`捕获：${state.lastCapture.reason}`);
        }
        return parts.join(' · ');
      };

      const loadStatus = async (reset) => {
        try {
          const since = reset ? 0 : lastSeq;
          const response = await fetch(
            '/plugins/smriti/status?since=' + encodeURIComponent(String(since)) + '&limit=200',
            { headers: { accept: 'application/json' } },
          );
          if (!response.ok) throw new Error('HTTP ' + response.status);
          const data = await response.json();
          lastSeq = typeof data.lastSeq === 'number' ? data.lastSeq : lastSeq;
          if (reset) logsView.replaceChildren();
          appendLogs(Array.isArray(data.logs) ? data.logs : []);
          stateLine.textContent = formatState(data.state);
        } catch (failure) {
          stateLine.textContent = '状态读取失败：' + (failure && failure.message ? failure.message : String(failure));
        }
      };

      const refreshAll = () => {
        void loadContext();
        void loadStatus(true);
      };

      tabContext.addEventListener('click', () => { activeTab = 'context'; renderTab(); });
      tabLogs.addEventListener('click', () => { activeTab = 'logs'; renderTab(); });
      refresh.addEventListener('click', refreshAll);
      close.addEventListener('click', () => dialog.close());
      dialog.addEventListener('click', (event) => {
        if (event.target === dialog) dialog.close();
      });
      dialog.addEventListener('close', () => {
        if (pollTimer !== null) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
      });
      dialog.smritiOpen = () => {
        renderTab();
        refreshAll();
        if (pollTimer === null) {
          pollTimer = setInterval(() => {
            if (dialog.open) void loadStatus(false);
          }, 2000);
        }
      };
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
        dialog.smritiOpen();
      };
      return h('button', {
        type: 'button',
        title: '记忆',
        'aria-label': '记忆',
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
