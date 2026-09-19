/**
 * prefill-core.js — 第三方预填充桥接（Prefill Bridge）的零依赖核心逻辑。
 *
 * 这个文件不引用任何 SillyTavern / 浏览器 API，纯函数、可在 Node 里单测。
 * 适配层（st-bridge.js）负责把真实的 ST 事件与设置喂进来。
 *
 * 背景（源码级根因，SillyTavern 1.13.x / TauriTavern 同源前端）：
 *   - `assistant_prefill` 只有在 chat_completion_source === 'claude' 时才会被写进 generate_data
 *     （public/scripts/openai.js:2872-2882），第三方（custom）渠道即使填了也永远发不出去。
 *   - 服务端只有三条「第一方」预填充通路：
 *       claude    -> convertClaudeMessages(messages, assistant_prefill, ...)
 *       deepseek  -> addAssistantPrefix(messages, tools, 'prefix')   // DeepSeek 前缀续写
 *       makersuite/vertexai -> addAssistantPrefix(messages, tools, 'partial')
 *     而 CUSTOM 分支（chat-completions.js 的 `chat_completion_source === CUSTOM`）
 *     只做 custom_include_body 合并，既不设旗标也不消费 assistant_prefill。
 *   - 结论：第三方渠道要生效，必须由前端在消息数组上「自己把预填充放成末位 assistant」，
 *     并在响应侧把预填充前缀补回消息（因为上游只回续写部分）。
 *
 * 本模块实现这三件事：
 *   1. resolvePrefill()   —— 决定本次请求的预填充文本（手动 / 预设条目 / 已有末位 assistant）
 *   2. planPrefill()      —— 变换即将发出的 chat 数组（hoist 到末位、去重、安全闸门）
 *   3. composeMessage()   —— 把预填充前缀补回模型返回的续写文本
 */

/** 这些 source 由 SillyTavern / TauriTavern 自己处理预填充，默认不再插手。 */
export const FIRST_PARTY_PREFILL_SOURCES = ['claude', 'deepseek', 'moonshot'];

/** 生成类型白名单语义：quiet = 摘要/隐藏生成，impersonate = 扮演用户。 */
export const DEFAULT_SKIP_TYPES = ['quiet'];

/**
 * 这些 post-processing 模式会把末尾 assistant 合并进一条大 user 文本，预填充会被彻底消灭。
 * 依据：src/prompt-converters.js:85-104 的 mergeMessages(single:true)。
 */
export const DESTRUCTIVE_POST_PROCESSING = ['single'];

export const PREFILL_ROLE = 'assistant';

