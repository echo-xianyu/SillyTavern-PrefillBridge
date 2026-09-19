第三方预填充桥接

第三方预填充桥接 / Prefill Bridge
让 SillyTavern 与 TauriTavern 在 第三方（custom / OpenAI 兼容）渠道 下也能真正生效预填充。
为什么需要它

SillyTavern 的 assistant_prefill 只在 Claude 渠道被写进请求（openai.js:2872-2882）。
服务端只有三条第一方通路：Claude（原生 prefill）、DeepSeek（prefix:true）、Gemini（partial:true）。
CUSTOM 分支既不设旗标也不消费 assistant_prefill，预填充自然不生效。

它做什么

从预设里识别 role=assistant 的预填充条目（默认名字含「预填充 / prefill」）。
在 CHAT_COMPLETION_PROMPT_READY 时把预填充落到消息数组末位（可选把历史里的重复副本搬走）。
生成结束后把预填充前缀补回消息（上游只回续写部分）。
可选：通过 custom_include_body 注入 body 级旗标（如 {"prefix":true}）。

面板
装好后在「扩展设置」抽屉里会多出一张「🧩 第三方预填充桥接」卡片，可开关、切换来源、查看诊断。
