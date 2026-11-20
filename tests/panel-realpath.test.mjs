/** 用真实 dataDir 跑面板，验证「图片」按钮传的路径 */
import { build } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { parseHTML } from "linkedom";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const outDir = join(root, ".test/panel-realpath");
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

// 读真实 dataDir
const conf = JSON.parse(readFileSync("Z:/siyuan/conf/conf.json", "utf8"));
const realDataDir = conf.system.dataDir;
console.log("真实 dataDir:", realDataDir);

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
window.siyuan = { config: { system: { dataDir: realDataDir } }, zIndex: 10, storage: {} };
window.location = { origin: "" };

let opened = [];
window.require = (name) => {
    if (name === "fs") {
        return {
            existsSync: (p) => existsSync(p),
            readFileSync: () => "",
        };
    }
    if (name === "@electron/remote") {
        return {
            shell: {
                openPath: async (p) => {
                    opened.push(p);
                    return "";
                },
            },
            dialog: null,
        };
    }
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

const mod = await import(pathToFileURL(bundle).href + "?" + Date.now());
const host = document.createElement("div");
document.body.appendChild(host);

const panel = new mod.default({
    target: host,
    props: {
        initialSettings: {
            apis: [{ id: "a1", name: "V3", protocol: "openai", baseURL: "https://api.gpt.ge/v1", apiKey: "k", models: ["gpt-image-2.6-sunburst"], picked: ["gpt-image-2.6-sunburst"], model: "gpt-image-2.6-sunburst" }],
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
        },
        persist: () => {},
        initialTemplates: [],
        persistTemplates: () => {},
        initialMcpServers: [],
        persistMcpServers: () => {},
        initialSessions: [],
        persistSessions: () => {},
        pluginName: "siyuan-plugin-ai-chat",
    },
});

const $ = (s) => host.querySelector(s);
const $$ = (s) => Array.from(host.querySelectorAll(s));
const byText = (t) => $$(".ctrl-bar .pill").find((e) => (e.textContent || "").trim() === t);

console.log("\n点「图片」按钮：");
const btn = byText("图片");
ok("找得到「图片」按钮", !!btn, $$(".ctrl-bar .pill").map((e) => e.textContent.trim()).join("|"));
btn.dispatchEvent(new window.Event("click", { bubbles: true }));
await new Promise((r) => setTimeout(r, 60));

const want = "Z:\\siyuan\\data\\storage\\petal\\siyuan-plugin-ai-chat\\images";
ok("调用了 openPath", opened.length === 1, "次数 " + opened.length);
ok("传的路径完全正确", opened[0] === want, opened[0]);
ok("路径里没有 data\\data", !(opened[0] || "").includes("data\\data"), opened[0]);
ok("真实目录存在", existsSync(want));
ok("状态栏说已打开", /已打开/.test($(".status")?.textContent || ""), $(".status")?.textContent);

console.log("");
console.log(`结果：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