export const DEFAULT_SETTINGS = Object.freeze({
    /** 总开关 */
    enabled: true,
    /**
     * 预填充文本来源：
     *   auto     —— 手动文本 > 预设条目 > 消息数组里已有的末位 assistant（默认）
     *   manual   —— 只用手动文本
     *   preset   —— 只用预设里匹配到的 assistant 条目
     *   trailing —— 只用消息数组里已有的末位 assistant
     */
    mode: 'auto',
    /** 手动预填充文本（mode=manual/auto 时优先） */
    manualText: '',
    /** 预设条目名匹配正则（对 chatCompletionSettings.prompts[].name 生效） */
    entryNamePattern: '预填充|prefill',
    /** 额外的预设条目 identifier 白名单（精确匹配，优先级高于 name 正则） */
    entryIdentifiers: [],
    /** 把上下文里出现过的同名预填充条目搬到末位（避免同一段文本在历史里出现两次） */
    hoist: true,
    /** 内容匹配方式：exact | prefix | contains */
    matchMode: 'prefix',
    /** matchMode=prefix 时取预填充文本的前 N 个字符做锚点 */
    matchAnchorChars: 24,
    /** 不插手的 source 列表（这些由 ST 自己处理） */
    skipSources: [...FIRST_PARTY_PREFILL_SOURCES],
    /** 不插手的生成类型（quiet=摘要等） */
    skipTypes: [...DEFAULT_SKIP_TYPES],
    /**
     * TauriTavern 特有：custom 源若把 `custom_api_format` 设为 `claude_messages`，
     * TT 客户端会自己下发 assistant_prefill、Rust 侧也会消费，插件必须让位，
     * 否则同一段预填充会被追加两次（且 TT 对不支持预填充的 Claude 模型直接报 ValidationError）。
     */
    skipClaudeMessagesFormat: true,
    /** 末位已经是同一段预填充时不再重复追加 */
    dedupe: true,
    /**
     * 合并「连续的 assistant 消息」为一条。
     * 依据：CommandCode 实测（evidence/11-10-prefill-multi-assistant.json）多条 assistant
     * 连排虽然合法，但续写基准=最后一条结尾，且更容易触发思考膨胀/重复。
     */
    mergeAssistantRun: false,
    /** 生成结束后把预填充前缀补回消息内容 */
    compensate: true,
    /** 补回时如果回复本身已经以预填充开头，就不重复补 */
    compensateOnlyWhenMissing: true,
    /**
     * 附加到「末位预填充消息」上的字段（JSON 文本，默认空）。
     * 为什么是这个位置：厂商私有旗标是**消息级**的，例如 DeepSeek 前缀续写要求
     * `{"role":"assistant","content":"…","prefix":true}`（旗标在消息对象里，不在 body 顶层）。
     * ST/TauriTavern 对 custom 源把 messages 原样透传（ST chat-completions.js:2653、
     * TT payload/openai.rs:148-176），所以这里加的键能一路到上游。
     * 示例：{"prefix": true} / {"partial": true}
     */
    prefillMessageFlags: '{}',
    /**
     * 是否通过 generate_data.custom_include_body 往请求体**顶层**塞字段。
     * 只对 custom 源有效（服务端 mergeObjectWithYaml 到 body 根，chat-completions.js:2409）。
     */
    injectBody: false,
    /** 要注入的 body JSON 文本，例如 {"prefix": true} 或 {"continue_final_message": true} */
    bodyTemplate: '{}',
    /** impersonate 生成时改用 assistant_impersonation 作为预填充 */
    useImpersonationPrefill: false,
    /** 诊断：把每次请求的判定结果留在 bridge 状态里（面板可看） */
    diagnostics: true,
    /** 面板是否折叠（点击标题切换，状态持久化） */
    panelCollapsed: false,
    /**
     * 输出预算下限（0 = 不干预）。CommandCode 实测：v4.1-flash 是推理模型，
     * max_tokens 太小时 reasoning 会吃掉全部预算，content 回空串（finish_reason=length）。
     * 开启后，只要本次落了预填充，就把 generate_data.max_tokens 抬到不低于该值。
     */
    minOutputTokens: 0,
    /** 预填充请求返回空正文时给出提示（reasoning 吃满预算 / 上游忽略预填充） */
    warnOnEmptyContent: true,
    /** 兜底：上游拒绝末尾 assistant 时，标记（由适配层在错误路径读取） */
    stripOnError: true,
    /**
     * 本次落了预填充时，把会消灭末尾 assistant 的 post-processing（`single`）临时降级为默认。
     * 只影响这一次请求，不改用户保存的设置。
     */
    bypassDestructivePostProcessing: true,
    /**
     * 运行时探测兜底：连续 N 次「落了预填充但没拿到回复」时自动降级（不再追加预填充）。
     * 针对未知第三方中转可能直接 4xx 拒绝末尾 assistant 的情况（研究未决项 U1）——
     * 前端拿不到明确的错误事件，只能用「请求没换来消息」这一事实做探测。
     */
    autoFallbackOnFailure: true,
    /** 连续失败多少次后降级 */
    failureThreshold: 2,
});

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

