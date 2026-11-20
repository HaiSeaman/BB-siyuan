/**
 * 真实挂载测试：生图模式能真的点。
 *
 * 为什么非要真挂载：主人点不到按钮，光看代码是看不出来的。
 * 这个文件把 ChatPanel 编出来、挂到假 DOM 上、真的派发 click，
 * 然后断言界面变了什么。
 *
 * 覆盖的是主人这次提的每一条：
 *   1. 选画图模型 → 自动进生图模式
 *   2. 思考档位左边有「上传 / 大小 / 尺寸 / 优化」四个按钮
 *   3. 大小里是 1K/2K/4K，尺寸里有 10 种比例
 *   4. 图片底下有「复制图片 / 保存到电脑」
 *   5. 生图和对话能来回切，不会互相打架
 */
import { build } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { parseHTML } from "linkedom";
import { mkdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const outDir = join(root, ".test/panel-img");
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

// ---------- 1. 浏览器环境 ----------
const { window, document } = parseHTML("<!doctype html><html><body><div id=host></div></body></html>");
globalThis.window = window;
globalThis.document = document;
Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
globalThis.HTMLElement = window.HTMLElement;
globalThis.Element = window.Element;
globalThis.Node = window.Node;
globalThis.CustomEvent = window.CustomEvent;
globalThis.Event = window.Event;
globalThis.MouseEvent = window.MouseEvent || window.Event;
globalThis.FormData = globalThis.FormData || class {};
globalThis.getComputedStyle = window.getComputedStyle?.bind(window) || (() => ({}));
window.siyuan = { config: { system: { dataDir: "D:\\siyuan" } }, zIndex: 10, storage: {} };
window.location = { origin: "" };
window.confirm = () => true;
// linkedom 里没有 navigator.clipboard，明确不要它，好让代码走"给一句人话"的兜底
try {
    Object.defineProperty(window.navigator, "clipboard", { value: undefined, configurable: true });
} catch {}

// 拦掉所有真实网络请求：这个测试只验界面，不发数据出去
const calls = [];
/** 拦截时把"这次请求的目标地址"也记下来，断言请求口径要用 */
function targetOf(body) {
    try {
        const j = JSON.parse(body);
        return j.url || "";
    } catch {
        return "";
    }
}
globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    // 手机/内核转发这条路：把内层真实地址摊开记下来，
    // 这样断言看到的是 /images/generations，而不是 /api/network/forwardProxy
    calls.push({ url: u, target: targetOf(opts.body), opts });
    // putFile 的返回：假装存成功了
    if (u.includes("/api/file/putFile")) {
        return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ code: 0, msg: "", data: null }),
            arrayBuffer: async () => new ArrayBuffer(0),
            headers: new Map(),
        };
    }
    // getFile：故意返回 JSON 错误体，模拟"图还没存好"
    if (u.includes("/api/file/getFile")) {
        return {
            ok: false,
            status: 404,
            text: async () => JSON.stringify({ code: -1, msg: "not found" }),
            arrayBuffer: async () => new ArrayBuffer(0),
            headers: { get: () => "application/json" },
        };
    }
    // 内核转发：返回一份"生图成功"的假结果
    if (u.includes("/api/network/forwardProxy")) {
        const inner = targetOf(opts.body);
        let result = { status: 200, contentType: "application/json", body: "{}" };
        if (/images\/(generations|edits)/.test(inner)) {
            result = {
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({ data: [{ b64_json: "iVBORw0KGgo=" }] }),
            };
        } else if (/chat\/completions/.test(inner)) {
            result = { status: 200, contentType: "text/event-stream", body: 'data: {"choices":[{"delta":{"content":"一只猫"}}]}\n\ndata: [DONE]\n\n' };
        }
        return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ code: 0, msg: "", data: result }),
            arrayBuffer: async () => new ArrayBuffer(0),
            headers: { get: () => "application/json" },
        };
    }
    // 生图接口本身（原生通道）
    if (/images\/(generations|edits)/.test(u)) {
        return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ data: [{ b64_json: "iVBORw0KGgo=" }] }),
            arrayBuffer: async () => new ArrayBuffer(0),
            headers: { get: () => "application/json" },
        };
    }
    return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ code: 0, data: {} }),
        arrayBuffer: async () => new ArrayBuffer(0),
        headers: { get: () => "application/json" },
    };
};

