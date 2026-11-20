/**
 * 多套 API 配置。
 *
 * 一个 API = 一套「协议 + 地址 + 密钥」，下面挂几个自己填的模型名。
 * 面板顶栏按 API 分组列出所有模型，点一下就连 API 带模型一起切换。
 */
import type { Protocol } from "./providers";

export interface ApiConfig {
    id: string;
    /** 显示名，比如「中转站A」。留空就显示 id */
    name: string;
    protocol: Protocol;
    baseURL: string;
    apiKey: string;
    /** 这台服务商上有哪些模型。用户手填，也可以从接口拉 */
    models: string[];
    /**
     * 勾选要用的模型（多选）。
     *
     * 和 models 的区别：models 是"这台服务商上有哪些"，
     * picked 是"我要在日常切换里出现哪几个"。
     * 拉回来几十个模型时，只勾常用的几个，顶栏就不会一屏都是。
     */
    picked: string[];
    /** 当前选中哪个模型。切换 API 时跟着这个走 */
    model: string;
}

const PROTOCOLS: Protocol[] = ["openai", "anthropic", "gemini"];

export function newApiId(): string {
    return "a" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export function createApi(partial: Partial<ApiConfig> = {}, id = newApiId()): ApiConfig {
    const protocol = PROTOCOLS.includes(partial.protocol as Protocol)
        ? (partial.protocol as Protocol)
        : "openai";
    const rawModels = Array.isArray(partial.models)
        ? partial.models.filter((m): m is string => typeof m === "string").map((m) => m.trim())
        : [];
    // 去空格后可能撞车（" m1" 和 "m1"），必须去重，否则下拉里会出现两个一样的模型
    const models = rawModels.filter((m, i) => m && rawModels.indexOf(m) === i);
    const model = typeof partial.model === "string" ? partial.model.trim() : "";
    // 手改配置里可能出现「model 不在 models 里」，补进去，否则下拉里看不到当前模型
    if (model && !models.includes(model)) models.push(model);
    // 老配置没有 picked：默认把所有模型都算"选过的"，行为和老版本一致，
    // 主人不会升级完发现顶栏突然空了。
    const rawPicked = Array.isArray(partial.picked) ? partial.picked : null;
    const pickedBase = rawPicked
        ? rawPicked.filter((m): m is string => typeof m === "string").map((m) => m.trim())
        : [...models];
    const picked = pickedBase.filter((m) => m && models.includes(m));
    // 当前模型必须在 picked 里，否则顶栏选了它却又不显示
    if (model && !picked.includes(model)) picked.push(model);

    return {
        id,
        name: typeof partial.name === "string" ? partial.name.trim() : "",
        protocol,
        baseURL: typeof partial.baseURL === "string" ? partial.baseURL.trim() : "",
        apiKey: typeof partial.apiKey === "string" ? partial.apiKey : "",
        models,
        picked,
        model,
    };
}

/** 把外部进来的脏数据洗成能用的列表；同一个 id 只留第一个 */
export function normalizeApis(raw: unknown): ApiConfig[] {
    if (!Array.isArray(raw)) return [];
    const out: ApiConfig[] = [];
    const used = new Set<string>();
    for (const item of raw) {
        if (!item || typeof item !== "object") continue;
        const o = item as any;
        const id = typeof o.id === "string" && o.id.trim() ? o.id.trim() : "";
        if (!id || used.has(id)) continue;
        // 只要有 id 就留着：id 是程序生成的，说明这条是用户真建过的。
        // 用户可能刚点完「添加 API」还没来得及填名字/地址就重启了，
        // 按「内容为空就丢」会让他以为配置丢了。
        used.add(id);
        out.push(createApi(o, id));
    }
    return out;
}

/** 当前勾选的清单；老对象可能根本没这个字段，当作"全选" */
export function pickedOf(api: ApiConfig): string[] {
    const p = Array.isArray(api?.picked) ? api.picked : [];
    return p.length ? p : Array.isArray(api?.models) ? api.models : [];
}

/** 勾上/取消一个模型（用于"多选"）。返回新数组，不改原对象 */
export function togglePick(api: ApiConfig, name: string): ApiConfig {
    const cur = pickedOf(api);
    const has = cur.includes(name);
    // 取消勾选时不能把正在用的那个也取消掉，否则顶栏显示的名字会消失
    if (api.model === name && has) return api;

    let picked = has ? cur.filter((m) => m !== name) : [...cur, name];

    // 至少留一个：全取消会让这套 API 变成"没有模型可用"
    if (!picked.length) {
        picked = [api.model || api.models?.[0] || ""].filter(Boolean);
    }
    return { ...api, picked };
}

export function isPicked(api: ApiConfig, name: string): boolean {
    return pickedOf(api).includes(name);
}

/** 顶栏该列哪些模型：只列勾过的；一个都没勾就退回全部 */
export function visibleModels(api: ApiConfig): string[] {
    return pickedOf(api);
}

export function findApi(list: ApiConfig[], id: string): ApiConfig | undefined {
    return list.find((a) => a.id === id);
}

/** 当前该用哪套配置；activeApiId 失效时退回第一个 */
export function pickActiveApi(list: ApiConfig[], activeId: string): ApiConfig | undefined {
    return findApi(list, activeId) || list[0];
}

/**
 * 模型列表接口的地址。
 * 三种协议的路径不一样，规则跟 providers.ts 里发消息那套保持一致。
 */
export function modelsEndpoint(protocol: Protocol, baseURL: string): string {
    let base = String(baseURL || "").trim().replace(/\/+$/, "");

    if (protocol === "gemini") {
        const head = base.replace(/\/v1beta$|\/v1$/, "");
        return head + "/v1beta/models";
    }

    // OpenAI 兼容：地址可能填到 /chat/completions，要先退回去
    if (protocol === "openai") {
        base = base.replace(/\/chat\/completions$/, "");
        return base + "/models";
    }

    // Claude：地址可能填到 /messages
    base = base.replace(/\/messages$/, "");
    if (/\/v1$/.test(base)) return base + "/models";
    return base + "/v1/models";
}

/**
 * 从服务商的返回里挑出模型名。
 *
 * 三家的结构：
 *   OpenAI 兼容 → { data: [{ id }] }（也见过直接返回数组的中转站）
 *   Claude      → { data: [{ id, display_name }] }
 *   Gemini      → { models: [{ name: "models/gemini-2.0-flash" }] }
 */
export function parseModelList(protocol: Protocol, raw: any): string[] {
    const out: string[] = [];

    const push = (value: unknown) => {
        if (typeof value !== "string") return;
        let name = value.trim();
        if (!name) return;
        if (protocol === "gemini") name = name.replace(/^models\//, "");
        if (!out.includes(name)) out.push(name);
    };

    if (protocol === "gemini") {
        const list = Array.isArray(raw?.models) ? raw.models : [];
        for (const m of list) {
            // 只留能聊天的：Gemini 的清单里混着 embedding / aqa 这类
            const actions = m?.supportedActions || m?.supportedGenerationMethods;
            if (Array.isArray(actions) && actions.length && !actions.includes("generateContent")) {
                continue;
            }
            push(m?.name ?? m);
        }
        return out;
    }

    const list = Array.isArray(raw?.data) ? raw.data : Array.isArray(raw) ? raw : [];
    for (const m of list) push(typeof m === "string" ? m : m?.id);
    return out;
}

/** 造请求头：拉模型列表用的，和发消息那套鉴权方式一致 */
export function modelsHeaders(protocol: Protocol, apiKey: string): Record<string, string> {
    const h: Record<string, string> = { Accept: "application/json" };
    if (!apiKey) return h;
    if (protocol === "anthropic") {
        h["x-api-key"] = apiKey;
        h["anthropic-version"] = "2023-06-01";
        return h;
    }
    if (protocol === "gemini") {
        h["x-goog-api-key"] = apiKey;
        return h;
    }
    h.Authorization = "Bearer " + apiKey;
    return h;
}

export interface ModelFetchResult {
    /** 能聊天的那些（已滤掉 embedding 之类） */
    models: string[];
    /** 画图模型：不能聊天，但生图要用 */
    imageModels: string[];
    /** 被滤掉的数量，用来给用户一句人话 */
    skipped: number;
    error: string;
}

type Fetcher = (
    url: string,
    opts: { method: string; headers: Record<string, string>; body?: string }
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

/**
 * 去服务商那里拉模型清单。
 *
 * fetcher 由调用方注入（真实场景用 net.ts 的 fetchOnce），
 * 这样这里不需要碰 window，测试也好写。
 */
export async function fetchModels(
    api: Pick<ApiConfig, "protocol" | "baseURL" | "apiKey">,
    fetcher: Fetcher
): Promise<ModelFetchResult> {
    const empty: ModelFetchResult = { models: [], imageModels: [], skipped: 0, error: "" };
    if (!api.baseURL.trim()) return { ...empty, error: "先填接口地址" };

    const url = modelsEndpoint(api.protocol, api.baseURL);
    let resp;
    try {
        resp = await fetcher(url, { method: "GET", headers: modelsHeaders(api.protocol, api.apiKey) });
    } catch (e: any) {
        return { ...empty, error: String(e?.message || e) };
    }

    const text = await resp.text().catch(() => "");
    if (!resp.ok) {
        const detail = text ? "：" + text.slice(0, 160) : "";
        return { ...empty, error: `接口返回 ${resp.status}${detail}` };
    }

    let json: any = null;
    try {
        json = JSON.parse(text);
    } catch {
        return { ...empty, error: "返回的不是 JSON，可能这个中转站不开放模型列表" };
    }

    const all = parseModelList(api.protocol, json);
    if (!all.length) return { ...empty, error: "接口没返回任何模型，手动填吧" };

    const { chat, image, skipped } = splitChatModels(all);
    // 聊天和画图都被滤光了，说明名单可能误杀。
    // 宁可全放出来让用户自己挑，也不要给个空清单。
    if (!chat.length && !image.length) return { ...empty, models: all };
    return { models: chat, imageModels: image, skipped, error: "" };
}

/** 把拉回来的模型合并进现有清单，保留已有顺序 */
export function mergeModels(current: string[], incoming: string[]): string[] {
    const out = [...current];
    for (const m of incoming) {
        if (m && !out.includes(m)) out.push(m);
    }
    return out;
}

/**
 * 画图模型名。
 *
 * 这类模型走的是另一套接口（/images/generations），拿它聊天必然 400。
 * 但它们不是"垃圾名字"：主人在生图模式里正要用它们，
 * 所以要把它们单独认出来，而不是和 embedding 一起丢掉。
 *
 * 规则分两层（先认名字，认不出来再由主人手动标，见 imageOnly）：
 *   1. 名字里带 image / 带已知画图系列 —— 最常见的一类
 *   2. 上面都不沾，但名字里有 diffusion / 画图之类的强特征
 */
const IMAGE_PATTERNS: RegExp[] = [
    // 名字里带 "image" 的基本都是画图：gpt-image-1、gemini-3.1-flash-image、
    // qwen-image、seedream-image... 这是最省事也最不容易漏的一条
    /image/i,
    /dall-e/i,
    /stable-diffusion/i,
    /diffusion/i,
    /sdxl/i,
    /(^|[/_-])flux([/_-]|$)/i, // black-forest-labs/flux
    /(^|[/_-])sd3([/_-]|$)/i,
    /midjourney/i,
    /(^|[/_-])imagen([/_-]|$)/i, // Google imagen
    /(^|[/_-])kolors([/_-]|$)/i,
    /(^|[/_-])seedream([/_-]|$)/i,
    /(^|[/_-])wanx([/_-]|$)/i, // 通义万相
    /(^|[/_-])cogview([/_-]|$)/i,
    /(^|[/_-])playground-v2/i,
    /(^|[/_-])pixart([/_-]|$)/i,
    /(^|[/_-])hidream([/_-]|$)/i,
];

/** 名字里出现这些，说明是"看图"或"边说边画"的多模态，别当成纯画图 */
const IMAGE_FALSE_POSITIVE = /chat|vision|vl([/_-]|$)/i;

/** 这个名字看起来是不是画图模型 */
export function isImageModel(name: string): boolean {
    const n = String(name || "").trim();
    if (!n) return false;
    if (IMAGE_FALSE_POSITIVE.test(n)) return false;
    return IMAGE_PATTERNS.some((re) => re.test(n));
}

/**
 * 明显不能聊天、也不是画图的模型名。
 *
 * 中转站的 /models 会把 embedding、语音的模型混在一起，
 * 这些名字一旦被选中，发消息必然 400 —— 用户看到的就是
 * 「从接口拉来的不能用，自己手打一个就能用」。
 *
 * 名单刻意写窄：只挡铁定不能用的，宁可漏几个也别误杀能用的。
 * 漏掉的顶多报一次错，误杀会让用户以为模型消失了。
 */
const NON_CHAT_PATTERNS: RegExp[] = [
    /embed/i, // text-embedding-3-small、jina-embeddings、nomic-embed
    /(^|[/_-])bge([/_-]|$)/i, // BAAI/bge-m3
    /whisper/i,
    /(^|[/_-])tts([/_-]|$)/i, // tts-1
    /rerank/i,
    /moderation/i,
];

/** 这个名字看起来能不能聊天（画图模型不算，见 isImageModel） */
export function isChatModel(name: string): boolean {
    const n = String(name || "").trim();
    if (!n) return false;
    if (isImageModel(n)) return false;
    return !NON_CHAT_PATTERNS.some((re) => re.test(n));
}

/**
 * 用户手动标成"这是画图模型"的名字（存在设置里）。
 *
 * 为什么必须留这条路：模型名千奇百怪，靠正则猜总会漏。
 * 漏了的表现是"我明明配了画图模型，插件说没有" —— 这条兜底能救任何名字。
 */
export function isManualImage(name: string, manual: string[] | undefined): boolean {
    const n = String(name || "").trim();
    if (!n) return false;
    return Array.isArray(manual) && manual.includes(n);
}

/** 综合判断：名字像画图，或者主人手动标过 */
export function isImageModelOf(name: string, manual: string[] | undefined): boolean {
    return isManualImage(name, manual) || isImageModel(name);
}

/** 综合判断能不能聊天：画图的不算（手动标过的也一样） */
export function isChatModelOf(name: string, manual: string[] | undefined): boolean {
    if (isManualImage(name, manual)) return false;
    return isChatModel(name);
}

/**
 * 拉回来的名字分三堆：能聊天的、能画图的、以及干脆没用的。
 *
 * 画图的和聊天的都要留下来 —— 一个进对话模式，一个进生图模式。
 */
export function splitChatModels(list: string[]): { chat: string[]; image: string[]; skipped: number } {
    const chat: string[] = [];
    const image: string[] = [];
    let skipped = 0;
    for (const m of list) {
        if (isChatModel(m)) chat.push(m);
        else if (isImageModel(m)) image.push(m);
        else skipped++;
    }
    return { chat, image, skipped };
}

/** 下拉里给模型名配的一句人话注释（把手动标记的名单也算进来） */
export function modelKindLabelOf(name: string, manual: string[] | undefined): string {
    if (isImageModelOf(name, manual)) return "画图";
    if (!isChatModelOf(name, manual)) return "不能聊天";
    return "";
}
