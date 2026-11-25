/**
 * stdio 传输的 MCP 客户端（本地命令行服务器，仅桌面端）。
 *
 * 协议：JSON-RPC 消息按行分隔，写进子进程 stdin，从 stdout 按行读回。
 * stderr 只当日志，不参与协议。
 *
 * spawn 可注入，测试时用假的；真实使用时由插件从 Electron 取 child_process。
 */
import { makeRequest, makeNotification, parseMessage, extractText } from "./mcp-jsonrpc";
import type { McpTool, ConnectInfo } from "./mcp-http";

export interface StdioMcpClientOptions {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    spawn: (cmd: string, args: string[], opts: any) => any;
    timeoutMs?: number;
}

/** 按行切分流式输入，兼容 \r\n 和最后没换行的情况 */
export function splitLines() {
    let buf = "";
    return {
        push(chunk: string): string[] {
            buf += chunk;
            const out: string[] = [];
            let i = buf.indexOf("\n");
            while (i !== -1) {
                const line = buf.slice(0, i).replace(/\r$/, "").trim();
                buf = buf.slice(i + 1);
                if (line) out.push(line);
                i = buf.indexOf("\n");
            }
            return out;
        },
        flush(): string[] {
            const line = buf.replace(/\r$/, "").trim();
            buf = "";
            return line ? [line] : [];
        },
    };
}

export class StdioMcpClient {
    private nextId = 1;
    private child: any = null;
    private lines = splitLines();
    private waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
    private stderrLog = "";
    tools: McpTool[] = [];

    constructor(private opts: StdioMcpClientOptions) {}

    private start() {
        if (this.child) return;
        const baseEnv = (globalThis as any).process?.env;
        const hasCustom = Boolean(this.opts.env && Object.keys(this.opts.env).length > 0);
        // 拿不到进程 env 且用户也没配额外变量时，不传 env 让 spawn 继承父环境，避免传成 {} 抹掉 PATH
        const env = baseEnv
            ? hasCustom
                ? { ...baseEnv, ...this.opts.env }
                : baseEnv
            : hasCustom
            ? this.opts.env
            : undefined;
        // 起不来就让错误直接冒出去，别吞掉
        const child = this.opts.spawn(this.opts.command, this.opts.args || [], {
            env,
            cwd: this.opts.cwd,
            stdio: ["pipe", "pipe", "pipe"],
        });
        this.child = child;

        // 每个回调都要先确认「我还是当前那个进程」。
        // 旧进程退出的通知可能比新进程启动更晚到，那种时候不能去动新进程的状态。
        const isCurrent = () => this.child === child;

        // 子进程自己会发 'error'，不接住的话整个 Node 进程会崩
        child.on?.("error", (err: any) => {
            const msg = String(err?.message || err);
            for (const [, w] of this.waiting) w.reject(new Error(msg));
            this.waiting.clear();
            // 置空才能重连：否则 start() 会一直以为进程还活着
            if (isCurrent()) this.child = null;
        });

        child.stdout.on("data", (chunk: any) => {
            if (!isCurrent()) return;
            for (const line of this.lines.push(chunk.toString())) this.handleLine(line);
        });

        child.stderr?.on("data", (chunk: any) => {
            if (!isCurrent()) return;
            this.stderrLog = (this.stderrLog + chunk.toString()).slice(-2000);
        });

        child.on?.("exit", (code: number) => {
            if (!isCurrent()) return;
            const msg = `本地 MCP 进程退出了（code ${code}）` + (this.stderrLog ? "：" + this.stderrLog.slice(-300) : "");
            for (const [, w] of this.waiting) w.reject(new Error(msg));
            this.waiting.clear();
            // 同样要置空，下次调用会自动重启进程
            this.child = null;
            this.lines = splitLines();
        });
    }

    private handleLine(line: string) {
        const parsed = parseMessage(line);
        // 不是合法 JSON-RPC 的行（比如服务器打的日志）直接忽略
        if (!parsed) return;
        if (parsed.kind === "notification") return;

        const w = this.waiting.get(parsed.id);
        if (!w) return;
        this.waiting.delete(parsed.id);

        if (parsed.kind === "error") w.reject(new Error(parsed.errorText));
        else w.resolve(parsed.result);
    }

    private send(payload: object) {
        this.start();
        const stdin = this.child?.stdin;
        // 进程刚好在这一瞬间退出时 stdin 可能已经关了，write 会抛 EPIPE。
        // 这里抛出去比静默丢弃好：request() 会接住并把错误报给用户。
        if (!stdin || stdin.destroyed) {
            throw new Error("本地 MCP 进程已断开，请重新连接");
        }
        stdin.write(JSON.stringify(payload) + "\n");
    }

    private request(method: string, params?: Record<string, unknown>): Promise<any> {
        const id = this.nextId++;
        const timeoutMs = this.opts.timeoutMs ?? 30000;

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.waiting.delete(id);
                reject(new Error(`本地 MCP 没有在 ${timeoutMs} 毫秒内回应：${method}`));
            }, timeoutMs);

            this.waiting.set(id, {
                resolve: (v) => {
                    clearTimeout(timer);
                    resolve(v);
                },
                reject: (e) => {
                    clearTimeout(timer);
                    reject(e);
                },
            });

            try {
                this.send(makeRequest(id, method, params));
            } catch (e: any) {
                clearTimeout(timer);
                this.waiting.delete(id);
                reject(e);
            }
        });
    }

    async connect(): Promise<ConnectInfo> {
        // 先把进程起起来，起不来就在这里失败，比等到超时好
        this.start();

        const result = await this.request("initialize", {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "siyuan-ai-chat", version: "0.1.0" },
        });

        try {
            this.send(makeNotification("notifications/initialized"));
        } catch {
            // 通知失败不影响
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
        // 先摘掉引用：这一轮 exit 回调里 isCurrent() 会失败，不会再去清别人的状态
        const child = this.child;
        this.child = null;
        try {
            child?.stdin?.end?.();
        } catch {}
        try {
            child?.kill?.();
        } catch {}
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
            inputSchema:
                t.inputSchema && typeof t.inputSchema === "object"
                    ? t.inputSchema
                    : { type: "object", properties: {} },
        });
    }
    return out;
}
