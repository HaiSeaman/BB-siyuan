/**
 * 旧版 SSE 传输的 MCP 客户端（2024-11-05 那一套）。
 *
 * 流程：
 *   1. GET 建立事件流，服务端先发一条 `event: endpoint` 告诉客户端往哪 POST
 *   2. 之后的请求都 POST 到那个端点，响应从流里回来
 *
 * 现实中的实现差异很大：有的把结果直接放在 POST 的响应体里，
 * 有的只回 202 然后从流里推。两种都要兜住。
 */
import { makeRequest, makeNotification, parseMessage, extractText } from "./mcp-jsonrpc";
import type { Fetcher, FetcherResponse, McpTool, ConnectInfo } from "./mcp-http";

export interface SseMcpClientOptions {
    url: string;
    headers?: Record<string, string>;
    fetcher: Fetcher;
    timeoutMs?: number;
}

export class SseMcpClient {
    private nextId = 1;
    tools: McpTool[] = [];
    /** 服务端通过 event: endpoint 告诉我们的消息地址 */
    messageUrl = "";

    constructor(private opts: SseMcpClientOptions) {}

    private timeout(ms: number): Promise<never> {
        return new Promise((_, reject) => setTimeout(() => reject(new Error(`连接超时（${ms} 毫秒）`)), ms));
    }

    /** 建立事件流，从中取出消息端点 */
    private async openStream(): Promise<void> {
        const timeoutMs = this.opts.timeoutMs ?? 15000;
        const headers: Record<string, string> = {
            Accept: "text/event-stream",
            ...(this.opts.headers || {}),
        };

        let timer: any = null;
        const timeoutPromise = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`连接超时（${timeoutMs} 毫秒）`)), timeoutMs);
        });

        try {
            const resp = await Promise.race([
                this.opts.fetcher(this.opts.url, { method: "GET", headers }),
                timeoutPromise,
            ]);

            if (!resp.ok) {
                const detail = await resp.text().catch(() => "");
                throw new Error(`HTTP ${resp.status}${detail ? "：" + detail.slice(0, 120) : ""}`);
            }

            // 关键：SSE 的正常状态是「一直不关闭」。
            // 直接 await resp.text() 会永远挂住，所以读到 endpoint 就停。
            const raw = await Promise.race([this.readUntilEndpoint(resp), timeoutPromise]);
            const endpoint = findEndpointEvent(raw);
            if (!endpoint) {
                throw new Error("这个地址没有返回 SSE 端点（可能不是旧版 SSE 服务器）");
            }
            this.messageUrl = resolveUrl(this.opts.url, endpoint);
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    /** 从流里读到 endpoint 事件就停止，不等连接关闭 */
    private async readUntilEndpoint(resp: any): Promise<string> {
        // 拿不到流式读取能力就退回整块读（测试里的假 resp 是这种）
        if (typeof resp.body?.getReader !== "function") {
            return resp.text();
        }

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                buf += decoder.decode(value, { stream: true });
                if (findEndpointEvent(buf)) break;
                // 防御：别无限攒数据
                if (buf.length > 65536) break;
            }
        } finally {
            await reader.cancel().catch(() => {});
        }
        return buf;
    }

    private async post(payload: object): Promise<string> {
        const timeoutMs = this.opts.timeoutMs ?? 15000;
        const headers: Record<string, string> = {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            ...(this.opts.headers || {}),
        };

        const resp = await Promise.race([
            this.opts.fetcher(this.messageUrl, {
                method: "POST",
                headers,
                body: JSON.stringify(payload),
            }),
            this.timeout(timeoutMs),
        ]);

        if (!resp.ok) {
            const detail = await resp.text().catch(() => "");
            throw new Error(`HTTP ${resp.status}${detail ? "：" + detail.slice(0, 160) : ""}`);
        }
        return resp.text();
    }

    /** 发请求并从响应体里找 id 对应的结果 */
    private async request(method: string, params?: Record<string, unknown>): Promise<any> {
        const id = this.nextId++;
        const raw = await this.post(makeRequest(id, method, params));
        const result = pickResult(raw, id);
        if (result !== undefined) return result;
        // 有些实现先把结果放进 POST 响应体之外的地方，取不到就算失败
        throw new Error("没有收到 " + method + " 的结果");
    }

    async connect(): Promise<ConnectInfo> {
        await this.openStream();

        const result = await this.request("initialize", {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "siyuan-ai-chat", version: "0.1.0" },
        });

        try {
            await this.post(makeNotification("notifications/initialized"));
        } catch {
            // 通知失败不影响连接
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
        this.messageUrl = "";
    }
}

/** 从 SSE 文本里找 `event: endpoint` 那一行后面的地址 */
function findEndpointEvent(raw: string): string {
    const lines = raw.split("\n");
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim() === "event: endpoint") {
            for (let j = i + 1; j < lines.length; j++) {
                const l = lines[j].trim();
                if (l.startsWith("data:")) {
                    const v = l.slice(5).trim();
                    if (v) return v;
                }
                if (l.startsWith("event:")) break;
            }
        }
    }
    // 有的服务端不发 event 名，只在 data 里给个相对路径
    for (const line of lines) {
        const l = line.trim();
        if (l.startsWith("data:")) {
            const v = l.slice(5).trim();
            if (v.startsWith("/") || v.startsWith("http")) return v;
        }
    }
    return "";
}

function resolveUrl(base: string, target: string): string {
    if (/^https?:\/\//i.test(target)) return target;
    try {
        return new URL(target, base).toString();
    } catch {
        return target;
    }
}

/** 在返回的文本（可能是 SSE 片段，也可能是纯 JSON）里找 id 匹配的结果 */
function pickResult(raw: string, wantId: number): any {
    if (!raw) return undefined;

    const direct = parseMessage(raw.trim());
    if (direct) {
        if (direct.kind === "error") throw new Error(direct.errorText);
        if (direct.kind === "result" && direct.id === wantId) return direct.result;
    }

    for (const line of raw.split("\n")) {
        const l = line.trim();
        if (!l.startsWith("data:")) continue;
        const payload = l.slice(5).trim();
        if (!payload) continue;
        const parsed = parseMessage(payload);
        if (!parsed) continue;
        if (parsed.kind === "error") throw new Error(parsed.errorText);
        if (parsed.kind === "result" && parsed.id === wantId) return parsed.result;
    }
    return undefined;
}

function normalizeTools(raw: any): McpTool[] {
    if (!Array.isArray(raw)) return [];
    const out: McpTool[] = [];
    for (const t of raw) {
        if (!t || typeof t.name !== "string" || !t.name) continue;
        out.push({
            name: t.name,
            description: typeof t.description === "string" ? t.description : "",
            inputSchema:
                t.inputSchema && typeof t.inputSchema === "object"
                    ? t.inputSchema
                    : { type: "object", properties: {} },
        });
    }
    return out;
}