export function normalizeText(value) {
    return String(value ?? '')
        .replace(/\r\n?/g, '\n')
        .replace(/[ \t]+$/gm, '')
        .trim();
}

/** 合并用户设置与默认值，并把字符串/数组字段清洗成安全形态。 */
export function normalizeSettings(raw) {
    const out = { ...DEFAULT_SETTINGS, ...(raw && typeof raw === 'object' ? raw : {}) };
    out.enabled = Boolean(out.enabled);
    out.hoist = Boolean(out.hoist);
    out.dedupe = Boolean(out.dedupe);
    out.mergeAssistantRun = Boolean(out.mergeAssistantRun);
    out.compensate = Boolean(out.compensate);
    out.compensateOnlyWhenMissing = Boolean(out.compensateOnlyWhenMissing);
    out.injectBody = Boolean(out.injectBody);
    out.useImpersonationPrefill = Boolean(out.useImpersonationPrefill);
    out.diagnostics = Boolean(out.diagnostics);
    out.panelCollapsed = Boolean(out.panelCollapsed);
    out.stripOnError = Boolean(out.stripOnError);
    out.warnOnEmptyContent = Boolean(out.warnOnEmptyContent);
    out.skipClaudeMessagesFormat = Boolean(out.skipClaudeMessagesFormat);
    out.autoFallbackOnFailure = Boolean(out.autoFallbackOnFailure);
    out.failureThreshold = clampInt(out.failureThreshold, 1, 10, DEFAULT_SETTINGS.failureThreshold);
    out.minOutputTokens = clampInt(out.minOutputTokens, 0, 4_000_000, 0);

    out.mode = ['auto', 'manual', 'preset', 'trailing'].includes(out.mode) ? out.mode : 'auto';
    out.matchMode = ['exact', 'prefix', 'contains'].includes(out.matchMode) ? out.matchMode : 'prefix';
    out.matchAnchorChars = clampInt(out.matchAnchorChars, 4, 512, DEFAULT_SETTINGS.matchAnchorChars);
    out.manualText = String(out.manualText ?? '');
    out.entryNamePattern = String(out.entryNamePattern ?? '');
    out.bodyTemplate = String(out.bodyTemplate ?? '{}');
    out.prefillMessageFlags = String(out.prefillMessageFlags ?? '{}');
    out.entryIdentifiers = toStringArray(out.entryIdentifiers);
    out.skipSources = toStringArray(out.skipSources);
    out.skipTypes = toStringArray(out.skipTypes);
    return out;
}

function toStringArray(value) {
    if (Array.isArray(value)) {
        return value.map((v) => String(v).trim()).filter(Boolean);
    }
    if (typeof value === 'string') {
        return value
            .split(/[,，\n]/)
            .map((v) => v.trim())
            .filter(Boolean);
    }
    return [];
}

