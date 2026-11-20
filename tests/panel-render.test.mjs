/**
 * 真实挂载测试：把 ChatPanel 真正渲染出来，逐个点按钮，看状态有没有变。
 *
 * 为什么非做不可：主人反馈「所有 UI 按键都点不动」。
 * 只读代码只能猜，这个测试能给出确定答案 ——
 * 事件到底绑上没有、点了有没有反应。
 *
 * 用 Vite 编译（项目本来就用它，子组件解析一定没问题），
 * 挂到 linkedom 的假 DOM 上，然后 dispatchEvent 模拟点击。
 */
import { build } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { parseHTML } from "linkedom";
import { mkdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const outDir = join(root, ".test/panel");
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

// ---------- 1. 准备浏览器环境 ----------
const { window, document } = parseHTML("<!doctype html><html><body><div id=host></div></body></html>");
globalThis.window = window;
globalThis.document = document;
// Node 里 navigator 是只读 getter，只能 defineProperty 覆盖
Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
globalThis.HTMLElement = window.HTMLElement;
globalThis.Element = window.Element;
globalThis.Node = window.Node;
globalThis.CustomEvent = window.CustomEvent;
globalThis.Event = window.Event;
globalThis.getComputedStyle = window.getComputedStyle?.bind(window) || (() => ({}));
// 思源的环境变量
window.siyuan = {
    config: { system: { dataDir: "/tmp/x" } },
    zIndex: 10,
    storage: {},
};
window.location = { origin: "http://127.0.0.1:6806" };

// ---------- 2. 编译组件（用 Vite，和正式构建同一条链） ----------
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
        outDir: outDir,
        emptyOutDir: false,
        minify: false,
        cssCodeSplit: false,
        rollupOptions: {
            external: ["siyuan"],
        },
    },
    plugins: [svelte({ compilerOptions: { dev: false } })],
    resolve: { alias: { "@": join(root, "src") } },
});
console.log("组件已编译。");

// ---------- 3. 挂载 ----------
// Windows 上必须用 file:// URL 才能动态 import
const mod = await import(pathToFileURL(bundlePath).href + "?t=" + Date.now());
const ChatPanel = mod.default;

