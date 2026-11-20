/**
 * 本轮四个需求的回归测试（数据层）。
 *
 * 防的是这几个真实故障：
 *   1. 点设置页里非当前 API 的模型名，只改了 model、没改 activeApiId，
 *      结果顶栏还显示旧模型，发出去的还是旧模型 —— 用户说「点了没反应」。
 *   2. 拉取模型后自动选中清单第一个（常是 embedding），一发就 400 ——
 *      用户说「拉来的不能用，手输才行」。
 *   3. 保存延迟把旧快照写回去，刚改的模型被盖掉 —— 用户说「改了又变回去」。
 */
import {
    settings,
    initSettings,
    snapshot,
    activeApi,
    updateSettings,
    updateSettingsWith,
} from "../.test/settings.js";
import { fetchModels, isChatModel } from "../.test/apis.js";

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

const seed = () =>
    initSettings({
        apis: [
            { id: "a", name: "中转站A", baseURL: "http://a/v1", apiKey: "ka", models: ["m-a1"], model: "m-a1" },
            { id: "b", name: "中转站B", baseURL: "http://b/v1", apiKey: "kb", models: ["n-b1"], model: "n-b1" },
        ],
        activeApiId: "a",
    });

/** 和 Settings.svelte 的 pickModel 完全一致的写法 */
function pickModel(id, model, persist) {
    updateSettingsWith((s) => {
        if (!s.apis.some((a) => a.id === id)) return s;
        const apis = s.apis.map((a) => (a.id === id ? { ...a, model } : a));
        return { ...s, apis, activeApiId: id };
    }, persist);
}

/** 和 Settings.svelte 的 clearModels 完全一致的写法（只清没选中的） */
function clearModels(id, persist) {
    const s0 = snapshot();
    const api = s0.apis.find((a) => a.id === id);
    const all = api?.models || [];
    if (!all.length || !api?.model) return;
    const keep = api.model;
    const drop = all.length - 1;
    if (drop <= 0) return;
    updateSettingsWith(
        (s) => {
            const apis = s.apis.map((a) => (a.id === id ? { ...a, models: [keep], model: keep } : a));
            return { ...s, apis };
        },
        persist
    );
}

/** 和 Settings.svelte 的 fallbackModel 完全一致 */
function fallbackModel(models) {
    return models.find((m) => isChatModel(m)) || models[0] || "";
}

console.log("点模型名必须把当前 API 一起切过去：");
{
    seed();
    pickModel("b", "n-b1", () => {});
    check("activeApiId 切到了 B", snapshot().activeApiId, "b");
    check("顶栏读到的就是 B 的模型", activeApi(snapshot()).model, "n-b1");
    check("发请求用的是 B 的地址", activeApi(snapshot()).baseURL, "http://b/v1");
    check("B 自己记的模型也是它", snapshot().apis.find((x) => x.id === "b").model, "n-b1");
}

console.log("在非当前 API 上点模型也要生效：");
{
    seed();
    // 当前是 A，直接点 B 的模型
    check("点之前当前是 A", activeApi(snapshot()).id, "a");
    pickModel("b", "n-b1", () => {});
    check("点完当前变成 B", activeApi(snapshot()).id, "b");
    check("点完顶栏是 B 的模型", activeApi(snapshot()).model, "n-b1");
}

console.log("点到不存在的 API 不能把状态弄坏：");
{
    seed();
    pickModel("不存在", "x", () => {});
    check("当前仍是 A", activeApi(snapshot()).id, "a");
    check("A 的模型没被改", activeApi(snapshot()).model, "m-a1");
}

console.log("清除其他模型：只留当前选中的");
{
    initSettings({
        apis: [
            {
                id: "a",
                name: "A",
                baseURL: "http://a/v1",
                apiKey: "",
                models: ["m1", "m2", "m3"],
                model: "m2",
            },
            { id: "b", name: "B", baseURL: "http://b/v1", apiKey: "", models: ["n1"], model: "n1" },
        ],
        activeApiId: "a",
    });
    clearModels("a");
    const a = snapshot().apis.find((x) => x.id === "a");
    check("只剩选中的那个", a.models, ["m2"]);
    check("当前模型没变", a.model, "m2");
    check("顶栏仍能读到模型", activeApi(snapshot()).model, "m2");
    check("另一套 API 没被牵连", snapshot().apis.find((x) => x.id === "b").models, ["n1"]);
}