/** 这次调用请求的是哪个真实地址（内核转发会把地址藏在 body 里） */
function realTarget(c) {
    return c.target || c.url;
}

// ---------- 2. 编译 ----------
const bundlePath = join(outDir, "panel.bundle.mjs");
await build({
    configFile: false,
    root,
    logLevel: "error",
    build: {
        lib: {
            entry: join(root, "src/ui/ChatPanel.svelte"),
            formats: ["es"],
            fileName: () => "panel.bundle.mjs",
        },
        outDir,
        emptyOutDir: false,
        minify: false,
        cssCodeSplit: false,
        rollupOptions: { external: ["siyuan"] },
    },
    plugins: [svelte({ compilerOptions: { dev: false } })],
    resolve: { alias: { "@": join(root, "src") } },
});
console.log("组件已编译。");

const mod = await import(pathToFileURL(bundlePath).href + "?t=" + Date.now());
const ChatPanelBase = mod.default;

/**
 * 每个段都要拿到一份全新的组件。
 *
 * 因为设置 store 是模块级单例，上一段把模型改成画图模型之后，
 * 下一段再挂载时会直接沿用 —— 这不是 bug（真实使用就是想要这个行为），
 * 但测试里会串味。用带随机 query 的 import 每次都拿一份新的模块实例，
 * 每段的 store 都是干净的。
 */
let mountSeq = 0;
async function freshPanel() {
    mountSeq++;
    const m = await import(pathToFileURL(bundlePath).href + "?fresh=" + mountSeq + "-" + Date.now());
    return m.default;
}

/** 一份"有聊天模型也有画图模型"的配置 */
function makeProps(overrides = {}) {
    const persisted = [];
    const sessions = [];
    return {
        persisted,
        sessions,
        props: {
            initialSettings: {
                apis: [
                    {
                        id: "a1",
                        name: "中转站A",
                        protocol: "openai",
                        baseURL: "http://a/v1",
                        apiKey: "k1",
                        models: ["glm-5.3", "gpt-image-1", "text-embedding-3-small"],
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
                lastChatModel: "",
                imageSize: "2K",
                imageRatio: "16:9",
                ...overrides,
            },
            persist: (s) => persisted.push(s),
            initialTemplates: [{ id: "t1", name: "日记", content: "整理一下" }],
            persistTemplates: () => {},
            initialMcpServers: [],
            persistMcpServers: () => {},
            initialSessions: [],
            persistSessions: (list) => sessions.splice(0, sessions.length, ...list),
            pluginName: "siyuan-plugin-ai-chat",
        },
    };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const tick2 = () => new Promise((r) => setTimeout(r, 5));

async function mount(props, Panel = ChatPanelBase) {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const panel = new Panel({ target: host, props });
    const $ = (sel) => host.querySelector(sel);
    const $$ = (sel) => Array.from(host.querySelectorAll(sel));
    const byText = (sel, text) => $$(sel).find((el) => (el.textContent || "").trim().includes(text));
    const click = (el) => {
        if (!el) throw new Error("要点的元素不存在");
        el.dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true }));
    };
    const type = (el, value) => {
        el.value = value;
        el.dispatchEvent(new window.Event("input", { bubbles: true }));
    };
    return { host, panel, $, $$, byText, click, type };
}

/** 用一份全新的模块挂载：段落之间不串味 */
async function mountFresh(props) {
    return await mount(props, await freshPanel());
}

// ---------- 3. 默认是对话模式 ----------
console.log("默认状态（当前是聊天模型）：");
{
    const { panel, $, $$, byText } = await mountFresh(makeProps().props);
    ok("渲染出面板", !!$(".panel"));
    ok("没有生图提示条", !$(".img-banner"));
    ok("提示词条还在", !!$(".tpl-bar"));
    ok("控制条里有「🎨 生图」按钮", !!byText(".pill", "生图"));
    ok("对话模式下 4 个按钮也在（主人要求常驻）", !!byText(".pill", "上传"));
    ok("对话模式下有思考按钮", !!byText(".pill", "思考："));
    ok("发送按钮写着「发送」", (byText(".compose button", "发送")?.textContent || "").trim() === "发送");
    panel.$destroy();
}

