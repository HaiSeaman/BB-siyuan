/**
 * 用主人真实的模型名做一次面板挂载测试。
 *
 * 这一轮修的三个问题都必须在这里复现出来：
 *   1. 4 个按钮全部存在，而且在思考强度的右边
 *   2. 图片底下两个按钮都在（复制 + 保存）
 *   3. 用 gemini-3.1-flash-image 时能进生图模式，不再说"没有模型"
 */
import { build } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { parseHTML } from "linkedom";
import { mkdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const outDir = join(root, ".test/panel-fix");
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

const puts = [];
globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes("/api/file/putFile")) puts.push(u);
    return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ code: 0, data: {}, msg: "" }),
        arrayBuffer: async () => new ArrayBuffer(0),
        headers: { get: () => "application/json" },
    };
};

const bundlePath = join(outDir, "panel.bundle.mjs");
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
    const m = await import(pathToFileURL(bundlePath).href + "?f=" + seq + "-" + Date.now());
    const host = document.createElement("div");
    document.body.appendChild(host);
    const panel = new m.default({ target: host, props });
    const $ = (s) => host.querySelector(s);
    const $$ = (s) => Array.from(host.querySelectorAll(s));
    const byText = (sel, t) => $$(sel).find((e) => (e.textContent || "").trim().includes(t));
    const click = (el) => {
        if (!el) throw new Error("要点的元素不存在");
        el.dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true }));
    };
    return { host, panel, $, $$, byText, click };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const tick2 = () => new Promise((r) => setTimeout(r, 6));

/** 主人那份配置（模型名完全照搬） */
function ownerProps(over = {}) {
    const persisted = [];
    return {
        persisted,
        initialSettings: {
            apis: [
                { id: "default", name: "Trae", protocol: "openai", baseURL: "http://192.168.1.8:17864/v1", apiKey: "k", models: ["glm-5.3"], model: "glm-5.3" },
                { id: "ms", name: "魔塔", protocol: "openai", baseURL: "https://api-inference.modelscope.cn/v1", apiKey: "k", models: ["ZhipuAI/GLM-5.2"], model: "ZhipuAI/GLM-5.2" },
                {
                    id: "n3",
                    name: "新 API 3",
                    protocol: "openai",
                    baseURL: "http://192.168.1.8:18045/v1",
                    apiKey: "k",
                    models: ["gemini-3.1-flash-image"],
                    model: "gemini-3.1-flash-image",
                },
            ],
            activeApiId: "n3",
            temperature: 0.7,
            maxTokens: 4096,
            thinking: "high",
            contextMessages: 10,
            showReasoning: false,
            contextLimit: 200000,
            maxToolRounds: 8,
            lastChatModel: "n3::gemini-3.1-flash-image",
            imageSize: "2K",
            imageRatio: "16:9",
            imageModels: [],
            ...over,
        },
        persist: (s) => persisted.push(s),
        initialTemplates: [],
        persistTemplates: () => {},
        initialMcpServers: [],
        persistMcpServers: () => {},
        initialSessions: [],
        persistSessions: () => {},
        pluginName: "siyuan-plugin-ai-chat",
    };
}

console.log("【问题3】用 gemini-3.1-flash-image 打开面板：");
{
    const props = ownerProps();
    const { panel, $, $$, byText } = await mountFresh(props);

    ok("自动进入生图模式（有生图提示条）", !!$(".img-banner"), "没有 .img-banner");
    ok("顶栏显示的就是这个模型", ($(".model-btn")?.textContent || "").includes("gemini-3.1-flash-image"), $(".model-btn")?.textContent);
    ok("顶栏小圆点是橙色（画图标记）", !!$(".dot-api.draw"));
    ok("不再提示没有模型", !/没有.*模型|没有发现/.test($(".status")?.textContent || ""), $(".status")?.textContent);
    ok("发送按钮是「生成」", !!byText(".compose button", "生成"));
    panel.$destroy();
}