function clampInt(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** 宽松的正则编译：非法正则退化为字面量包含匹配。 */
function compileSafe(pattern) {
    if (!pattern) return null;
    try {
        return new RegExp(pattern, 'i');
    } catch {
        return null;
    }
}

/* ------------------------------------------------------------------ *
 * 1. 判定与解析
 * ------------------------------------------------------------------ */

/**
 * 判断一个预设 prompt 条目是否是「预填充条目」。
 * @param {{identifier?:string,name?:string,role?:string,content?:string,enabled?:boolean}} entry
 * @param {object} settings
 */
export function isPrefillEntry(entry, settings = DEFAULT_SETTINGS) {
    if (!entry || typeof entry !== 'object') return false;
    if (String(entry.role ?? '').toLowerCase() !== PREFILL_ROLE) return false;
    const identifiers = toStringArray(settings.entryIdentifiers);
    if (identifiers.length && identifiers.includes(String(entry.identifier ?? ''))) return true;
    const name = String(entry.name ?? '');
    const re = compileSafe(settings.entryNamePattern);
    if (re && re.test(name)) return true;
    // 没有显式 identifier 命中、name 也没命中时，再看 content 是否带预填充标记
    if (identifiers.length === 0 && !re && /^\s*<prefill>/i.test(String(entry.content ?? ''))) return true;
    return false;
}

/**
 * 从预设 prompt 列表里收集所有预填充候选（含禁用项，禁用项会被标注）。
 * 后出现的条目优先级更高（与 ST 的 prompt_order 顺序一致）。
 *
 * 注意：ST 判定条目是否生效**不读 `prompts[i].enabled`**，而是读
 * `prompt_order[].order[].enabled`（PromptManager.js:1516-1541 getPromptCollection
 * → getPromptOrderForCharacter，实现见 PromptManager.js:1248-1250）。
 * 所以这里额外给出 `activeByOrder`：true/false/null(未知)。
 */
export function collectPrefillCandidates(promptEntries, settings = DEFAULT_SETTINGS, orderInfo = {}) {
    const list = Array.isArray(promptEntries) ? promptEntries : [];
    const out = [];
    for (let i = 0; i < list.length; i++) {
        const entry = list[i];
        if (!isPrefillEntry(entry, settings)) continue;
        const content = String(entry.content ?? '');
        if (!normalizeText(content)) continue;
        const identifier = String(entry.identifier ?? '');
        out.push({
            index: i,
            identifier,
            name: String(entry.name ?? ''),
            role: String(entry.role ?? ''),
            enabled: entry.enabled !== false,
            activeByOrder: lookupOrderEnabled(orderInfo.promptOrder, orderInfo.characterId, identifier),
            content,
            position: entry.injection_position,
            depth: entry.injection_depth,
        });
    }
    return out;
}

/**
 * 用 prompt_order 判断某个 identifier 是否生效。
 * orderInfo 缺失时返回 null（未知），调用方自行决定宽严。
 * @returns {boolean|null}
 */
export function lookupOrderEnabled(promptOrder, characterId, identifier) {
    if (!Array.isArray(promptOrder) || promptOrder.length === 0) return null;
    const id = String(identifier ?? '');
    if (!id) return null;
    const lists = [
        promptOrder.find((l) => l && String(l.character_id) === String(characterId)),
        promptOrder.find((l) => l && String(l.character_id) === '100000'), // ST 的 dummyId（全局顺序）
        promptOrder[promptOrder.length - 1],
    ].filter(Boolean);
    for (const list of lists) {
        const entry = (list.order ?? []).find((e) => e && String(e.identifier) === id);
        if (entry) return entry.enabled !== false;
    }
    return null;
}

/** 取消息数组里最末尾的 assistant 文本（用于 trailing / auto 兜底）。 */
export function detectTrailingPrefill(chat) {
    if (!Array.isArray(chat) || chat.length === 0) return null;
    for (let i = chat.length - 1; i >= 0; i--) {
        const msg = chat[i];
        if (!msg || typeof msg !== 'object') continue;
        const role = String(msg.role ?? '').toLowerCase();
        if (role === PREFILL_ROLE) {
            const text = extractText(msg.content);
            return normalizeText(text) ? text : null;
        }
        // 允许中间夹着空内容项，但遇到 user/tool 立即停止
        if (role) return null;
    }
    return null;
}

function extractText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .map((part) => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : ''))
            .join('');
    }
    return '';
}

/**
 * 决定本次请求用哪个预填充文本。
 *
 * @param {object} input
 * @param {object} input.settings         normalizeSettings() 的结果
 * @param {Array}  [input.promptEntries]  chatCompletionSettings.prompts
 * @param {Array}  [input.chat]           即将发出的消息数组（用于 trailing 兜底 / 二次确认）
 * @param {(s:string)=>string} [input.substitute] 宏替换函数（ST 的 substituteParams）
 * @param {string} [input.generationType] normal | quiet | impersonate | continue ...
 * @param {object} [input.chatCompletionSettings] 用于 impersonate 时的 assistant_impersonation
 * @returns {{text:string, source:'manual'|'preset'|'trailing'|'none', candidates:Array, warnings:string[]}}
 */
