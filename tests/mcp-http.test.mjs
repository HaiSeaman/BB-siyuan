/**
 * Streamable HTTP 传输：握手、会话头、SSE 与 JSON 两种响应。
 * 用可注入的假 fetcher 验证协议行为，不碰真实网络。
 */
import { HttpMcpClient } from "../.test/mcp-http.js";

let pass = 0;
let fail = 0;

function check(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) {
        pass++;
        console.log("  OK   " + name);
    } else {
        fail++;
        console.log("  FAIL " + name);
        console.log("       实际: " + JSON.stringify(actual));
        console.log("       期望: " + JSON.stringify(expected));
    }
}

/** 造一个假的服务端：按顺序吐出预设响应 */
function fakeServer(handlers) {
    const calls = [];
    const fetcher = async (url, init) => {
        const body = init?.body ? JSON.parse(init.body) : null;
        calls.push({ url, init, body });
        const h = handlers[body?.method] || handlers["*"];
        if (!h) throw new Error("没有为 " + body?.method + " 准备响应");
        return h(body, init);
    };
    return { fetcher, calls };
}

function jsonResp(obj, headers = {}) {
    return {
        ok: true,
        status: 200,
        headers: new Map(Object.entries({ "content-type": "application/json", ...headers })),
        text: async () => JSON.stringify(obj),
    };
}

function sseResp(events) {
    const text = events
        .map((e) => `event: message\ndata: ${JSON.stringify(e)}\n\n`)
        .join("");
    return {
        ok: true,
        status: 200,
        headers: new Map([["content-type", "text/event-stream"]]),
        text: async () => text,
    };
}

console.log("握手（JSON 响应）：");
{
    const { fetcher, calls } = fakeServer({
        initialize: () =>
            jsonResp(
                {
                    jsonrpc: "2.0",
                    id: 1,
                    result: {
                        protocolVersion: "2025-06-18",
                        capabilities: { tools: {} },
                        serverInfo: { name: "time", version: "1.0" },
                    },
                },
                { "mcp-session-id": "sess-123" }
            ),
        "tools/list": () =>
            jsonResp({
                jsonrpc: "2.0",
                id: 2,
                result: {
                    tools: [
                        { name: "get_time", description: "拿当前时间", inputSchema: { type: "object" } },
                        { name: "convert", description: "换算", inputSchema: { type: "object" } },
                    ],
                },
            }),
    });

    const client = new HttpMcpClient({ url: "http://x/mcp", fetcher });
    const info = await client.connect();

    check("握手成功", info.serverName, "time");
    check("协议版本记下来", info.protocolVersion, "2025-06-18");
    check("会话 id 被记住", client.sessionId, "sess-123");
    check("工具数量", client.tools.length, 2);
    check("工具名", client.tools[0].name, "get_time");

    check("发了三次请求（握手 + 通知 + 列工具）", calls.length, 3);
    check(
        "Accept 同时包含 json 和 event-stream",
        calls[0].init.headers.Accept.includes("application/json") && calls[0].init.headers.Accept.includes("text/event-stream"),
        true
    );
    check("初始化后发了 initialized 通知", calls.some((c) => c.body?.method === "notifications/initialized"), true);
    check(
        "第二次请求带上了会话头",
        calls[1].init.headers["Mcp-Session-Id"],
        "sess-123"
    );
}

console.log("握手（SSE 响应）：");
{
    const { fetcher } = fakeServer({
        initialize: () =>
            sseResp([
                {
                    jsonrpc: "2.0",
                    method: "notifications/progress",
                    params: { progress: 1 },
                },
                {
                    jsonrpc: "2.0",
                    id: 1,
                    result: {
                        protocolVersion: "2025-06-18",
                        capabilities: {},
                        serverInfo: { name: "sse-server", version: "1" },
                    },
                },
            ]),
        "tools/list": () => sseResp([{ jsonrpc: "2.0", id: 2, result: { tools: [] } }]),
    });
    const client = new HttpMcpClient({ url: "http://x/mcp", fetcher });
    const info = await client.connect();
    check("能从 SSE 里挑出结果", info.serverName, "sse-server");
    check("通知不会被打成结果", client.tools.length, 0);
}