const persisted = [];
const props = {
    initialSettings: {
        apis: [
            {
                id: "a1",
                name: "中转站A",
                protocol: "openai",
                baseURL: "http://a/v1",
                apiKey: "k1",
                models: ["m1", "m2"],
                model: "m1",
            },
            {
                id: "b1",
                name: "中转站B",
                protocol: "openai",
                baseURL: "http://b/v1",
                apiKey: "k2",
                models: ["n1"],
                model: "n1",
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
    },
    persist: (s) => persisted.push(s),
    initialTemplates: [{ id: "t1", name: "日记", content: "整理一下" }],
    persistTemplates: () => {},
    initialMcpServers: [],
    persistMcpServers: () => {},
    initialSessions: [],
    persistSessions: () => {},
};

const host = document.getElementById("host");
const panel = new ChatPanel({ target: host, props });

const $ = (sel) => host.querySelector(sel);
const $$ = (sel) => Array.from(host.querySelectorAll(sel));
const byText = (sel, text) => $$(sel).find((el) => (el.textContent || "").trim().includes(text));
const click = (el) => {
    if (!el) throw new Error("要点的元素不存在");
    // linkedom 没实现 MouseEvent，用普通 Event 带 type=click 就够了，Svelte 只监听 type
    const ev = new window.Event("click", { bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
};

/** Svelte 的状态更新是微任务，等一拍再断言 */
const tick = () => new Promise((r) => setTimeout(r, 0));

console.log("组件挂载后基本结构：");
ok("渲染出面板根元素", !!$(".panel"));
ok("渲染出顶栏", !!$(".topbar"));
ok("顶栏有模型按钮", !!$(".model-btn"));
const iconBtns = $$(".icon-btn");
ok("顶栏按钮不止一个", iconBtns.length >= 3, "实际 " + iconBtns.length);

console.log("点「设置」按钮（⚙）应当打开抽屉：");
{
    const gear = $(".icon-btn.gear");
    ok("找得到设置按钮", !!gear);
    click(gear);
    await tick();
    ok("抽屉出现了", !!$(".drawer"), "drawer 不存在");
    if ($(".drawer")) {
        const body = $(".drawer-body");
        ok("抽屉里有内容（设置页挂上了）", !!body && (body.textContent || "").length > 20);
    }
}

console.log("点抽屉的 × 应当关掉：");
{
    const x = $(".drawer .x");
    ok("找得到关闭按钮", !!x);
    if (x) {
        click(x);
        await tick();
        ok("抽屉关掉了", !$(".drawer"));
    }
}

console.log("点「新对话」：");
{
    const ta = $("#compose-input");
    ok("有输入框", !!ta);
    const newBtn = byText(".icon-btn", "新对话");
    ok("找得到新对话按钮", !!newBtn);
    if (newBtn) {
        click(newBtn);
        await tick();
        ok("点完没有报错，界面还在", !!$(".panel"));
    }
}

console.log("点模型按钮应当展开切换器：");
{
    const modelBtn = $(".model-btn");
    click(modelBtn);
    await tick();
    ok("切换器出现了", !!$(".picker"));
    ok("切换器包在 picker-layer 里", !!$(".picker-layer"));
    ok("遮罩也在 layer 里", !!$(".picker-layer .picker-mask"));
    const layer = $(".picker-layer");
    ok("layer 的父节点就是面板", layer && layer.parentElement === $(".panel"));
    ok("顶栏按钮仍然存在且可点（不被移除）", !!$(".model-btn"));

    console.log("在切换器里点另一个模型：");
    const rows = $$(".picker .model-row");
    ok("列出的模型行数正确", rows.length === 3, "实际 " + rows.length);
    const target = rows.find((r) => (r.textContent || "").includes("n1"));
    ok("找得到 B 的模型 n1", !!target);
    if (target) {
        click(target);
        await tick();
        ok("点完切换器关闭", !$(".picker"));
        const txt = $(".model-btn").textContent || "";
        ok("顶栏换成了 B · n1", txt.includes("中转站B") && txt.includes("n1"), txt);
    }
}

console.log("再点一次模型按钮，点遮罩应当关闭：");
{
    click($(".model-btn"));
    await tick();
    ok("切换器又打开了", !!$(".picker"));
    const mask = $(".picker-mask");
    ok("遮罩存在", !!mask);
    if (mask) {
        click(mask);
        await tick();
        ok("点遮罩后关闭", !$(".picker"));
    }
}

console.log("点「管理」应当打开模板抽屉：");
{
    const mgr = byText(".icon-btn", "管理");
    ok("找得到管理按钮", !!mgr);
    if (mgr) {
        click(mgr);
        await tick();
        ok("抽屉打开了", !!$(".drawer"));
        const title = $(".drawer-head");
        ok("抽屉标题是提示词管理", (title?.textContent || "").includes("提示词"), title?.textContent);
        const x = $(".drawer .x");
        if (x) {
            click(x);
            await tick();
            ok("关掉了", !$(".drawer"));
        }
    }
}

console.log("手机端形态（没有 require）：");
{
    // 卸载后以「手机」身份重挂
    panel.$destroy();
    delete window.require;
    const host2 = document.createElement("div");
    document.body.appendChild(host2);
    const p2 = new ChatPanel({ target: host2, props });
    const local = (sel) => host2.querySelector(sel);
    const localAll = (sel) => Array.from(host2.querySelectorAll(sel));

    ok("手机端有「显示在侧栏」按钮", localAll(".icon-btn").some((b) => (b.textContent || "").includes("显示在侧栏")));
    const mb = local(".model-btn");
    mb.dispatchEvent(new window.Event("click", { bubbles: true }));
    await tick();
    const picker = local(".picker");
    ok("手机端切换器出现", !!picker);
    ok("手机端切换器带 sheet 样式", (picker?.className || "").includes("sheet"));
    // 手机端也不许盖住顶栏
    ok("手机端 layer 同样只覆盖对话区", !!local(".picker-layer"));
    p2.$destroy();
}

// ---------- 4. 我发的消息：复制 / 重发 ----------
console.log("我发出的消息带「复制」「重发」：");
{
    // 前一段把 panel 销毁了，这里重挂一个干净的
    const host3 = document.createElement("div");
    document.body.appendChild(host3);
    const p3 = new ChatPanel({ target: host3, props: { ...props, initialSessions: [] } });
    const local = (sel) => host3.querySelector(sel);
    const localAll = (sel) => Array.from(host3.querySelectorAll(sel));
    const clickIn = (el) => el.dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true }));

    // 造一条「我发的」消息：往输入框里写，然后点发送。
    // 网络不通没关系，气泡会先出现，我们只看按钮。
    const ta = local("#compose-input");
    ok("有输入框", !!ta);
    // linkedom 没有内置的 input 事件，用 window.Event 造一个最能被 Svelte 认到的
    ta.value = "这是一句测试原话";
    ta.dispatchEvent(new window.Event("input", { bubbles: true }));
    await tick();

    const sendBtn = local(".compose button.primary");
    ok("有发送按钮", !!sendBtn);
    clickIn(sendBtn);
    await tick();

    const mine = localAll(".row.me .bubble .plain");
    ok("我的消息渲染出来了", mine.length === 1, "实际 " + mine.length);
    ok("消息内容就是原话", (mine[0]?.textContent || "").includes("这是一句测试原话"), mine[0]?.textContent);

    const acts = localAll(".row.me .mine-actions .copy");
    ok("我的气泡下面有两个按钮", acts.length === 2, "实际 " + acts.length);
    ok("一个是复制", acts.some((b) => (b.textContent || "").includes("复制")));
    ok("一个是重发", acts.some((b) => (b.textContent || "").trim() === "重发"));

    // 点「复制」：桌面端没有 navigator.clipboard 时走兜底 document.execCommand，
    // linkedom 里没有就返回 false，按钮保持原文。这里只验证点击不崩、界面还在。
    const copyBtn = acts.find((b) => (b.textContent || "").includes("复制"));
    if (copyBtn) {
        clickIn(copyBtn);
        await tick();
        ok("点复制后界面还在（没崩）", !!local(".panel"));
    }

    // 点「重发」：不能新增消息，只能是同一组「原话 + 回答」重新生成
    const beforeCount = localAll(".row").length;
    const beforeMine = localAll(".row.me .bubble .plain").length;
    const resendBtn = acts.find((b) => (b.textContent || "").trim() === "重发");
    if (resendBtn) {
        clickIn(resendBtn);
        await tick();
        await tick();
        const afterCount = localAll(".row").length;
        const afterMine = localAll(".row.me .bubble .plain").length;
        ok("点重发后消息条数不变（不新增一组）", afterCount === beforeCount, beforeCount + " → " + afterCount);
        ok("我发的消息还是只有一条", afterMine === beforeMine, beforeMine + " → " + afterMine);
        const mineTexts = localAll(".row.me .bubble .plain").map((e) => (e.textContent || "").trim());
        ok("原话没被改动", mineTexts.filter((t) => t === "这是一句测试原话").length === 1, JSON.stringify(mineTexts));
    }
    p3.$destroy();
}

// ---------- 5. 设置页：点模型名要真的切过去 ----------
console.log("设置页点模型名必须切换当前 API：");
{
    const host4 = document.createElement("div");
    document.body.appendChild(host4);
    const p4 = new ChatPanel({ target: host4, props: { ...props, initialSessions: [] } });
    const local = (sel) => host4.querySelector(sel);
    const localAll = (sel) => Array.from(host4.querySelectorAll(sel));
    const clickIn = (el) => el.dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true }));

    // 打开设置
    clickIn(local(".icon-btn.gear"));
    await tick();
    ok("设置抽屉打开了", !!local(".drawer"));

    const cards = localAll(".drawer .api-card");
    ok("两张 API 卡片都在", cards.length === 2, "实际 " + cards.length);

    // B 卡片名是 input，文字里看不到名字，所以内容用地址/模型判断
    const cardB = cards[1];
    ok("第二张卡是 B（看地址和模型）", (cardB?.textContent || "").includes("http://b/v1") && (cardB?.textContent || "").includes("n1"), cardB?.textContent);

    // 先把当前切回 A，这样后面点 B 才是在验证「切换」，而不是本来就对
    const useB = Array.from(localAll(".drawer .api-card")[1].querySelectorAll(".card-btn")).find((b) =>
        (b.textContent || "").includes("设为当前")
    );
    if (useB) {
        clickIn(useB);
        await tick();
    }
    const useA2 = Array.from(localAll(".drawer .api-card")[0].querySelectorAll(".card-btn")).find((b) =>
        (b.textContent || "").includes("设为当前")
    );
    if (useA2) {
        clickIn(useA2);
        await tick();
    }
    const beforeBar = local(".model-btn")?.textContent || "";
    ok("点之前顶栏是 A 的模型", beforeBar.includes("m1"), beforeBar);

    // 第二张卡（B）还没展开，点它展开
    const expand = localAll(".drawer .api-card")[1].querySelector(".collapsed");
    ok("B 有展开按钮", !!expand);
    if (expand) {
        clickIn(expand);
        await tick();
    }

    // 在 B 的卡片里点模型名
    const cardB2 = localAll(".drawer .api-card")[1];
    const chipsB = Array.from(cardB2.querySelectorAll(".model-chip .chip-name"));
    ok("B 卡片里能看到模型 n1", chipsB.some((c) => (c.textContent || "").trim() === "n1"), JSON.stringify(chipsB.map((c) => c.textContent)));
    const targetChip = chipsB.find((c) => (c.textContent || "").trim() === "n1");
    if (targetChip) {
        clickIn(targetChip);
        await tick();
        // 顶栏必须跟着变成 B · n1（这正是以前「点了没反应」的地方）
        const bar = local(".model-btn")?.textContent || "";
        ok("顶栏变成了 n1（真的切过去了）", bar.includes("n1"), bar);
        const res = local(".drawer .res")?.textContent || "";
        ok("给出了已切换的提示", /已切到/.test(res), res);
    }

    // 「清除其他模型」：只清没选中的，当前选中的必须留着
    // 先用一张「多模型」的新 API 卡片来测（一行一个模型才看得出清没清）
    window.confirm = () => true;
    const addApiBtn = localAll(".drawer .add-api")[0];
    ok("有「添加 API」按钮", !!addApiBtn);
    if (addApiBtn) {
        clickIn(addApiBtn);
        await tick();
        // 新卡会自动展开，往里面塞三个模型并选中第二个
        const addInput = localAll(".drawer .model-add input").pop();
        const addBtn = Array.from(localAll(".drawer .model-add button")).filter((b) => (b.textContent || "").trim() === "添加").pop();
        ok("新卡片有模型输入框", !!addInput);
        if (addInput && addBtn) {
            for (const name of ["m-one", "m-two", "m-three"]) {
                addInput.value = name;
                addInput.dispatchEvent(new window.Event("input", { bubbles: true }));
                await tick();
                clickIn(Array.from(localAll(".drawer .model-add button")).filter((b) => (b.textContent || "").trim() === "添加").pop());
                await tick();
            }
            const card = localAll(".drawer .api-card").pop();
            const chips = Array.from(card.querySelectorAll(".model-chip .chip-name"));
            ok("三个模型都在", chips.length === 3, "实际 " + chips.length);
            const pick = chips.find((c) => (c.textContent || "").trim() === "m-two");
            if (pick) {
                clickIn(pick);
                await tick();
            }
            const clearBtn2 = card.querySelector(".clear-all");
            ok("有「清除其他模型」按钮", !!clearBtn2);
            if (clearBtn2) {
                const beforeChips = card.querySelectorAll(".model-chip").length;
                clickIn(clearBtn2);
                await tick();
                const nowCard = localAll(".drawer .api-card").pop();
                const afterChips = nowCard.querySelectorAll(".model-chip").length;
                ok("点清除后模型变少", afterChips < beforeChips, beforeChips + " → " + afterChips);
                ok("只剩一个模型", afterChips === 1, "实际 " + afterChips);
                const kept = Array.from(nowCard.querySelectorAll(".model-chip .chip-name")).map((c) => (c.textContent || "").trim());
                ok("留下的是选中的 m-two", kept.length === 1 && kept[0] === "m-two", JSON.stringify(kept));
                ok("留下的那个仍是选中态", nowCard.querySelectorAll(".model-chip.active").length === 1);
                const resText = nowCard.querySelector(".res")?.textContent || "";
                ok("清完提示了已清除", /已清除/.test(resText), resText);
                ok("清完界面还在（没崩）", !!local(".panel"));
            }
        }
    }
    p4.$destroy();
}

