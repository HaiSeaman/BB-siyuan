/**
 * 设置迁移。
 *
 * 历史阶段：
 *   阶段一：只有 reasoningEffort（四档）
 *   阶段二：改成 thinking（六档）
 *   阶段三：多 API —— 原来是单份 protocol/baseURL/apiKey/model，
 *           现在要变成 apis[] + activeApiId
 *
 * 阶段三最关键：老用户的地址、密钥、模型必须原样搬进第一套 API，
 * 搬错或搬丢等于把人家的配置弄没了。
 */
import type { Settings } from "./settings";
import { createApi, normalizeApis } from "./apis";

const THINKING = ["off", "minimal", "low", "medium", "high", "max"];
const PROTOCOLS = ["openai", "anthropic", "gemini"];

export function migrateSettings(raw: any): Partial<Settings> | null {
    if (!raw || typeof raw !== "object") return null;
    const out: Record<string, any> = { ...raw };

    // ---- 阶段一 → 二：reasoningEffort 改名成 thinking ----
    if (out.thinking === undefined && out.reasoningEffort !== undefined) {
        const old = out.reasoningEffort;
        out.thinking = THINKING.includes(old) ? old : "high";
    }
    delete out.reasoningEffort;

    if (out.protocol === undefined) out.protocol = "openai";

    // 挡住手改配置写进来的野值
    if (!THINKING.includes(out.thinking)) out.thinking = "high";
    if (!PROTOCOLS.includes(out.protocol)) out.protocol = "openai";

    // ---- 阶段二 → 三：单份配置搬进 apis[0] ----
    if (!Array.isArray(out.apis)) {
        const oldModel = typeof out.model === "string" ? out.model.trim() : "";
        const oldBase = typeof out.baseURL === "string" ? out.baseURL.trim() : "";
        const oldKey = typeof out.apiKey === "string" ? out.apiKey : "";

        const api = createApi(
            {
                name: "默认",
                protocol: out.protocol,
                baseURL: oldBase,
                apiKey: oldKey,
                models: oldModel ? [oldModel] : [],
                model: oldModel,
            },
            "default"
        );
        out.apis = [api];
        out.activeApiId = "default";
    } else {
        // 已经是新格式：洗一遍脏数据，缺 activeApiId 就指第一个
        const apis = normalizeApis(out.apis);
        out.apis = apis;
        if (!apis.some((a) => a.id === out.activeApiId)) {
            out.activeApiId = apis[0]?.id || "";
        }
    }

    // 单份配置的字段已经搬走了，留着只会和 apis 打架
    delete out.protocol;
    delete out.baseURL;
    delete out.apiKey;
    delete out.model;

    if (typeof out.maxTokens === "number") {
        out.maxTokens = Math.min(64000, Math.max(256, Math.round(out.maxTokens)));
    }
    if (typeof out.contextMessages === "number") {
        out.contextMessages = Math.min(50, Math.max(1, Math.round(out.contextMessages)));
    }
    if (typeof out.temperature === "number") {
        out.temperature = Math.min(2, Math.max(0, out.temperature));
    }
    if (typeof out.contextLimit === "number") {
        // 0 是「不检查」的合法值，负数和离谱的大数都夹回去
        out.contextLimit = out.contextLimit <= 0 ? 0 : Math.min(4000000, Math.round(out.contextLimit));
    }
    if (typeof out.maxToolRounds === "number") {
        out.maxToolRounds = Math.min(30, Math.max(1, Math.round(out.maxToolRounds)));
    }

    return out;
}