console.log("没有会话 id 也能用：");
{
    const { fetcher, calls } = fakeServer({
        initialize: () =>
            jsonResp({
                jsonrpc: "2.0",
                id: 1,
                result: { protocolVersion: "x", capabilities: {}, serverInfo: { name: "n", version: "1" } },
            }),
        "tools/list": () => jsonResp({ jsonrpc: "2.0", id: 2, result: { tools: [] } }),
    });
    const client = new HttpMcpClient({ url: "http://x/mcp", fetcher });
    await client.connect();
    check("没有会话头时不硬加", "Mcp-Session-Id" in calls[1].init.headers, false);
}

console.log("工具调用：");
{
    const { fetcher, calls } = fakeServer({
        initialize: () =>
            jsonResp({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "x", capabilities: {}, serverInfo: { name: "n", version: "1" } } }),
        "tools/list": () => jsonResp({ jsonrpc: "2.0", id: 2, result: { tools: [] } }),
        "tools/call": () =>
            jsonResp({
                jsonrpc: "2.0",
                id: 3,
                result: { content: [{ type: "text", text: "现在 21:30" }] },
            }),
    });
    const client = new HttpMcpClient({ url: "http://x/mcp", fetcher });
    await client.connect();
    const out = await client.callTool("get_time", { tz: "Asia/Shanghai" });

    check("调用拿到文本", out, "现在 21:30");
    const call = calls.find((c) => c.body?.method === "tools/call");
    check("工具名传对", call.body.params.name, "get_time");
    check("参数传对", call.body.params.arguments.tz, "Asia/Shanghai");
}

console.log("工具参数为空：");
{
    const { fetcher, calls } = fakeServer({
        initialize: () =>
            jsonResp({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "x", capabilities: {}, serverInfo: { name: "n", version: "1" } } }),
        "tools/list": () => jsonResp({ jsonrpc: "2.0", id: 2, result: { tools: [] } }),
        "tools/call": () => jsonResp({ jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: "ok" }] } }),
    });
    const client = new HttpMcpClient({ url: "http://x/mcp", fetcher });
    await client.connect();
    await client.callTool("ping", {});
    const call = calls.find((c) => c.body?.method === "tools/call");
    check("空参数传空对象", call.body.params.arguments, {});
}

console.log("服务端报错：");
{
    const { fetcher } = fakeServer({
        initialize: () =>
            jsonResp({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "不支持 initialize" } }),
    });
    const client = new HttpMcpClient({ url: "http://x/mcp", fetcher });
    let err = "";
    try {
        await client.connect();
    } catch (e) {
        err = e.message;
    }
    check("错误被抛出", err.includes("不支持 initialize"), true);
}

console.log("HTTP 状态错误：");
{
    const fetcher = async () => ({
        ok: false,
        status: 401,
        headers: new Map([["content-type", "application/json"]]),
        text: async () => '{"error":"密钥不对"}',
    });
    const client = new HttpMcpClient({ url: "http://x/mcp", fetcher });
    let err = "";
    try {
        await client.connect();
    } catch (e) {
        err = e.message;
    }
    check("401 说清楚状态码", err.includes("401"), true);
}

console.log("超时：");
{
    const fetcher = () => new Promise((resolve) => setTimeout(() => resolve(jsonResp({})), 10000));
    const client = new HttpMcpClient({ url: "http://x/mcp", fetcher, timeoutMs: 120 });
    let err = "";
    try {
        await client.connect();
    } catch (e) {
        err = e.message;
    }
    check("超时会报错", err.includes("超时") || err.includes("timeout"), true);
}

console.log("");
console.log(`结果：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
