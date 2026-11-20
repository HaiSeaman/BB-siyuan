/**
 * MCP 连接管理：把配置变成活着的客户端，供面板使用。
 *
 * 设计：连接懒加载 —— 第一次真正需要工具时才连，避免启动时卡住。
 * 单个服务器失败不影响其他的。
 */
import { HttpMcpClient } from "./mcp-http";
import { SseMcpClient } from "./mcp-sse";
import { StdioMcpClient } from "./mcp-stdio";
import type { Fetcher } from "./mcp-http";
import { buildToolSpecs, type McpServer, type ToolSpec, type ToolBinding } from "./mcp-manager";
import { splitToolName } from "./mcp-jsonrpc";

export interface ServerState {
    id: string;
    name: string;
    /** idle 未连 / connecting / ready / error */
    status: "idle" | "connecting" | "ready" | "error";
    error: string;
    tools: { name: string; description: string }[];
}

type Client = HttpMcpClient | SseMcpClient | StdioMcpClient;

export class McpManager {
    private clients = new Map<string, Client>();
    private states = new Map<string, ServerState>();
    /** 发给模型的名字 → 原始工具名，调用时必须查它 */
    private bindings: ToolBinding[] = [];

    constructor(
        private servers: McpServer[],
        private fetcher: Fetcher,
        private spawnProcess: ((cmd: string, args: string[], opts: any) => any) | null
    ) {}

    /** 当前各服务器的状态，供界面显示 */
    snapshot(): ServerState[] {
        return this.servers.map(
            (s) =>
                this.states.get(s.id) || {
                    id: s.id,
                    name: s.name,
                    status: "idle",
                    error: "",
                    tools: [],
                }
        );
    }

    /** 暴露名 → 原始名的对照表，界面显示工具名时要用 */
    getBindings(): ToolBinding[] {
        if (!this.bindings.length) this.toolSpecs();
        return this.bindings;
    }

    private setState(id: string, patch: Partial<ServerState>) {
        const base =
            this.states.get(id) ||
            { id, name: this.servers.find((s) => s.id === id)?.name || id, status: "idle" as const, error: "", tools: [] };
        this.states.set(id, { ...base, ...patch });
    }

    private createClient(server: McpServer): Client {
        if (server.type === "stdio") {
            if (!this.spawnProcess) {
                throw new Error("当前环境不能启动本地进程（仅桌面版可用）");
            }
            return new StdioMcpClient({
                command: server.command,
                args: server.args,
                env: server.env,
                spawn: this.spawnProcess,
                timeoutMs: server.timeoutMs,
            });
        }
        if (server.type === "sse") {
            return new SseMcpClient({
                url: server.url,
                headers: server.headers,
                fetcher: this.fetcher,
                timeoutMs: server.timeoutMs,
            });
        }
        return new HttpMcpClient({
            url: server.url,
            headers: server.headers,
            fetcher: this.fetcher,
            timeoutMs: server.timeoutMs,
        });
    }

    /** 连上所有启用的服务器；失败的只记错误，不抛 */
    async connectAll(): Promise<ServerState[]> {
        const jobs = this.servers
            .filter((s) => s.enabled)
            .map(async (server) => {
                this.setState(server.id, { status: "connecting", error: "", tools: [] });

                // 重连前先把旧的关掉，否则 stdio 子进程会越攒越多
                const old = this.clients.get(server.id);
                if (old) {
                    try {
                        await old.close();
                    } catch {}
                    this.clients.delete(server.id);
                }

                let client: Client | null = null;
                try {
                    client = this.createClient(server);
                    await client.connect();
                    this.clients.set(server.id, client);
                    this.setState(server.id, {
                        status: "ready",
                        error: "",
                        tools: client.tools.map((t) => ({ name: t.name, description: t.description })),
                    });
                } catch (e: any) {
                    // 进程可能已经起来了，连不上也得关掉，不然就是僵尸进程
                    if (client) {
                        try {
                            await client.close();
                        } catch {}
                    }
                    this.setState(server.id, {
                        status: "error",
                        error: String(e?.message || e),
                        tools: [],
                    });
                }
            });
        await Promise.all(jobs);
        return this.snapshot();
    }

    /** 合并所有已连上服务器的工具 */
    toolSpecs(): ToolSpec[] {
        const built = this.buildAll();
        this.bindings = built.bindings;
        return built.specs;
    }

    private buildAll() {
        const groups = this.servers
            .filter((s) => this.states.get(s.id)?.status === "ready")
            .map((s) => {
                const client = this.clients.get(s.id);
                return { server: s, tools: client ? client.tools : [] };
            });
        return buildToolSpecs(groups as any);
    }

    /**
     * 执行一个工具。
     *
     * 必须靠 bindings 查原始名：模型只会照着我们发的名字原样回传，
     * 而前缀是服务器 id、工具名里的横线也被换成了下划线。
     */
    async callTool(exposedName: string, args: Record<string, unknown>): Promise<string> {
        if (!this.bindings.length) this.toolSpecs();

        const hit = this.bindings.find((b) => b.exposed === exposedName);
        if (hit) {
            const client = this.clients.get(hit.serverId);
            if (!client) throw new Error("服务器「" + hit.serverName + "」没有连上");
            return client.callTool(hit.original, args);
        }

        // 兜底：按前缀拆一次，前缀是服务器 id
        const parsed = splitToolName(exposedName);
        if (!parsed) throw new Error("不是 MCP 工具：" + exposedName);
        const server = this.servers.find((s) => s.id === parsed.server || s.name === parsed.server);
        if (!server) throw new Error("找不到服务器：" + parsed.server);
        const client = this.clients.get(server.id);
        if (!client) throw new Error("服务器「" + server.name + "」没有连上");
        return client.callTool(parsed.tool, args);
    }

    async closeAll() {
        for (const [, c] of this.clients) {
            try {
                await c.close();
            } catch {}
        }
        this.clients.clear();
        this.states.clear();
        // 对照表必须一起清：否则 callTool 会以为「已经建过表」，
        // 拿着指向已关闭服务器的一堆旧名字去查，报出一个莫名其妙的「没有连上」
        this.bindings = [];
    }
}
