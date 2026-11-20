/**
 * 真实 MCP 端到端验证。
 *
 * 启动官方测试服务器 @modelcontextprotocol/server-everything，
 * 用我们的客户端真的连上去、真的列工具、真的调工具。
 *
 * 用法：node tests/live-mcp.mjs
 */
import { spawn } from "node:child_process";
import { StdioMcpClient } from "../.test/mcp-stdio.js";
import { HttpMcpClient } from "../.test/mcp-http.js";
import { makeSpawner } from "../.test/mcp-spawn.js";

// Windows 上 npx 是 npx.cmd，适配层会补扩展名（不开 shell）
const spawner = makeSpawner({ spawn }, process.platform);

let pass = 0;
let fail = 0;

function ok(name, extra) {
    pass++;
    console.log("  OK   " + name + (extra ? " —— " + extra : ""));
}
function bad(name, why) {
    fail++;
    console.log("  FAIL " + name + " —— " + why);
}

console.log("=== 1. stdio 真实连接（官方 everything 服务器）===");
let stdioClient = null;
try {
    stdioClient = new StdioMcpClient({
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-everything", "stdio"],
        spawn: spawner,
        timeoutMs: 60000,
    });
    const info = await stdioClient.connect();
    console.log(`  服务器：${info.serverName} v${info.serverVersion}`);
    console.log(`  协议版本：${info.protocolVersion}`);
    console.log(`  工具数量：${stdioClient.tools.length}`);

    if (info.protocolVersion) ok("握手成功，拿到协议版本");
    else bad("握手", "没拿到协议版本");

    if (stdioClient.tools.length > 0) {
        ok("拿到工具清单", "例如 " + stdioClient.tools.slice(0, 3).map((t) => t.name).join("、"));
    } else {
        bad("工具清单", "空的");
    }

    // 找一个能安全调用的工具：echo
    const echo = stdioClient.tools.find((t) => /echo/i.test(t.name));
    if (echo) {
        const out = await stdioClient.callTool(echo.name, { message: "你好 MCP" });
        if (out.includes("你好 MCP")) ok("调用 echo 工具成功", JSON.stringify(out.slice(0, 60)));
        else bad("调用 echo", "没回显预期内容：" + out.slice(0, 100));
    } else {
        bad("找 echo 工具", "工具清单里没有 echo：" + stdioClient.tools.map((t) => t.name).join(","));
    }

    // add 工具测数字运算
    const add = stdioClient.tools.find((t) => /^add$/i.test(t.name));
    if (add) {
        const out = await stdioClient.callTool(add.name, { a: 7, b: 35 });
        if (out.includes("42")) ok("调用 add 工具算出 42");
        else bad("调用 add", "结果不对：" + out.slice(0, 100));
    }
} catch (e) {
    bad("stdio 连接", e.message);
} finally {
    try {
        await stdioClient?.close();
    } catch {}
}

console.log("");
console.log("=== 2. Streamable HTTP 真实连接 ===");
let httpServer = null;
let httpClient = null;
try {
    // 端口可能被上一轮测试占着，让服务器自己挑
    const port = 3100 + Math.floor(Math.random() * 400);
    httpServer = spawner(
        "npx",
        ["-y", "@modelcontextprotocol/server-everything", "streamableHttp"],
        {
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env, PORT: String(port) },
        }
    );

    // 等它打印监听信息
    await new Promise((resolve, reject) => {
        let buf = "";
        const timer = setTimeout(() => reject(new Error("服务器 60 秒内没启动：" + buf.slice(-300))), 60000);
        const onData = (d) => {
            buf += d.toString();
            if (/listen|running|http.*server|started/i.test(buf)) {
                clearTimeout(timer);
                resolve();
            }
        };
        httpServer.stdout.on("data", onData);
        httpServer.stderr.on("data", onData);
    });

    const url = `http://127.0.0.1:${port}/mcp`;
    console.log(`  连接地址：${url}`);

    // 用 Node 原生 fetch 当 fetcher
    const fetcher = async (u, init) => {
        const r = await fetch(u, {
            method: init.method,
            headers: init.headers,
            body: init.body,
            signal: init.signal,
        });
        return {
            ok: r.ok,
            status: r.status,
            headers: r.headers,
            text: () => r.text(),
        };
    };

    httpClient = new HttpMcpClient({ url, fetcher, timeoutMs: 30000 });
    const info = await httpClient.connect();
    console.log(`  服务器：${info.serverName}`);

    if (httpClient.tools.length > 0) ok("HTTP 握手并拿到工具", httpClient.tools.length + " 个");
    else bad("HTTP 工具清单", "空的");

    const echo = httpClient.tools.find((t) => /echo/i.test(t.name));
    if (echo) {
        const out = await httpClient.callTool(echo.name, { message: "HTTP 也通了" });
        if (out.includes("HTTP 也通了")) ok("HTTP 调用工具成功");
        else bad("HTTP 调用", out.slice(0, 100));
    }
} catch (e) {
    bad("HTTP 连接", e.message);
} finally {
    try {
        await httpClient?.close();
    } catch {}
    try {
        httpServer?.kill();
    } catch {}
}

console.log("");
console.log(`结果：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