console.log("【问题1】4 个按钮一个不少，且在思考右边：");
{
    const { panel, $, $$, byText } = await mountFresh(ownerProps());

    const bar = $(".ctrl-bar");
    ok("控制条存在", !!bar);

    const pillTexts = $$(".ctrl-bar .pill").map((p) => (p.textContent || "").trim());
    ok("有「上传」", pillTexts.some((t) => t === "上传"), JSON.stringify(pillTexts));
    ok("有大小档位（2K）", pillTexts.some((t) => t.startsWith("2K")), JSON.stringify(pillTexts));
    ok("有尺寸比例（16:9）", pillTexts.some((t) => t.startsWith("16:9")), JSON.stringify(pillTexts));
    ok("有「优化」", pillTexts.some((t) => t === "优化"), JSON.stringify(pillTexts));

    // 位置：DOM 顺序必须是 思考 → ... → 上传 → 大小 → 尺寸 → 优化
    const order = $$(".ctrl-bar > *").map((e) => (e.textContent || "").trim());
    const isz = order.findIndex((t) => t.startsWith("思考") || t.includes("不支持思考"));
    const iup = order.findIndex((t) => t === "上传");
    const isize = order.findIndex((t) => t.startsWith("2K"));
    const iratio = order.findIndex((t) => t.startsWith("16:9"));
    const iopt = order.findIndex((t) => t === "优化");
    ok("思考档位在最前面", isz === 0, JSON.stringify(order));
    ok("上传在思考的右边", iup > isz, JSON.stringify(order));
    ok("顺序是 上传 → 大小 → 尺寸 → 优化", iup < isize && isize < iratio && iratio < iopt, JSON.stringify(order));

    // 对话模式（切回聊天模型）下按钮也要在
    const chatProps = ownerProps({ activeApiId: "default" });
    chatProps.initialSettings = { ...chatProps.initialSettings, apis: chatProps.initialSettings.apis.map((a) => (a.id === "default" ? { ...a, model: "glm-5.3" } : a)) };
    const c = await mountFresh(chatProps);
    const chatPills = c.$$(".ctrl-bar .pill").map((p) => (p.textContent || "").trim());
    ok("对话模式下 4 个按钮也在", chatPills.some((t) => t === "上传") && chatPills.some((t) => t.startsWith("2K")) && chatPills.some((t) => t.startsWith("16:9")) && chatPills.some((t) => t === "优化"), JSON.stringify(chatPills));
    ok("对话模式显示「🎨 生图」按钮", chatPills.some((t) => t.includes("生图")), JSON.stringify(chatPills));
    c.panel.$destroy();

    panel.$destroy();
}

console.log("【问题3】在对话模式下点「🎨 生图」：");
{
    const props = ownerProps({ activeApiId: "default" });
    props.initialSettings = { ...props.initialSettings, apis: props.initialSettings.apis.map((a) => (a.id === "default" ? { ...a, model: "glm-5.3" } : a)) };
    const { panel, $, byText, click } = await mountFresh(props);

    ok("开始是对话模式", !$(".img-banner"));
    click(byText(".ctrl-bar .pill", "生图"));
    await tick2();

    ok("切到了生图模式", !!$(".img-banner"), "点完还是对话模式");
    ok("模型切成了画图模型", ($(".model-btn")?.textContent || "").includes("gemini-3.1-flash-image"), $(".model-btn")?.textContent);
    ok("没有报「没有画图模型」", !/还没有画图模型/.test($(".status")?.textContent || ""), $(".status")?.textContent);
    ok("4 个按钮还在", !!($(".ctrl-bar") && byText(".ctrl-bar .pill", "上传")), "按钮丢了");
    panel.$destroy();
}

