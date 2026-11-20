/**
 * 这轮两个需求的真实面板测试：
 *   1. 一个 API 多选模型 → 顶栏只显示勾过的
 *   2. 图片显示：能读到就显示 <img>，读不到要说清原因 + 给重试
 */
import { build } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { parseHTML } from "linkedom";
import { mkdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const outDir = join(root, ".test/panel-mp");
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
window.siyuan = { config: { system: { dataDir: "Z:\\siyuan" } }, zIndex: 10, storage: {} };
window.location = { origin: "" };
window.confirm = () => true;

/** 假的图片字节（1x1 PNG） */
const PNG_BYTES = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

let getFileCalls = [];
let getFileShouldFail = false;

globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/api/file/getFile")) {
        getFileCalls.push(u);
        if (getFileShouldFail) {
            return {
                ok: false,
                status: 404,
                text: async () => JSON.stringify({ code: -1 }),
                arrayBuffer: async () => new ArrayBuffer(0),
                headers: { get: () => "application/json" },
            };
        }
        return {
            ok: true,
            status: 200,
            text: async () => "",
            arrayBuffer: async () => PNG_BYTES.buffer.slice(0),
            headers: { get: () => "image/png" },
        };
    }
    return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ code: 0, data: {}, msg: "" }),
        arrayBuffer: async () => new ArrayBuffer(0),
        headers: { get: () => "application/json" },
    };
};

