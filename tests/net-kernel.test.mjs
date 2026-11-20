/**
 * 手机端的「内核转发」通道。
 *
 * 手机上没有 require（没有主进程通道），只能让思源内核替我们发请求：
 * 调 /api/network/forwardProxy，把状态码和整段响应体拿回来。
 * 这里用假的 window / fetch 验证三件事：
 *   1. 手机环境下能正确选中「内核转发」通道
 *   2. 请求体的格式符合内核接口要求（headers 是对象数组）
 *   3. 出错时能把内核的报错翻出来，流不会悬挂
 */
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

/** 攒下所有对 fetch 的调用，方便断言 */
let calls = [];
/** 下一次 fetch 要返回什么 */
let reply = { status: 200, body: "" };

globalThis.window = {
    location: { origin: "http://127.0.0.1:6806" },
    siyuan: { config: { system: { dataDir: "D:/x" } } },
};

globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return {
        ok: reply.status >= 200 && reply.status < 300,
        status: reply.status,
        text: async () => reply.body,
        headers: { forEach() {} },
    };
};

const { streamChat, fetchOnce, currentChannel } = await import("../.test/net.js");

function reset() {
    calls = [];
}

/** 跑一次流式请求，收齐所有回调 */
function run(handlers = {}) {
    return new Promise((resolve) => {
        const got = { chunks: [], endCount: 0, err: undefined, status: undefined };
        const h = {
            onDelta: (t) => {
                got.chunks.push(t);
                handlers.onDelta?.(t);
            },
            onEnd: (err, status) => {
                got.endCount++;
                got.err = err;
                got.status = status;
                resolve(got);
            },
        };
        const handle = streamChat({ url: "http://api.example.com/v1/chat/completions", headers: { Authorization: "Bearer k" }, body: '{"a":1}' }, h);
        handlers.onStart?.(handle);
    });
}

console.log("通道判定：");
{
    reset();
    check("手机端（无 require、有 http 源）走内核转发", currentChannel(), "kernel");
}

console.log("请求体格式：");
{
    reset();
    reply = {
        status: 200,
        body: JSON.stringify({ code: 0, data: { status: 200, body: "data: hi\n\n" } }),
    };
    await run();

    check("只发了一次请求", calls.length, 1);
    check("打的是内核地址", calls[0].url, "/api/network/forwardProxy");
    check("用的是 POST", calls[0].init.method, "POST");

    const sent = JSON.parse(calls[0].init.body);
    check("目标地址原样传过去", sent.url, "http://api.example.com/v1/chat/completions");
    check("方法传过去", sent.method, "POST");
    // 内核要的是 [{ "键": "值" }, ...]，不是普通对象
    check("请求头是对象数组", sent.headers, [{ Authorization: "Bearer k" }]);
    check("body 被解析成对象", sent.payload, { a: 1 });
    check("有 body 时用 json 编码", sent.payloadEncoding, "json");
    check("带上了超时", typeof sent.timeout, "number");
}

console.log("没有 body 的请求（比如 MCP 的 DELETE）：");
{
    reset();
    reply = { status: 200, body: JSON.stringify({ code: 0, data: { status: 200, body: "" } }) };
    await fetchOnce("http://mcp.example.com/mcp", { method: "DELETE", headers: {} });
    const sent = JSON.parse(calls[0].init.body);
    check("不能把 null 当 body 发出去", sent.payload, "");
    check("用 text 编码保证不发多余内容", sent.payloadEncoding, "text");
}

console.log("正常返回：");
{
    reset();
    reply = {
        status: 200,
        body: JSON.stringify({ code: 0, data: { status: 200, body: "data: a\ndata: b\n\n" } }),
    };
    const got = await run();
    check("整段原文交给了上层", got.chunks, ["data: a\ndata: b\n\n"]);
    check("正常结束没有错误", got.err, undefined);
    check("只结束一次", got.endCount, 1);
}

console.log("接口返回 401：");
{
    reset();
    reply = {
        status: 200,
        body: JSON.stringify({ code: 0, data: { status: 401, body: '{"error":"bad key"}' } }),
    };
    const got = await run();
    check("错误里带状态码", /401/.test(String(got.err)), true);
    check("错误里带上响应体", /bad key/.test(String(got.err)), true);
    check("状态码也传给了上层", got.status, 401);
    check("不该有内容", got.chunks.length, 0);
}

console.log("内核自己报错（code != 0）：");
{
    reset();
    reply = { status: 200, body: JSON.stringify({ code: 3, msg: "decode base64-std payload failed" }) };
    const got = await run();
    check("把内核的话翻出来", /decode base64/.test(String(got.err)), true);
    check("只结束一次", got.endCount, 1);
}

console.log("内核返回的不是 JSON：");
{
    reset();
    reply = { status: 502, body: "<html>bad gateway</html>" };
    const got = await run();
    check("说清是内核没给结果", /没有返回可识别的结果/.test(String(got.err)), true);
    check("带上状态码", /502/.test(String(got.err)), true);
}

console.log("用户点停止：");
{
    reset();
    // 让内核请求一直不返回，模拟慢请求
    globalThis.fetch = () => new Promise(() => {});
    const got = await run({
        onStart: (handle) => {
            setTimeout(() => handle.abort(), 10);
        },
    });
    check("停止会回调一次", got.endCount, 1);
    check("说的是已停止", got.err, "已停止");
}

console.log("MCP 用的一次性请求：");
{
    reset();
    // 恢复可用 fetch
    globalThis.fetch = async (url, init) => {
        calls.push({ url, init });
        return {
            ok: true,
            status: 200,
            text: async () => reply.body,
            headers: { forEach() {} },
        };
    };
    reply = { status: 200, body: JSON.stringify({ code: 0, data: { status: 200, body: '{"ok":true}', contentType: "application/json" } }) };

    const r = await fetchOnce("http://mcp.example.com/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: '{"jsonrpc":"2.0"}',
    });
    check("走的是内核地址", calls[0].url, "/api/network/forwardProxy");
    check("拿回 ok", r.ok, true);
    check("状态码", r.status, 200);
    check("内容类型", r.headers.get("content-type"), "application/json");
    const text = await r.text();
    check("响应体", text, '{"ok":true}');
}

console.log("");
console.log(`结果：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