export function resolvePrefill(input = {}) {
    const settings = normalizeSettings(input.settings);
    const substitute = typeof input.substitute === 'function' ? input.substitute : (s) => s;
    const warnings = [];
    const orderInfo = input.orderInfo ?? {
        promptOrder: input.chatCompletionSettings?.prompt_order,
        characterId: input.characterId,
    };
    const candidates = collectPrefillCandidates(input.promptEntries, settings, orderInfo);
    const mode = settings.mode;

    const applySub = (text) => {
        try {
            return String(substitute(text) ?? text);
        } catch (error) {
            warnings.push(`宏替换失败，已退回原文: ${error?.message ?? error}`);
            return text;
        }
    };

    const manual = applySub(settings.manualText);
    const impersonation = settings.useImpersonationPrefill
        ? applySub(String(input.chatCompletionSettings?.assistant_impersonation ?? ''))
        : '';
    if (settings.useImpersonationPrefill && String(input.generationType ?? '') === 'impersonate' && normalizeText(impersonation)) {
        return { text: impersonation, source: 'manual', candidates, warnings };
    }

    if (mode === 'manual') {
        return { text: manual, source: normalizeText(manual) ? 'manual' : 'none', candidates, warnings };
    }
    if (mode === 'preset') {
        const picked = pickCandidate(candidates, warnings);
        if (!picked) return { text: '', source: 'none', candidates, warnings };
        return { text: applySub(picked.content), source: 'preset', candidates, warnings };
    }
    if (mode === 'trailing') {
        const trailing = detectTrailingPrefill(input.chat);
        return { text: trailing ?? '', source: trailing ? 'trailing' : 'none', candidates, warnings };
    }

    // auto：手动 > 预设 > 已有末位 assistant
    if (normalizeText(manual)) {
        return { text: manual, source: 'manual', candidates, warnings };
    }
    const picked = pickCandidate(candidates, warnings);
    if (picked) {
        return { text: applySub(picked.content), source: 'preset', candidates, warnings };
    }
    const trailing = detectTrailingPrefill(input.chat);
    if (trailing) {
        return { text: trailing, source: 'trailing', candidates, warnings };
    }
    return { text: '', source: 'none', candidates, warnings };
}

function pickCandidate(candidates, warnings) {
    if (!candidates.length) {
        warnings.push('预设里没有匹配到预填充条目');
        return null;
    }
    const eligible = candidates.filter(candidateUsable);
    if (!eligible.length) {
        warnings.push(`匹配到 ${candidates.length} 个预填充条目，但它们在 Prompt Manager / prompt_order 里都是禁用状态`);
        return null;
    }
    // prompt_order 才是 ST 真正的启用开关；优先取 order 里明确的
    const activeInOrder = eligible.filter((c) => c.activeByOrder === true);
    const pool = activeInOrder.length ? activeInOrder : eligible;
    if (pool.length > 1) {
        warnings.push(`匹配到 ${pool.length} 个启用的预填充条目，取最后一个：${pool[pool.length - 1].name}`);
    }
    return pool[pool.length - 1];
}

/**
 * 条目是否可用：
 *   activeByOrder === true  → 可用
 *   activeByOrder === false → 在 Prompt Manager 里被显式禁用，尊重用户
 *   activeByOrder === null  → 拿不到 order，退回 prompts[].enabled
 */
function candidateUsable(candidate) {
    if (candidate.activeByOrder === true) return true;
    if (candidate.activeByOrder === false) return false;
    return candidate.enabled !== false;
}