console.log("【问题2】图片底下的两个按钮：");
{
    const props = ownerProps();
    props.initialSessions = [
        {
            id: "s1",
            title: "画猫",
            updatedAt: 100,
            messages: [
                { role: "user", content: "一只猫", reasoning: "" },
                { role: "assistant", content: "", reasoning: "", images: [{ path: "images/a.png", size: "2048 × 1152", prompt: "一只橘猫" }] },
            ],
        },
    ];
    const { panel, $, $$, byText, click } = await mountFresh(props);

    click(byText(".icon-btn", "历史"));
    await tick();
    click($(".drawer .hist-main"));
    await tick();
    await tick2();

    ok("图片卡片出现了", !!$(".img-card"));
    const btns = $$(".img-card .img-actions button").map((b) => (b.textContent || "").trim());
    ok("图片底下正好两个按钮", btns.length === 2, JSON.stringify(btns));
    ok("有「复制图片」", btns.includes("复制图片"), JSON.stringify(btns));
    ok("有「保存到电脑」", btns.includes("保存到电脑"), JSON.stringify(btns));

    // 点保存不能崩
    const save = $$(".img-card .img-actions button").find((b) => (b.textContent || "").includes("保存"));
    click(save);
    await tick2();
    ok("点保存后界面还在", !!$(".panel"));
    ok("点保存后有提示（不是静默）", ($(".status")?.textContent || "").length > 0, $(".status")?.textContent);
    ok("提示里说了为什么失败/成功", /保存|找不到/.test($(".status")?.textContent || ""), $(".status")?.textContent);
    panel.$destroy();
}

console.log("【兜底】名字认不出来时手动标记：");
{
    const props = ownerProps({
        activeApiId: "x",
        apis: [{ id: "x", name: "X", protocol: "openai", baseURL: "http://x/v1", apiKey: "", models: ["my-secret-drawer"], model: "my-secret-drawer" }],
        imageModels: ["my-secret-drawer"],
    });
    const { panel, $, byText } = await mountFresh(props);
    ok("标记过的模型也进生图模式", !!$(".img-banner"), "没进生图模式");
    ok("4 个按钮在", !!byText(".ctrl-bar .pill", "上传"));
    panel.$destroy();
}

console.log("【问题2 真场景】图是以 base64 混在正文里返回的：");
{
    // 照抄主人那条 964KB 消息的形态：![image](data:image/jpeg;base64,...)
    const b64 = "iVBORw0KGgoAAAANSUhEUg" + "A".repeat(30000);
    const props = ownerProps();
    props.initialSessions = [
        {
            id: "s-real",
            title: "生图对话",
            updatedAt: 200,
            messages: [
                { role: "user", content: "画一只猫", reasoning: "" },
                { role: "assistant", content: "这是你要的图：\n\n![image](data:image/jpeg;base64," + b64 + ")", reasoning: "" },
            ],
        },
    ];
    const { panel, $, $$, byText, click } = await mountFresh(props);

    click(byText(".icon-btn", "历史"));
    await tick();
    click($(".drawer .hist-main"));
    await tick();
    await tick2();
    await tick2();

    ok("正文里的图被变成了图片卡片", !!$(".img-card"), "没有 .img-card（还在当文字渲染）");
    const btns = $$(".img-card .img-actions button").map((b) => (b.textContent || "").trim());
    ok("卡片底下有「复制图片」", btns.includes("复制图片"), JSON.stringify(btns));
    ok("卡片底下有「保存到电脑」", btns.includes("保存到电脑"), JSON.stringify(btns));
    ok("base64 不再当正文显示", !($(".msgs")?.textContent || "").includes("base64"), "还在显示 base64");
    ok("原来的文字还在", ($(".msgs")?.textContent || "").includes("这是你要的图"), $(".msgs")?.textContent?.slice(0, 80));

    // 图应该被搬到 images/ 里（fetch 被 mock 成成功）
    const putCalls = puts.length;
    ok("尝试把大图搬进了 images/", putCalls >= 1, "putFile 调用次数 " + putCalls);
    panel.$destroy();
}

console.log("");
console.log(`结果：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
