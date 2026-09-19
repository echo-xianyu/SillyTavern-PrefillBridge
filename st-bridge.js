/**
 * st-bridge.js — 预填充桥接的 SillyTavern / TauriTavern 适配层。
 *
 * 依赖：prefill-core.js（同目录，ESM）。
 * 运行位置：ST 前端页面（原生扩展）或酒馆助手脚本 iframe（通过 window.parent 拿 ctx）。
 *
 * 三个 hook（全部是 ST 官方事件系统，TauriTavern 前端同源因此同样可用）：
 *   1. GENERATION_AFTER_COMMANDS(type, options, dryRun)        —— 记录本次生成类型
 *   2. CHAT_COMPLETION_PROMPT_READY({chat, dryRun})            —— 就地改写待发消息数组
 *   3. CHAT_COMPLETION_SETTINGS_READY(generate_data)           —— 注入 body 级旗标（可选）
 *   +  MESSAGE_RECEIVED(messageId, type)                       —— 把预填充前缀补回消息
 *      GENERATION_ENDED(chat.length)                          —— 流式下的补偿兜底（早于 MESSAGE_RECEIVED）
 *      GENERATION_STOPPED                                     —— 用户中止，清理待补偿
 */

import {
    DEFAULT_SETTINGS,
    DESTRUCTIVE_POST_PROCESSING,
    normalizeSettings,
    sanitizeFlags,
    resolvePrefill,
    shouldApply,
    planPrefill,
    composeMessage,
    patchMessageText,
    summarizePlan,
    normalizeText,
} from './prefill-core.js';

export const SETTINGS_KEY = 'prefill_bridge';
export const EXTENSION_ID = 'third-party/tavern-prefill';

const MAX_HISTORY = 50;

/** 这些生成类型不会产出「新的助手楼层」，因此不做输出补偿（但也不计为失败）。 */
const NON_COMPENSABLE_TYPES = ['impersonate', 'quiet', 'continue', 'first_message', 'command', 'extension', 'append', 'appendFinal'];
/** 只有这些类型算「用户正常发起的一轮」，失败才计入自动降级。 */
const FAILURE_COUNTED_TYPES = ['normal', ''];

/** 极简事件订阅封装：兼容 ctx.eventSource / TavernHelper 两种形态。 */
function makeEventBus(ctx) {
    const source = ctx?.eventSource;
    const types = ctx?.eventTypes ?? ctx?.event_types ?? {};
    const listeners = [];
    return {
        types,
        on(eventName, handler) {
            if (!eventName || !source?.on) return () => {};
            const wrapped = (...args) => handler(...args);
            source.on(eventName, wrapped);
            listeners.push([eventName, wrapped]);
            return () => {
                source.removeListener?.(eventName, wrapped);
            };
        },
        dispose() {
            while (listeners.length) {
                const [name, handler] = listeners.pop();
                source?.removeListener?.(name, handler);
            }
        },
    };
}

/**
 * @param {object} options
 * @param {object} options.ctx            ST context（getContext() 的结果）
 * @param {object} [options.storage]      { get():object, set(object):void }
 * @param {object} [options.settings]     初始设置（优先级低于 storage）
 * @param {(level:string,msg:string,data?:any)=>void} [options.logger]
 */