// ---------- 6. 历史对话：一键清空全部 ----------
console.log("历史对话一键清空：");
{
    const host5 = document.createElement("div");
    document.body.appendChild(host5);
    const p5 = new ChatPanel({
        target: host5,
        props: {
            ...props,
            initialSessions: [
                { id: "s1", title: "第一个对话", messages: [{ role: "user", content: "a", reasoning: "" }], updatedAt: 1 },
                { id: "s2", title: "第二个对话", messages: [{ role: "user", content: "b", reasoning: "" }], updatedAt: 2 },
            ],
        },
    });
    const local = (sel) => host5.querySelector(sel);
    const localAll = (sel) => Array.from(host5.querySelectorAll(sel));
    const clickIn = (el) => el.dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true }));

    clickIn(localAll(".icon-btn").find((b) => (b.textContent || "").includes("历史")));
    await tick();
    ok("历史抽屉打开了", !!local(".drawer"));

    ok("有两条历史", localAll(".drawer .hist-item").length === 2, "实际 " + localAll(".drawer .hist-item").length);
    const clearHist = local(".drawer .clear-hist");
    ok("有「清空全部历史」按钮", !!clearHist);
    ok("按钮上写了几条", /2 个/.test(clearHist?.textContent || ""), clearHist?.textContent);

    if (clearHist) {
        window.confirm = () => true;
        clickIn(clearHist);
        await tick();
        ok("历史被清空了", localAll(".drawer .hist-item").length === 0, "还剩 " + localAll(".drawer .hist-item").length);
        ok("显示了已清空提示", /已清空/.test(local(".status")?.textContent || ""), local(".status")?.textContent);
        ok("清完界面还在（没崩）", !!local(".panel"));
    }

    // 点取消（confirm 返回 false）时不能删掉任何东西
    const host6 = document.createElement("div");
    document.body.appendChild(host6);
    const p6 = new ChatPanel({
        target: host6,
        props: {
            ...props,
            initialSessions: [
                { id: "t1", title: "要保留的对话", messages: [{ role: "user", content: "x", reasoning: "" }], updatedAt: 3 },
            ],
        },
    });
    const l6 = (sel) => host6.querySelector(sel);
    const l6all = (sel) => Array.from(host6.querySelectorAll(sel));
    l6all(".icon-btn")
        .find((b) => (b.textContent || "").includes("历史"))
        ?.dispatchEvent(new window.Event("click", { bubbles: true }));
    await tick();
    window.confirm = () => false; // 用户点了「取消」
    const cancelBtn = l6(".drawer .clear-hist");
    ok("取消测试找到了按钮", !!cancelBtn);
    if (cancelBtn) {
        cancelBtn.dispatchEvent(new window.Event("click", { bubbles: true }));
        await tick();
        ok("点了取消，历史一条都没少", l6all(".drawer .hist-item").length === 1, "实际 " + l6all(".drawer .hist-item").length);
    }
    p6.$destroy();

    p5.$destroy();
}

