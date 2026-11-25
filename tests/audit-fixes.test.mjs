/**
 * 本轮全仓审计发现的真实 bug 与安全隐患回归测试。
 * 覆盖：二进制代理通道、SSE 长连接推送、stdio 环境变量、Gemini 工具消息合并、
 * 生图重发原地替换、小内嵌图保存、手动标画图模型设置、XSS 过滤、并发锁、
 * 超 30 条淘汰图片清理、MCP 带空格参数二次编辑。
 */
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { build } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { parseHTML } from "linkedom";
import { mkdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const outDir = join(root, ".test/panel-audit");
mkdirSync(outDir, { recursive: true });

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

// ---------- 1. net-proxy.cjs + fetchBinary 二进制无损传递 ----------
console.log("1. net-proxy.cjs 与 fetchBinary 二进制图片无损传输：");
{
    const req = createRequire(import.meta.url);
    const Module = req("node:module");
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xd8, 0x80]);

    // 拦截 require('electron') 用假 net.request 验证 net-proxy.cjs 真走 binary 分支
    const origLoad = Module._load;
    let capturedOpts = null;
    Module._load = function (request, parent, isMain) {
        if (request === "electron") {
            return {
                net: {
                    request(opts) {
                        capturedOpts = opts;
                        const r = new EventEmitter();
                        r.setHeader = () => {};
                        r.abort = () => {};
                        r.end = () => {
                            queueMicrotask(() => {
                                const res = new EventEmitter();
                                res.statusCode = 200;
                                res.headers = { "content-type": "image/png" };
                                r.emit("response", res);
                                res.emit("data", pngBytes.subarray(0, 5));
                                res.emit("data", pngBytes.subarray(5));
                                res.emit("end");
                            });
                        };
                        return r;
                    },
                },
            };
        }
        return origLoad.apply(this, arguments);
    };

    let proxy = null;
    try {
        proxy = req(join(root, "net-proxy.cjs"));
    } finally {
        Module._load = origLoad;
    }

    const fakeOwner = Object.assign(new EventEmitter(), { isDestroyed: () => false });
    const events = [];
    await new Promise((resolve) => {
        proxy.startRequest({ url: "https://img.example.com/a.png", method: "GET", binary: true, owner: fakeOwner }, (t, v) => {
            events.push({ t, v });
            if (t === "end" || t === "error") resolve();
        });
    });

    ok("net-proxy 收到 binary=true 后发出 binary 事件", events.some((e) => e.t === "binary"), JSON.stringify(events));
    ok("net-proxy 不会发 UTF-8 损坏的 data 事件", !events.some((e) => e.t === "data"), JSON.stringify(events));

    // 再把 net-proxy.cjs 接入 net.ts 的 fetchBinary 走完整条链
    const { window } = parseHTML("<!doctype html><html><body></body></html>");
    globalThis.window = window;
    window.siyuan = { config: { system: { dataDir: "D:\\x" } } };
    window.require = (name) => {
        if (name === "@electron/remote") {
            return {
                getCurrentWebContents: () => fakeOwner,
                require: () => proxy,
            };
        }
        if (name === "path") return { join: (...a) => a.join("/") };
        throw new Error("unexpected require: " + name);
    };

    const net = await import(pathToFileURL(join(root, ".test/net.js")).href + "?bin=" + Date.now());
    net.setPluginName("siyuan-plugin-ai-chat");
    const resp = await net.fetchBinary("https://img.example.com/a.png", { method: "GET", headers: {} });
    const gotBytes = Array.from(await resp.bytes());
    ok("fetchBinary 拿回来的字节与原始 PNG 完全一致（未被 U+FFFD 破坏）", JSON.stringify(gotBytes) === JSON.stringify(Array.from(pngBytes)), JSON.stringify(gotBytes));
    ok("没有走错误", !!capturedOpts);
}

