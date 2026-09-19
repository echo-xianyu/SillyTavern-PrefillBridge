/**
 * panel.js — 预填充桥接的设置面板（原生 DOM，无框架依赖）。
 *
 * 挂载策略（按优先级）：
 *   1. ST 扩展抽屉 #extensions_settings2 / #extensions_settings 里插入一个可折叠卡片
 *   2. 退化为右下角悬浮按钮 + 抽屉
 * 两种环境（原生扩展 / 酒馆助手脚本 iframe）都能用。
 */

const STYLE_ID = 'prefill-bridge-style';
const CARD_ID = 'prefill-bridge-card';
const BODY_ID = 'prefill-bridge-body';

const CSS = `
.pb-card{border:1px solid var(--SmartThemeBorderColor,#555);border-radius:8px;margin:6px 0;padding:8px;font-size:12px;background:var(--SmartThemeBlurTintColor,rgba(0,0,0,.15))}
.pb-card h4{margin:0 0 6px;font-size:13px;display:flex;justify-content:space-between;align-items:center;gap:6px}
.pb-card h4 .pb-title{display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;flex:1 1 auto}
.pb-card h4 .pb-title:hover{opacity:.85}
.pb-caret{display:inline-block;width:12px;text-align:center;font-size:10px;opacity:.8}
.pb-body{display:flex;flex-direction:column}
.pb-row{display:flex;align-items:center;gap:6px;margin:4px 0}
.pb-row label{flex:0 0 auto}
.pb-row.pb-col{flex-direction:column;align-items:stretch}
.pb-card textarea,.pb-card input[type=text],.pb-card select{width:100%;box-sizing:border-box;font-family:monospace;font-size:11px}
.pb-card textarea{min-height:64px;resize:vertical}
.pb-muted{opacity:.7}
.pb-badge{display:inline-block;padding:1px 5px;border-radius:6px;font-size:10px;border:1px solid currentColor}
.pb-ok{color:#2ecc71}.pb-warn{color:#ffb020}.pb-err{color:#ff5b5b}
.pb-btn{cursor:pointer;padding:2px 8px;border-radius:6px;border:1px solid var(--SmartThemeBorderColor,#555);background:transparent;color:inherit}
.pb-fab{position:fixed;right:14px;bottom:80px;z-index:9999;width:38px;height:38px;border-radius:50%;border:1px solid #555;background:rgba(20,20,25,.85);color:#eee;cursor:pointer;font-size:17px}
.pb-drawer{position:fixed;right:14px;bottom:124px;z-index:9999;width:340px;max-height:70vh;overflow:auto;background:rgba(15,15,20,.96);color:#eee;border:1px solid #555;border-radius:10px;padding:10px;box-shadow:0 8px 30px rgba(0,0,0,.5)}
.pb-pre{white-space:pre-wrap;word-break:break-all;font-family:monospace;font-size:10px;max-height:140px;overflow:auto;border:1px dashed #555;border-radius:6px;padding:4px;margin-top:4px}
`;

function injectStyle(doc) {
    if (doc.getElementById(STYLE_ID)) return;
    const style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    doc.head?.appendChild(style);
}

function el(doc, tag, props = {}, children = []) {
    const node = doc.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
        if (k === 'style') node.setAttribute('style', v);
        else if (k === 'text') node.textContent = v;
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
        else if (v === true) node.setAttribute(k, '');
        else if (v !== false && v != null) node.setAttribute(k, String(v));
    }
    for (const child of [].concat(children)) {
        node.appendChild(typeof child === 'string' ? doc.createTextNode(child) : child);
    }
    return node;
}