export function createBridge({ ctx, storage, settings, logger } = {}) {
    const log = typeof logger === 'function' ? logger : (...args) => console.debug('[prefill-bridge]', ...args);

    const defaultStorage = {
        get() {
            try {
                return ctx?.extensionSettings?.[SETTINGS_KEY] ?? {};
            } catch {
                return {};
            }
        },
        set(value) {
            try {
                if (!ctx?.extensionSettings) return;
                ctx.extensionSettings[SETTINGS_KEY] = value;
                ctx.saveSettingsDebounced?.();
            } catch (error) {
                log('warn', `保存设置失败: ${error?.message ?? error}`);
            }
        },
    };
    const store = storage ?? defaultStorage;

    const state = {
        // storage 里已保存的用户设置优先级最高，构造参数只作为「首次运行的默认值」
        settings: normalizeSettings({ ...(settings ?? {}), ...store.get() }),
        generationType: 'normal',
        generationDryRun: false,
        pending: null,
        pendingUnresolved: false,
        lastResolution: null,
        lastPlan: null,
        lastCompose: null,
        history: [],
        stats: {
            applied: 0,
            compensated: 0,
            skipped: {},
            blocked: 0,
            errors: 0,
            emptyResponses: 0,
            postProcessingBypassed: 0,
            autoFallbacks: 0,
            bodyFlagsSkipped: 0,
        },
        lastError: null,
        lastEmpty: null,
        consecutiveFailures: 0,
        fallbackActive: false,
        attached: false,
    };

    /** 取界面聊天最后一条的正文快照（用于判断 swipe/regenerate 是否真的产出了新内容）。 */
function snapshotTail(chat) {
    if (!Array.isArray(chat) || chat.length === 0) return null;
    return String(chat[chat.length - 1]?.mes ?? chat[chat.length - 1]?.content ?? '');
}

/** 尽量用宿主 toastr 提示；拿不到就退化为 console。 */
    function notify(message) {
        try {
            const toastr = globalThis.toastr ?? (typeof window !== 'undefined' ? window.toastr : undefined);
            if (toastr?.warning) {
                toastr.warning(message, '预填充桥接');
                return;
            }
        } catch {
            /* ignore */
        }
        log('warn', message);
    }

    function persist() {
        store.set({ ...state.settings });
    }

    function record(entry) {
        if (!state.settings.diagnostics) return;
        state.history.push({ at: new Date().toISOString(), ...entry });
        if (state.history.length > MAX_HISTORY) state.history.splice(0, state.history.length - MAX_HISTORY);
    }

    function bumpSkip(reason) {
        const key = String(reason ?? 'unknown');
        state.stats.skipped[key] = (state.stats.skipped[key] ?? 0) + 1;
    }

    /* ---------------- hook: 生成类型 ---------------- */
    function onGenerationAfterCommands(type, _options, dryRun) {
        state.generationType = type ?? 'normal';
        state.generationDryRun = Boolean(dryRun);
    }

    /* ---------------- hook: 消息数组变换 ---------------- */
    function onPromptReady(eventData) {
        try {
            if (!eventData || !Array.isArray(eventData.chat)) return;
            const cs = ctx?.chatCompletionSettings ?? {};
            const source = cs.chat_completion_source;
            // 真实生成开始前，先把上一轮遗留的 pending 结算掉（dry-run 轮次不算新一轮）
            if (!eventData.dryRun) resolveStalePending();
            const verdict = shouldApply({
                settings: state.settings,
                source,
                generationType: state.generationType,
                dryRun: eventData.dryRun,
                customApiFormat: cs.custom_api_format,
            });
            if (state.fallbackActive) {
                bumpSkip('auto-fallback');
                record({ kind: 'prompt-ready', skipped: 'auto-fallback', source });
                return;
            }
            if (!verdict.apply) {
                bumpSkip(verdict.reason);
                record({ kind: 'prompt-ready', skipped: verdict.reason, source });
                return;
            }

            const resolution = resolvePrefill({
                settings: state.settings,
                promptEntries: cs.prompts,
                chat: eventData.chat,
                substitute: ctx?.substituteParams,
                generationType: state.generationType,
                chatCompletionSettings: cs,
                characterId: ctx?.characterId,
            });
            if (!normalizeText(resolution.text)) {
                // 空/全空白文本：不要建立 pending，否则会白白触发 post-processing 兜底与预算调整
                bumpSkip('no-prefill-text');
                record({ kind: 'prompt-ready', source, skipped: 'no-prefill-text' });
                return;
            }
            const plan = planPrefill(eventData.chat, {
                text: resolution.text,
                settings: state.settings,
                flags: sanitizeFlags(parseJsonObject(state.settings.prefillMessageFlags)),
            });
            state.lastResolution = resolution;
            state.lastPlan = plan;

            if (plan.changed) {
                state.pending = {
                    text: resolution.text,
                    source: resolution.source,
                    at: Date.now(),
                    chatLength: eventData.chat.length,
                    // D8：记录 PROMPT_READY 时的界面楼层数，收尾时用它判断「这一轮有没有产生新楼层」
                    baseline: Array.isArray(ctx?.chat) ? ctx.chat.length : null,
                    baselineTail: snapshotTail(ctx?.chat),
                    generationType: String(state.generationType ?? 'normal'),
                };
                state.stats.applied++;
            } else if (plan.action === 'blocked-by-tools') {
                state.stats.blocked++;
            } else if (!resolution.text) {
                bumpSkip('no-prefill-text');
            } else {
                // already-last：仍然要补偿（上游只回续写）
                state.pending = {
                    text: resolution.text,
                    source: resolution.source,
                    at: Date.now(),
                    noop: true,
                    baseline: Array.isArray(ctx?.chat) ? ctx.chat.length : null,
                    baselineTail: snapshotTail(ctx?.chat),
                    generationType: String(state.generationType ?? 'normal'),
                };
            }

            record({
                kind: 'prompt-ready',
                source,
                type: state.generationType,
                action: plan.action,
                prefillSource: resolution.source,
                prefillChars: normalizeText(resolution.text).length,
                removed: plan.removed,
                warnings: [...resolution.warnings, ...plan.warnings],
                tailRoles: eventData.chat.slice(-3).map((m) => m?.role),
            });
            log('info', `prompt-ready: ${summarizePlan(resolution, plan, verdict).action}`, {
                source,
                prefillSource: resolution.source,
            });
        } catch (error) {
            state.stats.errors++;
            state.lastError = String(error?.stack ?? error);
            log('error', `prompt-ready 处理失败: ${error?.message ?? error}`);
        }
    }

    /* ---------------- hook: 请求体调整（body 旗标 + 输出预算下限） ---------------- */
    function onSettingsReady(generateData) {
        try {
            if (!generateData || typeof generateData !== 'object') return;
            const cs = ctx?.chatCompletionSettings ?? {};
            const source = cs.chat_completion_source ?? generateData?.chat_completion_source;

            // 1) 输出预算下限：只在本次真的落了预填充时抬高，且只升不降
            const floor = state.settings.minOutputTokens;
            if (state.pending && floor > 0) {
                const current = Number(generateData.max_tokens);
                if (Number.isFinite(current) && current < floor) {
                    generateData.max_tokens = floor;
                    record({ kind: 'token-floor', from: current, to: floor });
                    log('info', `settings-ready: max_tokens ${current} -> ${floor}（预填充保险）`);
                }
            }

            // 2) post-processing 兜底：`single` 会把末尾 assistant 并进一条大 user 文本，
            //    预填充会被彻底消灭（src/prompt-converters.js:85-104 mergeMessages single:true）。
            //    只降级这一次请求，不动用户保存的设置。
            if (state.pending && state.settings.bypassDestructivePostProcessing) {
                const type = String(generateData.custom_prompt_post_processing ?? '').toLowerCase();
                if (DESTRUCTIVE_POST_PROCESSING.includes(type)) {
                    generateData.custom_prompt_post_processing = '';
                    state.stats.postProcessingBypassed++;
                    record({ kind: 'post-processing-bypass', from: type });
                    log('warn', `settings-ready: custom_prompt_post_processing=${type} 会消灭末尾 assistant，本次已降级为默认`);
                }
            }

            // 3) body 旗标（只有 custom 源服务端会 merge custom_include_body）
            if (!state.settings.injectBody) return;
            if (!state.pending) return; // 本次没有落预填充就不要动 body
            if (source !== 'custom') return;

            const flags = sanitizeFlags(parseJsonObject(state.settings.bodyTemplate));
            if (!Object.keys(flags).length) return;
            const rawExisting = generateData.custom_include_body;
            const parsedExisting = parseJsonObject(rawExisting);
            if (rawExisting != null && String(rawExisting).trim() && !parsedExisting) {
                // 既有值是 YAML 形式（ST 支持 mergeObjectWithYaml）——不要用 JSON 覆盖它
                state.stats.bodyFlagsSkipped++;
                record({ kind: 'body-flags', skipped: 'existing-not-json', existing: String(rawExisting).slice(0, 120) });
                notify('body 顶层字段未被注入：当前 Custom 渠道的「附加 body」不是 JSON 格式（疑似 YAML），为避免覆盖已跳过。');
                return;
            }
            generateData.custom_include_body = JSON.stringify({ ...(parsedExisting ?? {}), ...flags });
            record({ kind: 'body-flags', flags: Object.keys(flags) });
            log('info', 'settings-ready: 注入 body 顶层字段', flags);
        } catch (error) {
            state.stats.errors++;
            state.lastError = String(error?.stack ?? error);
            log('error', `请求体调整失败: ${error?.message ?? error}`);
        }
    }

    /* ---------------- hook: 输出补偿 ---------------- */

    /**
     * 把待补偿的预填充前缀写回楼层。
     * @param {number|undefined} messageId 目标消息 id；非法/缺失时取最后一条
     * @param {object} pending
     * @returns {'compensated'|'skipped'|'no-message'}
     */
    function compensatePending(messageId, pending) {
        if (!state.settings.compensate) return 'skipped';
        const chat = ctx?.chat;
        if (!Array.isArray(chat) || chat.length === 0) return 'no-message';

        // D8/D9：这一轮到底有没有产出「可补偿的新助手内容」
        const type = String(pending.generationType ?? state.generationType ?? 'normal');
        if (NON_COMPENSABLE_TYPES.includes(type)) return 'skipped';
        const swipeLike = ['swipe', 'regenerate'].includes(type);
        if (swipeLike) {
            // swipe/regenerate 是原地替换最后一条，长度不变：用「正文是否变化」判断本轮是否成功。
            // 失败的 swipe 不得把预填充写到旧楼层上（验证者 D8）。
            if (pending.baselineTail != null && snapshotTail(chat) === pending.baselineTail) return 'no-message';
        } else if (Number.isFinite(pending.baseline) && chat.length <= Number(pending.baseline)) {
            // 普通轮次必须有新楼层
            return 'no-message';
        }

        const id = Number(messageId);
        const message = Number.isInteger(id) && id >= 0 && id < chat.length ? chat[id] : chat[chat.length - 1];
        if (!message) return 'no-message';
        // ST 的聊天对象用 is_user/is_system 标身份；额外兼容 role 字段（测试与自定义数据）
        const role = String(message.role ?? '').toLowerCase();
        if (message.is_user || role === 'user' || role === 'system') return 'no-message';
        const finalId = Number.isInteger(id) && id >= 0 && id < chat.length ? id : chat.length - 1;

        // 空正文：多半是上游把预算全花在 reasoning 上（CommandCode v4.1-flash 实测），
        // 此时不要把预填充当成正文写进楼层。
        if (!String(message.mes ?? '').trim()) {
            state.stats.emptyResponses++;
            state.lastEmpty = { at: new Date().toISOString(), prefillChars: normalizeText(pending.text).length };
            record({ kind: 'compensate', messageId: finalId, skipped: 'empty-response', hint: 'reasoning 可能吃满输出预算' });
            if (state.settings.warnOnEmptyContent) notify('模型返回空正文，预填充未生效；请提高「回复最大长度」（v4.1-flash 的 reasoning 会占用同一预算）。');
            return 'skipped';
        }

        const composed = composeMessage(pending.text, message.mes, state.settings);
        state.lastCompose = { ...composed, messageId: finalId };
        if (!composed.compensated) {
            record({ kind: 'compensate', messageId: finalId, skipped: composed.reason });
            return 'skipped';
        }
        patchMessageText(message, composed.text);
        try {
            ctx.updateMessageBlock?.(finalId, message, { rerenderMessage: true });
        } catch (error) {
            log('warn', `重渲染消息失败（内容已写入数据层）: ${error?.message ?? error}`);
        }
        try {
            ctx.saveChat?.();
        } catch (error) {
            log('warn', `保存聊天失败: ${error?.message ?? error}`);
        }
        state.stats.compensated++;
        record({
            kind: 'compensate',
            messageId: finalId,
            prefillChars: normalizeText(pending.text).length,
            responseChars: String(message.mes ?? '').length,
        });
        log('info', 'message-received: 预填充前缀已补回', { messageId: finalId });
        return 'compensated';
    }

    /** 非流式路径：ST 在 saveReply 里发 MESSAGE_RECEIVED（早于 GENERATION_ENDED）。 */
    function onMessageReceived(messageId) {
        const pending = state.pending;
        if (!pending) return;
        try {
            const outcome = compensatePending(messageId, pending);
            if (outcome === 'no-message') {
                state.pendingUnresolved = true;
                return;
            }
            state.pending = null;
            state.pendingUnresolved = false;
            state.consecutiveFailures = 0;
        } catch (error) {
            state.stats.errors++;
            state.lastError = String(error?.stack ?? error);
            log('error', `输出补偿失败: ${error?.message ?? error}`);
        }
    }

    /**
     * 生成结束（`hideStopButton()` → `GENERATION_ENDED`，payload = chat.length）。
     *
     * 时序陷阱（实测 + 源码确认）：**流式路径下 `GENERATION_ENDED` 早于 `MESSAGE_RECEIVED`**
     * —— `finalizeIntermediaryMessage()` 先 `unblockGeneration()` → `hideStopButton()` → emit
     * `GENERATION_ENDED`（public/script.js:3794-3799 → 3536），随后才 emit `MESSAGE_RECEIVED`。
     * 因此这里**不能立刻清掉 pending**，否则 `MESSAGE_RECEIVED` 到达时无事可做，补偿永远不会执行。
     * 处理方式：先就地尝试一次（幂等），失败则把 pending 留给同一轮稍后的 `MESSAGE_RECEIVED`；
     * 真正「这一轮什么都没拿到」的判定推迟到下一次 PROMPT_READY。
     */
    function onGenerationEnded(chatLength) {
        if (!state.pending) {
            state.consecutiveFailures = 0;
            return;
        }
        try {
            const outcome = compensatePending(Number(chatLength) - 1, state.pending);
            if (outcome === 'no-message') {
                // 只有用户正常发起的一轮才计入自动降级：swipe/regenerate/impersonate 等
                // 属于用户主动重试或本就不产出助手楼层，计失败会造成误停用（验证者 D8/D9）。
                const type = String(state.pending?.generationType ?? state.generationType ?? 'normal');
                state.pendingUnresolved = FAILURE_COUNTED_TYPES.includes(type);
                if (!state.pendingUnresolved) {
                    state.pending = null;
                    state.consecutiveFailures = 0;
                }
                return;
            }
            state.pending = null;
            state.pendingUnresolved = false;
            state.consecutiveFailures = 0;
        } catch (error) {
            state.stats.errors++;
            state.lastError = String(error?.stack ?? error);
            log('error', `生成结束补偿失败: ${error?.message ?? error}`);
        }
    }

    /** 用户中止：清掉待补偿，不算失败。 */
    function onGenerationStopped() {
        state.pending = null;
        state.pendingUnresolved = false;
        state.consecutiveFailures = 0;
    }

    /**
     * 新一轮开始：上一轮的 pending 若仍未消费，说明那次请求没换来任何助手消息
     * （可能被上游拒绝末尾 assistant）——现在才计为一次失败。
     */
    function resolveStalePending() {
        if (!state.pending) return;
        const counted = state.pendingUnresolved;
        state.pending = null;
        state.pendingUnresolved = false;
        if (!counted || !state.settings.autoFallbackOnFailure) return;
        state.consecutiveFailures++;
        if (state.consecutiveFailures >= state.settings.failureThreshold && !state.fallbackActive) {
            state.fallbackActive = true;
            state.stats.autoFallbacks++;
            record({ kind: 'auto-fallback', failures: state.consecutiveFailures });
            notify(
                `连续 ${state.consecutiveFailures} 次预填充请求没有拿到回复，已临时停用预填充（上游可能拒绝末尾 assistant 消息）。` +
                    '排查后可在面板里改任意设置即可自动恢复。',
            );
            log('warn', '触发自动降级：停止追加预填充');
        }
    }

    /* ---------------- 生命周期 ---------------- */
    const bus = makeEventBus(ctx);
    function attach() {
        if (state.attached) return unsubscribe;
        const t = bus.types;
        bus.on(t.GENERATION_AFTER_COMMANDS, onGenerationAfterCommands);
        bus.on(t.CHAT_COMPLETION_PROMPT_READY, onPromptReady);
        bus.on(t.CHAT_COMPLETION_SETTINGS_READY, onSettingsReady);
        bus.on(t.MESSAGE_RECEIVED, onMessageReceived);
        bus.on(t.GENERATION_ENDED, onGenerationEnded);
        if (t.GENERATION_STOPPED) bus.on(t.GENERATION_STOPPED, onGenerationStopped);
        state.attached = true;
        log('info', '已挂接 ST 事件');
        return unsubscribe;
    }
    function unsubscribe() {
        bus.dispose();
        state.attached = false;
    }

    const api = {
        state,
        get settings() {
            return state.settings;
        },
        attach,
        dispose: unsubscribe,
        /** 局部更新设置并持久化 */
        updateSettings(patch) {
            state.settings = normalizeSettings({ ...state.settings, ...patch });
            // 用户再次改设置 = 明确要求重新尝试，解除运行时自动降级
            state.fallbackActive = false;
            state.consecutiveFailures = 0;
            persist();
            return state.settings;
        },
        resetSettings() {
            state.settings = normalizeSettings({ ...DEFAULT_SETTINGS, ...(settings ?? {}) });
            persist();
            return state.settings;
        },
        getDiagnostics() {
            return {
                settings: state.settings,
                stats: state.stats,
                fallbackActive: state.fallbackActive,
                consecutiveFailures: state.consecutiveFailures,
                lastResolution: state.lastResolution,
                lastPlan: state.lastPlan && {
                    action: state.lastPlan.action,
                    changed: state.lastPlan.changed,
                    removed: state.lastPlan.removed,
                    warnings: state.lastPlan.warnings,
                },
                lastCompose: state.lastCompose,
                lastEmpty: state.lastEmpty,
                history: state.history.slice(-MAX_HISTORY),
                lastError: state.lastError,
            };
        },
        /** 给测试/调试用：直接对一段 chat 跑一次变换 */
        dryApply(chat, overrides = {}) {
            const cs = ctx?.chatCompletionSettings ?? {};
            const saved = state.settings;
            state.settings = normalizeSettings({ ...saved, ...overrides });
            try {
                const resolution = resolvePrefill({
                    settings: state.settings,
                    promptEntries: cs.prompts,
                    chat,
                    substitute: ctx?.substituteParams,
                    generationType: state.generationType,
                    chatCompletionSettings: cs,
                });
                const plan = planPrefill(chat, {
                    text: resolution.text,
                    settings: state.settings,
                    flags: sanitizeFlags(parseJsonObject(state.settings.prefillMessageFlags)),
                });
                return { resolution, plan };
            } finally {
                state.settings = saved;
            }
        },
    };
    return api;
}

/** 解析一段 JSON 文本/对象；失败返回 null。 */
export function parseJsonObject(value) {
    if (value == null) return null;
    if (typeof value === 'object' && !Array.isArray(value)) return value;
    const text = String(value).trim();
    if (!text) return null;
    try {
        const parsed = JSON.parse(text);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

export { DEFAULT_SETTINGS };