// ---------- 7. 重发中间那条：后面的对话不能被挤掉 ----------
console.log("重发中间那条消息：");
{
    const host7 = document.createElement("div");
    document.body.appendChild(host7);
    const p7 = new ChatPanel({
        target: host7,
        props: {
            ...props,
            // 载入一段现成的两轮对话，避免两次发送被「正在生成」拦住
            initialSessions: [
                {
                    id: "hist1",
                    title: "两轮对话",
                    updatedAt: 100,
                    messages: [
                        { role: "user", content: "第一句", reasoning: "" },
                        { role: "assistant", content: "第一个回答", reasoning: "" },
                        { role: "user", content: "第二句", reasoning: "" },
                        { role: "assistant", content: "第二个回答", reasoning: "" },
                    ],
                },
            ],
        },
    });
    const l7 = (sel) => host7.querySelector(sel);
    const l7all = (sel) => Array.from(host7.querySelectorAll(sel));
    const click7 = (el) => el.dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true }));

    // 从历史抽屉里把这段对话打开
    click7(l7all(".icon-btn").find((b) => (b.textContent || "").includes("历史")));
    await tick();
    click7(l7(".drawer .hist-main"));
    await tick();

    const mineBubbles = () => l7all(".row.me .bubble .plain").map((e) => (e.textContent || "").trim());
    const aiBubbles = () => l7all(".row.ai .bubble").map((e) => (e.textContent || "").trim());
    ok("载入了两轮对话", mineBubbles().length === 2, JSON.stringify(mineBubbles()));
    ok("两个回答都在", aiBubbles().length === 2, JSON.stringify(aiBubbles()));

    // 点第一条「第一句」上的重发
    const firstRow = l7all(".row.me")[0];
    const resendFirst = Array.from(firstRow.querySelectorAll(".mine-actions .copy")).find(
        (b) => (b.textContent || "").trim() === "重发"
    );
    ok("第一句上有重发按钮", !!resendFirst);
    ok("第一句是第一句", (firstRow.textContent || "").includes("第一句"), firstRow.textContent);
    const rowsBefore = l7all(".row").length;
    if (resendFirst) {
        click7(resendFirst);
        await tick();
        await tick();
        ok("重发后消息总数没变", l7all(".row").length === rowsBefore, rowsBefore + " → " + l7all(".row").length);
        ok("两句原话都还在", mineBubbles().length === 2, JSON.stringify(mineBubbles()));
        ok("顺序没乱：第一句在前", mineBubbles()[0] === "第一句", JSON.stringify(mineBubbles()));
        ok("第二句没被吃掉", mineBubbles()[1] === "第二句", JSON.stringify(mineBubbles()));
        ok("重发的是第一条，不是最后一条", l7all(".row.me")[0].textContent.includes("第一句"));
    }
    p7.$destroy();
}

console.log("");
console.log(`结果：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
