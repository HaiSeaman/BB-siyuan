/**
 * stdio 传输：本地起个进程，用行分隔的 JSON 通信。
 * 用假的 spawn 来验证，不真的起进程。
 */
import { StdioMcpClient, splitLines } from "../.test/mcp-stdio.js";

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

console.log("按行切分（流式输入）：");
{
    const s = splitLines();
    check("半条不出结果", s.push('{"a":1'), []);
    check("补齐后出一条", s.push("}\n"), ['{"a":1}']);
}
{
    const s = splitLines();
    check("一次两条", s.push('{"a":1}\n{"b":2}\n'), ['{"a":1}', '{"b":2}']);
}
{
    const s = splitLines();
    check("Windows 换行也能处理", s.push('{"a":1}\r\n'), ['{"a":1}']);
}
{
    const s = splitLines();
    s.push('{"a":1}');
    check("结束时把残留吐出来", s.flush(), ['{"a":1}']);
}
{
    const s = splitLines();
    check("空行被忽略", s.push("\n\n"), []);
}

/** 假的子进程：收到输入就按预设回话 */
function fakeChild(responder) {
    const listeners = { stdout: [], stderr: [], exit: [] };
    const written = [];
    return {
        written,
        child: {
            stdin: {
                write(chunk) {
                    written.push(chunk);
                    const line = chunk.toString().replace(/\n$/, "");
                    let req = null;
                    try {
                        req = JSON.parse(line);
                    } catch {
                        return;
                    }
                    const out = responder(req);
                    if (out) {
                        setTimeout(() => listeners.stdout.forEach((cb) => cb(Buffer.from(JSON.stringify(out) + "\n"))), 0);
                    }
                },
                end() {},
            },
            stdout: { on: (ev, cb) => listeners.stdout.push(cb) },
            stderr: { on: (ev, cb) => listeners.stderr.push(cb) },
            on: (ev, cb) => {
                if (listeners[ev]) listeners[ev].push(cb);
            },
            kill() {},
        },
    };
}

console.log("stdio 握手：");
{
    const { child, written } = fakeChild((req) => {
        if (req.method === "initialize") {
            return {
                jsonrpc: "2.0",
                id: req.id,
                result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "local-time", version: "1" } },
            };
        }
        if (req.method === "tools/list") {
            return { jsonrpc: "2.0", id: req.id, result: { tools: [{ name: "now", description: "当前时间" }] } };
        }
        return null;
    });

    const client = new StdioMcpClient({ command: "npx", args: ["-y", "server"], spawn: () => child });
    const info = await client.connect();

    check("拿到服务器名", info.serverName, "local-time");
    check("拿到工具", client.tools.length, 1);
    check("工具名", client.tools[0].name, "now");
    check("握手的确写进去了", written.length >= 2, true);
    check("第一次写的是 initialize", JSON.parse(written[0]).method, "initialize");
}

console.log("stdio 请求带 id：");
{
    let seenId = null;
    const { child } = fakeChild((req) => {
        if (req.method === "initialize") {
            seenId = req.id;
            return { jsonrpc: "2.0", id: req.id, result: { protocolVersion: "x", capabilities: {}, serverInfo: { name: "n", version: "1" } } };
        }
        if (req.method === "tools/list") return { jsonrpc: "2.0", id: req.id, result: { tools: [] } };
        return null;
    });
    const client = new StdioMcpClient({ command: "x", args: [], spawn: () => child });
    await client.connect();
    check("id 从 1 开始", seenId, 1);
}

console.log("stdio 工具调用：");
{
    const { child } = fakeChild((req) => {
        if (req.method === "initialize") return { jsonrpc: "2.0", id: req.id, result: { protocolVersion: "x", capabilities: {}, serverInfo: { name: "n", version: "1" } } };
        if (req.method === "tools/list") return { jsonrpc: "2.0", id: req.id, result: { tools: [] } };
        if (req.method === "tools/call") return { jsonrpc: "2.0", id: req.id, result: { content: [{ type: "text", text: "21:30" }] } };
        return null;
    });
    const client = new StdioMcpClient({ command: "x", args: [], spawn: () => child });
    await client.connect();
    const out = await client.callTool("now", {});
    check("拿到结果", out, "21:30");
}

console.log("stdio 服务端报错：");
{
    const { child } = fakeChild((req) => {
        if (req.method === "initialize") return { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: "没这个方法" } };
        return null;
    });
    const client = new StdioMcpClient({ command: "x", args: [], spawn: () => child });
    let err = "";
    try {
        await client.connect();
    } catch (e) {
        err = e.message;
    }
    check("错误冒出来", err.includes("没这个方法"), true);
}

console.log("stdio 起不来：");
{
  const client = new StdioMcpClient({
    command: "不存在的命令",
    args: [],
    spawn: () => {
      throw new Error("找不到该命令");
    },
  });
  let err = "";
  try {
    await client.connect();
  } catch (e) {
    err = e.message;
  }
  check("说清命令起不来", err.includes("找不到该命令"), true);
}

console.log("stdio 忽略坏行：");
{
    const listeners = { stdout: [], stderr: [], exit: [] };
    let n = 0;
    const child = {
        stdin: {
            write(chunk) {
                const req = JSON.parse(chunk.toString());
                n++;
                setTimeout(() => {
                    // 先吐一行坏数据，再吐真结果
                    listeners.stdout.forEach((cb) => cb(Buffer.from("这不是json\n")));
                    listeners.stdout.forEach((cb) =>
                        cb(
                            Buffer.from(
                                JSON.stringify({
                                    jsonrpc: "2.0",
                                    id: req.id,
                                    result:
                                        req.method === "initialize"
                                            ? { protocolVersion: "x", capabilities: {}, serverInfo: { name: "n", version: "1" } }
                                            : { tools: [] },
                                }) + "\n"
                            )
                        )
                    );
                }, 0);
            },
            end() {},
        },
        stdout: { on: (ev, cb) => listeners.stdout.push(cb) },
        stderr: { on: (ev, cb) => listeners.stderr.push(cb) },
        on: (ev, cb) => {
            if (listeners[ev]) listeners[ev].push(cb);
        },
        kill() {},
    };
    const client = new StdioMcpClient({ command: "x", args: [], spawn: () => child });
    let err = "";
    try {
        await client.connect();
    } catch (e) {
        err = e.message;
    }
    check("坏行不影响正常结果", err, "");
}

console.log("");
console.log(`结果：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