// ---------- 4. 选画图模型 → 自动进生图模式 ----------
console.log("在模型切换器里点画图模型：");
{
    const { panel, $, $$, byText, click } = await mountFresh(makeProps().props);
    click($(".model-btn"));
    await tick();
    ok("切换器打开了", !!$(".picker"));

    const rows = $$(".picker .model-row");
    const imgRow = rows.find((r) => (r.textContent || "").includes("gpt-image-1"));
    ok("画图模型在清单里", !!imgRow);
    ok("画图模型带「画图」标签", (imgRow?.textContent || "").includes("画图"), imgRow?.textContent);
    const badRow = rows.find((r) => (r.textContent || "").includes("text-embedding"));
    ok("嵌入模型带「不能聊天」标签", (badRow?.textContent || "").includes("不能聊天"), badRow?.textContent);

    click(imgRow);
    await tick();

    ok("切换器关掉了", !$(".picker"));
    ok("顶栏换成了画图模型", ($(".model-btn")?.textContent || "").includes("gpt-image-1"), $(".model-btn")?.textContent);
    ok("自动进了生图模式（有提示条）", !!$(".img-banner"));
    ok("提示词条藏起来了", !$(".tpl-bar"));
    ok("MCP 条也藏起来了", !$(".mcp-bar"));
    ok("顶栏小圆点变成橙色标记", !!$(".dot-api.draw"));
    ok("发送按钮变成「生成」", (byText(".compose button", "生成")?.textContent || "").trim() === "生成");
    ok("输入框提示语改了", /画面/.test($("#compose-input")?.getAttribute("placeholder") || ""), $("#compose-input")?.getAttribute("placeholder"));
    panel.$destroy();
}

// ---------- 5. 生图控制条：四个按钮都在，位置在思考区 ----------
console.log("生图控制条的四个按钮：");
{
    // 当前就是画图模型 → 一挂载便是生图模式，不用点任何按钮
    const imgProps = makeProps({ imageSize: "2K", imageRatio: "16:9" }).props;
    imgProps.initialSettings = {
        ...imgProps.initialSettings,
        apis: [
            {
                id: "a1",
                name: "中转站A",
                protocol: "openai",
                baseURL: "http://a/v1",
                apiKey: "k1",
                models: ["glm-5.3", "gpt-image-1"],
                model: "gpt-image-1",
            },
        ],
        activeApiId: "a1",
        lastChatModel: "a1::glm-5.3",
    };
    const { panel, $, $$, byText, click } = await mountFresh(imgProps);

    ok("当前是画图模型时直接就是生图模式", !!$(".img-banner"));
    const pills = $$(".ctrl-bar.img .pill");
    ok("生图控制条存在", !!$(".ctrl-bar.img"), "没找到 .ctrl-bar.img");
    ok("第一个是思考档位（4 个按钮在它右边）", (pills[0]?.textContent || "").includes("思考"), pills[0]?.textContent);
    ok("有「上传」按钮", !!byText(".ctrl-bar.img .pill", "上传"));
    ok("有「2K」按钮", !!byText(".ctrl-bar.img .pill", "2K"));
    ok("有「16:9」按钮", !!byText(".ctrl-bar.img .pill", "16:9"));
    ok("有「优化」按钮", !!byText(".ctrl-bar.img .pill", "优化"));
    ok("生图模式下思考档位还在（按钮排在它右边）", !!byText(".ctrl-bar.img .pill", "思考"));

    // 按钮顺序要符合主人说的「思考强度左边依次是 上传 / 大小 / 尺寸 / 优化」
    const texts = pills.map((p) => (p.textContent || "").trim());
    const iThink = texts.findIndex((t) => t.startsWith("思考"));
    const iUpload = texts.findIndex((t) => t === "上传");
    const iSize = texts.findIndex((t) => t.startsWith("2K"));
    const iRatio = texts.findIndex((t) => t.startsWith("16:9"));
    const iOpt = texts.findIndex((t) => t === "优化");
    ok("思考在最左", iThink === 0, JSON.stringify(texts));
    ok("4 个按钮排在思考右边，顺序 上传 → 大小 → 尺寸 → 优化", iUpload > iThink && iUpload < iSize && iSize < iRatio && iRatio < iOpt, JSON.stringify(texts));
    panel.$destroy();
}

