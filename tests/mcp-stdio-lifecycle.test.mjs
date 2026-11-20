/**
 * stdio 客户端的进程生命周期。
 *
 * 这里防的是真机上会遇到的一种时序：
 *   旧进程死了 → 我们立刻重启了一个新进程 → 旧进程的 exit 回调这时才到。
 * 如果那个回调不加判断就去清 child，新进程就会被「判死」，
 * 表现成刚重启就报「进程已断开」，怎么点都连不上。
 */
import { EventEmitter } from "node:events";
import { StdioMcpClient } from "../.test/mcp-stdio.js";

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

/** 造一个假子进程，能手动触发 data / exit；顺便记下 client 写进来的请求 id */
function fakeChild() {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.sent = [];
    child.stdin = {
        destroyed: false,
        write(text) {
            try {
                child.sent.push(JSON.parse(String(text).trim()));
            } catch {}
        },
        end() {},
    };
    child.killed = false;
    child.kill = () => {
        child.killed = true;
    };
    return child;
}

/** 按 client 实际发来的 id 回一条结果，避免测试里写死 id */
function replyTo(child, method, result) {
    const req = [...child.sent].reverse().find((m) => m.method === method && m.id !== undefined);
    if (!req) throw new Error("找不到请求：" + method);
    child.stdout.emit("data", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }) + "\n"));
}

/** 让出事件循环，等 client 发出下一个请求 */
function tick() {
    return new Promise((r) => setTimeout(r, 0));
}

/**
 * 完整走一次握手。
 * 必须等 initialize 回完、tools/list 才发得出去，所以要分两步。
 */
async function handshake(child, serverName) {
    replyTo(child, "initialize", { serverInfo: { name: serverName } });
    await tick();
    replyTo(child, "tools/list", { tools: [] });
}

console.log("旧进程的 exit 晚到，不能把新进程判死：");
{
    const children = [];
    const spawn = () => {
        const c = fakeChild();
        children.push(c);
        return c;
    };
    const client = new StdioMcpClient({ command: "x", spawn, timeoutMs: 200 });

    // 第一次：连上（进程 1）
    const p1 = client.connect().catch((e) => e.message);
    const c1 = children[0];
    await tick();
    await handshake(c1, "s");
    await p1;

    // 进程 1 退出
    c1.emit("exit", 1);

    // 立刻重启（进程 2）
    const p2 = client.connect().catch((e) => e.message);
    check("重启会起新进程", children.length, 2);
    const c2 = children[1];
    await tick();

    // 关键：此时旧进程的 exit 又迟到一次
    c1.emit("exit", 1);

    // 新进程必须还活着，能正常完成握手
    await handshake(c2, "s2");
    const r2 = await p2;
    check("新进程握手成功，没被旧进程的 exit 干扰", r2.serverName, "s2");
}

console.log("close 之后旧进程的 exit 不该报错：");
{
    const children = [];
    const spawn = () => {
        const c = fakeChild();
        children.push(c);
        return c;
    };
    const client = new StdioMcpClient({ command: "x", spawn, timeoutMs: 200 });
    const p = client.connect().catch((e) => e.message);
    const c1 = children[0];
    await tick();
    await handshake(c1, "s");
    await p;
    await client.close();
    check("close 会 kill 进程", c1.killed, true);
    // 再触发一次 exit，不该抛
    let threw = false;
    try {
        c1.emit("exit", 0);
    } catch {
        threw = true;
    }
    check("close 后的 exit 不抛错", threw, false);
}

console.log("请求超时能解除等待：");
{
    const children = [];
    const client = new StdioMcpClient({
        command: "x",
        spawn: () => {
            const c = fakeChild();
            children.push(c);
            return c;
        },
        timeoutMs: 60,
    });
    const err = await client.connect().catch((e) => e.message);
    check("没回应会报超时", /没有在 .* 毫秒内回应/.test(err), true);
}

console.log("");
console.log(`结果：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
