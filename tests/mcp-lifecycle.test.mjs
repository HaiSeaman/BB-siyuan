/**
 * MCP 连接管理器的生命周期。
 *
 * 重点防一个「看着能用、其实拿着过期数据」的坑：
 * closeAll() 之后如果不清工具对照表，callTool 会以为表还在，
 * 拿着指向已关闭服务器的旧名字去查，报一个跟真实原因无关的错误。
 */
import { McpManager } from "../.test/mcp-connect.js";
import { normalizeMcpServers, createServer } from "../.test/mcp-manager.js";

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

/** 假 fetcher：握手返回一个工具，工具调用返回固定文本 */
function fakeFetcher(serverName) {
    return async (url, init) => {
        const body = init.body ? JSON.parse(init.body) : {};
        const method = body.method;
        let result = {};
        if (method === "initialize") {
            result = { serverInfo: { name: serverName }, protocolVersion: "2025-06-18" };
        } else if (method === "tools/list") {
            result = { tools: [{ name: "get-sum", description: "求和", inputSchema: { type: "object" } }] };
        } else if (method === "tools/call") {
            result = { content: [{ type: "text", text: "算好了" }] };
        }
        return {
            ok: true,
            status: 200,
            headers: new Map([["content-type", "application/json"]]),
            text: async () => JSON.stringify({ jsonrpc: "2.0", id: body.id, result }),
        };
    };
}

const servers = normalizeMcpServers([
    { id: "s1", name: "计算", type: "http", url: "http://x/mcp", enabled: true },
]);

console.log("连上之后能用工具：");
{
    const mcp = new McpManager(servers, fakeFetcher("calc"), null);
    const states = await mcp.connectAll();
    check("状态是 ready", states[0].status, "ready");

    const specs = mcp.toolSpecs();
    check("有一个工具", specs.length, 1);
    const exposed = specs[0].function.name;

    const out = await mcp.callTool(exposed, { a: 1, b: 2 });
    check("能调出结果", out, "算好了");
}

console.log("closeAll 之后不能拿着旧对照表干活：");
{
    const mcp = new McpManager(servers, fakeFetcher("calc"), null);
    await mcp.connectAll();
    const exposed = mcp.toolSpecs()[0].function.name;

    await mcp.closeAll();

    // 关掉之后回调，必须报「没有连上」，而不是成功
    let err = "";
    try {
        await mcp.callTool(exposed, {});
    } catch (e) {
        err = String(e?.message || e);
    }
    check("关掉之后调用会失败", err.length > 0, true);
    check("错误说清是没连上", /没有连上|找不到服务器/.test(err), true);
}

console.log("重新连上后能继续用：");
{
    const mcp = new McpManager(servers, fakeFetcher("calc"), null);
    await mcp.connectAll();
    await mcp.closeAll();
    await mcp.connectAll();
    const exposed = mcp.toolSpecs()[0].function.name;
    const out = await mcp.callTool(exposed, {});
    check("重连后正常", out, "算好了");
}

console.log("连接失败只标错误，不抛：");
{
    const bad = async () => {
        throw new Error("连不上");
    };
    const mcp = new McpManager(servers, bad, null);
    const states = await mcp.connectAll();
    check("状态是 error", states[0].status, "error");
    check("带上了原因", states[0].error, "连不上");
    check("没有工具", mcp.toolSpecs().length, 0);
}

console.log("stdio 在没有 spawn 能力时不该崩：");
{
    const list = normalizeMcpServers([
        createServer({ name: "本地", type: "stdio", command: "npx", args: ["-y", "x"] }, () => "local1"),
    ]);
    const mcp = new McpManager(list, fakeFetcher("x"), null);
    const states = await mcp.connectAll();
    check("状态是 error", states[0].status, "error");
    check("提示仅桌面版可用", /仅桌面版可用/.test(states[0].error), true);
}

console.log("");
console.log(`结果：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