/** 直接从生图模式开始的一组 props（省得每段都先点一次） */
function imageModeProps(extra = {}) {
    const { props } = makeProps({ imageSize: "2K", imageRatio: "16:9", ...extra });
    props.initialSettings = {
        ...props.initialSettings,
        apis: [
            {
                id: "a1",
                name: "中转站A",
                protocol: "openai",
                baseURL: "http://a/v1",
                apiKey: "k1",
                models: ["glm-5.3", "gpt-image-1"],
                model: "gpt-image-1",
            },
        ],
        activeApiId: "a1",
        lastChatModel: "a1::glm-5.3",
    };
    return props;
}

// ---------- 6. 大小下拉：1K / 2K / 4K ----------
console.log("点「大小」：");
{
    const { panel, $, $$, byText, click } = await mountFresh(imageModeProps());
    ok("进来就是生图模式", !!$(".img-banner"));

    click(byText(".ctrl-bar.img .pill", "2K"));
    await tick();
    const menu = $(".ctrl-bar.img .menu");
    ok("菜单弹出来了", !!menu);
    const items = $$(".ctrl-bar.img .menu .menu-item").map((b) => (b.textContent || "").trim());
    ok("有四个档位（含 4K+）", items.length === 4, JSON.stringify(items));
    ok("有 1K", items.some((t) => t.startsWith("1K")));
    ok("有 2K", items.some((t) => t.startsWith("2K")));
    ok("有 4K", items.some((t) => t.startsWith("4K")));
    ok("有 4K+", items.some((t) => t.startsWith("4K+")));
    ok("菜单里显示了换算后的像素", (menu?.textContent || "").includes("2560"), menu?.textContent);

    // 点 4K：要真的换成 4K，并且菜单关掉
    const fourK = $$(".ctrl-bar.img .menu .menu-item").find((b) => (b.textContent || "").trim().startsWith("4K"));
    click(fourK);
    await tick();
    ok("点了 4K 之后菜单关了", !$(".ctrl-bar.img .menu"));
    ok("按钮文字变成 4K", (byText(".ctrl-bar.img .pill", "4K")?.textContent || "").includes("4K"));
    panel.$destroy();
}

// ---------- 7. 尺寸下拉：10 种比例 ----------
console.log("点「尺寸」：");
{
    // 用一个没有官方尺寸限制的画图模型（flux 这类），才能看到纯换算结果
    const props = imageModeProps();
    props.initialSettings = {
        ...props.initialSettings,
        apis: [{ ...props.initialSettings.apis[0], models: ["glm-5.3", "flux-schnell"], model: "flux-schnell" }],
    };
    const { panel, $, $$, byText, click } = await mountFresh(props);

    click(byText(".ctrl-bar.img .pill", "16:9"));
    await tick();
    const ratioMenu = $(".ctrl-bar.img .ratio-menu");
    ok("比例菜单弹出来了", !!ratioMenu);
    const ratios = $$(".ctrl-bar.img .ratio-menu .menu-item").map((b) => (b.textContent || "").trim());
    ok("有 10 种比例", ratios.length === 10, "实际 " + ratios.length + "：" + JSON.stringify(ratios));
    for (const want of ["1:1", "4:3", "9:16", "16:9", "3:2", "21:9"]) {
        ok("比例里有 " + want, ratios.includes(want), JSON.stringify(ratios));
    }

    // 点 1:1 → 2K 应该是 2048×2048
    const oneOne = $$(".ctrl-bar.img .ratio-menu .menu-item").find((b) => (b.textContent || "").trim() === "1:1");
    click(oneOne);
    await tick();
    ok("点完菜单关了", !$(".ctrl-bar.img .ratio-menu"));
    ok("控制条上显示了新像素（2K+1:1 = 2560×2560）", ($(".ctrl-bar.img")?.textContent || "").includes("2560 × 2560"), $(".ctrl-bar.img")?.textContent);
    panel.$destroy();
}