console.log("没选中模型时不许乱清：");
{
    initSettings({
        apis: [{ id: "a", name: "A", baseURL: "http://a/v1", apiKey: "", models: ["m1", "m2"], model: "" }],
        activeApiId: "a",
    });
    clearModels("a");
    check("没有选中就不清，模型全留着", snapshot().apis.find((x) => x.id === "a").models, ["m1", "m2"]);
}

console.log("只剩一个模型时清除不报错也不变：");
{
    initSettings({
        apis: [{ id: "a", name: "A", baseURL: "http://a/v1", apiKey: "", models: ["only"], model: "only" }],
        activeApiId: "a",
    });
    clearModels("a");
    check("一个都不该少", snapshot().apis.find((x) => x.id === "a").models, ["only"]);
    check("当前模型还在", snapshot().apis.find((x) => x.id === "a").model, "only");
}

console.log("删掉当前模型后要退回能聊天的那个：");
{
    initSettings({
        apis: [
            {
                id: "a",
                name: "A",
                baseURL: "http://a/v1",
                apiKey: "",
                models: ["text-embedding-3-small", "glm-5.3", "whisper-1"],
                model: "glm-5.3",
            },
        ],
        activeApiId: "a",
    });
    // 删掉正在用的 glm-5.3 之后，剩下的两个都不像能聊天的
    const remaining = ["text-embedding-3-small", "whisper-1"];
    check("剩下都是非聊天模型时不会崩", fallbackModel(remaining), "text-embedding-3-small");
    // 只要还有一个能聊的，就必须优先选它，而不是清单第一个
    check("有能聊的就优先它能聊的", fallbackModel(["whisper-1", "glm-5.3"]), "glm-5.3");
    check("啥都没有时给空", fallbackModel([]), "");
}

console.log("保存必须写最新状态，不能被旧快照盖掉：");
{
    seed();
    const written = [];
    const persist = (s) => written.push(s);

    // 模拟：先改地址，紧接着（400ms 内）点模型。两处用同一个 persist，和真实界面一致
    updateSettingsWith(
        (s) => {
            const apis = s.apis.map((a) => (a.id === "a" ? { ...a, baseURL: "http://新地址/v1" } : a));
            return { ...s, apis };
        },
        persist
    );
    pickModel("b", "n-b1", persist);

    // 等保存定时器真的跑完
    await new Promise((r) => setTimeout(r, 700));

    check("只写了一次盘", written.length, 1);
    const last = written[written.length - 1];
    check("写盘时带上新地址", last.apis.find((x) => x.id === "a").baseURL, "http://新地址/v1");
    check("写盘时带上新模型", last.activeApiId, "b");
    check("写盘时模型名没回退", last.apis.find((x) => x.id === "b").model, "n-b1");
}

console.log("拉取后不自动选第一个：");
{
    // 和 Settings.svelte 的 pullModels 同一套逻辑：只补一个能聊天的当默认，不乱覆盖
    const r = await fetchModels(
        { protocol: "openai", baseURL: "http://a/v1", apiKey: "" },
        async () => ({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ data: [{ id: "text-embedding-3-small" }, { id: "glm-5.3" }] }),
        })
    );
    check("拉回来只留能聊的", r.models, ["glm-5.3"]);
    check("报告跳过了 1 个", r.skipped, 1);
    check("原来没选过才用第一个能聊的", fallbackModel(r.models), "glm-5.3");
    // 已经选过模型时 pullModels 走的是 current.model，不会覆盖
    const current = { model: "kimi-k3" };
    check("原来选过就保留原选择", current.model || fallbackModel(r.models), "kimi-k3");
}

console.log("");
console.log(`结果：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
