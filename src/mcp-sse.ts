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
    private streamReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: any }>();
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
            // 直接 await resp.text() 会永远挂住，所以读到 endpoint 就停并转入后台持续收流。
            const raw = await Promise.race([this.readUntilEndpoint(resp), timeoutPromise]);
            const endpoint = findEndpointEvent(raw);
            if (!endpoint) {
                await this.stopStream();
                throw new Error("这个地址没有返回 SSE 端点（可能不是旧版 SSE 服务器）");
            }
            this.messageUrl = resolveUrl(this.opts.url, endpoint);
        } catch (e) {
            await this.stopStream();
            throw e;
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    private async stopStream() {
        const r = this.streamReader;
        this.streamReader = null;
        if (r) await r.cancel().catch(() => {});
    }

    /** 从流里读到 endpoint 事件后交出控制权，同时把流留给后台循环收后续消息 */
    private async readUntilEndpoint(resp: any): Promise<string> {
        // 拿不到流式读取能力就退回整块读（测试里的假 resp 是这种）
        if (typeof resp.body?.getReader !== "function") {
            return resp.text();
        }

        const reader: ReadableStreamDefaultReader<Uint8Array> = resp.body.getReader();
        this.streamReader = reader;
        const decoder = new TextDecoder();
        let buf = "";
        let found = false;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            if (findEndpointEvent(buf)) {
                found = true;
                break;
            }
            // 防御：别无限攒数据
            if (buf.length > 65536) break;
        }
        if (found) {
            // 保留同一块里 endpoint 之后的未处理数据，继续在后台读 202 推送的响应
            const after = sliceAfterEndpoint(buf);
            void this.pumpStream(reader, decoder, after);
        } else {
            await this.stopStream();
        }
        return buf;
    }

    private async pumpStream(
        reader: ReadableStreamDefaultReader<Uint8Array>,
        decoder: TextDecoder,
        initial: string
    ) {
        let buf = initial;
        const flushLines = () => {
            let nl = buf.indexOf("\n");
            while (nl !== -1) {
                const line = buf.slice(0, nl).trim();
                buf = buf.slice(nl + 1);
                this.handleSseLine(line);
                nl = buf.indexOf("\n");
            }
        };
        try {
            flushLines();
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                buf += decoder.decode(value, { stream: true });
                flushLines();
            }
            if (buf.trim()) this.handleSseLine(buf.trim());
        } catch {
            // 主动 close 或断流时忽略
        } finally {
            if (this.streamReader === reader) this.streamReader = null;
            this.rejectAllPending("SSE 连接已断开");
        }
    }

    private handleSseLine(line: string) {
        if (!line.startsWith("data:")) return;
        const payload = line.slice(5).trim();
        if (!payload) return;
        const parsed = parseMessage(payload);
        if (!parsed || parsed.kind === "notification") return;
        const wait = this.pending.get(parsed.id);
        if (!wait) return;
        this.pending.delete(parsed.id);
        clearTimeout(wait.timer);
        if (parsed.kind === "error") wait.reject(new Error(parsed.errorText));
        else wait.resolve(parsed.result);
    }

    private rejectAllPending(msg: string) {
        for (const [id, wait] of this.pending) {
            clearTimeout(wait.timer);
            wait.reject(new Error(msg));
            this.pending.delete(id);
        }
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

    /** 发请求：既收 POST 直接响应，也等 GET 长连接推回来的结果 */
    private request(method: string, params?: Record<string, unknown>): Promise<any> {
        const id = this.nextId++;
        const timeoutMs = this.opts.timeoutMs ?? 15000;

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error("没有收到 " + method + " 的结果"));
            }, timeoutMs);

            this.pending.set(id, { resolve, reject, timer });

            this.post(makeRequest(id, method, params))
                .then((raw) => {
                    const wait = this.pending.get(id);
                    if (!wait) return; // 已被流推送先唤醒
                    try {
                        const result = pickResult(raw, id);
                        if (result !== undefined) {
                            this.pending.delete(id);
                            clearTimeout(wait.timer);
                            wait.resolve(result);
                            return;
                        }
                    } catch (e: any) {
                        this.pending.delete(id);
                        clearTimeout(wait.timer);
                        wait.reject(e instanceof Error ? e : new Error(String(e)));
                        return;
                    }
                    // 没挂着长连接流、POST 里也没带结果时不用干等超时
                    if (!this.streamReader) {
                        this.pending.delete(id);
                        clearTimeout(wait.timer);
                        wait.reject(new Error("没有收到 " + method + " 的结果"));
                    }
                })
                .catch((e: any) => {
                    const wait = this.pending.get(id);
                    if (!wait) return;
                    this.pending.delete(id);
                    clearTimeout(wait.timer);
                    wait.reject(e instanceof Error ? e : new Error(String(e)));
                });
        });
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
        this.rejectAllPending("SSE 连接已关闭");
        await this.stopStream();
    }
}

/** 取 endpoint 那一行之后的残余数据，避免重复解析或吞掉紧挨着的第一条推送 */
function sliceAfterEndpoint(raw: string): string {
    const lines = raw.split("\n");
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim() === "event: endpoint") {
            for (let j = i + 1; j < lines.length; j++) {
                if (lines[j].trim().startsWith("data:")) {
                    return lines.slice(j + 1).join("\n");
                }
            }
        }
    }
    for (let i = 0; i < lines.length; i++) {
        const l = lines[i].trim();
        if (l.startsWith("data:")) {
            const v = l.slice(5).trim();
            if (v.startsWith("/") || v.startsWith("http")) return lines.slice(i + 1).join("\n");
        }
    }
    return "";
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