/** 本次生成是否应该由插件接管。 */
export function shouldApply({ settings, source, generationType, dryRun, customApiFormat } = {}) {
    const s = normalizeSettings(settings);
    if (!s.enabled) return { apply: false, reason: 'disabled' };
    if (dryRun) return { apply: false, reason: 'dry-run' };
    if (s.skipClaudeMessagesFormat && String(customApiFormat ?? '').toLowerCase() === 'claude_messages') {
        return { apply: false, reason: 'claude-messages-format' };
    }
    if (source && s.skipSources.includes(String(source))) return { apply: false, reason: `first-party-source:${source}` };
    if (generationType && s.skipTypes.includes(String(generationType))) {
        return { apply: false, reason: `skip-type:${generationType}` };
    }
    return { apply: true, reason: 'ok' };
}

/* ------------------------------------------------------------------ *
 * 2. 消息数组变换
 * ------------------------------------------------------------------ */

/** 内容匹配：a 是消息数组里的文本，b 是预填充文本。 */
export function contentMatches(a, b, settings = DEFAULT_SETTINGS) {
    const s = normalizeSettings(settings);
    const left = normalizeText(a);
    const right = normalizeText(b);
    if (!left || !right) return false;
    switch (s.matchMode) {
        case 'exact':
            return left === right;
        case 'contains':
            return left.includes(right);
        case 'prefix':
        default: {
            if (left === right) return true;
            const anchor = right.slice(0, s.matchAnchorChars);
            return anchor.length > 0 && left.startsWith(anchor);
        }
    }
}

/**
 * 需要剥离的旧预填充判定。
 *
 * ⚠️ 只用「完全相等」或「前缀匹配且长度不超过预填充本身太多」。
 * 原因：被补偿过的上一轮助手消息**以预填充开头**（prefill + 续写），如果按纯前缀匹配删，
 * 会把包含真实正文的历史整条删掉（验证者发现的缺陷）。这里用长度上限把真实回复排除在外。
 */
function isHoistableDuplicate(message, prefillText, settings) {
    if (!message || typeof message !== 'object') return false;
    if (String(message.role ?? '').toLowerCase() !== PREFILL_ROLE) return false;
    if (Array.isArray(message.tool_calls) && message.tool_calls.length) return false;
    const s = normalizeSettings(settings);
    const left = normalizeText(extractText(message.content));
    const right = normalizeText(prefillText);
    if (!left || !right) return false;
    if (left === right) return true;
    if (s.matchMode === 'exact') return false;
    // 只承认「预填充 + 纯空白尾巴」这种必然是同一条注入副本的情况。
    // 之前用长度上限(±16B/10%)判断，验证者指出「prefill + 短续写」（例如 prefill+“\n好的”）
    // 也会被整条删掉——短续写同样是有价值的正文，必须保守处理：拿不准就不删。
    // 代价：宏替换导致文本不同的注入副本不会被去重（退化为 hoist=false 的行为，安全侧）。
    if (s.matchMode === 'prefix' && left.startsWith(right)) {
        return left.slice(right.length).trim() === '';
    }
    if (s.matchMode === 'contains' && left.includes(right)) {
        return left.split(right).join('').trim() === '';
    }
    return false;
}

/**
 * 清洗「消息级旗标」：只保留安全的自有可枚举键。
 * 防原型污染（`__proto__` / `constructor` / `prototype`）——`JSON.parse` 会把 `__proto__`
 * 变成自有属性，一旦用赋值写回对象就会改写原型。
 */
export function sanitizeFlags(flags) {
    const out = {};
    if (!flags || typeof flags !== 'object' || Array.isArray(flags)) return out;
    for (const key of Object.keys(flags)) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
        const value = flags[key];
        // 只接受 JSON 可表达的字面量，避免函数/循环引用混进请求体
        if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) out[key] = value;
    }
    return out;
}

