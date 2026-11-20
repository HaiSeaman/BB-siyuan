/**
 * 会话存档。
 *
 * 目标：关掉面板再打开，之前的对话还在。
 * 只存纯数据，不碰网络也不碰界面。
 *
 * 图片消息只存"文件路径 + 尺寸 + 提示词"，绝不存图片数据本身：
 * 一张 4K 图的 base64 有十几兆，塞进 sessions.json 会把存档撑爆，
 * 面板打开速度会越来越慢，最后连历史都读不出来。
 */

export interface SessionMessage {
    role: "user" | "assistant";
    content: string;
    reasoning: string;
    /** 这条消息里带的图片。只有生图模式会有 */
    images?: SessionImage[];
    /** 我发消息时带的参考图文件名（只用于回显"当时传过图"） */
    refName?: string;
}

/** 一张已保存的图片的元数据 */
export interface SessionImage {
    /** 相对插件数据目录的路径，如 images/img-xxx.png；外部网址时为空 */
    path: string;
    /** 尺寸，如 "2048 × 1152" */
    size: string;
    /** 这张图用的提示词 */
    prompt: string;
    /** 服务商给的图片网址（有的中转站只给网址，不给图片数据） */
    url?: string;
    /**
     * 只在内存里用的图片数据（存盘失败时留的临时副本）。
     * 绝不写进 sessions.json —— cleanImages 会把它丢掉。
     */
    mem?: string;
}

export interface Session {
    id: string;
    title: string;
    messages: SessionMessage[];
    updatedAt: number;
}

/** 最多留多少个会话。太多会拖慢界面，也占地方 */
export const MAX_SESSIONS = 30;

/** 标题最长多少字 */
const TITLE_MAX = 24;

/** 一张图最多记这么多张，防脏数据把内存撑爆 */
const MAX_IMAGES_PER_MSG = 8;

export function sessionTitle(firstMessage: string): string {
    const flat = (firstMessage || "").replace(/\s+/g, " ").trim();
    if (!flat) return "新对话";
    if (flat.length <= TITLE_MAX) return flat;
    return flat.slice(0, TITLE_MAX) + "…";
}

export function createSession(
    title: string,
    idFactory: () => string = () => "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    now: () => number = Date.now
): Session {
    return {
        id: idFactory(),
        title: title || "新对话",
        messages: [],
        updatedAt: now(),
    };
}

/** 洗一遍图片元数据：只要路径/网址、尺寸、提示词，别的一律丢掉 */
function cleanImages(raw: unknown): SessionImage[] {
    if (!Array.isArray(raw)) return [];
    const out: SessionImage[] = [];
    for (const item of raw) {
        if (!item || typeof item !== "object") continue;
        const o = item as Record<string, unknown>;
        const path = typeof o.path === "string" ? o.path.trim() : "";
        const url = typeof o.url === "string" ? o.url.trim() : "";
        // 两个都没有 = 这张图根本找不回来，留着只会显示破图
        if (!path && !url) continue;
        // 没有的就别写空字符串：存档里多一堆 "" 既占地方又难核对
        const img: SessionImage = {
            path,
            size: typeof o.size === "string" ? o.size : "",
            prompt: typeof o.prompt === "string" ? o.prompt : "",
        };
        if (url) img.url = url;
        out.push(img);
        if (out.length >= MAX_IMAGES_PER_MSG) break;
    }
    return out;
}

/**
 * 只保留「有正文的」消息。
 * 生成的助手消息如果只有思考没有正文，说明中途断了，不该存档。
 * 但带图的消息（哪怕没有文字）必须留下来 —— 图片本身就是结果。
 */
function cleanMessages(raw: unknown): SessionMessage[] {
    if (!Array.isArray(raw)) return [];
    const out: SessionMessage[] = [];
    for (const m of raw) {
        if (!m || typeof m !== "object") continue;
        const o = m as Record<string, unknown>;
        const role = o.role === "assistant" ? "assistant" : o.role === "user" ? "user" : null;
        if (!role) continue;
        const content = typeof o.content === "string" ? o.content : "";
        const reasoning = typeof o.reasoning === "string" ? o.reasoning : "";
        const images = cleanImages(o.images);
        if (!content.trim() && images.length === 0) continue;
        const msg: SessionMessage = { role, content, reasoning };
        if (images.length) msg.images = images;
        if (typeof o.refName === "string" && o.refName) msg.refName = o.refName;
        out.push(msg);
    }
    return out;
}

export function normalizeSessions(raw: unknown): Session[] {
    if (!Array.isArray(raw)) return [];

    const seen = new Set<string>();
    const out: Session[] = [];

    for (const item of raw) {
        if (!item || typeof item !== "object") continue;
        const o = item as Record<string, unknown>;

        const id = typeof o.id === "string" ? o.id.trim() : "";
        if (!id || seen.has(id)) continue;

        const messages = cleanMessages(o.messages);
        // 一条像样的话都没有，存着也没意义
        if (messages.length === 0) continue;

        seen.add(id);
        out.push({
            id,
            title: typeof o.title === "string" && o.title.trim() ? o.title.trim() : sessionTitle(messages[0].content),
            messages,
            updatedAt: typeof o.updatedAt === "number" && Number.isFinite(o.updatedAt) ? o.updatedAt : 0,
        });
    }

    // 最近的排最前
    out.sort((a, b) => b.updatedAt - a.updatedAt);
    return out.slice(0, MAX_SESSIONS);
}

/** 有同 id 就替换（并提到最前），没有就插入到最前 */
export function upsertSession(list: Session[], s: Session): Session[] {
    const rest = list.filter((x) => x.id !== s.id);
    return [s, ...rest];
}

export function removeSession(list: Session[], id: string): Session[] {
    return list.filter((s) => s.id !== id);
}

/** 两条会话的消息内容是否完全一致（不看时间戳） */
export function sameMessages(a: SessionMessage[], b: SessionMessage[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i].role !== b[i].role) return false;
        if (a[i].content !== b[i].content) return false;
        if (a[i].reasoning !== b[i].reasoning) return false;
        if ((a[i].refName || "") !== (b[i].refName || "")) return false;
        const ai = a[i].images || [];
        const bi = b[i].images || [];
        if (ai.length !== bi.length) return false;
        for (let j = 0; j < ai.length; j++) {
            if (ai[j].path !== bi[j].path) return false;
            if ((ai[j].url || "") !== (bi[j].url || "")) return false;
            if (ai[j].size !== bi[j].size) return false;
            if (ai[j].prompt !== bi[j].prompt) return false;
        }
    }
    return true;
}

/** 只保留最新的若干个（假定已经按时间倒序） */
export function trimSessions(list: Session[]): Session[] {
    return list.slice(0, MAX_SESSIONS);
}
