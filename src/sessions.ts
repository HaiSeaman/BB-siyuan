/**
 * 会话存档。
 *
 * 目标：关掉面板再打开，之前的对话还在。
 * 只存纯数据，不碰网络也不碰界面。
 */

export interface SessionMessage {
    role: "user" | "assistant";
    content: string;
    reasoning: string;
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

/**
 * 只保留「有正文的」消息。
 * 生成的助手消息如果只有思考没有正文，说明中途断了，不该存档。
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
        if (!content.trim()) continue;
        out.push({ role, content, reasoning });
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
    }
    return true;
}

/** 只保留最新的若干个（假定已经按时间倒序） */
export function trimSessions(list: Session[]): Session[] {
    return list.slice(0, MAX_SESSIONS);
}
