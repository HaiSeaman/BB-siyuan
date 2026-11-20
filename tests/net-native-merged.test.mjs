/**
 * 合并 net.ts 两个重复函数后，验证桌面通道行为不变。
 *
 * 关键坑：net.ts 把 bridge 缓存在模块级（cachedBridge），
 * 所以每个场景都必须重新 import 一份新模块，否则一直用第一份假 bridge。
 */
import { pathToFileURL } from "node:url";

let pass = 0;
let fail = 0;
function ok(name, cond, extra = "") {
    if (cond) {
        pass++;
        console.log("  OK   " + name);
    } else {
        fail++;
        console.log("  FAIL " + name + (extra ? "  → " + extra : ""));
    }
}

/** 造一个假的 Electron bridge，按真实协议回放事件 */
function makeBridge(script) {
    return {
        startRequest(options, onEvent) {
            let aborted = false;
            setTimeout(() => {
                if (aborted) return;
                for (const ev of script) {
                    if (aborted) break;
                    if (ev.type === "response") onEvent("response", { statusCode: ev.status, headers: ev.headers || {} });
                    else if (ev.type === "data") onEvent("data", ev.data);
                    else if (ev.type === "end") onEvent("end");
                    else if (ev.type === "error") onEvent("error", { message: ev.message });
                }
            }, 0);
            return {
                abort() {
                    aborted = true;
                },
            };
        },
    };
}

let seq = 0;
/** 每次拿一份全新的 net 模块，避免 cachedBridge 串场景 */
async function freshNet(bridge) {
    seq++;
    globalThis.window = {
        require: (n) => {
            if (n === "@electron/remote") {
                return {
                    getCurrentWebContents: () => ({
                        isDestroyed: () => false,
                        session: {},
                        once: () => {},
                        removeListener: () => {},
                    }),
                    require: () => bridge,
                };
            }
            if (n === "path") return { join: (...a) => a.join("/") };
            return {};
        },
        siyuan: { config: { system: { dataDir: "Z:/siyuan/data" } } },
        location: { origin: "" },
    };
    const url = pathToFileURL(".test/net.js").href + "?fresh=" + seq + "-" + Date.now();
    return await import(url);
}

console.log("正常返回 200 + 文本：");
{
    const net = await freshNet(
        makeBridge([
            { type: "response", status: 200, headers: { "content-type": "application/json" } },
            { type: "data", data: '{"ok":true}' },
            { type: "end" },
        ])
    );
    net.setPluginName("siyuan-plugin-ai-chat");
    const r = await net.fetchOnce("http://x/api", { method: "POST", headers: {}, body: "{}" });
    ok("ok 为 true", r.ok, String(r.ok));
    ok("状态码 200", r.status, String(r.status));
    ok("拿到文本", (await r.text()) === '{"ok":true}', await r.text());
    ok("content-type 被收下", r.headers.get("content-type") === "application/json", r.headers.get("content-type"));
}

console.log("非 2xx：ok 为 false，但响应体照常返回：");
{
    const net = await freshNet(
        makeBridge([
            { type: "response", status: 401, headers: {} },
            { type: "data", data: '{"error":"bad key"}' },
            { type: "end" },
        ])
    );
    net.setPluginName("siyuan-plugin-ai-chat");
    const r = await net.fetchOnce("http://x/api", { method: "POST", headers: {}, body: "{}" });
    ok("ok 为 false", !r.ok, String(r.ok));
    ok("状态码 401", r.status, String(r.status));
    ok("错误体能取到（上层要用它翻译人话）", (await r.text()).includes("bad key"), await r.text());
}

console.log("多段数据要按顺序拼起来：");
{
    const net = await freshNet(
        makeBridge([
            { type: "response", status: 200, headers: {} },
            { type: "data", data: "第一段" },
            { type: "data", data: "第二段" },
            { type: "data", data: "第三段" },
            { type: "end" },
        ])
    );
    net.setPluginName("siyuan-plugin-ai-chat");
    const r = await net.fetchOnce("http://x/api", { method: "POST", headers: {}, body: "{}" });
    ok("三段都拼上了", (await r.text()) === "第一段第二段第三段", await r.text());
}

console.log("网络错误要 reject 并带上原因：");
{
    const net = await freshNet(
        makeBridge([
            { type: "response", status: 200, headers: {} },
            { type: "error", message: "连接被重置" },
        ])
    );
    net.setPluginName("siyuan-plugin-ai-chat");
    let caught = "";
    try {
        await net.fetchOnce("http://x/api", { method: "POST", headers: {}, body: "{}" });
    } catch (e) {
        caught = String(e.message || e);
    }
    ok("抛出了错误", !!caught, "没抛");
    ok("错误原因保留", caught.includes("连接被重置"), caught);
}

console.log("fetchBinary 也要能拿到字节（生图用）：");
{
    const net = await freshNet(
        makeBridge([
            { type: "response", status: 200, headers: { "content-type": "application/json" } },
            { type: "data", data: '{"data":[{"b64_json":"AAAA"}]}' },
            { type: "end" },
        ])
    );
    net.setPluginName("siyuan-plugin-ai-chat");
    const r = await net.fetchBinary("http://x/images/generations", { method: "POST", headers: {}, body: "{}" });
    ok("ok 为 true", r.ok);
    ok("bytes() 能拿到非空字节", (await r.bytes()).length > 0, String((await r.bytes()).length));
    ok("text() 与 bytes 一致", new TextDecoder().decode(await r.bytes()) === (await r.text()));
}

console.log("超时要能拒绝：");
{
    const net = await freshNet({
        startRequest() {
            return { abort() {} };
        },
    });
    net.setPluginName("siyuan-plugin-ai-chat");
    const t0 = Date.now();
    let caught = "";
    try {
        await net.fetchBinary("http://x/slow", { method: "POST", headers: {}, body: "{}", timeoutMs: 120 });
    } catch (e) {
        caught = String(e.message || e);
    }
    const cost = Date.now() - t0;
    ok("超时抛出了错误", !!caught, "没抛");
    ok("说的是请求超时", caught.includes("超时"), caught);
    ok("确实等到了超时时间", cost >= 100, cost + "ms");
}

console.log("");
console.log(`结果：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
