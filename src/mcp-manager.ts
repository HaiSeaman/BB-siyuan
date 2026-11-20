/**
 * MCP 服务器配置的清洗、新建，以及把各服务器的工具合并成一份清单。
 *
 * 这一层不碰网络，只做数据形状，方便测试。
 */
import { toolNameFor, splitToolName } from "./mcp-jsonrpc";
import type { McpTool } from "./mcp-http";

export type McpServerType = "http" | "sse" | "stdio";

export interface McpServer {
    id: string;
    name: string;
    type: McpServerType;
    url: string;
    headers: Record<string, string>;
    command: string;
    args: string[];
    env: Record<string, string>;
    timeoutMs: number;
    enabled: boolean;
}

/** 模型的 tools 字段格式（OpenAI 那套，Anthropic 只是少个 type 字段） */
export interface ToolSpec {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: any;
    };
}

export interface ServerTools {
    server: McpServer;
    tools: McpTool[];
}

/**
 * 工具名映射表。
 *
 * 为什么需要：模型能用的工具名有字符限制，`get-sum` 里的横线、
 * 服务器名里的中文，都可能被模型或接口改写。
 * 所以对外发一个安全名字，同时记住它原本是什么。
 */
export interface ToolBinding {
    /** 给模型看的名字，如 mcp__计算__get_sum */
    exposed: string;
    /** 服务器给的原始工具名，如 get-sum */
    original: string;
    serverId: string;
    serverName: string;
}

function str(v: unknown): string {
    return typeof v === "string" ? v.trim() : "";
}

function strMap(v: unknown): Record<string, string> {
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (typeof val === "string") out[k] = val;
    }
    return out;
}

function strArray(v: unknown): string[] {
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is string => typeof x === "string" && x.length > 0);
}

/**
 * 洗净配置。任何不合规的项直接丢掉，
 * 免得后面连接时才炸，还搞不清是哪里错了。
 */
export function normalizeMcpServers(raw: unknown): McpServer[] {
    if (!Array.isArray(raw)) return [];

    const out: McpServer[] = [];
    const seen = new Set<string>();

    for (const item of raw) {
        if (!item || typeof item !== "object") continue;
        const o = item as Record<string, unknown>;

        const id = str(o.id);
        const name = str(o.name);
        if (!id || !name || seen.has(id)) continue;

        const type: McpServerType =
            o.type === "sse" || o.type === "stdio" || o.type === "http" ? o.type : "http";

        const url = str(o.url);
        const command = str(o.command);

        // 该有的地址或命令必须有，否则连不上，留着也没意义
        if (type === "http" || type === "sse") {
            if (!url) continue;
        } else {
            if (!command) continue;
        }

        const timeout = typeof o.timeoutMs === "number" && Number.isFinite(o.timeoutMs)
            ? Math.min(300000, Math.max(1000, Math.round(o.timeoutMs)))
            : 30000;

        out.push({
            id,
            name,
            type,
            url,
            headers: strMap(o.headers),
            command,
            args: strArray(o.args),
            env: strMap(o.env),
            timeoutMs: timeout,
            enabled: o.enabled !== false,
        });
        seen.add(id);
    }

    return out;
}

export function createServer(
    input: {
        name: string;
        type: McpServerType;
        url?: string;
        command?: string;
        args?: string[];
        headers?: Record<string, string>;
        env?: Record<string, string>;
    },
    idFactory: () => string
): McpServer {
    return {
        id: idFactory(),
        name: input.name.trim(),
        type: input.type,
        url: (input.url || "").trim(),
        headers: input.headers || {},
        command: (input.command || "").trim(),
        args: input.args || [],
        env: input.env || {},
        timeoutMs: 30000,
        enabled: true,
    };
}

/**
 * 把多个服务器的工具合并成模型的 tools 字段，同时给出「发给模型的名字 → 原始名字」对照表。
 *
 * 前缀用服务器的 **id** 而不是名字：
 *   - id 是我们自己生成的 ASCII 串（如 m1abcde），一定合法且唯一
 *   - 名字可能是中文（如「时间」），清洗后会变成 srv 这类无意义的串，
 *     而且「时间」和「时间2」清洗后可能撞车
 * 所以暴露名用 id，界面显示才用名字。
 */
export function buildToolSpecs(groups: ServerTools[]): { specs: ToolSpec[]; bindings: ToolBinding[] } {
    const specs: ToolSpec[] = [];
    const bindings: ToolBinding[] = [];
    const used = new Set<string>();

    for (const g of groups) {
        if (!g.server.enabled) continue;

        // 用 id 做前缀；id 万一为空才退回名字
        const prefix = g.server.id || g.server.name;

        for (const t of g.tools) {
            const name = toolNameFor(prefix, t.name);
            if (used.has(name)) continue;
            used.add(name);

            specs.push({
                type: "function",
                function: {
                    name,
                    description: t.description || t.name,
                    parameters: t.inputSchema || { type: "object", properties: {} },
                },
            });
            bindings.push({
                exposed: name,
                original: t.name,
                serverId: g.server.id,
                serverName: g.server.name,
            });
        }
    }

    return { specs, bindings };
}

/**
 * 界面上显示的「服务器 / 工具」。
 *
 * 注意：暴露给模型的名字前缀是服务器 **id**，不是名字，
 * 所以这里要按 id 查（也兼容老的按名字查）。
 */
export function toolDisplayName(
    prefixed: string,
    servers: { id: string; name: string }[],
    bindings?: ToolBinding[]
): string {
    // 最可靠：直接查对照表拿原始名和服务器名
    const hit = bindings?.find((b) => b.exposed === prefixed);
    if (hit) return hit.serverName + " / " + hit.original;

    const parsed = splitToolName(prefixed);
    if (!parsed) return prefixed;
    const s = servers.find((x) => x.id === parsed.server) || servers.find((x) => x.name === parsed.server);
    return (s ? s.name : parsed.server) + " / " + parsed.tool;
}