/** 面板主体（DOM 无关部分可单测：返回节点树）。 */
export function buildPanel(doc, bridge) {
    injectStyle(doc);
    const s = bridge.settings;

    const status = el(doc, 'div', { class: 'pb-muted' });
    const diagPre = el(doc, 'div', { class: 'pb-pre' });
    const detected = el(doc, 'div', { class: 'pb-pre' });

    const refresh = () => {
        const diag = bridge.getDiagnostics();
        status.textContent = `启用:${diag.settings.enabled ? '是' : '否'} · 生效${diag.stats.applied} · 补偿${diag.stats.compensated} · 拦截${diag.stats.blocked} · 异常${diag.stats.errors}`;
        const last = diag.history[diag.history.length - 1];
        diagPre.textContent = [
            last ? `最近一次: ${last.kind} ${last.action ?? last.skipped ?? ''} ${last.prefillSource ?? ''}` : '尚无记录',
            last?.warnings?.length ? `警告: ${last.warnings.join(' / ')}` : '',
            diag.lastCompose ? `补偿: ${diag.lastCompose.reason} (#${diag.lastCompose.messageId})` : '',
            diag.lastError ? `错误: ${String(diag.lastError).split('\n')[0]}` : '',
            `跳过统计: ${JSON.stringify(diag.stats.skipped)}`,
        ]
            .filter(Boolean)
            .join('\n');
        const cs = bridge.ctx?.chatCompletionSettings ?? {};
        const entries = (cs.prompts ?? [])
            .filter((p) => String(p.role ?? '').toLowerCase() === 'assistant' && p.content && p.enabled !== false)
            .map((p) => `· ${p.name} (${p.identifier})`);
        detected.textContent = [`当前渠道: ${cs.chat_completion_source ?? '?'}`, `候选 assistant 条目 ${entries.length} 个:`, ...entries.slice(0, 8)].join('\n');
    };

    const enabledInput = el(doc, 'input', { type: 'checkbox' });
    enabledInput.checked = s.enabled;
    enabledInput.addEventListener('change', () => {
        bridge.updateSettings({ enabled: enabledInput.checked });
        refresh();
    });

    const modeSelect = el(doc, 'select');
    for (const [value, label] of [
        ['auto', 'auto：手动 > 预设条目 > 末尾 assistant'],
        ['manual', 'manual：只用手动文本'],
        ['preset', 'preset：只用预设条目'],
        ['trailing', 'trailing：只用末尾 assistant'],
    ]) {
        const option = el(doc, 'option', { value, text: label });
        if (s.mode === value) option.setAttribute('selected', '');
        modeSelect.appendChild(option);
    }
    modeSelect.addEventListener('change', () => {
        bridge.updateSettings({ mode: modeSelect.value });
        refresh();
    });

    const manualInput = el(doc, 'textarea', { placeholder: '手动预填充文本（留空则自动取预设条目）' });
    manualInput.value = s.manualText;
    manualInput.addEventListener('change', () => {
        bridge.updateSettings({ manualText: manualInput.value });
        refresh();
    });

    const patternInput = el(doc, 'input', { type: 'text', value: s.entryNamePattern });
    patternInput.addEventListener('change', () => {
        bridge.updateSettings({ entryNamePattern: patternInput.value });
        refresh();
    });

    const hoistInput = el(doc, 'input', { type: 'checkbox' });
    hoistInput.checked = s.hoist;
    hoistInput.addEventListener('change', () => bridge.updateSettings({ hoist: hoistInput.checked }));

    const compensateInput = el(doc, 'input', { type: 'checkbox' });
    compensateInput.checked = s.compensate;
    compensateInput.addEventListener('change', () => bridge.updateSettings({ compensate: compensateInput.checked }));

    const flagsInput = el(doc, 'textarea', { placeholder: '{"prefix": true}  —— 消息级旗标，挂在末位预填充消息上' });
    flagsInput.value = s.prefillMessageFlags;
    flagsInput.addEventListener('change', () => bridge.updateSettings({ prefillMessageFlags: flagsInput.value }));

    const injectBodyInput = el(doc, 'input', { type: 'checkbox' });
    injectBodyInput.checked = s.injectBody;
    injectBodyInput.addEventListener('change', () => bridge.updateSettings({ injectBody: injectBodyInput.checked }));

    const bodyInput = el(doc, 'textarea', { placeholder: '{"prefix": true}' });
    bodyInput.value = s.bodyTemplate;
    bodyInput.addEventListener('change', () => bridge.updateSettings({ bodyTemplate: bodyInput.value }));

    const body = el(doc, 'div', { class: 'pb-body', id: BODY_ID }, [
        el(doc, 'div', { class: 'pb-muted', text: '让 custom / 第三方 OpenAI 兼容渠道也能真正生效预填充（末尾 assistant 续写 + 展示补回）。' }),
        el(doc, 'div', { class: 'pb-row' }, [enabledInput, el(doc, 'span', { text: '启用插件' })]),
        el(doc, 'div', { class: 'pb-row pb-col' }, [el(doc, 'label', { text: '预填充来源' }), modeSelect]),
        el(doc, 'div', { class: 'pb-row pb-col' }, [el(doc, 'label', { text: '手动预填充文本' }), manualInput]),
        el(doc, 'div', { class: 'pb-row pb-col' }, [el(doc, 'label', { text: '预设条目名匹配正则' }), patternInput]),
        el(doc, 'div', { class: 'pb-row' }, [hoistInput, el(doc, 'span', { text: '把历史里的重复预填充搬到末位' })]),
        el(doc, 'div', { class: 'pb-row' }, [compensateInput, el(doc, 'span', { text: '生成后把预填充前缀补回消息' })]),
        el(doc, 'div', { class: 'pb-row pb-col' }, [el(doc, 'label', { text: '消息级旗标 JSON（挂到末位预填充消息）' }), flagsInput]),
        el(doc, 'div', { class: 'pb-row' }, [injectBodyInput, el(doc, 'span', { text: '注入 body 顶层字段（仅 custom 源）' })]),
        el(doc, 'div', { class: 'pb-row pb-col' }, [el(doc, 'label', { text: 'body 顶层字段 JSON' }), bodyInput]),
        el(doc, 'div', { class: 'pb-row pb-col' }, [el(doc, 'label', { text: '状态' }), status]),
        el(doc, 'div', { class: 'pb-row pb-col' }, [el(doc, 'label', { text: '检测到的候选' }), detected]),
        el(doc, 'div', { class: 'pb-row pb-col' }, [el(doc, 'label', { text: '诊断' }), diagPre]),
    ]);

    // 折叠/展开（状态持久化在设置里，刷新页面后保持）
    const caret = el(doc, 'span', { class: 'pb-caret', text: '▼' });
    const setCollapsed = (collapsed, persist = true) => {
        body.style.display = collapsed ? 'none' : 'flex';
        caret.textContent = collapsed ? '▶' : '▼';
        card.setAttribute('data-collapsed', collapsed ? 'true' : 'false');
        if (persist) bridge.updateSettings({ panelCollapsed: collapsed });
    };
    const title = el(doc, 'span', {
        class: 'pb-title',
        title: '点击折叠 / 展开',
        onclick: () => setCollapsed(!bridge.settings.panelCollapsed),
    }, [caret, el(doc, 'span', { text: '🧩 第三方预填充桥接' })]);

    const refreshBtn = el(doc, 'button', {
        class: 'pb-btn',
        text: '刷新',
        onclick: (event) => {
            event?.stopPropagation?.();
            refresh();
        },
    });

    const card = el(doc, 'div', { class: 'pb-card', id: CARD_ID }, [el(doc, 'h4', {}, [title, refreshBtn]), body]);
    setCollapsed(Boolean(s.panelCollapsed), false);
    refresh();
    bridge.__refreshPanel = refresh;
    return card;
}

