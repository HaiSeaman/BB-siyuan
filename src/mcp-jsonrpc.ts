/**
 * MCP 的 JSON-RPC 2.0 层。
 *
 * 只做协议本身，不碰网络。拆出来是为了能单独测：
 * 消息构造、响应解析、工具名映射、结果取文本。
 */

export const MCP_PREFIX = "mcp__";

export interface JsonRpcRequest {
    jsonrpc: "2.0";
    id: number;
    method: string;
    params?: Record<string, unknown>;
}

export interface JsonRpcNotification {
    jsonrpc: "2.0";
    method: string;
    params?: Record<string, unknown>;
}

export function makeRequest(id: number, method: string, params?: Record<string, unknown>): JsonRpcRequest {
    const msg: JsonRpcRequest = { jsonrpc: "2.0", id, method };
    if (params) msg.params = params;
    return msg;
}

export function makeNotification(method: string, params?: Record<string, unknown>): JsonRpcNotification {
    const msg: JsonRpcNotification = { jsonrpc: "2.0", method };
    if (params) msg.params = params;
    return msg;
}

export type ParsedMessage =
    | { kind: "result"; id: number; result: any }
    | { kind: "error"; id: number; errorText: string; code?: number }
    | { kind: "notification"; method: string; params?: any };

/** 解析一条服务端消息；看不懂就返回 null，不要抛错打断整条流 */
export function parseMessage(raw: string): ParsedMessage | null {
    let json: any;
    try {
        json = JSON.parse(raw);
    } catch {
        return null;
    }
    if (!json || json.jsonrpc !== "2.0") return null;

    if (json.error) {
        return {
            kind: "error",
            id: json.id,
            errorText: json.error.message || JSON.stringify(json.error),
            code: json.error.code,
        };
    }
    if (json.method && json.id === undefined) {
        return { kind: "notification", method: json.method, params: json.params };
    }
    if ("result" in json) {
        return { kind: "result", id: json.id, result: json.result };
    }
    if (json.method) {
        return { kind: "notification", method: json.method, params: json.params };
    }
    return null;
}

/**
 * 给模型看的工具名：mcp__服务器__工具
 *
 * 接口对函数名有硬性限制：只能 `[A-Za-z0-9_-]`，最长 64。
 * 中文、空格、点号全都要换掉，否则整次请求会被 400 拒掉。
 *
 * 注意：不能简单地把非法字符逐个换成下划线 —— 中文服务器名会变成一长串下划线，
 * 和 `__` 分隔符糊在一起就拆不回去了。所以：
 *   - 先压缩连续的非法字符为一个下划线
 *   - 首尾的下划线去掉
 *   - 万一整段都非法，用 `srv` / `tool` 兜底
 */
export function toolNameFor(server: string, tool: string): string {
    const s = sanitize(server, "srv");
    const t = sanitize(tool, "tool");
    const name = MCP_PREFIX + s + "__" + t;
    if (name.length <= 64) return name;

    // 超长要截断，但得保住前缀和分隔，否则就拆不回去了
    const room = 64 - MCP_PREFIX.length - 2;
    const sLen = Math.min(s.length, Math.max(1, Math.floor(room / 2)));
    const tLen = Math.max(1, room - sLen);
    return MCP_PREFIX + s.slice(0, sLen) + "__" + t.slice(0, tLen);
}

function sanitize(v: string, fallback: string): string {
    // 先按界面上常见的中文标点切开，让「求-和」「求 和」都变成 `求_和` 而不是整段糊掉
    const out = (v || "")
        .replace(/[^A-Za-z0-9_]+/g, "_")
        .replace(/^_+|_+$/g, "");
    if (out) return out;

    // 整段都是中文：用它的字符编码给个稳定、可复现的短标识，
    // 不用 srv/tool 这种笼统名字，否则多个服务器会重名。
    let h = 0;
    for (let i = 0; i < v.length; i++) {
        h = (h * 31 + v.charCodeAt(i)) >>> 0;
    }
    return fallback + "_" + h.toString(36).slice(0, 6);
}

export function splitToolName(name: string): { server: string; tool: string } | null {
    if (!name || !name.startsWith(MCP_PREFIX)) return null;
    const rest = name.slice(MCP_PREFIX.length);
    const at = rest.indexOf("__");
    if (at <= 0 || at === rest.length - 2) return null;
    return { server: rest.slice(0, at), tool: rest.slice(at + 2) };
}

/** 把 tools/call 的结果压成一段给模型看的文本 */
export function extractText(result: any): string {
    if (!result || typeof result !== "object") return "";
    const blocks = Array.isArray(result.content) ? result.content : [];
    const parts: string[] = [];
    for (const b of blocks) {
        if (!b || typeof b !== "object") continue;
        if (typeof b.text === "string" && b.text) parts.push(b.text);
        else if (b.type === "image") parts.push("[图片，无法显示]");
        else if (b.type === "resource") parts.push("[资源：" + (b.resource?.uri || "未知") + "]");
    }

    let out = parts.join("\n");
    if (!out && result.structuredContent) {
        try {
            out = JSON.stringify(result.structuredContent);
        } catch {
            out = "";
        }
    }
    if (result.isError) out = "[工具报错] " + (out || "没有说明");
    return out;
}

const WRITE_WORDS = new Set([
    "delete",
    "remove",
    "write",
    "update",
    "create",
    "insert",
    "drop",
    "truncate",
    "patch",
    "put",
    "set",
    "move",
    "rename",
    "upload",
    "edit",
    "add",
    "save",
]);

/**
 * 粗判是不是写操作，用来决定要不要先问一句。
 *
 * 不能直接用 \b 词边界：`delete_file` 里的下划线也算词字符，
 * 所以 `delete_` 后面没有边界，正则会漏判。
 * 改成按分隔符切开逐段比。
 */
export function isWriteLike(name: string): boolean {
    if (!name) return false;

    // 先拆成单词：驼峰、下划线、横线、点都当分隔
    const words = name
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .split(/[^A-Za-z0-9]+/)
        .map((w) => w.toLowerCase())
        .filter(Boolean);

    // readonly 不是写操作
    if (words.includes("readonly")) return false;

    return words.some((w) => WRITE_WORDS.has(w));
}
