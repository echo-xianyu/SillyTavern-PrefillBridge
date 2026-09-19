/**
 * index.js — SillyTavern / TauriTavern 原生扩展入口。
 *
 * 安装位置（两套宿主通用）：
 *   ST:          data/<user>/extensions/third-party/tavern-prefill/
 *   TauriTavern: data/default-user/extensions/tavern-prefill/  或 data/extensions/third-party/tavern-prefill/
 *
 * 本文件只做引导：真正的逻辑在 prefill-core.js / st-bridge.js / panel.js。
 */

import { bootBridge } from './boot.js';

const boot = () => {
    try {
        void bootBridge({ mountPanel: true });
    } catch (error) {
        console.error('[prefill-bridge] 启动失败:', error);
    }
};

if (typeof window !== 'undefined' && window.SillyTavern?.getContext) {
    const ctx = window.SillyTavern.getContext();
    // 等 ST 扩展系统就绪后再挂事件，避免与 settings 加载竞争
    if (ctx?.eventSource && (ctx.eventTypes ?? {}).APP_READY) {
        ctx.eventSource.once(ctx.eventTypes.APP_READY, boot);
        // 兜底：3 秒后无论如何都启动一次（APP_READY 可能已经错过）
        setTimeout(boot, 3000);
    } else {
        boot();
    }
} else {
    // 非 ST 页面（例如被直接当脚本加载）时也尝试一次
    boot();
}
