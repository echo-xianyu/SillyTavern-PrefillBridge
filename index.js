/*!
 * Prefill Bridge — 第三方预填充桥 v0.1.0
 * 适配 SillyTavern (Web) 与 TauriTavern (Tauri 桌面端)
 * 让预设里"尾随 assistant 的预填充提示词"在第三方 / 中转渠道真正生效。
 *
 * 构建产物，请勿直接编辑；源码见 src/。
 */

/*!
 * Prefill Bridge — 第三方预填充桥 (core)
 * ============================================================
 * 目标宿主: SillyTavern (Web) / TauriTavern (Tauri Desktop)
 *
 * 问题: SillyTavern 只在少数"原生"渠道实现了 assistant 预填充：
 *   - claude    -> service 端 convertClaudeMessages() 把尾随 assistant 变成
 *                  Anthropic 原生 prefill（src/prompt-converters.js:335）
 *   - deepseek  -> 走 https://api.deepseek.com/beta 并给最后一条 assistant
 *                  打 prefix:true（src/prompt-converters.js:67 + chat-completions.js:1119）
 *   - moonshot  -> 给最后一条 assistant 打 partial:true（chat-completions.js:2542）
 *   - 其余所有渠道（custom / openai / azure / openrouter / xai / groq / ...）
 *     只是把 messages 原样转发（chat-completions.js:2394-2423 / 2650-2680），
 *     预设里那条尾随 assistant 的“预填充”提示词因此不生效。
 *
 * 本模块在请求真正发出前（CHAT_COMPLETION_SETTINGS_READY）改写 generate_data，
 * 按渠道选择正确的预填充机制；渠道不支持真前缀时退化为"软预填充"（合并进末条消息）。
 *
 * 本文件为 UMD：浏览器挂到 globalThis.PrefillBridge，Node 下 module.exports。
 */