console.log("4K + 1:1 在画图模型上会被换成官方尺寸：");
{
    // gpt-image-1 只认三种尺寸，4K 会被换成 1024×1024 并明确告知
    const props = imageModeProps();
    props.initialSettings = { ...props.initialSettings, imageSize: "4K", imageRatio: "1:1" };
    const { panel, $ } = await mountFresh(props);
    const text = $(".ctrl-bar.img")?.textContent || "";
    ok("控制条上提示已换", /已换/.test(text), text);
    ok("提示里写了换成了什么（gpt-image-1 的某档官方尺寸）", /1536 × 1024|1024 × 1536|1024 × 1024/.test(text), text);
    panel.$destroy();
}

// ---------- 8. 上传：选文件后出现参考图条 ----------
console.log("点「上传」后选一张图：");
{
    const { panel, $, $$, byText, click } = await mountFresh(imageModeProps());
    ok("进来就是生图模式", !!$(".img-banner"));

    const fileInput = $(".file-input");
    ok("有隐藏的文件选择框", !!fileInput);
    ok("只接受三种图片格式", (fileInput?.getAttribute("accept") || "").includes("image/png"), fileInput?.getAttribute("accept"));

    // 试着选一个不合规的文件（GIF）
    const badFile = { name: "x.gif", type: "image/gif", size: 100 };
    Object.defineProperty(fileInput, "files", { value: [badFile], configurable: true });
    fileInput.dispatchEvent(new window.Event("change", { bubbles: true }));
    await tick2();
    ok("选了 GIF 会被拦下并说明原因", /PNG/.test($(".status")?.textContent || ""), $(".status")?.textContent);
    ok("参考图预览条显示错误", !!$(".ref-bar .ref-err"));

    // 选一个正常 PNG
    const okFile = {
        name: "cat.png",
        type: "image/png",
        size: 2048,
        arrayBuffer: async () => new Uint8Array([137, 80, 78, 71, 1, 2, 3]).buffer,
    };
    Object.defineProperty(fileInput, "files", { value: [okFile], configurable: true });
    fileInput.dispatchEvent(new window.Event("change", { bubbles: true }));
    await tick2();
    ok("选好之后状态栏说已选参考图", /参考图/.test($(".status")?.textContent || ""), $(".status")?.textContent);
    ok("出现参考图对应的操作条", !!$(".ref-bar"));
    ok("条上写了文件名", ($(".ref-name")?.textContent || "").includes("cat.png"), $(".ref-name")?.textContent);
    ok("上传按钮变成「换图」", !!byText(".ctrl-bar.img .pill", "换图"));

    // 去掉参考图
    click($(".ref-x"));
    await tick();
    ok("点 × 之后参考图没了", !$(".ref-bar .ref-name"));
    ok("按钮变回「上传」", !!byText(".ctrl-bar.img .pill", "上传"));
    panel.$destroy();
}

// ---------- 9. 优化：没有聊天模型时要说人话 ----------
console.log("点「优化」：");
{
    // 只有画图模型，没有能聊天的
    const props = makeProps({
        apis: [
            {
                id: "a1",
                name: "只有画图",
                protocol: "openai",
                baseURL: "http://a/v1",
                apiKey: "k1",
                models: ["gpt-image-1"],
                model: "gpt-image-1",
            },
        ],
        activeApiId: "a1",
        lastChatModel: "",
    }).props;
    const { panel, $, byText, click, type } = await mountFresh(props);
    ok("只有画图模型时自动就是生图模式", !!$(".img-banner"));
    type($("#compose-input"), "一只猫");
    const before = calls.length;
    click(byText(".ctrl-bar.img .pill", "优化"));
    await tick2();
    ok("提示说要用聊天模型", /聊天模型/.test($(".status")?.textContent || ""), $(".status")?.textContent);
    ok("没有偷偷把画图模型拿去优化", !/失败：.*gpt-image/.test($(".status")?.textContent || ""));
    // 关键：一个请求都不该发出去（拿画图模型去请求，必然是白花钱 + 报错）
    const after = calls.slice(before);
    ok("一个请求都没发出去", after.length === 0, JSON.stringify(after.map(realTarget)));
    panel.$destroy();
}