// ---------- 2. SseMcpClient 标准 202 + GET 长连接推送 ----------
console.log("2. 旧版 MCP SSE 标准 202 流式响应：");
{
    const { SseMcpClient } = await import(pathToFileURL(join(root, ".test/mcp-sse.js")).href + "?sse=" + Date.now());
    let streamCtrl = null;
    let streamClosed = false;
    const enc = new TextEncoder();

    const fetcher = async (url, init) => {
        if ((init?.method || "GET") === "GET") {
            const body = new ReadableStream({
                start(controller) {
                    streamCtrl = controller;
                    controller.enqueue(enc.encode("event: endpoint\ndata: /messages?sid=9\n\n"));
                },
                cancel() {
                    streamClosed = true;
                },
            });
            return { ok: true, status: 200, headers: new Map([["content-type", "text/event-stream"]]), body, text: async () => "" };
        }
        const req = JSON.parse(init.body);
        if (req.id !== undefined) {
            setTimeout(() => {
                let res = {};
                if (req.method === "initialize") res = { protocolVersion: "2024-11-05", serverInfo: { name: "real-sse", version: "1" } };
                else if (req.method === "tools/list") res = { tools: [{ name: "ping", description: "测" }] };
                else if (req.method === "tools/call") res = { content: [{ type: "text", text: "pong-from-stream" }] };
                streamCtrl.enqueue(enc.encode(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: req.id, result: res })}\n\n`));
            }, 5);
        }
        return { ok: true, status: 202, headers: new Map(), text: async () => "" };
    };

    const client = new SseMcpClient({ url: "http://sse.test/sse", fetcher, timeoutMs: 500 });
    const info = await client.connect();
    ok("标准 202 流式握手成功", info.serverName === "real-sse", info.serverName);
    const out = await client.callTool("ping", {});
    ok("标准 202 流式工具调用拿到结果", out === "pong-from-stream", out);
    await client.close();
    ok("close 后取消长连接流", streamClosed === true);
}

// ---------- 3. StdioMcpClient 环境变量继承兜底 ----------
console.log("3. StdioMcpClient 无 process.env 时不抹掉 PATH：");
{
    const { StdioMcpClient } = await import(pathToFileURL(join(root, ".test/mcp-stdio.js")).href + "?env=" + Date.now());
    const origProcess = globalThis.process;
    let passedOpts = null;
    const spawn = (_cmd, _args, opts) => {
        passedOpts = opts;
        const c = new EventEmitter();
        c.stdout = new EventEmitter();
        c.stderr = new EventEmitter();
        c.stdin = {
            destroyed: false,
            write(line) {
                const req = JSON.parse(String(line).trim());
                if (req.id !== undefined) {
                    queueMicrotask(() => {
                        const res = req.method === "initialize" ? { serverInfo: { name: "x" } } : { tools: [] };
                        c.stdout.emit("data", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: res }) + "\n"));
                    });
                }
            },
            end() {},
        };
        c.kill = () => {};
        return c;
    };

    try {
        Object.defineProperty(globalThis, "process", { value: undefined, configurable: true });
        const client = new StdioMcpClient({ command: "node", spawn, timeoutMs: 300 });
        await client.connect();
        ok("无 process.env 且无自定义 env 时传 undefined（保留父环境）", passedOpts?.env === undefined, JSON.stringify(passedOpts?.env));
        await client.close();
    } finally {
        Object.defineProperty(globalThis, "process", { value: origProcess, configurable: true });
    }
}

// ---------- 4. Gemini 连续多工具返回合并 ----------
console.log("4. Gemini 并行工具结果合并成同一 user 回合：");
{
    const { bodyFor } = await import(pathToFileURL(join(root, ".test/providers.js")).href + "?gem=" + Date.now());
    const b = bodyFor(
        "gemini",
        { baseURL: "http://x/v1", apiKey: "k", model: "gemini-3.5-flash", temperature: 0.7, maxTokens: 1024, thinking: "off" },
        [
            { role: "user", content: "查两件事" },
            {
                role: "assistant",
                content: "",
                tool_calls: [
                    { id: "1", type: "function", function: { name: "t1", arguments: "{}" } },
                    { id: "2", type: "function", function: { name: "t2", arguments: "{}" } },
                ],
            },
            { role: "tool", tool_call_id: "1", tool_name: "t1", content: "r1" },
            { role: "tool", tool_call_id: "2", tool_name: "t2", content: "r2" },
        ],
        "",
        []
    );
    const last = b.contents[b.contents.length - 1];
    ok("两条连续 tool 合并成一个 user 回合", b.contents.length === 3 && last.role === "user", JSON.stringify(b.contents));
    ok("该回合包含 2 个 functionResponse part", last.parts.length === 2, JSON.stringify(last.parts));
}

// ---------- 5. 面板真挂载测试（Vite + linkedom） ----------
const { window, document } = parseHTML("<!doctype html><html><body></body></html>");
globalThis.window = window;
globalThis.document = document;
Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
globalThis.HTMLElement = window.HTMLElement;
globalThis.Element = window.Element;
globalThis.Node = window.Node;
globalThis.CustomEvent = window.CustomEvent;
globalThis.Event = window.Event;
globalThis.getComputedStyle = window.getComputedStyle?.bind(window) || (() => ({}));
window.siyuan = { config: { system: { dataDir: "Z:\\siyuan\\data" } }, zIndex: 10, storage: {} };
window.location = { origin: "" };

const bundle = join(outDir, "panel.mjs");
await build({
    configFile: false,
    root,
    logLevel: "error",
    build: {
        lib: { entry: join(root, "src/ui/ChatPanel.svelte"), formats: ["es"], fileName: () => "panel.mjs" },
        outDir,
        emptyOutDir: false,
        minify: false,
        cssCodeSplit: false,
        rollupOptions: { external: ["siyuan"] },
    },
    plugins: [svelte({ compilerOptions: { dev: false } })],
    resolve: { alias: { "@": join(root, "src") } },
});

let seq = 0;
async function mountFresh(props) {
    seq++;
    const m = await import(pathToFileURL(bundle).href + "?a=" + seq + "-" + Date.now());
    const host = document.createElement("div");
    document.body.appendChild(host);
    const panel = new m.default({ target: host, props });
    const $ = (s) => host.querySelector(s);
    const $$ = (s) => Array.from(host.querySelectorAll(s));
    const byText = (sel, t) => $$(sel).find((e) => (e.textContent || "").trim().includes(t));
    const click = (el) => {
        if (!el) throw new Error("元素不存在");
        el.dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true }));
    };
    const type = (el, val) => {
        el.value = val;
        el.dispatchEvent(new window.Event("input", { bubbles: true }));
    };
    return { host, panel, $, $$, byText, click, type };
}
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function baseProps(over = {}) {
    return {
        initialSettings: {
            apis: [
                {
                    id: "a1",
                    name: "默认",
                    protocol: "openai",
                    baseURL: "http://a/v1",
                    apiKey: "k",
                    models: ["glm-5.3", "custom-draw", "gpt-image-1"],
                    picked: ["glm-5.3", "custom-draw", "gpt-image-1"],
                    model: "gpt-image-1",
                },
            ],
            activeApiId: "a1",
            temperature: 0.7,
            maxTokens: 4096,
            thinking: "high",
            contextMessages: 10,
            showReasoning: false,
            contextLimit: 200000,
            maxToolRounds: 8,
            lastChatModel: "a1::glm-5.3",
            imageSize: "2K",
            imageRatio: "16:9",
            imageModels: [],
            ...over,
        },
        persist: () => {},
        initialTemplates: [{ id: "t1", name: "日记", content: "整理" }],
        persistTemplates: () => {},
        initialMcpServers: [],
        persistMcpServers: () => {},
        initialSessions: [],
        persistSessions: () => {},
        pluginName: "siyuan-plugin-ai-chat",
    };
}

console.log("5. 生图模式点「重发」原地替换旧图、不追加重复气泡：");
{
    let imgCount = 0;
    globalThis.fetch = async (url) => {
        const u = String(url);
        if (u.includes("/images/generations")) {
            imgCount++;
            return {
                ok: true,
                status: 200,
                text: async () => JSON.stringify({ data: [{ b64_json: PNG_B64, revised_prompt: "第" + imgCount + "张图" }] }),
                arrayBuffer: async () => new TextEncoder().encode(JSON.stringify({ data: [{ b64_json: PNG_B64, revised_prompt: "第" + imgCount + "张图" }] })).buffer,
                headers: { get: () => "application/json", forEach() {} },
            };
        }
        return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: {} }), arrayBuffer: async () => new ArrayBuffer(0), headers: { get: () => "application/json", forEach() {} } };
    };

    const props = baseProps();
    props.initialSessions = [
        {
            id: "s1",
            title: "两轮画图",
            updatedAt: 100,
            messages: [
                { role: "user", content: "画第一只猫", reasoning: "" },
                { role: "assistant", content: "", reasoning: "", images: [{ path: "images/old1.png", url: "", size: "2K", prompt: "旧图1" }] },
                { role: "user", content: "画第二条狗", reasoning: "" },
                { role: "assistant", content: "", reasoning: "", images: [{ path: "images/old2.png", url: "", size: "2K", prompt: "旧图2" }] },
            ],
        },
    ];
    const { panel, $, $$, byText, click } = await mountFresh(props);
    click(byText(".icon-btn", "历史"));
    await tick();
    click($(".drawer .hist-main"));
    await tick(10);

    ok("载入了 4 条消息", $$(".row").length === 4, "实际 " + $$(".row").length);
    const firstResend = Array.from($$(".row.me")[0].querySelectorAll(".copy")).find((b) => (b.textContent || "").trim() === "重发");
    click(firstResend);
    await tick(25);

    ok("重发后消息数仍是 4 条（绝不尾部追加重复气泡）", $$(".row").length === 4, "实际 " + $$(".row").length);
    ok("第二轮我问的话完整保留", ($$(".row.me")[1]?.textContent || "").includes("画第二条狗"));
    const firstCardText = $$(".row.ai")[0]?.textContent || "";
    ok("第一条旧图被原地替换为新结果", firstCardText.includes("第1张图") && !firstCardText.includes("旧图1"), firstCardText);
    panel.$destroy();
}

console.log("6. 小于 20KB 的内嵌 data URL 图片可正常保存到电脑：");
{
    let savedBytesLen = 0;
    const origAnchorClick = window.HTMLAnchorElement?.prototype?.click;
    // 用 Electron 假保存对话验证字节直通，不撞 URL.createObjectURL
    window.require = (name) => {
        if (name === "@electron/remote") {
            return {
                dialog: { showSaveDialog: async () => ({ canceled: false, filePath: "Z:\\out.png" }) },
            };
        }
        if (name === "fs") {
            return {
                writeFileSync: (_p, buf) => {
                    savedBytesLen = buf.length;
                },
            };
        }
        return {};
    };

    const props = baseProps();
    props.initialSessions = [
        {
            id: "s-small",
            title: "小图",
            updatedAt: 100,
            messages: [
                { role: "user", content: "给我一个小图", reasoning: "" },
                { role: "assistant", content: "见图：![tiny](data:image/png;base64," + PNG_B64 + ")", reasoning: "" },
            ],
        },
    ];
    const { panel, $, $$, byText, click } = await mountFresh(props);
    click(byText(".icon-btn", "历史"));
    await tick();
    click($(".drawer .hist-main"));
    await tick(25);

    const saveBtn = $$(".img-card .img-actions button").find((b) => (b.textContent || "").includes("保存"));
    ok("小图生成了卡片和保存按钮", !!saveBtn);
    if (saveBtn) {
        click(saveBtn);
        await tick(25);
    }
    ok("小于 20KB 内嵌图直接解码成功并写入字节", savedBytesLen > 0, "写入字节 " + savedBytesLen);
    ok("状态栏显示已保存", /已保存/.test($(".status")?.textContent || ""), $(".status")?.textContent);
    delete window.require;
    if (origAnchorClick) window.HTMLAnchorElement.prototype.click = origAnchorClick;
    panel.$destroy();
}

console.log("7. 设置页：手动标为画图后不被误记进 lastChatModel，也不被清除误删：");
{
    const persisted = [];
    const props = baseProps({
        apis: [
            {
                id: "a1",
                name: "A",
                protocol: "openai",
                baseURL: "http://a/v1",
                apiKey: "k",
                models: ["glm-5.3", "custom-draw", "extra-unused"],
                picked: ["glm-5.3"],
                model: "glm-5.3",
            },
        ],
        lastChatModel: "a1::glm-5.3",
    });
    props.persist = (s) => persisted.push(s);

    const { panel, $, $$, click } = await mountFresh(props);
    click($(".icon-btn.gear"));
    await tick();
    click($(".drawer .collapsed"));
    await tick();

    // 给 custom-draw 点「标为画图」
    const chipDraw = $$(".drawer .model-chip").find((c) => (c.textContent || "").includes("custom-draw"));
    click(chipDraw.querySelector(".chip-mark"));
    await tick();

    // 再点 custom-draw 选中它
    const chipDraw2 = $$(".drawer .model-chip").find((c) => (c.textContent || "").includes("custom-draw"));
    click(chipDraw2.querySelector(".chip-name"));
    await tick(450);

    const latestAfterPick = persisted[persisted.length - 1];
    ok("选中手动标过画图的模型时，lastChatModel 仍保住 glm-5.3", latestAfterPick?.lastChatModel === "a1::glm-5.3", latestAfterPick?.lastChatModel);
    ok("设置提示说它是画图模型", /画图模型/.test($(".drawer .res")?.textContent || ""), $(".drawer .res")?.textContent);

    // 切回 glm-5.3（现在 custom-draw 既未勾选也不在用，纯靠 manualImage 保命）
    const chipChat = $$(".drawer .model-chip").find((c) => (c.textContent || "").includes("glm-5.3"));
    click(chipChat.querySelector(".chip-name"));
    await tick();

    click($(".drawer .clear-all"));
    await tick();
    click($(".drawer .confirm-yes"));
    await tick(450);

    const latestAfterClear = persisted[persisted.length - 1];
    const remaining = latestAfterClear?.apis?.[0]?.models || [];
    ok("清除其他模型后，手动标为画图的 custom-draw 仍保留", remaining.includes("custom-draw"), JSON.stringify(remaining));
    ok("真正没用的 extra-unused 被清除", !remaining.includes("extra-unused"), JSON.stringify(remaining));
    panel.$destroy();
}

console.log("8. Markdown 渲染剥离危险 XSS 脚本与事件处理器：");
{
    window.Lute = { New: () => ({ Md2HTML: (t) => t }) };
    const props = baseProps();
    props.initialSessions = [
        {
            id: "s-xss",
            title: "xss",
            updatedAt: 100,
            messages: [
                { role: "user", content: "测", reasoning: "" },
                {
                    role: "assistant",
                    content: '<p>安全正文</p><script>window.__hacked=1</script><img src="x" onerror="evil()"><a href="javascript:steal()">点</a>',
                    reasoning: "",
                },
            ],
        },
    ];
    const { panel, $, byText, click } = await mountFresh(props);
    click(byText(".icon-btn", "历史"));
    await tick();
    click($(".drawer .hist-main"));
    await tick(10);

    const html = $(".row.ai .md")?.innerHTML || "";
    ok("安全正文保留", html.includes("安全正文"), html);
    ok("script 标签被清除", !/<script/i.test(html), html);
    ok("onerror 内联脚本被清除", !/onerror/i.test(html), html);
    ok("javascript: 链接被中和", !/javascript:/i.test(html), html);
    delete window.Lute;
    panel.$destroy();
}

console.log("9. 生图进行中禁止切换历史对话（防止结果写串会话）：");
{
    globalThis.fetch = async (url) => {
        if (String(url).includes("/images/generations")) return new Promise(() => {});
        return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: {} }), arrayBuffer: async () => new ArrayBuffer(0), headers: { get: () => "application/json", forEach() {} } };
    };
    const props = baseProps();
    props.initialSessions = [
        { id: "old1", title: "旧对话", updatedAt: 50, messages: [{ role: "user", content: "旧内容", reasoning: "" }] },
    ];
    const { panel, $, byText, click, type } = await mountFresh(props);
    type($("#compose-input"), "画一只新猫");
    click(byText(".compose button", "生成"));
    await tick(10);

    click(byText(".icon-btn", "历史"));
    await tick();
    click($(".drawer .hist-main"));
    await tick();

    ok("生成中点旧历史会被拦下", /先点「停止」/.test($(".status")?.textContent || ""), $(".status")?.textContent);
    ok("当前画面内容没有被旧对话替换", ($(".msgs")?.textContent || "").includes("画一只新猫") && !($(".msgs")?.textContent || "").includes("旧内容"));
    click(byText(".compose button", "停止"));
    await tick();
    panel.$destroy();
}

console.log("10. 历史超过 30 条淘汰旧会话时同步删除其孤儿图片文件：");
{
    const removedBodies = [];
    globalThis.fetch = async (url, init) => {
        const u = String(url);
        if (u.includes("/api/file/removeFile")) {
            removedBodies.push(String(init?.body || ""));
        }
        if (u.includes("/images/generations")) {
            return {
                ok: true,
                status: 200,
                text: async () => JSON.stringify({ data: [{ b64_json: PNG_B64 }] }),
                arrayBuffer: async () => new TextEncoder().encode(JSON.stringify({ data: [{ b64_json: PNG_B64 }] })).buffer,
                headers: { get: () => "application/json", forEach() {} },
            };
        }
        return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: {} }), arrayBuffer: async () => new ArrayBuffer(0), headers: { get: () => "application/json", forEach() {} } };
    };
    const thirty = [];
    for (let k = 0; k < 30; k++) {
        const isOldest = k === 29;
        thirty.push({
            id: "old-" + k,
            title: "t" + k,
            updatedAt: 1000 - k,
            messages: [
                { role: "user", content: "p" + k, reasoning: "" },
                {
                    role: "assistant",
                    content: isOldest ? "" : "ok",
                    reasoning: "",
                    images: isOldest ? [{ path: "images/evicted-31.png", size: "1K", prompt: "old" }] : undefined,
                },
            ],
        });
    }
    const props = baseProps();
    props.initialSessions = thirty;
    const { panel, $, byText, click, type } = await mountFresh(props);
    type($("#compose-input"), "第31条画图");
    click(byText(".compose button", "生成"));
    await tick(30);

    ok("淘汰第 31 条历史后触发删除图片文件", removedBodies.some((b) => b.includes("evicted-31.png")), JSON.stringify(removedBodies));
    panel.$destroy();
}

console.log("11. MCP 编辑带空格参数不劈碎 + 空表单不弹原生 alert：");
{
    let savedMcp = [];
    const props = baseProps();
    props.initialSettings.apis[0].model = "glm-5.3";
    props.initialMcpServers = [
        { id: "m1", name: "本地工具", type: "stdio", url: "", headers: {}, command: "node", args: ["C:\\Program Files\\demo.js", "--port", "8080"], env: {}, enabled: false },
    ];
    props.persistMcpServers = (list) => {
        savedMcp = list;
    };
    window.require = () => ({});
    window.alert = () => {
        throw new Error("不应该再调原生 alert");
    };

    const { panel, $, $$, byText, click, type } = await mountFresh(props);
    click($(".mcp-bar"));
    await tick();
    click(byText(".drawer .mini", "改"));
    await tick();
    click(byText(".drawer button.primary", "保存"));
    await tick();

    ok("再次保存带空格路径的 args 仍是 3 项", savedMcp[0]?.args?.length === 3 && savedMcp[0].args[0] === "C:\\Program Files\\demo.js", JSON.stringify(savedMcp[0]?.args));

    // 再点新建一个空名字提交，检查显示 .warn 且没调用 alert
    click(byText(".drawer button.primary", "添加 HTTP"));
    await tick();
    type($(".drawer input"), "");
    click(byText(".drawer button.primary", "保存"));
    await tick();
    ok("空表单用内联 .warn 提示，不弹原生 alert", /起个名字/.test($(".drawer .warn")?.textContent || ""), $(".drawer .warn")?.textContent);
    delete window.require;
    delete window.alert;
    panel.$destroy();
}

console.log("12. 模板管理空名称用内联提示，不弹原生 alert：");
{
    window.alert = () => {
        throw new Error("模板管理不应该弹原生 alert");
    };
    const props = baseProps();
    props.initialSettings.apis[0].model = "glm-5.3";
    const { panel, $, byText, click, type } = await mountFresh(props);
    click(byText(".icon-btn", "管理"));
    await tick();
    click(byText(".drawer .mini", "改"));
    await tick();
    type($(".drawer input"), "   ");
    click(byText(".drawer button.primary", "保存"));
    await tick();
    ok("模板名空时显示 .warn，不弹原生 alert", /不能空/.test($(".drawer .warn")?.textContent || ""), $(".drawer .warn")?.textContent);
    delete window.alert;
    panel.$destroy();
}

console.log("13. 工具调用轮保留助手中间正文（第 2 轮请求带上第 1 轮说的话）：");
{
    const bodies = [];
    let round = 0;
    const enc = new TextEncoder();
    globalThis.fetch = async (url, init) => {
        const u = String(url);
        if (u.includes("/chat/completions")) {
            round++;
            bodies.push(JSON.parse(init.body));
            const sse =
                round === 1
                    ? 'data: {"choices":[{"delta":{"content":"我先查一下"}}]}\n\n' +
                      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"mcp__srv__ping","arguments":"{}"}}]}}]}\n\n' +
                      "data: [DONE]\n\n"
                    : 'data: {"choices":[{"delta":{"content":"查完了"}}]}\n\ndata: [DONE]\n\n';
            const body = new ReadableStream({
                start(c) {
                    c.enqueue(enc.encode(sse));
                    c.close();
                },
            });
            return { ok: true, status: 200, body, text: async () => sse, headers: { get: () => "text/event-stream", forEach() {} } };
        }
        if (u.includes("mcp.test")) {
            const req = init?.body ? JSON.parse(init.body) : {};
            let res = {};
            if (req.method === "initialize") res = { protocolVersion: "2025-06-18", serverInfo: { name: "srv", version: "1" } };
            else if (req.method === "tools/list") res = { tools: [{ name: "ping", description: "测", inputSchema: { type: "object", properties: {} } }] };
            else if (req.method === "tools/call") res = { content: [{ type: "text", text: "工具结果OK" }] };
            return { ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: "2.0", id: req.id, result: res }), headers: new Map([["content-type", "application/json"]]) };
        }
        return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: {} }), arrayBuffer: async () => new ArrayBuffer(0), headers: { get: () => "application/json", forEach() {} } };
    };
    const props = baseProps();
    props.initialSettings.apis[0].model = "glm-5.3";
    props.initialMcpServers = [{ id: "srv", name: "srv", type: "http", url: "http://mcp.test/mcp", headers: {}, command: "", args: [], env: {}, enabled: true }];
    const { panel, $, byText, click, type } = await mountFresh(props);
    await tick(25); // 等 autoConnectMcp 连上
    type($("#compose-input"), "测试工具轮");
    click(byText(".compose button", "发送"));
    await tick(40);
    ok("跑完两轮工具循环", bodies.length === 2, "轮数 " + bodies.length);
    const assistantMsg = bodies[1]?.messages?.find((m) => m.role === "assistant");
    ok("第 2 轮请求体带回第 1 轮说的话", assistantMsg?.content === "我先查一下", JSON.stringify(assistantMsg));
    panel.$destroy();
}

console.log("");
console.log(`结果：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
