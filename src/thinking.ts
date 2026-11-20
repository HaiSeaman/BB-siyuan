/**
 * 思考档位统一管理。
 *
 * 各家接口的档位名字不一样：
 *   glm：low / high / max
 *   deepseek：high / max
 *   大部分模型：low / medium / high
 * Claude 原生有自己的一套。
 *
 * 界面上只给一套档位，代码里按模型翻译。识别不出来就干脆不发参数，
 * 免得某些接口见到不认识的字段直接 400。
 */

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "max"] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** 模型名可能带供应商前缀，如 pool/glm-5.3，统一取最后一段比较 */
function base(model: string): string {
    const parts = model.split("/");
    return parts[parts.length - 1].toLowerCase();
}

export function supportsThinking(model: string): boolean {
    const m = base(model);
    if (!m) return false;
    if (/^glm/.test(m)) return true;
    if (/deepseek/.test(m)) return true;
    if (/^kimi|moonshot/.test(m)) return true;
    if (/^claude/.test(m)) return true;
    if (/^gpt-|^o\d/.test(m)) return true;
    if (/minimax/.test(m)) return true;
    if (/^qwen/.test(m)) return true;
    if (/^gemini/.test(m)) return true;
    return false;
}

/**
 * OpenAI 兼容接口该发什么档位。返回 undefined 表示不发这个参数。
 */
export function effortFor(model: string, level: ThinkingLevel): string | undefined {
    const m = base(model);

    // 本机实测：这台中转站的 glm-5.3 关不掉思考，只有 low 能压到零思考输出。
    // 所以 off/minimal 一律降到 low，不能省掉参数，否则会冒出思考内容。
    if (/^glm/.test(m)) {
        if (level === "off" || level === "minimal" || level === "low") return "low";
        if (level === "medium" || level === "high") return "high";
        return "max";
    }

    if (/deepseek-v4/.test(m)) {
        if (level === "off" || level === "minimal" || level === "low" || level === "medium") return "high";
        if (level === "high") return "high";
        return "max";
    }

    if (/deepseek/.test(m)) {
        // 老的 reasoner / r1 只认 high/max
        return level === "max" ? "max" : "high";
    }

    if (/^gpt-|^o\d/.test(m) || /minimax|^qwen|^kimi|moonshot/.test(m)) {
        if (level === "off") return "minimal";
        if (level === "minimal") return "low";
        if (level === "max") return "high";
        return level;
    }

    if (/^gemini/.test(m)) {
        if (level === "off" || level === "minimal" || level === "low") return "low";
        if (level === "medium") return "medium";
        return "high";
    }

    // claude 走 OpenAI 兼容层时用 low/medium/high
    if (/^claude/.test(m)) {
        if (level === "off" || level === "minimal") return "low";
        if (level === "max") return "high";
        return level;
    }

    return undefined;
}

/** Claude 原生接口的 effort 字段；undefined 表示不发 */
export function anthropicEffort(level: ThinkingLevel): string | undefined {
    if (level === "off") return undefined;
    if (level === "minimal") return "low";
    return level;
}

/**
 * Claude 的思考 token 预算。
 *
 * Anthropic 官方要求 budget_tokens 必须**小于** max_tokens，写等于也会 400。
 * 所以预算上限取 maxTokens 的 3/4，且不低于 1024。
 * 若 maxTokens 小到连 1024 都放不下，就返回 undefined —— 宁可不思考，也不能让请求失败。
 */
export function anthropicBudget(level: ThinkingLevel, maxTokens: number): number | undefined {
    if (level === "off") return undefined;

    const MIN_BUDGET = 1024;
    // 必须比 max_tokens 小，留 1/4 给正文
    const ceiling = Math.floor(maxTokens * 0.75);
    if (ceiling < MIN_BUDGET) return undefined;

    const ratio: Record<string, number> = {
        minimal: 0.2,
        low: 0.3,
        medium: 0.5,
        high: 0.75,
        max: 1,
    };
    const budget = Math.floor(ceiling * (ratio[level] ?? 0.5));
    return Math.max(MIN_BUDGET, Math.min(budget, ceiling));
}