;(function (root, factory) {
    // 无论被当作 CommonJS、ES module 还是普通 <script> 加载，都同时发布到 root。
    // 酒馆把扩展入口作为 <script type="module"> 加载，模块作用域里没有 module，
    // 若只走 CJS 分支就会导致 globalThis.PrefillBridge 缺失。
    var api = factory(root);
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    if (root && typeof root === 'object') {
        root.PrefillBridge = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
    'use strict';

    var VERSION = '0.1.0';
    var INSTALL_KEY = '__prefillBridge__';

    /** 所有可用的预填充策略 */
    var STRATEGIES = [
        'auto',                   // 按渠道自动决定
        'off',                    // 不处理（交给酒馆原生逻辑）
        'prefix',                 // 尾随 assistant 打 prefix:true          (DeepSeek /beta 系)
        'partial',                // 尾随 assistant 打 partial:true         (Moonshot / Kimi 系)
        'continue_final_message', // 顶层 continue_final_message:true       (vLLM / SGLang / llama.cpp)
        'passthrough',            // 保持尾随 assistant 原样不动             (Anthropic 兼容 / 已支持的网关)
        'soft_append',            // 删掉尾随 assistant，把预填充并入末条消息 (万能兜底)
    ];

    var DEFAULT_SOFT_TEMPLATE = [
        '<PrefillBridge>',
        '以下是本轮回复**已经写好的开头**。你必须直接从这段开头的结尾处无缝续写：',
        '1. 不要重复、不要改写、不要概述这段开头；',
        '2. 不要对它做任何解释、标注、评价或总结；',
        '3. 保持与它完全一致的文风、人称、分段与格式。',
        '',
        '<<<PREFILL',
        '{{prefill}}',
        'PREFILL>>>',
        '</PrefillBridge>',
    ].join('\n');

    var DEFAULT_CONFIG = {
        enabled: true,
        debug: false,
        /** 预填充文本来源: auto=优先尾随 assistant 消息, 其次酒馆 assistant_prefill 设置 */
        prefillSource: 'auto',      // auto | message | setting | off
        /** 尾随 assistant 消息是否视作预填充: auto=仅当其前面一条是 user */
        trailingAssistant: 'auto',  // auto | force | ignore
        /** 全局默认策略（auto=按渠道表） */
        defaultStrategy: 'auto',
        /** 按 chat_completion_source 的策略覆盖，例如 { custom: 'soft_append', openai: 'soft_append' } */
        perSource: {},
        /** 用户自定义渠道规则（优先于内置规则，按数组顺序首个命中者生效） */
        rules: [],
        /** 命中 DeepSeek 官方域名时，把 custom_url 改写到 /beta */
        rewriteDeepseekBeta: true,
        /** 文本补全(GENERATE_AFTER_DATA)路径是否也处理（默认只记录不修改） */
        handleTextCompletion: false,
        softAppend: {
            template: DEFAULT_SOFT_TEMPLATE,
            /** 合并到哪条消息: last-user=并入最后一条 user；new-message=新插入一条 */
            position: 'last-user',   // last-user | new-message
            /** 新插入消息的角色（position=new-message 时生效） */
            role: 'user',            // user | system
        },
        /** 诊断环形缓冲长度 */
        maxTrace: 40,
        /** 未识别渠道的兜底策略 */
        fallbackStrategy: 'soft_append',
        /**
         * 渠道探测结果缓存：{ "source|url|model": { verdict, at } }。
         * verdict='restart' 时，即使规则判定为 passthrough 也会改用 soft_append；
         * verdict='prefix' 时，规则判定为 soft_append 的会改回 passthrough。
         */
        probes: {},
        /**
         * 不参与改写的生成类型。
         * quiet 是酒馆用于摘要/标题等后台生成的静默请求，预设的"预填充"不该塞进去。
         * 可选值: normal / continue / impersonate / quiet / swipe
         */
        skipTypes: ['quiet'],
        /**
         * 挂钩开关。
         * settingsReady —— 主钩子，改 generate_data 本体（覆盖绝大多数请求）
         * fetch        —— 次级兜底，包装 window.fetch（覆盖 custom-request.js 等
         *                 不触发事件、以及 TauriTavern 宿主内核改写的场景）
         */
        hooks: { settingsReady: true, fetch: true },
    };

    /**
     * 内置渠道识别表（按顺序匹配，首个命中生效）。
     * source: 精确匹配 chat_completion_source（字符串或数组）
     * url:    正则，测试 custom_url || reverse_proxy
     * model:  正则，测试模型 id
     * strategy: 命中后的策略；'auto' 表示继续往下找
     */
    var BUILTIN_RULES = [
        // ============================================================
        // 0) 已"移除 assistant prefill"的模型：必须改写，否则 400 或静默失效。
        //    必须排在所有 URL / 厂商规则之前（Claude 4.6+ 也可能挂在 anthropic 域名下）。
        // ============================================================
        {
            id: 'model:claude-noprefill',
            model: /(^|[/_:.-])claude[-_.]?(opus[-_.]?4[-_.]?[678]|sonnet[-_.]?4[-_.]?6|opus[-_.]?5|sonnet[-_.]?5|fable|haiku[-_.]?5)/i,
            strategy: 'soft_append',
            label: 'Claude 4.6+/Fable/5 系（已移除 assistant prefill → 改为软预填充）',
        },
        {
            id: 'model:gemini-noprefill',
            model: /gemini[-_.]?3[-_.](5[-_.]?flash[-_.]?lite|6|7|8)/i,
            strategy: 'soft_append',
            label: 'Gemini 3.6~3.8 Flash / 3.5 Flash-Lite（拒绝尾随 model turn → 改为软预填充）',
        },

        // ============================================================
        // 1) 酒馆服务端已原生处理：默认 off，避免双重预填充。
        //    nativeGuard=noTools：酒馆的 addAssistantPrefix() 在存在 tools 时会直接跳过
        //    （src/prompt-converters.js:72-76），此时原生机制失效，必须由插件接手。
        // ============================================================
        { id: 'native:claude', source: 'claude', strategy: 'off', nativeGuard: 'claudeThinking', fallbackStrategy: 'soft_append', label: 'Claude（酒馆原生 prefill；思考模式下酒馆会把预填充降级为 user，改由插件接手）' },
        { id: 'native:deepseek', source: 'deepseek', strategy: 'off', nativeGuard: 'noTools', fallbackStrategy: 'soft_append', label: 'DeepSeek 官方（酒馆原生 prefix + /beta；带 tools 时失效）' },
        { id: 'native:moonshot', source: 'moonshot', strategy: 'off', nativeGuard: 'toolRole', fallbackStrategy: 'soft_append', label: 'Moonshot 官方（酒馆原生 partial；仅 tool 角色消息会使其失效）' },

        // ============================================================
        // 2) 按 URL / 模型识别第三方与自定义渠道
        // ============================================================
        // Command Code：实测尾随 assistant 会被当成真前缀续写
        // （2026-09-19 扫了账号目录里 10 个模型：DeepSeek 各档、Kimi K2.5/K2.6/K2.7/K3 全部只返回续写片段）。
        // 已知例外是个别小模型（如 inclusionai/ling-3.0-flash-sante:free 会整段重起），
        // 这类不靠规则表枚举，交由"渠道能力探测"的结果覆盖。
        {
            id: 'url:commandcode',
            url: /commandcode\.ai|\/provider\/v1\//i,
            strategy: 'passthrough',
            label: 'Command Code 网关（实测透传尾随 assistant 即真前缀续写）',
        },
        {
            id: 'url:deepseek',
            url: /(^|\/\/|\.)api\.deepseek\.com/i,
            strategy: 'prefix',
            rewriteBeta: true,
            label: 'DeepSeek 官方域名（prefix 前缀补全）',
        },
        {
            id: 'url:moonshot',
            url: /api\.moonshot\.(cn|ai)|api\.platform\.moonshot/i,
            strategy: 'partial',
            label: 'Moonshot / Kimi（partial）',
        },
        {
            id: 'url:mistral',
            url: /api\.mistral\.ai/i,
            strategy: 'prefix',
            label: 'Mistral（prefix 前缀补全）',
        },
        {
            id: 'url:openrouter',
            url: /openrouter\.ai/i,
            strategy: 'passthrough',
            label: 'OpenRouter（透传，由上游自行处理）',
        },
        {
            id: 'url:vllm',
            url: /(vllm|sglang)/i,
            strategy: 'continue_final_message',
            label: 'vLLM / SGLang（continue_final_message + add_generation_prompt:false）',
        },
        {
            id: 'url:anthropic',
            url: /anthropic|claude\.ai|api\.claude/i,
            strategy: 'passthrough',
            label: 'Anthropic <=4.5（尾随 assistant 即原生 prefill）',
        },
        {
            id: 'model:claude',
            model: /claude|anthropic/i,
            strategy: 'passthrough',
            label: 'Claude 系模型（经中转；4.6+ 已由上面的规则改判）',
        },
        // 注意：这里**故意没有** "模型名含 deepseek 就透传" 的规则。
        // 经中转站访问 DeepSeek 时，对方打的是普通端点还是 /beta、会不会带上 prefix，
        // 都无法从模型名推断；猜错的代价是预填充静默失效。未知渠道一律先走软预填充，
        // 真想知道就点面板上的"探测"。
        {
            id: 'url:gemini',
            url: /generativelanguage\.googleapis\.com|gemini/i,
            strategy: 'soft_append',
            label: 'Gemini 兼容端点（版本差异大，软预填充兜底）',
        },

        // ============================================================
        // 3) 未识别（含绝大多数中文中转站 / Ollama / LM Studio / 本机服务）：
        //    没有通用真前缀机制，用"软预填充"兜底 —— 不依赖服务商支持，永远可用。
        // ============================================================
        { id: 'fallback', matchAll: true, strategy: 'soft_append', label: '未知渠道（软预填充：改提示词让模型接着写，不是真前缀）' },
    ];

    // ------------------------------------------------------------------
    // 小工具
    // ------------------------------------------------------------------

    function isPlainObject(v) {
        if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
        if (v instanceof RegExp || v instanceof Date) return false;
        return true;
    }

    function clone(v) {
        if (v instanceof RegExp) return new RegExp(v.source, v.flags);
        if (v instanceof Date) return new Date(v.getTime());
        if (Array.isArray(v)) return v.map(clone);
        if (isPlainObject(v)) {
            var o = {};
            Object.keys(v).forEach(function (k) { o[k] = clone(v[k]); });
            return o;
        }
        return v;
    }

    function deepMerge(base, patch) {
        var out = clone(base);
        if (!isPlainObject(patch)) return out;
        Object.keys(patch).forEach(function (k) {
            var pv = patch[k];
            if (isPlainObject(pv) && isPlainObject(out[k])) out[k] = deepMerge(out[k], pv);
            else if (pv !== undefined) out[k] = clone(pv);
        });
        return out;
    }

    function normalizeConfig(raw) {
        var cfg = deepMerge(DEFAULT_CONFIG, raw || {});
        if (STRATEGIES.indexOf(cfg.defaultStrategy) < 0) cfg.defaultStrategy = 'auto';
        if (STRATEGIES.indexOf(cfg.fallbackStrategy) < 0) cfg.fallbackStrategy = 'soft_append';
        if (['auto', 'message', 'setting', 'off'].indexOf(cfg.prefillSource) < 0) cfg.prefillSource = 'auto';
        if (['auto', 'force', 'ignore'].indexOf(cfg.trailingAssistant) < 0) cfg.trailingAssistant = 'auto';
        if (!Array.isArray(cfg.rules)) cfg.rules = [];
        cfg.rules = cfg.rules.map(compileRulePatterns).filter(Boolean);
        if (!Array.isArray(cfg.skipTypes)) cfg.skipTypes = clone(DEFAULT_CONFIG.skipTypes);
        if (!isPlainObject(cfg.perSource)) cfg.perSource = {};
        if (!isPlainObject(cfg.probes)) cfg.probes = {};
        if (!isPlainObject(cfg.softAppend)) cfg.softAppend = clone(DEFAULT_CONFIG.softAppend);
        if (!isPlainObject(cfg.hooks)) cfg.hooks = clone(DEFAULT_CONFIG.hooks);
        if (cfg.hooks.settingsReady === undefined) cfg.hooks.settingsReady = true;
        if (cfg.hooks.fetch === undefined) cfg.hooks.fetch = true;
        if (typeof cfg.softAppend.template !== 'string' || !cfg.softAppend.template) {
            cfg.softAppend.template = DEFAULT_SOFT_TEMPLATE;
        }
        var mt = Number(cfg.maxTrace);
        cfg.maxTrace = isFinite(mt) && mt > 0
            ? Math.min(400, Math.floor(mt))
            : DEFAULT_CONFIG.maxTrace;
        return cfg;
    }

    /**
     * 规则里的 url / model / pattern 允许写成"正则字符串"（因为配置要能 JSON 持久化），
     * 这里统一编译成 RegExp；程序内直接传 RegExp 则原样保留。
     * source 保持"精确匹配"语义，不做正则化。
     */
    function compileRulePatterns(rule) {
        if (!isPlainObject(rule)) return null;
        var out = clone(rule);
        ['url', 'model', 'pattern'].forEach(function (key) {
            var v = out[key];
            var flags = out[key + 'Flags'] || out.flags || '';
            // 已经是 RegExp（程序内直接传）→ 原样保留
            if (v instanceof RegExp) return;
            // 字符串 → 正则源码
            if (typeof v === 'string') {
                try { out[key] = new RegExp(v, flags); }
                catch (e) { out[key] = undefined; }   // 非法正则视为未设置，避免误匹配
                return;
            }
            // 反序列化残留：{ source, flags } 形态还能救回来
            if (isPlainObject(v) && typeof v.source === 'string') {
                try { out[key] = new RegExp(v.source, v.flags || flags); }
                catch (e) { out[key] = undefined; }
                return;
            }
            // 其余对象（例如 JSON 化后变成 {}）一律当"未设置"，不能当成能匹配任何东西的规则
            if (v !== undefined && v !== null) out[key] = undefined;
        });
        delete out.flags;
        return out;
    }

    /**
     * 把运行时配置转成可 JSON 持久化的形态。
     * 关键：RegExp 必须落成 `url: <source>` + `urlFlags`，否则
     * extensionSettings 一旦被 JSON.stringify/parse 往返，正则就变成 `{}`，
     * 规则会静默失效（独立复核发现的 BUG-4）。
     */
    function serializeConfig(cfg) {
        var out = clone(cfg);
        out.rules = (cfg.rules || []).map(function (rule) {
            var r = clone(rule);
            ['url', 'model', 'pattern'].forEach(function (key) {
                if (!(r[key] instanceof RegExp)) return;
                var flags = r[key].flags;
                r[key] = r[key].source;
                if (flags) r[key + 'Flags'] = flags;
                else delete r[key + 'Flags'];
            });
            return r;
        });
        return out;
    }

    /** 取消息的纯文本（兼容多模态数组内容） */
    function messageText(msg) {
        if (!msg) return '';
        var c = msg.content;
        if (typeof c === 'string') return c;
        if (Array.isArray(c)) {
            return c
                .map(function (part) {
                    if (typeof part === 'string') return part;
                    if (part && typeof part.text === 'string') return part.text;
                    return '';
                })
                .join('');
        }
        return '';
    }

    /**
     * 以指定文本替换消息内容（保留多模态结构）。
     * 注意：多模态消息可能含**多个** text 片段，messageText() 会把它们拼起来，
     * 因此这里必须把所有 text 片段合并成一个，否则会出现"原文重复出现"的脏数据
     * （[AAA, img, BBB] + 追加 → [AAABBB…, img, BBB]）。图片等非文本片段原序保留。
     */
    function setMessageText(msg, text) {
        var c = msg.content;
        if (typeof c === 'string' || c === undefined || c === null) {
            msg.content = text;
            return true;
        }
        if (Array.isArray(c)) {
            var firstTextIdx = -1;
            var nonText = [];
            for (var i = 0; i < c.length; i++) {
                var part = c[i];
                var isText = typeof part === 'string' || (part && typeof part.text === 'string');
                if (isText && firstTextIdx < 0) { firstTextIdx = i; continue; }
                if (isText) continue;                       // 其余 text 片段并入首个
                nonText.push({ idx: i, part: part });
            }
            var rebuilt = [];
            var inserted = false;
            for (var j = 0; j < c.length; j++) {
                if (!inserted && j === firstTextIdx) {
                    rebuilt.push({ type: 'text', text: text });
                    inserted = true;
                }
                var p2 = c[j];
                var isText2 = typeof p2 === 'string' || (p2 && typeof p2.text === 'string');
                if (isText2) continue;
                rebuilt.push(p2);
            }
            if (!inserted) rebuilt.unshift({ type: 'text', text: text });
            msg.content = rebuilt;
            void nonText;
            return true;
        }
        msg.content = text;
        return true;
    }

    /** 在消息文本后追加文本（返回新增字符数） */
    function appendMessageText(msg, suffix) {
        var old = messageText(msg);
        setMessageText(msg, old + suffix);
        return suffix.length;
    }

    function preview(text, n) {
        if (typeof text !== 'string') return '';
        n = n || 200;
        return text.length > n ? text.slice(0, n) + ' …(+' + (text.length - n) + '字)' : text;
    }

    // ------------------------------------------------------------------
    // 渠道识别
    // ------------------------------------------------------------------

    function testPattern(pattern, value) {
        if (pattern === undefined || pattern === null) return true;
        if (typeof pattern === 'string') return value === pattern;
        if (Array.isArray(pattern)) return pattern.indexOf(value) >= 0;
        if (pattern instanceof RegExp) {
            pattern.lastIndex = 0;
            return pattern.test(value);
        }
        return false;
    }

    function ruleMatches(rule, probe) {
        if (!rule) return false;
        if (rule.enabled === false) return false;
        var conditions = 0;
        if (rule.source !== undefined) { conditions++; if (!testPattern(rule.source, probe.source)) return false; }
        if (rule.url !== undefined) { conditions++; if (!testPattern(rule.url, probe.url)) return false; }
        if (rule.model !== undefined) { conditions++; if (!testPattern(rule.model, probe.model)) return false; }
        if (rule.pattern !== undefined) {
            conditions++;
            var scope = rule.target === 'url' ? probe.url
                : rule.target === 'model' ? probe.model
                    : probe.url + '\n' + probe.model + '\n' + probe.source;
            if (!testPattern(rule.pattern, scope)) return false;
        }
        // 没有任何条件的规则只允许显式声明 matchAll，否则视为永不命中（避免误伤全部渠道）
        if (conditions === 0) return rule.matchAll === true;
        return true;
    }

    /**
     * 识别渠道并给出建议策略。
     * @returns {{ruleId:string,label:string,strategy:string,rewriteBeta:boolean,probe:object}}
     */
    function classify(probe, cfg) {
        cfg = cfg || DEFAULT_CONFIG;
        var userRules = Array.isArray(cfg.rules) ? cfg.rules : [];
        var i, r;
        for (i = 0; i < userRules.length; i++) {
            r = userRules[i];
            if (ruleMatches(r, probe)) {
                return {
                    ruleId: r.id || ('user:' + i),
                    label: r.label || r.note || '自定义规则',
                    strategy: r.strategy || 'auto',
                    rewriteBeta: !!r.rewriteBeta,
                    nativeGuard: r.nativeGuard,
                    fallbackStrategy: r.fallbackStrategy,
                    probe: probe,
                    fromUser: true,
                };
            }
        }
        for (i = 0; i < BUILTIN_RULES.length; i++) {
            r = BUILTIN_RULES[i];
            if (ruleMatches(r, probe)) {
                return {
                    ruleId: r.id,
                    label: r.label,
                    strategy: r.strategy || 'auto',
                    rewriteBeta: !!r.rewriteBeta,
                    nativeGuard: r.nativeGuard,
                    fallbackStrategy: r.fallbackStrategy,
                    probe: probe,
                    fromUser: false,
                };
            }
        }
        return {
            ruleId: 'fallback',
            label: '未知渠道（软预填充：改提示词让模型接着写，不是真前缀）',
            strategy: cfg.fallbackStrategy,
            rewriteBeta: false,
            nativeGuard: undefined,
            fallbackStrategy: undefined,
            probe: probe,
            fromUser: false,
        };
    }

    /** 结合用户覆盖，得出最终策略 */
    function resolveStrategy(channel, cfg) {
        var s = channel.strategy;
        var overridden = false;
        var bySource = cfg.perSource && cfg.perSource[channel.probe.source];
        if (bySource && STRATEGIES.indexOf(bySource) >= 0) {
            s = bySource;
            overridden = true;
        }
        if (!overridden && cfg.defaultStrategy && cfg.defaultStrategy !== 'auto') {
            s = cfg.defaultStrategy;
            overridden = true;
        }
        if (s === 'auto' || STRATEGIES.indexOf(s) < 0) s = cfg.fallbackStrategy;
        return { strategy: s, overridden: overridden };
    }

    // ------------------------------------------------------------------
    // 预填充抽取
    // ------------------------------------------------------------------

    /**
     * 判断尾随 assistant 消息是否应视作预填充。
     * auto: 仅当它前面一条是 user（正常聊天历史不会以 assistant+前置 user 收尾，
     *       而预设的“预填充”提示词恰好插在最后一条 user 之后）。
     */
    function isTrailingPrefill(messages, cfg) {
        if (!Array.isArray(messages) || messages.length === 0) return false;
        var last = messages[messages.length - 1];
        if (!last || last.role !== 'assistant') return false;
        if (cfg.trailingAssistant === 'ignore') return false;
        if (cfg.trailingAssistant === 'force') return true;
        var prev = messages[messages.length - 2];
        return !!prev && prev.role === 'user';
    }

    /**
     * 原生预填充失效的判定。
     * 每个原生源失效的原因不同，不能一概而论（这一点由独立复核抓出来，见 docs/05）：
     *
     * - deepseek: ST 调 addAssistantPrefix(messages, bodyParams.tools, 'prefix')，
     *   而该函数在 tools 数组非空**或**存在 tool 角色消息时直接跳过
     *   （src/prompt-converters.js:72-76）。
     * - moonshot: ST 传的是空数组 addAssistantPrefix(messages, [], 'partial')
     *   （chat-completions.js:2542），所以只有 tool 角色消息会让它跳过，
     *   tools 数组本身不影响。
     * - claude: 走的是另一条路（convertClaudeMessages + assistant_prefill），
     *   完全不经过 addAssistantPrefix，所以 tools 无关。真正会毁掉预填充的是
     *   "思考模式"：chat-completions.js:393-394 在 fixThinkingPrefill 为真时
     *   把最后一条 assistant 降级成 user。
     */
    var NATIVE_GUARDS = {
        noTools: function (body) {
            if (Array.isArray(body.tools) && body.tools.length > 0) return true;
            return hasToolRole(body);
        },
        toolRole: function (body) {
            return hasToolRole(body);
        },
        claudeThinking: function (body) {
            // 与 chat-completions.js:253 的 useThinking 正则保持一致
            var model = String(body.model || '');
            var thinkingModel = /^claude-(3-7|opus-4|sonnet-4|haiku-4-5|opus-4-5|opus-4-6|sonnet-4-6|opus-4-7)/.test(model)
                || /claude-fable/.test(model)
                || /claude-(opus-5|sonnet-5)/.test(model);
            if (!thinkingModel) return false;
            return body.include_reasoning === true;
        },
    };

    function hasToolRole(body) {
        if (!Array.isArray(body.messages)) return false;
        return body.messages.some(function (m) { return m && m.role === 'tool'; });
    }

    /**
     * 抽取预填充文本。
     * @returns {{text:string, from:'message'|'setting'|'none', index:number}}
     */
    function extractPrefill(body, cfg, env) {
        env = env || {};
        var messages = Array.isArray(body.messages) ? body.messages : [];
        var source = cfg.prefillSource;

        if (source === 'off') return { text: '', from: 'none', index: -1 };

        // auto 与 message：优先尾随 assistant 消息
        if (source === 'auto' || source === 'message') {
            if (isTrailingPrefill(messages, cfg)) {
                return {
                    text: messageText(messages[messages.length - 1]),
                    from: 'message',
                    index: messages.length - 1,
                };
            }
            if (source === 'message') return { text: '', from: 'none', index: -1 };
        }

        // auto 与 setting：退回酒馆的 assistant_prefill 设置
        if (source === 'auto' || source === 'setting') {
            var text = '';
            if (env.type === 'impersonate') {
                text = env.assistantImpersonation || body.assistant_impersonation || '';
            }
            if (!text) text = env.assistantPrefill || body.assistant_prefill || '';
            if (typeof text === 'string' && text.trim()) {
                return { text: text, from: 'setting', index: -1 };
            }
        }

        return { text: '', from: 'none', index: -1 };
    }

    // ------------------------------------------------------------------
    // 策略执行
    // ------------------------------------------------------------------

    function renderSoftBlock(template, prefill) {
        return String(template).split('{{prefill}}').join(prefill);
    }

    /** 移除尾随的预填充 assistant 消息 */
    function dropTrailingAssistant(body, prefillIndex) {
        if (prefillIndex >= 0 && prefillIndex === body.messages.length - 1) {
            var removed = body.messages.pop();
            return removed;
        }
        return null;
    }

    function ensureTrailingAssistant(body, text) {
        var messages = body.messages;
        var last = messages[messages.length - 1];
        if (last && last.role === 'assistant') return messages.length - 1;
        messages.push({ role: 'assistant', content: text });
        return messages.length - 1;
    }

    function escapeRegExp(str) {
        return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    /**
     * 判断 custom_include_body 是否是"顶层块映射"——只有这种形态才能安全地追加键。
     * 必须是顶层（无缩进）的 `key: value` 行；JSON、flow 映射 `{a: 1}`、序列、嵌套结构
     * 一律拒绝：往它们后面直接接一行 plain scalar，会让整段 YAML 变成非法，
     * 而酒馆的 mergeObjectWithYaml() 用 `catch {}` 静默吞掉解析失败
     * （src/util.js:861-863），结果是用户原有的 request body 参数**整段消失**且没有任何报错。
     */
    function isSafeBlockMapping(text) {
        if (/^[{[]/.test(text)) return false;
        var lines = String(text).split('\n');
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            if (!line.trim()) continue;
            if (/^\s*#/.test(line)) continue;
            if (/^\s/.test(line)) return false;            // 缩进 = 嵌套结构
            if (/^-{3,}/.test(line)) return false;          // 文档分隔
            if (!/^[A-Za-z0-9_."'$\-]+[^:]*:\s*.*$/.test(line)) return false;
            if (/[{[][^}\]]*$/.test(line)) return false;    // 值里有未闭合的流式结构
        }
        return true;
    }

    /**
     * 规划往 custom_include_body 注入顶层键。
     * 返回 { yaml, applied, conflicts }；conflicts 非空表示无法安全注入，调用方应换策略。
     */
    function planCustomIncludeBody(existing, pairs) {
        var out = typeof existing === 'string' ? existing : '';
        var trimmed = out.trim();
        var keys = Object.keys(pairs);

        if (!trimmed) {
            return {
                yaml: keys.map(function (k) { return k + ': ' + String(pairs[k]); }).join('\n'),
                applied: keys.slice(),
                conflicts: [],
            };
        }
        if (!isSafeBlockMapping(trimmed)) {
            return {
                yaml: out,
                applied: [],
                conflicts: ['custom_include_body 不是顶层块映射 YAML（可能是 JSON / flow 映射 / 嵌套结构），'
                    + '为免破坏其中已有参数而拒绝追加'],
            };
        }
        var lines = out.replace(/\s+$/, '').split('\n');
        var applied = [];
        var conflicts = [];
        keys.forEach(function (k) {
            var re = new RegExp('^' + escapeRegExp(k) + '\\s*:\\s*(.*)$');
            for (var i = 0; i < lines.length; i++) {
                var m = lines[i].match(re);
                if (!m) continue;
                var want = String(pairs[k]);
                if (m[1].trim() !== want) {
                    conflicts.push('custom_include_body 里已有 ' + k + ': ' + m[1].trim()
                        + '，与插件需要的 ' + want + ' 冲突');
                }
                return;
            }
            lines.push(k + ': ' + String(pairs[k]));
            applied.push(k);
        });
        if (conflicts.length) return { yaml: out, applied: [], conflicts: conflicts };
        return { yaml: lines.join('\n'), applied: applied, conflicts: [] };
    }

    var APPLIERS = {
        off: function () {
            return { changed: false, actions: [] };
        },

        prefix: function (body, prefill, cfg) {
            if (!prefill.text) return { changed: false, actions: [] };
            var idx = prefill.index >= 0 ? prefill.index : ensureTrailingAssistant(body, prefill.text);
            var msg = body.messages[idx];
            delete msg.partial;
            var changed = msg.prefix !== true;
            msg.prefix = true;
            var actions = [];
            if (changed) actions.push('messages[' + idx + '].prefix = true');
            if (cfg.rewriteDeepseekBeta) {
                var rw = rewriteBetaUrl(body);
                if (rw) actions.push(rw);
            }
            return { changed: changed || actions.length > 0, actions: actions };
        },

        partial: function (body, prefill) {
            if (!prefill.text) return { changed: false, actions: [] };
            var idx = prefill.index >= 0 ? prefill.index : ensureTrailingAssistant(body, prefill.text);
            var msg = body.messages[idx];
            delete msg.prefix;
            var changed = msg.partial !== true;
            msg.partial = true;
            return {
                changed: changed,
                actions: changed ? ['messages[' + idx + '].partial = true'] : [],
            };
        },

        continue_final_message: function (body, prefill, cfg) {
            void cfg;
            if (!prefill.text) return { changed: false, actions: [], notes: [] };
            var notes = [];

            // 酒馆 custom 分支的 requestBody 是"白名单顶层字段 + bodyParams"重建的
            // （src/endpoints/backends/chat-completions.js:2650-2680），直接挂在
            // generate_data 上的顶层字段会被丢掉。custom_include_body 是唯一被合并进
            // bodyParams（并在最后展开）的入口（:2409 + src/util.js:844）。
            var planYaml = null;
            if (String(body.chat_completion_source) === 'custom') {
                planYaml = planCustomIncludeBody(body.custom_include_body, {
                    continue_final_message: true,
                    add_generation_prompt: false,
                });
                if (planYaml.conflicts.length) {
                    // 无法安全注入 → 回退到不依赖服务端字段的软预填充（先不改动 body）
                    return {
                        changed: false,
                        actions: [],
                        notes: notes.concat(planYaml.conflicts),
                        fallbackTo: 'soft_append',
                    };
                }
            } else {
                notes.push('非 custom 渠道：酒馆可能不转发该顶层字段，若不生效请改用软预填充');
            }

            var actions = [];
            if (prefill.index < 0) ensureTrailingAssistant(body, prefill.text);
            if (body.continue_final_message !== true) {
                body.continue_final_message = true;
                actions.push('continue_final_message = true');
            }
            if (body.add_generation_prompt !== false) {
                body.add_generation_prompt = false;
                actions.push('add_generation_prompt = false');
            }
            if (planYaml && planYaml.yaml !== body.custom_include_body) {
                body.custom_include_body = planYaml.yaml;
                actions.push('custom_include_body 注入 ' + planYaml.applied.join(' / '));
            }
            return { changed: actions.length > 0, actions: actions, notes: notes };
        },

        passthrough: function () {
            return { changed: false, actions: [] };
        },

        soft_append: function (body, prefill, cfg) {
            if (!prefill.text) return { changed: false, actions: [] };
            var block = renderSoftBlock(cfg.softAppend.template, prefill.text);
            var actions = [];

            if (prefill.from === 'message') {
                var dropped = dropTrailingAssistant(body, prefill.index);
                if (dropped) actions.push('移除 messages[' + prefill.index + ']（assistant 预填充）');
            }

            var messages = body.messages;
            var pos = cfg.softAppend.position;
            var target = null;
            if (pos === 'last-user') {
                for (var i = messages.length - 1; i >= 0; i--) {
                    if (messages[i] && messages[i].role === 'user') { target = messages[i]; break; }
                }
            }
            // 幂等：同一段软预填充已经并进去了就不再重复追加（两种位置都检查）。
            // fetch 兜底钩子会对同一请求体再跑一次 plan，这里是关键的第二道闸。
            var alreadyThere = messages.some(function (m) {
                return messageText(m).indexOf(block) >= 0;
            });
            if (alreadyThere) {
                return { changed: actions.length > 0, actions: actions.concat(['软预填充已存在，跳过重复追加']) };
            }
            var notes = [];
            if (String(cfg.softAppend.template).indexOf('{{prefill}}') < 0) {
                notes.push('软预填充模板里没有 {{prefill}} 占位符，预填充原文不会被写入');
            }

            if (target) {
                appendMessageText(target, '\n\n' + block);
                actions.push('预填充并入末尾 user 消息（+' + block.length + ' 字符）');
            } else {
                var role = cfg.softAppend.role === 'system' ? 'system' : 'user';
                messages.push({ role: role, content: block });
                actions.push('新增一条 ' + role + ' 消息承载预填充（+' + block.length + ' 字符）');
            }
            return { changed: true, actions: actions, notes: notes };
        },
    };

    function rewriteBetaUrl(body) {
        var candidates = ['custom_url', 'reverse_proxy'];
        for (var i = 0; i < candidates.length; i++) {
            var key = candidates[i];
            var url = body[key];
            if (typeof url !== 'string' || !url) continue;
            if (!/api\.deepseek\.com/i.test(url)) continue;
            if (/\/beta(\/|$)/i.test(url)) return '';
            var next = url.replace(/\/+$/, '') + '/beta';
            body[key] = next;
            return key + ' -> ' + next;
        }
        return '';
    }

    // ------------------------------------------------------------------
    // 渠道能力探测
    //
    // "尾随 assistant 会不会被当前缀续写"本质上是**上游模型的能力**，网关不会告诉你。
    // 与其按域名/模型名猜，不如真发一次极短请求问它：
    //   给出一个带随机串的前缀 {"nonce":"XXXX","items":[1,2,  让模型补完。
    //   · 回复里只出现续写内容 → 真前缀可用（passthrough）
    //   · 回复里重新出现 nonce/字段名 → 它是重起了一整段（需要 soft_append）
    // 结果按 (source|url|model) 缓存，之后 plan() 直接采用，不再猜。
    // ------------------------------------------------------------------

    var PROBE_GUARD = 0; // 探测请求自身不能被 fetch 钩子改写

    function probeKey(template) {
        return [
            String(template.chat_completion_source || ''),
            String(template.custom_url || template.reverse_proxy || ''),
            String(template.model || ''),
        ].join('|');
    }

    function makeProbeBody(template, nonce) {
        var prefix = '{"nonce":"' + nonce + '","items":[1,2,';
        var body = clone(template);
        body.messages = [
            {
                role: 'user',
                content: '只输出下面这段 JSON 的剩余部分，不要重复已经给出的内容，不要解释，不要加代码块：\n' + prefix,
            },
            { role: 'assistant', content: prefix },
        ];
        body.stream = false;
        // 给足预算：实测部分模型会先用思考吃掉全部额度，返回空内容 + finish_reason=length，
        // 预算太小会把"支持前缀"误判成"未知"。
        body.max_tokens = 2048;
        body.temperature = 0;
        delete body.tools;
        delete body.tool_choice;
        delete body.json_schema;
        delete body.n;
        delete body.logprobs;
        return { body: body, prefix: prefix, nonce: nonce };
    }

    /**
     * 判定一次探测响应。
     * @returns {{verdict:'prefix'|'restart'|'unknown', reason:string}}
     */
    function analyzeProbe(nonce, content) {
        if (typeof content !== 'string' || !content.trim()) {
            return { verdict: 'unknown', reason: '响应为空（可能被思考内容吃光了 max_tokens）' };
        }
        var text = content;
        if (text.indexOf(nonce) >= 0) {
            return { verdict: 'restart', reason: '回复里重新出现了前缀标记 ' + nonce + '（说明它是重起而非续写）' };
        }
        if (/"nonce"\s*:/.test(text) || /"items"\s*:/.test(text)) {
            return { verdict: 'restart', reason: '回复重述了前缀里的字段名' };
        }
        if (/^\s*\[\s*1\s*,\s*2\s*,/.test(text) || /^\s*3\s*\]?/.test(text) || text.trim().length <= 40) {
            return { verdict: 'prefix', reason: '回复只包含续写片段，没有重述前缀' };
        }
        return { verdict: 'prefix', reason: '回复未重述前缀标记，判定为续写' };
    }

    /** 从各家的响应体里抠出文本（OpenAI / Anthropic / 纯 text 都兼容） */
    function extractResponseText(json) {
        if (!json) return '';
        if (typeof json === 'string') return json;
        var c = json.choices && json.choices[0];
        if (c) {
            if (c.message && typeof c.message.content === 'string') return c.message.content;
            if (Array.isArray(c.message && c.message.content)) {
                return c.message.content.map(function (p) { return (p && p.text) || ''; }).join('');
            }
            if (typeof c.text === 'string') return c.text;
        }
        if (Array.isArray(json.content)) {
            return json.content.map(function (p) { return (p && p.text) || ''; }).join('');
        }
        if (typeof json.text === 'string') return json.text;
        return '';
    }

    /**
     * 用当前渠道配置真发一次探测请求。
     * @param {object} template 最近一次的 generate_data（提供渠道/密钥/URL）
     * @param {object} [deps] { fetchImpl, headers, timeoutMs }
     */
    async function probeChannel(template, deps) {
        deps = deps || {};
        if (!template || typeof template !== 'object') {
            return { verdict: 'unknown', reason: '还没有捕获到任何请求，先在酒馆里生成一次再探测' };
        }
        var fetchImpl = deps.fetchImpl || (typeof root.fetch === 'function' ? root.fetch.bind(root) : null);
        if (!fetchImpl) return { verdict: 'unknown', reason: '当前环境没有 fetch' };

        var nonce = 'PB' + Math.random().toString(36).slice(2, 8).toUpperCase();
        var made = makeProbeBody(template, nonce);
        var key = probeKey(template);

        PROBE_GUARD++;
        try {
            var res = await fetchImpl('/api/backends/chat-completions/generate', {
                method: 'POST',
                headers: deps.headers || { 'Content-Type': 'application/json' },
                body: JSON.stringify(made.body),
            });
            var raw = await res.text();
            var json = null;
            try { json = JSON.parse(raw); } catch (e) { /* 可能是流式 */ }
            var text = extractResponseText(json) || (json === null ? raw : '');

            // 空回复 + 预算耗尽 → 不是"不支持"，是"没问出来"。自动加大预算再问一次。
            var finish = json && json.choices && json.choices[0] && json.choices[0].finish_reason;
            if (!String(text).trim() && finish === 'length') {
                PROBE_GUARD--;
                try {
                    var bigger = makeProbeBody(template, nonce);
                    bigger.body.max_tokens = 8192;
                    var res2 = await fetchImpl('/api/backends/chat-completions/generate', {
                        method: 'POST',
                        headers: deps.headers || { 'Content-Type': 'application/json' },
                        body: JSON.stringify(bigger.body),
                    });
                    var raw2 = await res2.text();
                    var json2 = null;
                    try { json2 = JSON.parse(raw2); } catch (e) { /* ignore */ }
                    text = extractResponseText(json2) || raw2;
                } finally {
                    PROBE_GUARD++;
                }
            }

            var verdict = analyzeProbe(made.nonce, text);
            return Object.assign(verdict, {
                key: key,
                nonce: made.nonce,
                httpStatus: res.status,
                replyPreview: String(text).slice(0, 200),
            });
        } catch (err) {
            return { verdict: 'unknown', reason: '探测请求失败：' + String((err && err.message) || err), key: key };
        } finally {
            PROBE_GUARD--;
        }
    }

    // ------------------------------------------------------------------
    // 主入口：把一个 generate_data 变成"预填充生效"的请求
    // ------------------------------------------------------------------

    /**
     * 就地改写 body（SillyTavern 的 generate_data），并返回一份诊断报告。
     *
     * @param {object} body  generate_data（含 messages / chat_completion_source / custom_url / model）
     * @param {object} [cfg] 配置（会先 normalize）
     * @param {object} [env] { type, host, assistantPrefill, assistantImpersonation, dryRun }
     * @returns {object} report
     */
    function plan(body, cfg, env) {
        env = env || {};

        var report = {
            at: Date.now(),
            version: VERSION,
            host: env.host || 'unknown',
            enabled: !!cfg.enabled,
            source: '',
            url: '',
            model: '',
            kind: env.kind || 'chat',
            type: env.type || 'normal',
            ruleId: '',
            channel: '',
            strategy: 'off',
            prefillFrom: 'none',
            prefillChars: 0,
            changed: false,
            skipped: null,
            probed: false,
            actions: [],
            notes: [],
            error: null,
            beforeTail: null,
            afterTail: null,
        };

        try {
            // normalizeConfig 必须在 try 内：用户配置可能被外部改坏（循环引用等），
            // 抛异常会逃逸到酒馆的事件总线之外。
            cfg = normalizeConfig(cfg);
            if (!isPlainObject(body)) {
                report.notes.push('generate_data 不是对象，跳过');
                return report;
            }
            report.source = String(body.chat_completion_source || '');
            report.url = String(body.custom_url || body.reverse_proxy || '');
            report.model = String(body.model || '');

            if (!cfg.enabled) {
                report.notes.push('插件已禁用');
                return report;
            }
            if (env.dryRun === true) {
                report.notes.push('dry-run 请求，跳过改写');
                report.beforeTail = snapshotTail(body);
                report.afterTail = snapshotTail(body);
                return report;
            }
            if (report.kind === 'text' && !cfg.handleTextCompletion) {
                report.notes.push('文本补全路径未启用（预填充在该路径天然生效）');
                return report;
            }
            if (!Array.isArray(body.messages)) {
                report.notes.push('该请求没有 messages 数组，跳过');
                return report;
            }
            // 幂等保护：同一请求体只改写一次（非枚举属性，不会被 JSON.stringify 带出去）
            if (body.__pbApplied === true) {
                report.skipped = 'already-applied';
                report.notes.push('该请求体已被改写，跳过（幂等保护）');
                report.beforeTail = snapshotTail(body);
                report.afterTail = snapshotTail(body);
                return report;
            }

            var probe = { source: report.source, url: report.url, model: report.model };
            var channel = classify(probe, cfg);
            var resolved = resolveStrategy(channel, cfg);
            // nativeGuard：酒馆原生预填充在"带 tools"的请求里会被 addAssistantPrefix()
            // 直接跳过（src/prompt-converters.js:72-76），此时 off 等于失效，
            // 必须由插件用兜底策略接手。
            var guard = channel.nativeGuard && NATIVE_GUARDS[channel.nativeGuard];
            if (guard && resolved.strategy === 'off' && guard(body)) {
                resolved = {
                    strategy: channel.fallbackStrategy || cfg.fallbackStrategy,
                    overridden: resolved.overridden,
                };
                report.notes.push('酒馆原生预填充在本次请求中会失效（' + channel.nativeGuard
                    + '），插件改用 ' + resolved.strategy + ' 接手');
            }
            // 探测结果优先级最高：它是对**这个模型**的实测结论，比规则表里的猜测可靠。
            var probed = cfg.probes[probeKey(body)];
            if (probed && probed.verdict && !resolved.overridden) {
                if (probed.verdict === 'restart' && resolved.strategy === 'passthrough') {
                    resolved = { strategy: 'soft_append', overridden: false, probed: true };
                    report.notes.push('实测该模型不续写前缀（探测于 '
                        + new Date(probed.at || Date.now()).toLocaleString() + '），改用软预填充');
                } else if (probed.verdict === 'prefix' && resolved.strategy === 'soft_append') {
                    resolved = { strategy: 'passthrough', overridden: false, probed: true };
                    report.notes.push('实测该模型支持真前缀续写，保持请求原样');
                }
            }
            report.ruleId = channel.ruleId;
            report.channel = channel.label;
            report.strategy = resolved.strategy;
            report.probed = !!(probed && probed.verdict);
            if (resolved.overridden) report.notes.push('策略被用户覆盖');
            if (channel.fromUser) report.notes.push('命中自定义规则');

            // 静默生成（摘要 / 标题等后台请求）不参与改写；此处已判定出策略，便于面板显示"本可用的策略"
            if (cfg.skipTypes.indexOf(report.type) >= 0) {
                report.notes.push('生成类型 ' + report.type + ' 在 skipTypes 中，本次跳过改写');
                report.beforeTail = snapshotTail(body);
                report.afterTail = snapshotTail(body);
                return report;
            }

            var prefill = extractPrefill(body, cfg, env);
            report.prefillFrom = prefill.from;
            report.prefillChars = prefill.text ? prefill.text.length : 0;

            if (resolved.strategy === 'off') {
                report.notes.push('策略 off：交由宿主原生逻辑处理');
                report.beforeTail = snapshotTail(body);
                report.afterTail = snapshotTail(body);
                return report;
            }
            if (!prefill.text) {
                report.notes.push('未发现预填充内容（尾随 assistant 消息 / assistant_prefill 均为空）');
                report.beforeTail = snapshotTail(body);
                report.afterTail = snapshotTail(body);
                return report;
            }

            report.beforeTail = snapshotTail(body);
            var applier = APPLIERS[resolved.strategy];
            if (!applier) {
                report.notes.push('未知策略 ' + resolved.strategy + '，回退 ' + cfg.fallbackStrategy);
                report.strategy = cfg.fallbackStrategy;
                applier = APPLIERS[cfg.fallbackStrategy];
            }
            var result = applier(body, prefill, cfg);
            if (result.notes && result.notes.length) report.notes = report.notes.concat(result.notes);
            if (result.fallbackTo && APPLIERS[result.fallbackTo]) {
                var fallbackName = result.fallbackTo;
                report.notes.push('该策略在当前请求上不安全，回退到 ' + fallbackName);
                result = APPLIERS[fallbackName](body, prefill, cfg);
                if (result.notes && result.notes.length) report.notes = report.notes.concat(result.notes);
                report.strategy = report.strategy + '→' + fallbackName;
            }
            report.actions = result.actions || [];
            report.changed = !!result.changed;
            if (report.changed) {
                try {
                    Object.defineProperty(body, '__pbApplied', {
                        value: true, enumerable: false, configurable: true, writable: true,
                    });
                } catch (e) { /* 冻结对象：忽略 */ }
            }
            report.afterTail = snapshotTail(body);
        } catch (err) {
            report.error = String((err && err.stack) || err);
        }
        return report;
    }

    function snapshotTail(body) {
        if (!Array.isArray(body.messages) || body.messages.length === 0) {
            return { empty: true };
        }
        var n = Math.min(3, body.messages.length);
        var tail = body.messages.slice(body.messages.length - n).map(function (m, i) {
            return {
                index: body.messages.length - n + i,
                role: m.role,
                prefix: m.prefix === true ? true : undefined,
                partial: m.partial === true ? true : undefined,
                chars: messageText(m).length,
                preview: preview(messageText(m), 120),
            };
        });
        return {
            count: body.messages.length,
            last: tail,
            continue_final_message: body.continue_final_message,
            add_generation_prompt: body.add_generation_prompt,
        };
    }

    // ------------------------------------------------------------------
    // 宿主检测
    // ------------------------------------------------------------------

    /**
     * 取最顶层窗口。
     * 酒馆助手脚本运行在 iframe 里，而真正发出 /api/backends/... 请求的是顶层窗口的
     * fetch；所以要包的是顶层 window，不是脚本自己的 iframe window。
     * 跨域访问 parent 会抛异常，此时退回自身。
     */
    function topWindow() {
        try {
            var w = root;
            var guard = 0;
            while (w && w.parent && w.parent !== w && guard < 10) {
                w = w.parent;
                guard++;
            }
            return w || root;
        } catch (e) {
            return root;
        }
    }

    /**
     * 宿主识别 —— 仅用于展示与排障；功能本身按"能力探测"决定（是否存在
     * CHAT_COMPLETION_SETTINGS_READY），不依赖宿主身份。
     * 识别信号来自 TauriTavern 实测（见 docs/04-host-apis.md C.13）：
     *   tauri.localhost / tauri:// origin、__TAURITAVERN__、__TAURITAVERN_MAIN_READY__、
     *   __TAURI_INTERNALS__、window.isTauri、以及 /version 的 agent 后缀 :TauriTavern。
     */
    function detectHost(win) {
        var w = win || topWindow() || root;
        try {
            if (w && w.__TAURITAVERN__) return 'tauritavern';
            if (w && w.__TAURITAVERN_MAIN_READY__) return 'tauritavern';
            if (w && (w.__TAURI_INTERNALS__ || w.__TAURI__ || w.isTauri)) return 'tauri';
            var loc = w && w.location;
            if (loc && typeof loc.origin === 'string' && /^(https?:\/\/tauri\.localhost|tauri:\/\/)/.test(loc.origin)) {
                return 'tauritavern';
            }
        } catch (e) { /* ignore */ }
        return 'sillytavern';
    }

    /**
     * 次级兜底钩子：包装 window.fetch，在请求真正出网前再拦一次
     * /api/backends/chat-completions/generate。
     *
     * 为什么需要它（见 docs/04-host-apis.md）：
     *   - public/scripts/custom-request.js:463 直接 POST 到该端点，不触发
     *     CHAT_COMPLETION_SETTINGS_READY（ChatCompletionService /
     *     ConnectionManagerRequestService / 酒馆助手 TavernHelper.generate 走的都是这条路）；
     *   - TauriTavern 自带一个会包装 window.fetch / $.ajax 的 JS 宿主内核，
     *     在它之外再包一层可以保证我们的改写发生在最靠近出网的位置。
     *
     * 幂等由 plan() 保证（soft_append 检查块是否已存在；prefix/partial/
     * continue_final_message 天然幂等），因此两个钩子同时开启不会重复改写。
     */
    function installFetchHook(onBody, w) {
        w = w || root;
        if (!w || typeof w.fetch !== 'function') return { installed: false, reason: 'no fetch' };
        if (!Array.isArray(w.__prefillBridgeFetchHandlers)) {
            try {
                Object.defineProperty(w, '__prefillBridgeFetchHandlers', {
                    value: [], enumerable: false, configurable: true, writable: true,
                });
            } catch (e) {
                w.__prefillBridgeFetchHandlers = [];
            }
        }
        var handlers = w.__prefillBridgeFetchHandlers;
        handlers.push(onBody);

        var wrappedNow = false;
        if (!w.__prefillBridgeFetchWrapped) {
            var original = w.fetch;
            var wrapped = function (input, init) {
                try {
                    var url = typeof input === 'string' ? input : (input && input.url) || '';
                    if (init && typeof init.body === 'string' &&
                        /\/api\/backends\/chat-completions\/generate(\?|$)/.test(String(url))) {
                        var raw = init.body;
                        var parsed = JSON.parse(raw);
                        var next = parsed;
                        for (var i = 0; i < handlers.length; i++) {
                            try {
                                var out = handlers[i](parsed, raw);
                                if (out && out !== parsed) next = out;
                            } catch (e) { /* 单个 handler 出错不影响请求 */ }
                        }
                        var serialized = JSON.stringify(next);
                        if (serialized !== raw) {
                            init = Object.assign({}, init, { body: serialized });
                        }
                    }
                } catch (e) {
                    // 绝不允许插件把请求搞挂：解析失败就原样放行
                }
                return original.call(this, input, init);
            };
            try {
                w.fetch = wrapped;
                Object.defineProperty(w, '__prefillBridgeFetchWrapped', {
                    value: true, enumerable: false, configurable: true, writable: true,
                });
                Object.defineProperty(w, '__prefillBridgeOriginalFetch', {
                    value: original, enumerable: false, configurable: true, writable: true,
                });
                Object.defineProperty(w, '__prefillBridgeWrappedFetch', {
                    value: wrapped, enumerable: false, configurable: true, writable: true,
                });
                wrappedNow = true;
            } catch (e) {
                handlers.pop();
                return { installed: false, reason: 'cannot assign fetch' };
            }
        }

        var uninstalled = false;
        return {
            installed: true,
            handlers: handlers.length,
            wrapped: wrappedNow,
            uninstall: function () {
                if (uninstalled) return;
                uninstalled = true;
                var idx = handlers.indexOf(onBody);
                if (idx >= 0) handlers.splice(idx, 1);
                if (handlers.length === 0 && w.__prefillBridgeOriginalFetch
                    && w.__prefillBridgeWrappedFetch
                    && w.fetch === w.__prefillBridgeWrappedFetch) {
                    // 只有当前 fetch 仍是我们的包装层时才还原；
                    // 否则说明别人（另一个扩展 / 宿主内核）在我们外面又包了一层，
                    // 直接覆盖会把它整个拆掉。
                    try {
                        w.fetch = w.__prefillBridgeOriginalFetch;
                        delete w.__prefillBridgeFetchWrapped;
                    } catch (e) { /* ignore */ }
                }
            },
        };
    }

    // ------------------------------------------------------------------
    // SillyTavern 接线
    // ------------------------------------------------------------------

    function resolveContext(options) {
        if (options && options.ctx) return options.ctx;
        try {
            var st = root.SillyTavern;
            if (st && typeof st.getContext === 'function') return st.getContext();
            if (root.parent && root.parent !== root) {
                st = root.parent.SillyTavern;
                if (st && typeof st.getContext === 'function') return st.getContext();
            }
        } catch (e) {
            // 跨域 iframe 访问 parent 会抛 SecurityError；不能让轮询静默死掉
            if (root.console) root.console.debug('[PrefillBridge] 访问父窗口上下文失败', e);
        }
        return null;
    }

    function waitForContext(options, timeoutMs, isCancelled) {
        var deadline = Date.now() + (timeoutMs || 30000);
        return new Promise(function (resolve) {
            (function tick() {
                if (typeof isCancelled === 'function' && isCancelled()) return resolve(null);
                var ctx = resolveContext(options);
                if (ctx && ctx.eventSource && (ctx.eventTypes || ctx.event_types)) return resolve(ctx);
                if (Date.now() > deadline) return resolve(null);
                setTimeout(tick, 200);
            })();
        });
    }

    /**
     * 酒馆助手（JS-Slash-Runner）脚本级持久化。
     * 4.10.0 起 getScriptData / replaceScriptData 已被移除，改用变量系统
     * getVariables / replaceVariables({type:'script', script_id})，这里两代都兼容。
     */
    function scriptStore(options) {
        var TH = root.TavernHelper;
        if (!TH || !options || !options.scriptId) return null;
        var id = options.scriptId;
        if (typeof TH.getScriptData === 'function' && typeof TH.replaceScriptData === 'function') {
            return {
                get: function () { return TH.getScriptData(id); },
                set: function (v) { TH.replaceScriptData(id, v); },
            };
        }
        if (typeof TH.getVariables === 'function' && typeof TH.replaceVariables === 'function') {
            var opt = { type: 'script', script_id: id };
            return {
                get: function () { return (TH.getVariables(opt) || {}).prefillBridge; },
                set: function (v) {
                    var all = TH.getVariables(opt) || {};
                    all.prefillBridge = v;
                    TH.replaceVariables(all, opt);
                },
            };
        }
        return null;
    }

    function loadConfig(ctx, options) {
        var stored = null;
        try {
            if (options && options.config) stored = options.config;
            else if (ctx && ctx.extensionSettings) stored = ctx.extensionSettings.prefillBridge;
        } catch (e) { /* ignore */ }
        if (!stored) {
            var store = scriptStore(options);
            if (store) {
                try { stored = store.get(); } catch (e) { /* ignore */ }
            }
        }
        return normalizeConfig(stored);
    }

    function saveConfig(ctx, cfg, options) {
        var persisted = serializeConfig(cfg);
        try {
            if (ctx && ctx.extensionSettings) ctx.extensionSettings.prefillBridge = persisted;
            if (ctx && typeof ctx.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
        } catch (e) { /* ignore */ }
        var store = scriptStore(options);
        if (store) {
            try { store.set(persisted); } catch (e) { /* ignore */ }
        }
    }

    /**
     * 安装插件。返回句柄：{ config, save, uninstall, getTrace, clearTrace, plan }
     */
    function install(options) {
        options = options || {};
        var existing = root[INSTALL_KEY];
        if (existing && !options.force) return existing;
        // 同一份代码可能同时以"原生扩展（顶层窗口）"和"酒馆助手脚本（iframe）"装载。
        // 顶层窗口已安装过就复用它，避免两个句柄、两份诊断、两个 fetch handler。
        try {
            var top = topWindow();
            if (top && top !== root && top[INSTALL_KEY] && !options.force) {
                var shared = top[INSTALL_KEY];
                shared.sharedFrom = 'iframe';
                return shared;
            }
        } catch (e) { /* 跨域等情况忽略 */ }

        var handle = {
            version: VERSION,
            installedAt: Date.now(),
            ctx: null,
            // 先给一份默认配置：TauriTavern 等宿主即使拿不到 ST 上下文，
            // fetch 兜底钩子也必须有配置可用，否则会直接放行。
            config: normalizeConfig(options.config),
            host: detectHost(options.win),
            trace: [],
            listeners: [],
            ready: null,
        };

        var env = {
            type: 'normal',
            kind: 'chat',
            host: handle.host,
            assistantPrefill: '',
            assistantImpersonation: '',
            dryRun: false,
        };
        handle.env = env;

        function pushTrace(report) {
            handle.trace.push(report);
            var max = handle.config ? handle.config.maxTrace : 40;
            while (handle.trace.length > max) handle.trace.shift();
            if (typeof options.onPlan === 'function') {
                try { options.onPlan(report); } catch (e) { /* ignore */ }
            }
        }

        handle.lastGenerateData = null;
        handle.probeChannel = function (deps) {
            var template = handle.lastGenerateData;
            var headers = null;
            try {
                if (handle.ctx && typeof handle.ctx.getRequestHeaders === 'function') {
                    headers = handle.ctx.getRequestHeaders();
                }
            } catch (e) { /* ignore */ }
            return probeChannel(template, Object.assign({ headers: headers }, deps)).then(function (res) {
                if (res && res.key && (res.verdict === 'prefix' || res.verdict === 'restart')) {
                    var probes = Object.assign({}, handle.config.probes);
                    probes[res.key] = { verdict: res.verdict, at: Date.now(), reason: res.reason };
                    handle.setConfig({ probes: probes });
                }
                return res;
            });
        };
        handle.getTrace = function () { return handle.trace.slice(); };
        handle.clearTrace = function () { handle.trace.length = 0; };
        handle.getLastReport = function () { return handle.trace.length ? handle.trace[handle.trace.length - 1] : null; };
        handle.plan = function (body, cfgOverride, envOverride) {
            return plan(body, cfgOverride || handle.config, Object.assign({ host: handle.host }, env, envOverride));
        };
        handle.save = function () { if (handle.ctx) saveConfig(handle.ctx, handle.config, options); };
        handle.setConfig = function (patch) {
            handle.config = normalizeConfig(deepMerge(handle.config, patch));
            handle.save();
            return handle.config;
        };
        /**
         * 事件钩子产出的请求体指纹环形缓冲。
         * fetch 兜底钩子靠它判断"这个请求已经被事件钩子处理过了"，从而避免重复改写，
         * 同时不需要在请求体里塞任何标记字段（不会污染发给服务商的 JSON）。
         */
        handle.emittedFingerprints = [];
        function rememberFingerprint(body) {
            try {
                handle.emittedFingerprints.push(JSON.stringify(body));
                while (handle.emittedFingerprints.length > 8) handle.emittedFingerprints.shift();
            } catch (e) { /* ignore */ }
        }
        function isAlreadyEmitted(raw) {
            return handle.emittedFingerprints.indexOf(raw) >= 0;
        }
        handle.uninstall = function () {
            handle.disposed = true; // 让 waitForContext 的轮询立即停止，不留僵尸定时器
            handle.listeners.forEach(function (off) { try { off(); } catch (e) { /* ignore */ } });
            handle.listeners.length = 0;
            if (handle.fetchHook && handle.fetchHook.uninstall) {
                try { handle.fetchHook.uninstall(); } catch (e) { /* ignore */ }
            }
            delete root[INSTALL_KEY];
        };

        root[INSTALL_KEY] = handle;

        // —— 次级兜底钩子：包装 window.fetch ——
        // 不依赖酒馆上下文，因此在 install() 里同步装好，覆盖
        // custom-request.js 等不触发事件、以及 TauriTavern 宿主内核改写 fetch 的场景。
        var fetchHookInstalled = installFetchHook(function (body, raw) {
            try {
                if (PROBE_GUARD > 0) return body; // 探测请求必须原样发出，否则测不出真话
                if (!handle.config || !handle.config.enabled) return body;
                if (handle.config.hooks && handle.config.hooks.fetch === false) return body;
                if (isAlreadyEmitted(raw)) return body; // 主钩子已处理过这个请求
                var report = plan(body, handle.config, Object.assign({ host: handle.host }, env, { kind: 'chat' }));
                if (report.changed || report.prefillFrom !== 'none' || report.error) pushTrace(report);
                if (handle.config.debug && root.console) {
                    root.console.debug('[PrefillBridge:fetch]', report.ruleId, report.strategy, report.actions);
                }
            } catch (err) {
                if (root.console) root.console.error('[PrefillBridge] fetch hook failed', err);
            }
            return body;
        }, options.win || topWindow());
        handle.fetchHook = fetchHookInstalled;

        handle.ready = waitForContext(options, options.timeoutMs, function () {
            return handle.disposed === true;
        }).then(function (ctx) {
            if (!ctx) {
                handle.error = '未能拿到 SillyTavern 上下文（getContext 不可用）';
                if (typeof options.onReady === 'function') options.onReady(handle, null);
                return handle;
            }
            handle.ctx = ctx;
            var loaded = loadConfig(ctx, options);
            // 上下文里的配置（可能是用户保存过的）与启动默认配置合并，避免丢掉任一侧
            handle.config = normalizeConfig(deepMerge(handle.config, loaded));

            var events = ctx.eventTypes || ctx.event_types || {};
            var es = ctx.eventSource;
            var on = function (name, fn) {
                if (!name || typeof es.on !== 'function') return;
                es.on(name, fn);
                handle.listeners.push(function () { es.removeListener(name, fn); });
            };

            // 记录本次生成的类型（normal / continue / impersonate / quiet / swipe）
            on(events.GENERATION_AFTER_COMMANDS, function (type, _opts, dryRun) {
                env.type = typeof type === 'string' ? type : 'normal';
                env.dryRun = !!dryRun;
            });

            // —— 主钩子：聊天补全请求体已就绪、即将 fetch ——
            // 实证见 docs/04-host-apis.md：openai.js:3146 emit 的 generate_data 与
            // :3148-3152 fetch 的 body 是同一个绑定，监听器被 await，且此处已是最终体。
            if (!handle.config.hooks || handle.config.hooks.settingsReady !== false) {
                on(events.CHAT_COMPLETION_SETTINGS_READY, function (generateData) {
                    try {
                        env.kind = 'chat';
                        readPrefillSettings(handle, ctx);
                        handle.lastGenerateData = generateData; // 供探测复用渠道配置
                        var report = plan(generateData, handle.config, Object.assign({ host: handle.host }, env));
                        if (!report.skipped) pushTrace(report); // 已被同一请求的其他句柄处理过就不再记一条
                        // 无论是否改写都要登记指纹：否则 off/passthrough 这类"看了但没动"的请求
                        // 会被 fetch 兜底钩子再处理一遍，诊断里出现重复条目。
                        rememberFingerprint(generateData);
                        if (handle.config.debug && root.console) {
                            root.console.debug('[PrefillBridge]', report.ruleId, report.strategy, report.actions);
                        }
                    } catch (err) {
                        if (root.console) root.console.error('[PrefillBridge] settings_ready handler failed', err);
                    }
                });
            }

            // —— 文本补全：prompt 已是字符串，预填充天然生效；默认只做记录 ——
            on(events.GENERATE_AFTER_DATA, function (generateData) {
                try {
                    if (!generateData || typeof generateData.prompt !== 'string') return;
                    env.kind = 'text';
                    var report = plan(generateData, handle.config, Object.assign({ host: handle.host }, env));
                    pushTrace(report);
                } catch (err) {
                    if (root.console) root.console.error('[PrefillBridge] after_data handler failed', err);
                }
            });

            if (typeof options.onReady === 'function') options.onReady(handle, ctx);
            return handle;
        });

        return handle;
    }

    /**
     * 把酒馆"高级格式化 → 助手预填充"两个设置读进 env。
     * 注意：酒馆只在 claude 渠道把 assistant_prefill 发到服务端（openai.js:2876），
     * 其它渠道该字段不会进入 request body，所以必须由插件自己带过来。
     */
    function readPrefillSettings(handle, ctx) {
        var settings = ctx.chatCompletionSettings || {};
        var prefill = settings.assistant_prefill;
        var impersonation = settings.assistant_impersonation;
        handle.env.assistantPrefill = typeof prefill === 'string' ? prefill : '';
        handle.env.assistantImpersonation = typeof impersonation === 'string' ? impersonation : '';
        return handle.env;
    }

    // ------------------------------------------------------------------
    // 导出
    // ------------------------------------------------------------------

    var api = {
        version: VERSION,
        STRATEGIES: STRATEGIES.slice(),
        DEFAULT_CONFIG: clone(DEFAULT_CONFIG),
        DEFAULT_SOFT_TEMPLATE: DEFAULT_SOFT_TEMPLATE,
        BUILTIN_RULES: clone(BUILTIN_RULES.map(function (r) {
            return {
                id: r.id,
                label: r.label,
                strategy: r.strategy,
                url: r.url ? String(r.url) : undefined,
                model: r.model ? String(r.model) : undefined,
                source: r.source,
            };
        })),
        normalizeConfig: normalizeConfig,
        serializeConfig: serializeConfig,
        classify: classify,
        resolveStrategy: resolveStrategy,
        extractPrefill: extractPrefill,
        isTrailingPrefill: isTrailingPrefill,
        messageText: messageText,
        plan: plan,
        install: install,
        detectHost: detectHost,
        topWindow: topWindow,
        probeKey: probeKey,
        makeProbeBody: makeProbeBody,
        analyzeProbe: analyzeProbe,
        extractResponseText: extractResponseText,
        probeChannel: probeChannel,
        waitForContext: waitForContext,
        getHandle: function () { return root[INSTALL_KEY] || null; },
    };

    return api;
});



/*!
 * Prefill Bridge — 设置面板 (UI)
 * 依赖 core.js 暴露的 globalThis.PrefillBridge
 * 同时适用于：JS-Slash-Runner 脚本（iframe 内，写入顶层文档）与原生酒馆扩展（顶层文档）
 */
;(function (root, factory) {
    // 无论被当作 CommonJS、ES module 还是普通 <script> 加载，都同时发布到 root。
    // 酒馆把扩展入口作为 <script type="module"> 加载，模块作用域里没有 module，
    // 若只走 CJS 分支就会导致 globalThis.PrefillBridge 缺失。
    var api = factory(root);
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    if (root && typeof root === 'object') {
        root.PrefillBridgeUI = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
    'use strict';

    var STYLE_ID = 'pb-prefill-bridge-style';
    var PANEL_ID = 'pb-prefill-bridge-panel';
    var CSS = [
        '#pb-prefill-bridge-panel{position:relative;font-size:13px;line-height:1.6;}',
        '#pb-prefill-bridge-panel .pb-row{display:flex;align-items:center;gap:8px;margin:6px 0;flex-wrap:wrap;}',
        '#pb-prefill-bridge-panel .pb-row>label{min-width:150px;flex:0 0 auto;opacity:.85;}',
        '#pb-prefill-bridge-panel select,#pb-prefill-bridge-panel input[type=text],#pb-prefill-bridge-panel textarea{background:rgba(127,127,127,.12);border:1px solid rgba(127,127,127,.35);border-radius:6px;color:inherit;padding:4px 6px;font-family:inherit;}',
        '#pb-prefill-bridge-panel textarea{width:100%;min-height:120px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;}',
        '#pb-prefill-bridge-panel select{min-width:180px;}',
        '#pb-prefill-bridge-panel .pb-btn{border:1px solid rgba(127,127,127,.45);border-radius:6px;background:rgba(127,127,127,.14);color:inherit;cursor:pointer;padding:4px 10px;font-size:12px;}',
        '#pb-prefill-bridge-panel .pb-btn:hover{background:rgba(127,127,127,.26);}',
        '#pb-prefill-bridge-panel .pb-muted{opacity:.62;font-size:12px;}',
        '#pb-prefill-bridge-panel .pb-mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11.5px;white-space:pre-wrap;word-break:break-all;background:rgba(127,127,127,.10);border-radius:6px;padding:8px;max-height:260px;overflow:auto;}',
        '#pb-prefill-bridge-panel .pb-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;}',
        '#pb-prefill-bridge-panel details{border:1px solid rgba(127,127,127,.3);border-radius:8px;padding:6px 10px;margin:8px 0;}',
        '#pb-prefill-bridge-panel summary{cursor:pointer;font-weight:600;}',
        '#pb-prefill-bridge-panel .pb-tag{display:inline-block;border-radius:999px;padding:1px 8px;font-size:11px;background:rgba(127,127,127,.2);margin-left:6px;}',
        '#pb-prefill-bridge-panel .pb-ok{background:rgba(46,204,113,.25);}',
        '#pb-prefill-bridge-panel .pb-warn{background:rgba(255,176,32,.25);}',
        '#pb-prefill-bridge-float{position:fixed;right:14px;bottom:14px;z-index:2147483000;border-radius:999px;padding:8px 14px;cursor:pointer;font-size:12px;background:#6a5cff;color:#fff;border:none;box-shadow:0 6px 18px rgba(0,0,0,.35);}',
        '#pb-prefill-bridge-panel.pb-floating{position:fixed;right:14px;bottom:64px;z-index:2147483000;width:520px;max-height:78vh;overflow:auto;background:var(--SmartThemeBlurTintColor,#1b1c22);color:var(--SmartThemeBodyColor,#e9e9ee);border:1px solid rgba(127,127,127,.4);border-radius:12px;padding:14px;box-shadow:0 10px 30px rgba(0,0,0,.4);display:none;}',
        '#pb-prefill-bridge-panel.pb-floating.pb-open{display:block;}',
        '#pb-prefill-bridge-panel.pb-floating .pb-close{position:absolute;top:8px;right:10px;cursor:pointer;opacity:.7;}',
    ].join('\n');

    var SOURCES = [
        'custom', 'openai', 'azure_openai', 'openrouter', 'claude', 'deepseek', 'moonshot',
        'xai', 'groq', 'mistralai', 'cohere', 'makersuite', 'vertexai', 'perplexity',
        'nanogpt', 'pollinations', 'electronhub', 'chutes', 'zai', 'aimlapi', 'minimax', 'ai21',
    ];

    var CORE = null;

    function core() {
        if (CORE) return CORE;
        CORE = root.PrefillBridge || (typeof require === 'function' ? require('./core.js') : null);
        return CORE;
    }

    function topDocument() {
        try {
            if (root.parent && root.parent !== root && root.parent.document) return root.parent.document;
        } catch (e) { /* cross-origin -> fall through */ }
        return root.document;
    }

    function el(doc, tag, props, children) {
        var node = doc.createElement(tag);
        if (props) {
            Object.keys(props).forEach(function (k) {
                if (k === 'style') node.setAttribute('style', props[k]);
                else if (k === 'text') node.textContent = props[k];
                else if (k === 'html') node.innerHTML = props[k];
                else if (k.slice(0, 2) === 'on' && typeof props[k] === 'function') {
                    node.addEventListener(k.slice(2).toLowerCase(), props[k]);
                } else if (props[k] !== undefined && props[k] !== null) {
                    node.setAttribute(k, props[k]);
                }
            });
        }
        (children || []).forEach(function (c) { if (c) node.appendChild(c); });
        return node;
    }

    function selectRow(doc, label, options, value, onChange, hint) {
        var sel = el(doc, 'select', {});
        options.forEach(function (o) {
            var opt = el(doc, 'option', { value: o[0], text: o[1] });
            if (String(o[0]) === String(value)) opt.setAttribute('selected', 'selected');
            sel.appendChild(opt);
        });
        sel.addEventListener('change', function () { onChange(sel.value); });
        var row = el(doc, 'div', { class: 'pb-row' }, [el(doc, 'label', { text: label }), sel]);
        if (hint) row.appendChild(el(doc, 'span', { class: 'pb-muted', text: hint }));
        return row;
    }

    function checkRow(doc, label, checked, onChange, hint) {
        var input = el(doc, 'input', { type: 'checkbox' });
        input.checked = !!checked;
        input.addEventListener('change', function () { onChange(input.checked); });
        var row = el(doc, 'div', { class: 'pb-row' }, [el(doc, 'label', { text: label }), input]);
        if (hint) row.appendChild(el(doc, 'span', { class: 'pb-muted', text: hint }));
        return row;
    }

    /** 跳过的生成类型（逗号分隔）：quiet 是摘要/标题等后台静默生成 */
    function skipTypesRow(doc, cfg, save) {
        var input = el(doc, 'input', { type: 'text', style: 'min-width:220px' });
        input.value = (cfg.skipTypes || []).join(', ');
        input.addEventListener('change', function () {
            var list = input.value.split(',').map(function (x) { return x.trim(); }).filter(Boolean);
            save({ skipTypes: list });
        });
        return el(doc, 'div', { class: 'pb-row' }, [
            el(doc, 'label', { text: '跳过的生成类型' }),
            input,
            el(doc, 'span', {
                class: 'pb-muted',
                text: '可选 normal / continue / impersonate / quiet / swipe；quiet=摘要等后台请求',
            }),
        ]);
    }

    function section(doc, title, nodes, open) {
        var d = el(doc, 'details', open ? { open: 'open' } : {});
        d.appendChild(el(doc, 'summary', { text: title }));
        nodes.filter(Boolean).forEach(function (n) { d.appendChild(n); });
        return d;
    }

    /**
     * 渲染并挂载设置面板。
     * @param {object} handle PrefillBridge.install() 返回的句柄
     * @param {object} [opts] { container: Element, floating: boolean }
     * @returns {{root:Element, refresh:Function, destroy:Function}}
     */
    function mount(handle, opts) {
        opts = opts || {};
        var PB = core();
        if (!PB) throw new Error('PrefillBridge core 未加载');
        var doc = topDocument();
        if (!doc) throw new Error('找不到文档');

        if (!doc.getElementById(STYLE_ID)) {
            doc.head.appendChild(el(doc, 'style', { id: STYLE_ID, text: CSS }));
        }

        var host = opts.container || doc.getElementById('extensions_settings2') || doc.getElementById('extensions_settings');
        var panel = doc.getElementById(PANEL_ID);
        if (panel) panel.remove();
        panel = el(doc, 'div', { id: PANEL_ID });

        var floatingBtn = null;
        if (!host) {
            floatingBtn = el(doc, 'button', { id: 'pb-prefill-bridge-float', text: '预填充桥' });
            panel.classList.add('pb-floating');
            floatingBtn.addEventListener('click', function () { panel.classList.toggle('pb-open'); });
            doc.body.appendChild(floatingBtn);
        }

        var body = el(doc, 'div', {});
        var cfg = handle.config;

        function save(patch) {
            handle.setConfig(patch);
            cfg = handle.config;
            refresh();
        }

        var header = el(doc, 'div', {}, [
            el(doc, 'b', { text: '第三方预填充桥 Prefill Bridge' }),
            el(doc, 'span', { class: 'pb-tag', text: 'v' + PB.version }),
            el(doc, 'span', { class: 'pb-tag', id: 'pb-host-tag', text: handle.host || 'unknown' }),
        ]);
        var closeBtn = el(doc, 'span', { class: 'pb-close', text: '✕', title: '关闭' });
        closeBtn.addEventListener('click', function () { panel.classList.remove('pb-open'); });
        if (!host) header.appendChild(closeBtn);
        body.appendChild(header);
        body.appendChild(el(doc, 'div', {
            class: 'pb-muted',
            text: '让预设里“尾随 assistant 的预填充提示词”在第三方 / 中转渠道真正生效：'
                + '酒馆只为 claude / deepseek / moonshot 做了原生预填充，其余渠道会原样转发 messages，预填充因此失效。',
        }));

        // ---- 基本 ----
        body.appendChild(section(doc, '基本设置', [
            checkRow(doc, '启用插件', cfg.enabled, function (v) { save({ enabled: v }); }),
            checkRow(doc, '调试日志（控制台输出每次改写）', cfg.debug, function (v) { save({ debug: v }); }),
            selectRow(doc, '预填充来源', [
                ['auto', 'auto：尾随 assistant 消息，其次 assistant_prefill 设置'],
                ['message', 'message：只用尾随 assistant 消息'],
                ['setting', 'setting：只用酒馆的 assistant_prefill 设置'],
                ['off', 'off：不识别预填充'],
            ], cfg.prefillSource, function (v) { save({ prefillSource: v }); },
                '仅在 auto/setting 下才会读取「高级格式化 → 助手预填充」'),
            selectRow(doc, '尾随 assistant 判定', [
                ['auto', 'auto：仅当其前一条是 user（推荐）'],
                ['force', 'force：只要最后一条是 assistant 就当预填充'],
                ['ignore', 'ignore：从不当作预填充'],
            ], cfg.trailingAssistant, function (v) { save({ trailingAssistant: v }); }),
            selectRow(doc, '默认策略', [
                ['auto', 'auto：按内置渠道表决定'],
                ['off', 'off：不处理'],
                ['prefix', 'prefix：给尾随 assistant 打 prefix:true（DeepSeek /beta）'],
                ['partial', 'partial：给尾随 assistant 打 partial:true（Moonshot）'],
                ['continue_final_message', 'continue_final_message（vLLM / SGLang / llama.cpp）'],
                ['passthrough', 'passthrough：原样保留尾随 assistant'],
                ['soft_append', 'soft_append：并入末条消息（万能兜底）'],
            ], cfg.defaultStrategy, function (v) { save({ defaultStrategy: v }); }),
            selectRow(doc, '未识别渠道兜底', [
                ['soft_append', 'soft_append：并入末条消息（推荐）'],
                ['passthrough', 'passthrough：原样转发'],
                ['prefix', 'prefix'],
                ['partial', 'partial'],
                ['continue_final_message', 'continue_final_message'],
                ['off', 'off'],
            ], cfg.fallbackStrategy, function (v) { save({ fallbackStrategy: v }); }),
            checkRow(doc, '命中 DeepSeek 官方域名时把 URL 改写到 /beta', cfg.rewriteDeepseekBeta,
                function (v) { save({ rewriteDeepseekBeta: v }); }),
            checkRow(doc, '文本补全（/completions）也处理', cfg.handleTextCompletion,
                function (v) { save({ handleTextCompletion: v }); }, '该路径预填充天然生效，默认只记录'),
            skipTypesRow(doc, cfg, save),
        ], true));

        // ---- 软预填充 ----
        var tpl = el(doc, 'textarea', {});
        tpl.value = cfg.softAppend.template;
        tpl.addEventListener('change', function () {
            save({ softAppend: { template: tpl.value } });
        });
        body.appendChild(section(doc, '软预填充（万能兜底）', [
            el(doc, 'div', { class: 'pb-muted', text: '占位符 {{prefill}} 会被替换为预设的预填充文本。' }),
            selectRow(doc, '合并位置', [
                ['last-user', 'last-user：并入最后一条 user 消息'],
                ['new-message', 'new-message：新插入一条消息'],
            ], cfg.softAppend.position, function (v) { save({ softAppend: { position: v } }); }),
            selectRow(doc, '新插入消息角色', [
                ['user', 'user'],
                ['system', 'system'],
            ], cfg.softAppend.role, function (v) { save({ softAppend: { role: v } }); }),
            tpl,
        ]));

        // ---- 渠道能力探测 ----
        var probeOut = el(doc, 'div', { class: 'pb-mono', text: '（还没探测过）' });
        var probeBtn = el(doc, 'button', { class: 'pb-btn', text: '探测当前渠道是否支持真前缀' });
        probeBtn.addEventListener('click', async function () {
            probeBtn.disabled = true;
            probeOut.textContent = '正在发一次极短请求试探…（大约几秒）';
            try {
                var res = await handle.probeChannel();
                var lines = [
                    '判定    ' + (res.verdict === 'prefix' ? '支持真前缀续写（保持请求不动）'
                        : res.verdict === 'restart' ? '不支持：模型会把前缀重起一遍（改用软预填充）'
                            : '未判定'),
                    '原因    ' + res.reason,
                    'HTTP    ' + (res.httpStatus === undefined ? '-' : res.httpStatus),
                    '对面回复 ' + (res.replyPreview === undefined ? '-' : JSON.stringify(res.replyPreview)),
                ];
                probeOut.textContent = lines.join('\n');
                refresh();
            } catch (e) {
                probeOut.textContent = '探测失败：' + e.message;
            } finally {
                probeBtn.disabled = false;
            }
        });
        body.appendChild(section(doc, '渠道能力探测', [
            el(doc, 'div', {
                class: 'pb-muted',
                text: '"尾随 assistant 会不会被续写"取决于上游模型，网关不会告诉你。'
                    + '点一下这里，插件会发一次带随机标记的极短请求问它，然后把结论按 渠道|URL|模型 记住，'
                    + '之后自动在"透传"和"软预填充"之间选。需要先在酒馆里正常生成过一次。',
            }),
            el(doc, 'div', { class: 'pb-row' }, [probeBtn]),
            probeOut,
        ]));

        // ---- 渠道覆盖 ----
        var sourceRows = [el(doc, 'div', {
            class: 'pb-muted',
            text: '按 chat_completion_source 覆盖策略；「跟随默认」= 不覆盖。',
        })];
        var probeEntries = Object.keys(cfg.probes || {});
        if (probeEntries.length) {
            sourceRows.push(el(doc, 'div', {
                class: 'pb-mono',
                text: '已探测到的渠道能力：\n' + probeEntries.map(function (k) {
                    return '  ' + k + '  →  ' + cfg.probes[k].verdict + '（'
                        + new Date(cfg.probes[k].at || 0).toLocaleString() + '）';
                }).join('\n'),
            }));
        }
        SOURCES.forEach(function (src) {
            sourceRows.push(selectRow(doc, src, [
                ['', '跟随默认'],
                ['off', 'off'],
                ['prefix', 'prefix'],
                ['partial', 'partial'],
                ['continue_final_message', 'continue_final_message'],
                ['passthrough', 'passthrough'],
                ['soft_append', 'soft_append'],
            ], cfg.perSource[src] || '', function (v) {
                var next = Object.assign({}, cfg.perSource);
                if (!v) delete next[src]; else next[src] = v;
                save({ perSource: next });
            }));
        });
        body.appendChild(section(doc, '渠道覆盖', sourceRows));

        // ---- 自定义规则 ----
        var rulesArea = el(doc, 'textarea', {});
        rulesArea.value = JSON.stringify((PB.serializeConfig(cfg).rules) || [], null, 2);
        var rulesMsg = el(doc, 'div', { class: 'pb-muted', text: '' });
        var rulesApply = el(doc, 'button', { class: 'pb-btn', text: '应用规则 JSON' });
        rulesApply.addEventListener('click', function () {
            try {
                var parsed = JSON.parse(rulesArea.value || '[]');
                if (!Array.isArray(parsed)) throw new Error('必须是数组');
                save({ rules: parsed });
                rulesArea.value = JSON.stringify((PB.serializeConfig(handle.config).rules) || [], null, 2);
                rulesMsg.textContent = '已应用 ' + parsed.length + ' 条规则';
            } catch (e) {
                rulesMsg.textContent = '解析失败：' + e.message;
            }
        });
        body.appendChild(section(doc, '自定义规则（高级）', [
            el(doc, 'div', {
                class: 'pb-muted',
                text: '示例：[{"id":"my-relay","url":"relay\\\\.example\\\\.com","strategy":"soft_append","label":"我的中转"}]。'
                    + '可用字段：source（字符串/数组）、url（正则）、model（正则）、target + pattern、strategy、label、enabled。',
            }),
            rulesArea,
            el(doc, 'div', { class: 'pb-row' }, [rulesApply, rulesMsg]),
        ]));

        // ---- 内置渠道表 ----
        var table = el(doc, 'div', { class: 'pb-mono' });
        table.textContent = (PB.BUILTIN_RULES || []).map(function (r) {
            return r.id.padEnd(22, ' ') + ' -> ' + r.strategy + '   ' + (r.label || '');
        }).join('\n');
        body.appendChild(section(doc, '内置渠道识别表', [table]));

        // ---- 最近请求 ----
        var traceBox = el(doc, 'div', { class: 'pb-mono', text: '（还没有请求）' });
        var refreshBtn = el(doc, 'button', { class: 'pb-btn', text: '刷新' });
        refreshBtn.addEventListener('click', refresh);
        var clearBtn = el(doc, 'button', { class: 'pb-btn', text: '清空记录' });
        clearBtn.addEventListener('click', function () { handle.clearTrace(); refresh(); });
        var copyBtn = el(doc, 'button', { class: 'pb-btn', text: '复制改写后请求体' });
        copyBtn.addEventListener('click', function () {
            var last = handle.getLastReport && handle.getLastReport();
            var text = last ? JSON.stringify(last, null, 2) : '';
            if (root.navigator && root.navigator.clipboard) root.navigator.clipboard.writeText(text);
        });
        body.appendChild(section(doc, '最近请求（诊断）', [
            traceBox,
            el(doc, 'div', { class: 'pb-row' }, [refreshBtn, clearBtn, copyBtn]),
            el(doc, 'div', {
                class: 'pb-muted',
                text: '注意：此处展示的是策略判定与改写动作；messages 原文请到浏览器控制台用 PrefillBridge.getHandle().getTrace() 查看。',
            }),
        ], true));

        // ---- 维护 ----
        var exportBtn = el(doc, 'button', { class: 'pb-btn', text: '导出配置' });
        exportBtn.addEventListener('click', function () {
            // 导出可持久化形态（正则落成字符串），否则粘回来的配置里正则会变成 {}
            var text = JSON.stringify(PB.serializeConfig(handle.config), null, 2);
            if (root.navigator && root.navigator.clipboard) root.navigator.clipboard.writeText(text);
            rulesMsg.textContent = '配置已复制到剪贴板';
        });
        var resetBtn = el(doc, 'button', { class: 'pb-btn', text: '恢复默认' });
        resetBtn.addEventListener('click', function () {
            handle.setConfig(PB.DEFAULT_CONFIG);
            cfg = handle.config;
            refresh();
        });
        var testBtn = el(doc, 'button', { class: 'pb-btn', text: '演练一次（不改动真实请求）' });
        var testOut = el(doc, 'div', { class: 'pb-mono', text: '' });
        testBtn.addEventListener('click', function () {
            var sample = {
                chat_completion_source: 'custom',
                custom_url: 'https://relay.example.com/v1',
                model: 'deepseek-chat',
                messages: [
                    { role: 'system', content: '（示例）system' },
                    { role: 'user', content: '（示例）用户输入' },
                    { role: 'assistant', content: '（示例）预设里的预填充' },
                ],
            };
            var report = PB.plan(sample, handle.config, { host: handle.host });
            testOut.textContent = JSON.stringify({
                rule: report.ruleId, strategy: report.strategy, changed: report.changed, actions: report.actions,
                messagesAfter: sample.messages.map(function (m) { return m.role; }),
            }, null, 2);
        });
        body.appendChild(section(doc, '维护', [
            el(doc, 'div', { class: 'pb-row' }, [exportBtn, resetBtn]),
            el(doc, 'div', { class: 'pb-row' }, [testBtn]),
            testOut,
        ]));

        panel.appendChild(body);

        if (host) host.appendChild(panel);
        else {
            doc.body.appendChild(panel);
        }

        function refresh() {
            var hostTag = panel.querySelector('#pb-host-tag');
            if (hostTag) hostTag.textContent = handle.host || 'unknown';
            var last = handle.getLastReport && handle.getLastReport();
            traceBox.textContent = last
                ? [
                    '时间       ' + new Date(last.at).toLocaleTimeString(),
                    '渠道       ' + last.channel + '  [' + last.ruleId + ']',
                    '来源/URL   ' + (last.source || '-') + '  ' + (last.url || '-'),
                    '模型       ' + (last.model || '-'),
                    '策略       ' + last.strategy + (last.changed ? '（已改写）' : '（未改写）'),
                    '预填充     ' + last.prefillFrom + ' / ' + last.prefillChars + ' 字符',
                    '动作       ' + (last.actions && last.actions.length ? last.actions.join(' | ') : '—'),
                    '说明       ' + ((last.notes || []).join(' | ') || '—'),
                    last.error ? ('错误       ' + last.error) : null,
                ].filter(Boolean).join('\n')
                : '（还没有请求）';
        }

        refresh();

        return {
            root: panel,
            refresh: refresh,
            destroy: function () {
                panel.remove();
                if (floatingBtn) floatingBtn.remove();
            },
        };
    }

    return { mount: mount, topDocument: topDocument };
});



/*!
 * Prefill Bridge — 引导（boot）
 * 在 core.js + ui.js 之后执行：等待酒馆上下文 → 安装 → 挂载设置面板。
 * 该文件同时被 JS-Slash-Runner 脚本与原生酒馆扩展使用。
 */
;(function () {
    'use strict';
    var root = typeof globalThis !== 'undefined' ? globalThis : this;
    var PB = root.PrefillBridge;
    if (!PB) {
        if (root.console) root.console.error('[PrefillBridge] core 未加载');
        return;
    }
    // 没有 DOM 说明不是浏览器环境（例如有人在 Node 里 import 这个包做测试）。
    // 此时不要自动安装：否则会去包装 Node 的 globalThis.fetch，产生意外的全局副作用。
    if (typeof root.document === 'undefined' || !root.document) {
        root.PrefillBridgeBoot = { handle: null, skipped: 'no-dom' };
        return;
    }
    if (root.__prefillBridgeBooted__) return;
    root.__prefillBridgeBooted__ = true;

    function scriptId() {
        try {
            if (typeof root.getScriptId === 'function') return root.getScriptId();
        } catch (e) { /* ignore */ }
        return undefined;
    }

    var handle = PB.install({
        scriptId: scriptId(),
        onPlan: null,
    });

    function mountUi() {
        try {
            var UI = root.PrefillBridgeUI;
            if (!UI || !UI.mount) return null;
            var doc = UI.topDocument ? UI.topDocument() : root.document;
            if (doc && doc.getElementById('pb-prefill-bridge-panel')) {
                var existing = { root: doc.getElementById('pb-prefill-bridge-panel'), refresh: function () {} };
                root.__prefillBridgeUi__ = existing;
                return existing;
            }
            var mounted = UI.mount(handle, {});
            root.__prefillBridgeUi__ = mounted;
            return mounted;
        } catch (err) {
            if (root.console) root.console.error('[PrefillBridge] 设置面板挂载失败', err);
            return null;
        }
    }

    handle.ready.then(function (ctx) {
        if (!ctx) {
            if (root.console) root.console.warn('[PrefillBridge] 未能获取酒馆上下文；将仍尝试挂载面板');
            setTimeout(mountUi, 1000);
            return;
        }
        var events = ctx.eventTypes || ctx.event_types || {};
        if (ctx.eventSource && events.APP_READY) {
            ctx.eventSource.once(events.APP_READY, function () { setTimeout(mountUi, 0); });
        }
        // 兜底：无论如何 1.5s 后挂载一次（APP_READY 可能已经过去）
        setTimeout(mountUi, 1500);
    });

    root.PrefillBridgeBoot = { handle: handle, mountUi: mountUi };
})();