const bundle = join(outDir, "panel.bundle.mjs");
await build({
    configFile: false,
    root,
    logLevel: "error",
    build: {
        lib: { entry: join(root, "src/ui/ChatPanel.svelte"), formats: ["es"], fileName: () => "panel.bundle.mjs" },
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
    const m = await import(pathToFileURL(bundle).href + "?m=" + seq + "-" + Date.now());
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
    return { panel, $, $$, byText, click };
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const tick2 = () => new Promise((r) => setTimeout(r, 10));

function props(over = {}) {
    return {
        initialSettings: {
            apis: [
                {
                    id: "a1",
                    name: "中转站",
                    protocol: "openai",
                    baseURL: "http://a/v1",
                    apiKey: "k",
                    models: ["glm-5.3", "kimi-k3", "gemini-3.1-flash-image"],
                    picked: ["glm-5.3", "gemini-3.1-flash-image"],
                    model: "glm-5.3",
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
        initialTemplates: [],
        persistTemplates: () => {},
        initialMcpServers: [],
        persistMcpServers: () => {},
        initialSessions: [],
        persistSessions: () => {},
        pluginName: "siyuan-plugin-ai-chat",
    };
}

console.log("多选：顶栏只列勾过的模型");
{
    const { panel, $, $$, click } = await mountFresh(props());
    click($(".model-btn"));
    await tick();
    const rows = $$(".picker .model-row").map((r) => (r.textContent || "").trim());
    ok("只显示勾选的两个", rows.length === 2, JSON.stringify(rows));
    ok("有 glm-5.3", rows.some((t) => t.includes("glm-5.3")), JSON.stringify(rows));
    ok("有 gemini 画图模型", rows.some((t) => t.includes("gemini-3.1-flash-image")), JSON.stringify(rows));
    ok("没勾的 kimi 不出现", !rows.some((t) => t.includes("kimi-k3")), JSON.stringify(rows));
    ok("顶部写了「2 / 3 个已勾选」", ($(".picker")?.textContent || "").includes("2 / 3"), $(".picker")?.textContent);
    panel.$destroy();
}

console.log("多选：没勾过的老配置仍然全显示");
{
    const p = props();
    p.initialSettings.apis[0].picked = [];
    p.initialSettings.apis[0].model = "glm-5.3";
    const { panel, $, $$, click } = await mountFresh(p);
    click($(".model-btn"));
    await tick();
    const rows = $$(".picker .model-row").length;
    ok("一个都没勾时退回显示全部", rows === 3, "实际 " + rows);
    panel.$destroy();
}

console.log("图片：能读到就显示 <img>");
{
    getFileShouldFail = false;
    getFileCalls = [];
    const p = props();
    p.initialSessions = [
        {
            id: "s1",
            title: "画图",
            updatedAt: 100,
            messages: [
                { role: "user", content: "一只猫", reasoning: "" },
                { role: "assistant", content: "", reasoning: "", images: [{ path: "images/a.jpg", size: "1K", prompt: "猫" }] },
            ],
        },
    ];
    const { panel, $, byText, click } = await mountFresh(p);
    click(byText(".icon-btn", "历史"));
    await tick();
    click($(".drawer .hist-main"));
    await tick();
    await tick2();
    await tick2();

    ok("调用了读图接口", getFileCalls.length > 0, "没调用");
    ok("渲染出 <img>", !!$(".img-thumb"), "没渲染出来");
    const src = $(".img-thumb")?.getAttribute("src") || "";
    ok("src 是 data URL", src.startsWith("data:image/"), src.slice(0, 40));
    ok("没有显示「暂时显示不出来」", !$(".img-missing"), "还是显示成缺失");
    panel.$destroy();
}

console.log("图片：读不到时说清原因 + 给重试");
{
    getFileShouldFail = true;
    getFileCalls = [];
    const p = props();
    p.initialSessions = [
        {
            id: "s2",
            title: "画图",
            updatedAt: 100,
            messages: [
                { role: "user", content: "一只猫", reasoning: "" },
                { role: "assistant", content: "", reasoning: "", images: [{ path: "images/b.jpg", size: "1K", prompt: "猫" }] },
            ],
        },
    ];
    const { panel, $, byText, click } = await mountFresh(p);
    click(byText(".icon-btn", "历史"));
    await tick();
    click($(".drawer .hist-main"));
    await tick();
    await tick2();
    await tick2();

    ok("显示缺失占位", !!$(".img-missing"), "没显示占位");
    const txt = $(".img-missing")?.textContent || "";
    ok("说的是「暂时显示不出来」而不是「找不到了」", txt.includes("暂时显示不出来"), txt);
    ok("给出了具体原因", txt.includes("原因") || txt.includes("网址"), txt);
    ok("有重试按钮", !!$(".retry-img"), "没有重试按钮");

    // 点重试，这次让它成功
    getFileShouldFail = false;
    const before = getFileCalls.length;
    click($(".retry-img"));
    await tick2();
    await tick2();
    ok("重试真的又请求了一次", getFileCalls.length > before, before + " → " + getFileCalls.length);
    ok("重试后图片显示出来了", !!$(".img-thumb"), "还是一样");
    panel.$destroy();
}

console.log("图片：content-type 是 octet-stream 但字节是图也要能显示");
{
    getFileShouldFail = false;
    globalThis.fetch = async (url) => {
        const u = String(url);
        if (u.includes("/api/file/getFile")) {
            return {
                ok: true,
                status: 200,
                text: async () => "",
                arrayBuffer: async () => PNG_BYTES.buffer.slice(0),
                // 关键：内核给了个不是 image/* 的类型
                headers: { get: () => "application/octet-stream" },
            };
        }
        return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ code: 0, data: {}, msg: "" }),
            arrayBuffer: async () => new ArrayBuffer(0),
            headers: { get: () => "application/json" },
        };
    };

    const p = props();
    p.initialSessions = [
        {
            id: "s3",
            title: "画图",
            updatedAt: 100,
            messages: [
                { role: "user", content: "x", reasoning: "" },
                { role: "assistant", content: "", reasoning: "", images: [{ path: "images/c.png", size: "1K", prompt: "猫" }] },
            ],
        },
    ];
    const { panel, $, byText, click } = await mountFresh(p);
    click(byText(".icon-btn", "历史"));
    await tick();
    click($(".drawer .hist-main"));
    await tick();
    await tick2();
    await tick2();

    ok("octet-stream 也能显示（靠字节嗅探）", !!$(".img-thumb"), "没显示");
    panel.$destroy();
}

console.log("");
console.log(`结果：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