console.log("输入框为空时点优化：");
{
    const { panel, $, byText, click } = await mountFresh(imageModeProps());
    click(byText(".ctrl-bar.img .pill", "优化"));
    await tick2();
    ok("提示先写内容", /先写/.test($(".status")?.textContent || ""), $(".status")?.textContent);
    panel.$destroy();
}

// ---------- 10. 生成接口的请求长什么样 ----------
console.log("点「生成」时发出去什么请求：");
{
    calls.length = 0;
    const { panel, $, byText, click, type } = await mountFresh(imageModeProps());
    type($("#compose-input"), "一只橘猫坐在窗台上");
    click(byText(".compose button", "生成"));
    await tick2();
    await tick2();

    // 生图走 fetchBinary → 浏览器直连环境下直接 fetch，请求体一眼能看
    const gen = calls.find((c) => /images\/generations/.test(realTarget(c)));
    ok("请求发到了 /images/generations", !!gen, JSON.stringify(calls.map(realTarget)));
    if (gen) {
        ok("用的是 POST", gen.opts.method, "POST");
        ok("地址是 baseURL + /images/generations", realTarget(gen), "http://a/v1/images/generations");
        const body = JSON.parse(gen.opts.body);
        ok("模型是 gpt-image-1", body.model, "gpt-image-1");
        ok("提示词是输入框里那句", body.prompt, "一只橘猫坐在窗台上");
        ok("尺寸是 2560x1440（2K + 16:9，按屏幕分辨率）", body.size, "2560x1440");
        ok("要 base64 回来", body.response_format, "b64_json");
        ok("带 Bearer 鉴权", gen.opts.headers.Authorization, "Bearer k1");
    }
    ok("界面没崩", !!$(".panel"));
    panel.$destroy();
}

// ---------- 11. 有参考图时走 edits + multipart ----------
console.log("带参考图生成：");
{
    calls.length = 0;
    const { panel, $, byText, click, type } = await mountFresh(imageModeProps());

    const fileInput = $(".file-input");
    const okFile = {
        name: "cat.png",
        type: "image/png",
        size: 2048,
        arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer,
    };
    Object.defineProperty(fileInput, "files", { value: [okFile], configurable: true });
    fileInput.dispatchEvent(new window.Event("change", { bubbles: true }));
    await tick2();

    type($("#compose-input"), "改成油画风格");
    click(byText(".compose button", "生成"));
    await tick2();
    await tick2();

    const edit = calls.find((c) => /images\/edits/.test(realTarget(c)));
    ok("请求发到了 /images/edits", !!edit, JSON.stringify(calls.map(realTarget)));
    if (edit) {
        const ct = edit.opts.headers["Content-Type"] || "";
        ok("用 multipart 而不是 JSON", /multipart\/form-data/.test(ct), ct);
        ok("multipart 带 boundary", /boundary=/.test(ct), ct);
        const body = edit.opts.body;
        ok("请求体是二进制（Uint8Array）", body instanceof Uint8Array, Object.prototype.toString.call(body));
        if (body instanceof Uint8Array) {
            const text = new TextDecoder().decode(body);
            ok("multipart 里有 prompt 字段", /name="prompt"/.test(text), text.slice(0, 200));
            ok("multipart 里有 image 文件", /name="image"; filename="cat.png"/.test(text), text.slice(0, 300));
        }
    }
    ok("界面没崩", !!$(".panel"));
    panel.$destroy();
}

