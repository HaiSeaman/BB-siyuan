/**
 * 旧版 SSE 传输：先 GET 拿到一个 SSE 端点，再往那个端点 POST 消息。
 */
import { SseMcpClient } from "../.test/mcp-sse.js";

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

/** 假服务端：GET /sse 返回一个事件，告诉客户端消息该发到哪个端点 */
function sseServer(messages) {
    const calls = [];
    const pending = [...messages];

    const fetcher = async (url, init) => {
        const method = init?.method || "GET";
        calls.push({ url, method, body: init?.body ? JSON.parse(init.body) : null, headers: init.headers });

        if (method === "GET") {
            return {
                ok: true,
                status: 200,
                headers: new Map([["content-type", "text/event-stream"]]),
                text: async () => "event: endpoint\ndata: /messages?sessionId=abc\n\n",
            };
        }

        // POST 到 messages 端点：返回 202，真正的结果从 SSE 流里来
        const req = init?.body ? JSON.parse(init.body) : null;
        const hit = pending.find((m) => m.id === req?.id || m.method === req?.method);
        return {
            ok: true,
            status: 202,
            headers: new Map([["content-type", "text/plain"]]),
            text: async () => (hit ? JSON.stringify(hit) : ""),
        };
    };

    return { fetcher, calls };
}

console.log("SSE 握手：");
{
    const { fetcher, calls } = sseServer([
        {
            jsonrpc: "2.0",
            id: 1,
            result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "old-sse", version: "1" } },
        },
        { jsonrpc: "2.0", id: 2, result: { tools: [{ name: "get_time", description: "时间" }] } },
    ]);

    const client = new SseMcpClient({ url: "http://x/sse", fetcher });
    const info = await client.connect();

    check("握手拿到服务器名", info.serverName, "old-sse");
    check("工具列表拿到", client.tools.length, 1);
    check("先发的是 GET 建流", calls[0].method, "GET");
    check("GET 的 Accept 是 event-stream", calls[0].headers.Accept.includes("text/event-stream"), true);
    check("从事件里拿到消息端点", client.messageUrl.includes("/messages"), true);
}

console.log("SSE 工具调用：");
{
    const { fetcher, calls } = sseServer([
        { jsonrpc: "2.0", id: 1, result: { protocolVersion: "x", capabilities: {}, serverInfo: { name: "s", version: "1" } } },
        { jsonrpc: "2.0", id: 2, result: { tools: [] } },
        { jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: "结果文本" }] } },
    ]);
    const client = new SseMcpClient({ url: "http://x/sse", fetcher });
    await client.connect();
    const out = await client.callTool("foo", { a: 1 });
    check("拿到工具结果", out, "结果文本");
    const post = calls.filter((c) => c.method === "POST").pop();
    check("工具名传对", post.body.params.name, "foo");
}

console.log("GET 失败：");
{
    const fetcher = async () => ({
        ok: false,
        status: 404,
        headers: new Map([["content-type", "text/plain"]]),
        text: async () => "not found",
    });
    const client = new SseMcpClient({ url: "http://x/sse", fetcher });
    let err = "";
    try {
        await client.connect();
    } catch (e) {
        err = e.message;
    }
    check("404 报出来", err.includes("404"), true);
}

console.log("没拿到 endpoint 事件：");
{
    const fetcher = async (url, init) => {
        if ((init?.method || "GET") === "GET") {
            return {
                ok: true,
                status: 200,
                headers: new Map([["content-type", "text/event-stream"]]),
                text: async () => "event: message\ndata: {}\n\n",
            };
        }
        return { ok: true, status: 202, headers: new Map(), text: async () => "" };
    };
    const client = new SseMcpClient({ url: "http://x/sse", fetcher });
    let err = "";
    try {
        await client.connect();
    } catch (e) {
        err = e.message;
    }
    check("说清楚没找到端点", err.includes("端点") || err.includes("endpoint"), true);
}

console.log("");
console.log(`结果：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
