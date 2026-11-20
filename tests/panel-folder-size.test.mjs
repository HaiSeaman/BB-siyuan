/** 面板测试：「图片」按钮位置 + 四档尺寸都在下拉里 */
import { build } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { parseHTML } from "linkedom";
import { mkdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const outDir = join(root, ".test/panel-folder");
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

// 记录 shell.openPath 被调用
let openPathCalls = [];
let openPathResult = "";
const fakeShell = {
    openPath: async (p) => {
        openPathCalls.push(p);
        return openPathResult;
    },
};
window.require = (name) => {
    if (name === "@electron/remote") return { shell: fakeShell, dialog: null };
    // 新逻辑会先确认目录存在，这里要假装存在
    if (name === "fs") return { existsSync: () => true, readFileSync: () => "" };
    return {};
};

globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ code: 0, data: {}, msg: "" }),
    arrayBuffer: async () => new ArrayBuffer(0),
    headers: { get: () => "application/json" },
});

const bundle = join(outDir, "p.mjs");
await build({
    configFile: false,
    root,
    logLevel: "error",
    build: {
        lib: { entry: join(root, "src/ui/ChatPanel.svelte"), formats: ["es"], fileName: () => "p.mjs" },
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
    const m = await import(pathToFileURL(bundle).href + "?f=" + seq + "-" + Date.now());
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
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function props(over = {}) {
    return {
        initialSettings: {
            apis: [
                {
                    id: "a1",
                    name: "V3",
                    protocol: "openai",
                    baseURL: "https://api.gpt.ge/v1",
                    apiKey: "k",
                    models: ["gpt-image-2.6-sunburst"],
                    picked: ["gpt-image-2.6-sunburst"],
                    model: "gpt-image-2.6-sunburst",
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
            lastChatModel: "",
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

console.log("「图片」按钮存在且在「上传」左边：");
{
    const { panel, $, $$, byText } = await mountFresh(props());
    const texts = $$(".ctrl-bar .pill").map((p) => (p.textContent || "").trim());
    ok("有「图片」按钮", texts.includes("图片"), JSON.stringify(texts));
    ok("有「上传」按钮", texts.includes("上传"), JSON.stringify(texts));

    const iThink = texts.findIndex((t) => t.startsWith("思考"));
    const iFolder = texts.findIndex((t) => t === "图片");
    const iUpload = texts.findIndex((t) => t === "上传");
    ok("思考在最左", iThink === 0, JSON.stringify(texts));
    ok("图片在思考右边", iFolder > iThink, JSON.stringify(texts));
    ok("图片在上传左边", iFolder < iUpload, JSON.stringify(texts));
    ok("顺序是 思考 → 图片 → 上传", iThink < iFolder && iFolder < iUpload, JSON.stringify(texts));
    panel.$destroy();
}

console.log("点「图片」会调用系统打开文件夹：");
{
    openPathCalls = [];
    openPathResult = "";
    const { panel, $, byText, click } = await mountFresh(props());
    click(byText(".ctrl-bar .pill", "图片"));
    await tick(30);

    ok("调用了 shell.openPath", openPathCalls.length === 1, "调用次数 " + openPathCalls.length);
    ok("传的是图片文件夹路径", (openPathCalls[0] || "").includes("petal"), openPathCalls[0]);
    ok("路径里带 images", (openPathCalls[0] || "").includes("images"), openPathCalls[0]);
    ok("路径里只有一层 data（不出现 data\\data）", !(openPathCalls[0] || "").includes("data\\data"), openPathCalls[0]);
    ok("状态栏说了已打开", /已打开/.test($(".status")?.textContent || ""), $(".status")?.textContent);
    panel.$destroy();
}

console.log("打开失败时要说清楚：");
{
    openPathCalls = [];
    openPathResult = "没有权限";
    const { panel, $, byText, click } = await mountFresh(props());
    click(byText(".ctrl-bar .pill", "图片"));
    await tick(30);
    ok("失败时给出原因", /打不开/.test($(".status")?.textContent || ""), $(".status")?.textContent);
    ok("失败时也给出路径", /petal/.test($(".status")?.textContent || ""), $(".status")?.textContent);
    panel.$destroy();
}

console.log("手机端（没有 require）要说清不能打开：");
{
    const savedRequire = window.require;
    delete window.require;
    const { panel, $, byText, click } = await mountFresh(props());
    click(byText(".ctrl-bar .pill", "图片"));
    await tick(30);
    ok("手机端说明不能打开", /手机端|不能直接打开/.test($(".status")?.textContent || ""), $(".status")?.textContent);
    ok("手机端仍给出路径", /petal/.test($(".status")?.textContent || ""), $(".status")?.textContent);
    window.require = savedRequire;
    panel.$destroy();
}

console.log("尺寸下拉里有四档，且显示的是新基准：");
{
    const { panel, $, $$, byText, click } = await mountFresh(props());
    click(byText(".ctrl-bar .pill", "2K"));
    await tick();
    const items = $$(".ctrl-bar .menu .menu-item").map((b) => (b.textContent || "").trim());
    ok("有四档", items.length === 4, JSON.stringify(items));
    ok("有 1K", items.some((t) => t.startsWith("1K")));
    ok("有 2K", items.some((t) => t.startsWith("2K")));
    ok("有 4K", items.some((t) => t.startsWith("4K")));
    ok("有 4K+", items.some((t) => t.startsWith("4K+")));
    ok("2K 那项写着长边 2560", items.some((t) => t.startsWith("2K") && t.includes("2560")), JSON.stringify(items));

    // 控制条右边显示的像素应该是 2560 × 1440
    ok("控制条显示 2560 × 1440", ($(".ctrl-bar")?.textContent || "").includes("2560 × 1440"), $(".ctrl-bar")?.textContent);
    panel.$destroy();
}

console.log("1K + 16:9 应该正好 1920×1080：");
{
    const { panel, $, byText, click } = await mountFresh(props({ imageSize: "1K", imageRatio: "16:9" }));
    ok("控制条显示 1920 × 1080", ($(".ctrl-bar")?.textContent || "").includes("1920 × 1080"), $(".ctrl-bar")?.textContent);
    panel.$destroy();
}

console.log("");
console.log(`结果：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