/**
 * 把预填充落到消息数组末位。
 *
 * @param {Array} chat 即将发出的 chat 数组（会被就地修改，也可传副本）
 * @param {object} options
 * @param {string} options.text            预填充文本
 * @param {object} options.settings
 * @returns {{chat:Array, changed:boolean, action:string, removed:number, warnings:string[], prefillText:string}}
 */
export function planPrefill(chat, { text, settings = DEFAULT_SETTINGS, flags = null } = {}) {
    const s = normalizeSettings(settings);
    const warnings = [];
    const list = Array.isArray(chat) ? chat : [];
    const prefillText = String(text ?? '');
    const extraFlags = sanitizeFlags(flags);
    const flagKeys = Object.keys(extraFlags);
    const result = { chat: list, changed: false, action: 'skipped', removed: 0, warnings, prefillText, flags: flagKeys };

    if (!normalizeText(prefillText)) {
        result.action = 'empty-prefill';
        return result;
    }
    if (!list.length) {
        warnings.push('消息数组为空');
        result.action = 'empty-chat';
        return result;
    }

    const last = list[list.length - 1];
    const lastRole = String(last?.role ?? '').toLowerCase();

    // 安全闸门：tool 消息 / tool_calls 之后不能直接接 assistant
    if (lastRole === 'tool' || (Array.isArray(last?.tool_calls) && last.tool_calls.length)) {
        result.action = 'blocked-by-tools';
        warnings.push('末尾是 tool 消息或 tool_calls，跳过预填充以保持协议合法');
        return result;
    }
    if (list.some((m) => Array.isArray(m?.tool_calls) && m.tool_calls.length)) {
        result.action = 'blocked-by-tools';
        warnings.push('消息数组里存在 tool_calls，跳过预填充');
        return result;
    }

    const alreadyLast = lastRole === PREFILL_ROLE && contentMatches(extractText(last.content), prefillText, s);
    if (alreadyLast) {
        result.action = 'already-last';
        // 末位已经是目标预填充；若开启 hoist，仍然清理历史里的重复副本
        if (s.hoist) {
            const removed = removeDuplicates(list, list.length - 1, prefillText, s);
            if (removed > 0) {
                result.removed = removed;
                result.changed = true;
                result.action = 'deduped';
            }
        }
        // 把消息级旗标补到现有末位消息上（DeepSeek 的 prefix / Kimi 的 partial 等）
        if (flagKeys.length) {
            let added = 0;
            for (const key of flagKeys) {
                if (last[key] !== extraFlags[key]) {
                    last[key] = extraFlags[key];
                    added++;
                }
            }
            if (added > 0) {
                result.changed = true;
                result.action += `+flags${added}`;
            }
        }
        if (s.mergeAssistantRun) {
            const merged = mergeConsecutiveAssistants(list);
            if (merged > 0) {
                result.merged = merged;
                result.changed = true;
                result.action += `+merged${merged}`;
            }
        }
        return result;
    }

    if (s.hoist) {
        result.removed = removeDuplicates(list, -1, prefillText, s);
    }
    list.push({ role: PREFILL_ROLE, content: prefillText, ...extraFlags });
    result.changed = true;
    result.action = result.removed > 0 ? 'hoisted+appended' : 'appended';
    if (flagKeys.length) result.action += `+flags${flagKeys.length}`;

    if (s.mergeAssistantRun) {
        const merged = mergeConsecutiveAssistants(list);
        if (merged > 0) {
            result.merged = merged;
            result.action += `+merged${merged}`;
        }
    }
    return result;
}

/**
 * 把连续的同 role 消息合并（默认只处理 assistant）。
 * @returns {number} 合并掉的条数
 */