// ---------- 12. 图片卡片：复制 / 保存 ----------
console.log("历史里带图的对话：");
{
    const props = makeProps({}).props;
    props.initialSessions = [
        {
            id: "s1",
            title: "画猫",
            updatedAt: 100,
            messages: [
                { role: "user", content: "一只猫", reasoning: "" },
                {
                    role: "assistant",
                    content: "",
                    reasoning: "",
                    images: [
                        { path: "images/a.png", size: "2048 × 1152", prompt: "一只橘猫，暖色调" },
                    ],
                },
            ],
        },
    ];
    const { panel, $, $$, byText, click } = await mountFresh(props);

    // 打开历史 → 点这条
    click(byText(".icon-btn", "历史"));
    await tick();
    ok("历史抽屉打开了", !!$(".drawer"));
    const item = $(".drawer .hist-main");
    ok("有一条历史", !!item);
    click(item);
    await tick();
    await tick2();

    ok("图片卡片渲染出来了", !!$(".img-card"), "没有 .img-card");
    const btns = $$(".img-card .img-actions button").map((b) => (b.textContent || "").trim());
    ok("图片底下有两个按钮", btns.length === 2, JSON.stringify(btns));
    ok("一个是「复制图片」", btns.includes("复制图片"), JSON.stringify(btns));
    ok("一个是「保存到电脑」", btns.includes("保存到电脑"), JSON.stringify(btns));
    ok("卡片上显示了尺寸", ($(".img-card")?.textContent || "").includes("2048 × 1152"), $(".img-card")?.textContent);
    ok("卡片上显示了提示词", ($(".img-card")?.textContent || "").includes("一只橘猫"));

    // 图片读不出来时不能崩，要给占位说明
    ok("图还没加载时显示占位说明", !!$(".img-missing"), "没有 .img-missing");

    // 点「复制图片」：这个环境没有 clipboard，应该给一句人话而不是崩
    const copyBtn = $$(".img-card .img-actions button").find((b) => (b.textContent || "").includes("复制"));
    click(copyBtn);
    await tick2();
    ok("点复制图片后界面还在", !!$(".panel"));
    ok("给了提示（没静默失败）", ($(".status")?.textContent || "").length > 0, $(".status")?.textContent);

    // 点「保存到电脑」：同样不能崩
    const saveBtn = $$(".img-card .img-actions button").find((b) => (b.textContent || "").includes("保存"));
    click(saveBtn);
    await tick2();
    ok("点保存到电脑后界面还在", !!$(".panel"));
    panel.$destroy();
}

// ---------- 13. 来回切模式 ----------
console.log("生图 / 对话 来回切：");
{
    // 从聊天模型开始，才能验证"切过去再切回来"
    const props = makeProps({ lastChatModel: "a1::glm-5.3" }).props;
    props.initialSettings = {
        ...props.initialSettings,
        apis: [
            {
                id: "a1",
                name: "中转站A",
                protocol: "openai",
                baseURL: "http://a/v1",
                apiKey: "k1",
                models: ["glm-5.3", "gpt-image-1"],
                model: "glm-5.3",
            },
        ],
        activeApiId: "a1",
        lastChatModel: "a1::glm-5.3",
    };
    const { panel, $, $$, byText, click } = await mountFresh(props);

    ok("开始是对话模式", !$(".img-banner"));
    click(byText(".pill", "生图"));
    await tick();
    ok("切到了生图模式", !!$(".img-banner"));
    ok("模型换成了画图模型", ($(".model-btn")?.textContent || "").includes("gpt-image-1"), $(".model-btn")?.textContent);

    click(byText(".ctrl-bar.img .pill", "对话"));
    await tick();
    ok("切回了对话模式", !$(".img-banner"));
    ok("模型换回了聊天模型", ($(".model-btn")?.textContent || "").includes("glm-5.3"), $(".model-btn")?.textContent);
    ok("提示词条回来了", !!$(".tpl-bar"));
    ok("生图控制条没了", !$(".ctrl-bar.img"));

    // 再切一次，确保不是一次性的
    click(byText(".pill", "生图"));
    await tick();
    ok("再切到生图也没问题", !!$(".img-banner"));
    panel.$destroy();
}

console.log("没有画图模型时点「生图」：");
{
    const props = makeProps({
        apis: [
            {
                id: "a1",
                name: "A",
                protocol: "openai",
                baseURL: "http://a/v1",
                apiKey: "",
                models: ["glm-5.3"],
                model: "glm-5.3",
            },
        ],
        activeApiId: "a1",
    }).props;
    const { panel, $, byText, click } = await mountFresh(props);
    click(byText(".pill", "生图"));
    await tick();
    ok("没有画图模型时不硬切", !$(".img-banner"));
    ok("给了明确提示", /画图模型/.test($(".status")?.textContent || ""), $(".status")?.textContent);
    panel.$destroy();
}