/** 选择面板宿主 document：酒馆助手脚本 iframe 里要挂到父页面。 */
export function pickPanelDocument() {
    const w = typeof window !== 'undefined' ? window : null;
    if (!w) return null;
    try {
        if (w.parent && w.parent !== w && w.parent.document?.body) return w.parent.document;
    } catch {
        /* cross-origin：退回自身 document */
    }
    return w.document ?? null;
}

/** 挂载到页面：优先塞进扩展设置抽屉，失败则退化为悬浮按钮。 */
export function mountPanel(bridge) {
    const doc = pickPanelDocument();
    if (!doc) return null;
    if (doc.getElementById(CARD_ID) || doc.getElementById('pb-fab')) return null;

    const card = buildPanel(doc, bridge);
    const host = doc.querySelector('#extensions_settings2') ?? doc.querySelector('#extensions_settings');
    if (host) {
        host.appendChild(card);
        return card;
    }

    // 退化：悬浮按钮 + 抽屉
    const drawer = el(doc, 'div', { class: 'pb-drawer', style: 'display:none' }, [card]);
    const fab = el(doc, 'button', {
        class: 'pb-fab',
        id: 'pb-fab',
        title: '预填充桥接',
        text: '🧩',
        onclick: () => {
            drawer.style.display = drawer.style.display === 'none' ? 'block' : 'none';
        },
    });
    const mountTarget = doc.body ?? doc.documentElement;
    mountTarget?.appendChild(drawer);
    mountTarget?.appendChild(fab);
    return card;
}

export { el as _el };