export function mergeConsecutiveAssistants(list, role = PREFILL_ROLE) {
    let merged = 0;
    for (let i = list.length - 2; i >= 0; i--) {
        const current = list[i];
        const next = list[i + 1];
        if (!current || !next) continue;
        if (String(current.role ?? '').toLowerCase() !== role) continue;
        if (String(next.role ?? '').toLowerCase() !== role) continue;
        if (Array.isArray(next.tool_calls) && next.tool_calls.length) continue;
        const nextText = extractText(next.content);
        const currentText = extractText(current.content);
        current.content = [currentText, nextText].filter((x) => String(x ?? '').length).join('\n');
        list.splice(i + 1, 1);
        merged++;
    }
    return merged;
}

function removeDuplicates(list, keepIndex, prefillText, settings) {
    let removed = 0;
    for (let i = list.length - 1; i >= 0; i--) {
        if (i === keepIndex) continue;
        if (isHoistableDuplicate(list[i], prefillText, settings)) {
            list.splice(i, 1);
            removed++;
        }
    }
    return removed;
}

/* ------------------------------------------------------------------ *
 * 3. 输出补偿
 * ------------------------------------------------------------------ */

/**
 * 模型只回「续写」，需要把预填充前缀补回展示文本。
 * @returns {{text:string, compensated:boolean, reason:string}}
 */
export function composeMessage(prefillText, responseText, settings = DEFAULT_SETTINGS) {
    const s = normalizeSettings(settings);
    const prefill = String(prefillText ?? '');
    const response = String(responseText ?? '');
    if (!normalizeText(prefill)) return { text: response, compensated: false, reason: 'no-prefill' };
    if (!s.compensate) return { text: response, compensated: false, reason: 'disabled' };
    if (s.compensateOnlyWhenMissing && startsWithPrefill(response, prefill)) {
        return { text: response, compensated: false, reason: 'already-present' };
    }
    return { text: joinPrefillAndResponse(prefill, response), compensated: true, reason: 'prepended' };
}

/** 宽松判断「回复已经以预填充开头」（忽略首尾空白差异）。 */
export function startsWithPrefill(responseText, prefillText) {
    const a = normalizeText(responseText);
    const b = normalizeText(prefillText);
    if (!b) return false;
    if (a.startsWith(b)) return true;
    // 上游可能回显了预填充但截断了尾部空白/换行
    const anchor = b.slice(0, Math.max(8, Math.min(b.length, 64)));
    return anchor.length > 0 && a.startsWith(anchor);
}

/**
 * 拼接预填充与续写文本，避免出现多余的换行。
 * 规则：预填充自身末尾有几个换行就保留几个；续写不做 trim（流式文本首尾空白有意义）。
 */
export function joinPrefillAndResponse(prefillText, responseText) {
    const prefill = String(prefillText ?? '');
    const response = String(responseText ?? '');
    if (!response) return prefill;
    if (!prefill) return response;
    if (prefill.endsWith('\n') || response.startsWith('\n')) {
        return prefill + response;
    }
    // 预填充以标签/文本结尾、续写以文字开头：直接相接更符合「同一段文本续写」语义
    return prefill + response;
}

/**
 * 把消息对象里的正文换成补偿后的文本，同步 swipes。
 * 纯数据操作，便于单测。
 */
export function patchMessageText(message, text) {
    if (!message || typeof message !== 'object') return false;
    const previous = message.mes;
    message.mes = text;
    const swipeId = Number(message.swipe_id ?? 0);
    if (Array.isArray(message.swipes) && message.swipes.length > swipeId) {
        message.swipes[swipeId] = text;
    }
    return previous !== text;
}

/* ------------------------------------------------------------------ *
 * 4. 诊断
 * ------------------------------------------------------------------ */

export function summarizePlan(resolution, plan, apply) {
    return {
        applied: Boolean(plan?.changed),
        action: plan?.action ?? 'skipped',
        prefillSource: resolution?.source ?? 'none',
        prefillLength: normalizeText(resolution?.text).length,
        removedDuplicates: plan?.removed ?? 0,
        reason: apply?.reason ?? 'ok',
        warnings: [...(resolution?.warnings ?? []), ...(plan?.warnings ?? [])],
    };
}
