/**
 * boot.js — 环境引导：拿到 ST context、创建 bridge、挂接事件、挂面板、暴露全局。
 *
 * 两种打包形态共用：
 *   - 原生扩展（index.js 直接 import 本文件）
 *   - 酒馆助手脚本（build.mjs 把 core+bridge+boot+panel 内联成单文件 IIFE）
 */

import { createBridge, SETTINGS_KEY } from './st-bridge.js';

/** 兼容三种运行环境拿到 ST context。 */
export function resolveContext() {
    const candidates = [];
    // 1) 酒馆助手脚本 iframe：predefine.js 会把 parent 的 SillyTavern 镜像到 iframe 全局
    try {
        if (typeof SillyTavern !== 'undefined' && typeof SillyTavern?.getContext === 'function') {
            candidates.push(SillyTavern.getContext());
        }
    } catch {
        /* ignore */
    }
    // 2) 扩展页面：window.SillyTavern
    try {
        const w = typeof window !== 'undefined' ? window : undefined;
        if (typeof w?.SillyTavern?.getContext === 'function') {
            candidates.push(w.SillyTavern.getContext());
        }
        // 3) 同级 iframe：window.parent.SillyTavern
        if (w?.parent && w.parent !== w && typeof w.parent.SillyTavern?.getContext === 'function') {
            candidates.push(w.parent.SillyTavern.getContext());
        }
    } catch {
        /* cross-origin iframe 会抛错，忽略 */
    }
    for (const ctx of candidates) {
        if (ctx && typeof ctx === 'object' && ctx.eventSource && ctx.chatCompletionSettings) return ctx;
    }
    return candidates[0] ?? null;
}

/** 等待 ST 就绪（扩展可能早于 settings 加载完成）。 */
export async function waitForContext({ timeoutMs = 30000, intervalMs = 200 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const ctx = resolveContext();
        if (ctx) return ctx;
        if (Date.now() >= deadline) return null;
        await new Promise((r) => setTimeout(r, intervalMs));
    }
}

/**
 * @param {object} [options]
 * @param {boolean} [options.mountPanel]
 * @param {object} [options.settings]  首次运行的默认设置
 * @returns {Promise<{bridge:object, ctx:object}|null>}
 */
export async function bootBridge({ mountPanel = true, settings, logger } = {}) {
    const ctx = await waitForContext();
    if (!ctx) {
        console.warn('[prefill-bridge] 未找到 SillyTavern context，插件未启动');
        return null;
    }
    const existing = globalThis.__PREFILL_BRIDGE__;
    if (existing) {
        existing.attach();
        return { bridge: existing, ctx };
    }
    const bridge = createBridge({ ctx, settings, logger });
    bridge.ctx = ctx;
    bridge.attach();
    globalThis.__PREFILL_BRIDGE__ = bridge;
    try {
        const w = typeof window !== 'undefined' ? window : undefined;
        if (w) w.PrefillBridge = bridge;
    } catch {
        /* ignore */
    }
    if (mountPanel) {
        // 面板是增强项，失败不影响核心功能。
        // 单文件脚本形态下没有模块系统，由打包器预先注入 __PREFILL_MOUNT_PANEL__。
        try {
            const injected = globalThis.__PREFILL_MOUNT_PANEL__;
            if (typeof injected === 'function') {
                injected(bridge);
            } else {
                const { mountPanel: mount } = await import('./panel.js');
                mount(bridge);
            }
        } catch (error) {
            console.debug('[prefill-bridge] 面板未挂载:', error?.message ?? error);
        }
    }
    return { bridge, ctx };
}

export { SETTINGS_KEY };
