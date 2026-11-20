/**
 * Streamable HTTP 传输的 MCP 客户端。
 *
 * 按官方规范：
 *   - POST 的 Accept 必须同时声明 application/json 和 text/event-stream
 *   - 服务端可能回 JSON，也可能回 SSE 流，两种都要支持
 *   - 初始化响应若带 Mcp-Session-Id，后续请求都要带上
 *   - 握手后要发一条 notifications/initialized
 *
 * fetcher 可注入，方便测试；真实使用时传 window.fetch 或主进程通道。
 */
import {
    makeRequest,
    makeNotification,
    parseMessage,
    extractText,
} from "./mcp-jsonrpc";

export interface McpTool {
    name: string;
    description: string;
    inputSchema: any;
}

export interface ConnectInfo {
    serverName: string;
    serverVersion: string;
    protocolVersion: string;
}

export interface FetcherResponse {
    ok: boolean;
    status: number;
    headers: { get(name: string): string | null } | Map<string, string>;
    text(): Promise<string>;
}

export type Fetcher = (url: string, init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
}) => Promise<FetcherResponse>;

export interface HttpMcpClientOptions {
    url: string;
    headers?: Record<string, string>;
    fetcher: Fetcher;
    timeoutMs?: number;
}

const PROTOCOL_VERSION = "2025-06-18";

export class HttpMcpClient {
    private nextId = 1;
    tools: McpTool[] = [];
    sessionId = "";

    constructor(private opts: HttpMcpClientOptions) {}

    private header(resp: FetcherResponse, name: string): string {
        const h: any = resp.headers;
        if (!h) return "";
        if (typeof h.get === "function") return h.get(name) || h.get(name.toLowerCase()) || "";
        return "";
    }

    private async post(payload: object, signal?: AbortSignal): Promise<FetcherResponse> {
        const headers: Record<string, string> = {
            "Content-Type": "application/json",
            // 官方要求：两个都要声明，否则服务端可能拒绝
            Accept: "application/json, text/event-stream",
            ...(this.opts.headers || {}),
        };
        if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;

        const timeoutMs = this.opts.timeoutMs ?? 30000;
        const ctrl = new AbortController();
        let timer: any;
        // 光靠 AbortSignal 不够：底层通道（比如主进程代理）不一定听它的。
        // 所以再和时间赛跑一次，保证一定会返回。
        const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
                try {
                    ctrl.abort();
                } catch {}
                reject(new Error(`连接超时（${timeoutMs} 毫秒）`));
            }, timeoutMs);
        });

        try {
            return await Promise.race([
                this.opts.fetcher(this.opts.url, {
                    method: "POST",
                    headers,
                    body: JSON.stringify(payload),
                    signal: signal || ctrl.signal,
                }),
                timeout,
            ]);
        } finally {
            clearTimeout(timer);
        }
    }

    /** 发一条请求，等它对应的那个 id 的结果 */
    private async request(method: string, params?: Record<string, unknown>): Promise<any> {
        const id = this.nextId++;
        const resp = await this.post(makeRequest(id, method, params));

        if (!resp.ok) {
            const detail = await resp.text().catch(() => "");
            throw new Error(`HTTP ${resp.status}${detail ? "：" + detail.slice(0, 200) : ""}`);
        }

        // 初始化响应里可能分配会话
        const sid = this.header(resp, "mcp-session-id");
        if (sid) this.sessionId = sid;

        const ct = this.header(resp, "content-type") || "";
        const raw = await resp.text();

        if (ct.includes("text/event-stream")) {
            return pickResultFromSSE(raw, id);
        }

        const parsed = parseMessage(raw);
        if (!parsed) throw new Error("服务端返回的不是合法的 MCP 消息");
        if (parsed.kind === "error") throw new Error(parsed.errorText);
        if (parsed.kind !== "result") throw new Error("服务端没返回结果");
        return parsed.result;
    }

    async connect(): Promise<ConnectInfo> {
        const result = await this.request("initialize", {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "siyuan-ai-chat", version: "0.1.0" },
        });

        // 握手完要通知一声，官方规范要求
        try {
            await this.post(makeNotification("notifications/initialized"));
        } catch {
            // 有的服务端不认这条通知，不该因此让整个连接失败
        }

        const list = await this.request("tools/list");
        this.tools = normalizeTools(list?.tools);

        return {
            serverName: result?.serverInfo?.name || "",
            serverVersion: result?.serverInfo?.version || "",
            protocolVersion: result?.protocolVersion || "",
        };
    }

    async callTool(name: string, args: Record<string, unknown>): Promise<string> {
        const result = await this.request("tools/call", { name, arguments: args || {} });
        return extractText(result);
    }

    async close() {
        if (!this.sessionId) return;
        try {
            await this.opts.fetcher(this.opts.url, {
                method: "DELETE",
                headers: { "Mcp-Session-Id": this.sessionId },
            });
        } catch {
            // 服务端可能不允许终止会话，忽略
        }
        this.sessionId = "";
    }
}

function normalizeTools(raw: any): McpTool[] {
    if (!Array.isArray(raw)) return [];
    const out: McpTool[] = [];
    for (const t of raw) {
        if (!t || typeof t.name !== "string" || !t.name) continue;
        out.push({
            name: t.name,
            description: typeof t.description === "string" ? t.description : "",
            inputSchema: t.inputSchema && typeof t.inputSchema === "object"
                ? t.inputSchema
                : { type: "object", properties: {} },
        });
    }
    return out;
}

/** 从 SSE 文本里挑出 id 匹配的那个结果；中间的通知忽略 */
function pickResultFromSSE(raw: string, wantId: number): any {
    for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload) continue;

        const parsed = parseMessage(payload);
        if (!parsed) continue;
        if (parsed.kind === "error") throw new Error(parsed.errorText);
        if (parsed.kind === "result" && parsed.id === wantId) return parsed.result;
    }
    throw new Error("SSE 流里没有找到结果");
}