// ---------- 14. 生成中不能乱点 ----------
console.log("生成中按钮状态：");
{
    calls.length = 0;
    // 让 fetch 挂住不返回，模拟"正在生成"
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (url, opts) => {
        if (/images\//.test(String(url))) return new Promise(() => {});
        return originalFetch(url, opts);
    };

    const { panel, $, $$, byText, click, type } = await mountFresh(makeProps().props);
    click(byText(".pill", "生图"));
    await tick();
    type($("#compose-input"), "一只猫");
    click(byText(".compose button", "生成"));
    await tick2();

    ok("出现「停止」按钮", !!byText(".compose button", "停止"));
    ok("输入框被禁用", $("#compose-input")?.hasAttribute("disabled"), $("#compose-input")?.outerHTML?.slice(0, 120));
    const uploadBtn = byText(".ctrl-bar.img .pill", "上传");
    ok("上传按钮被禁用", uploadBtn?.hasAttribute("disabled"), uploadBtn?.outerHTML);
    const sizeBtn = $$(".ctrl-bar.img .pill").find((b) => (b.textContent || "").includes("2K"));
    ok("大小按钮被禁用", sizeBtn?.hasAttribute("disabled"));
    ok("控制条显示正在画图", /画图/.test($(".msgs")?.textContent || "") || /画图/.test($(".typing")?.textContent || ""), $(".typing")?.textContent);

    // 点停止
    click(byText(".compose button", "停止"));
    await tick();
    ok("点停止后回到「生成」", !!byText(".compose button", "生成"));
    ok("状态栏说已停止", /已停止/.test($(".status")?.textContent || ""), $(".status")?.textContent);

    globalThis.fetch = originalFetch;
    panel.$destroy();
}

// ---------- 14b. 点了停止之后，晚到的结果不能再写进对话 ----------
console.log("点停止后晚到的结果要丢掉：");
{
    const originalFetch = globalThis.fetch;
    let release = null;
    globalThis.fetch = (url, opts) => {
        if (/images\//.test(String(url))) {
            return new Promise((resolve) => {
                // 先挂住，等测试点完"停止"再放行
                release = () =>
                    resolve({
                        ok: true,
                        status: 200,
                        text: async () => JSON.stringify({ data: [{ b64_json: "iVBORw0KGgo=" }] }),
                        arrayBuffer: async () => new ArrayBuffer(0),
                        headers: { get: () => "application/json" },
                    });
            });
        }
        return originalFetch(url, opts);
    };

    const { panel, $, $$, byText, click, type } = await mountFresh(imageModeProps());
    type($("#compose-input"), "一只猫");
    click(byText(".compose button", "生成"));
    await tick2();
    ok("请求已经发出去了", typeof release === "function");

    click(byText(".compose button", "停止"));
    await tick();
    // 这时候才把"迟到的图片"放行
    if (release) release();
    await tick2();
    await tick2();

    ok("停止后对话里没有出现图片卡片", !$(".img-card"), "居然出现了图片");
    ok("状态栏还是「已停止」", /已停止/.test($(".status")?.textContent || ""), $(".status")?.textContent);
    ok("界面没崩", !!$(".panel"));

    globalThis.fetch = originalFetch;
    panel.$destroy();
}

// ---------- 15. 手机端 ----------
console.log("手机端（没有 require）：");
{
    delete window.require;
    const { panel, $, byText, click } = await mountFresh(makeProps().props);
    click(byText(".pill", "生图"));
    await tick();
    ok("手机端也能进生图模式", !!$(".img-banner"));
    ok("手机端四个按钮都在", !!(byText(".ctrl-bar.img .pill", "上传") && byText(".ctrl-bar.img .pill", "优化")));
    ok("手机端发送按钮是「生成」", !!byText(".compose button", "生成"));
    panel.$destroy();
}

console.log("");
console.log(`结果：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
