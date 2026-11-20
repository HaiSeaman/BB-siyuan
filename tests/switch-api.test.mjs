/**
 * 切换 API + 模型的行为。
 *
 * 这一步最容易出的错是「只换了一半」：
 * 模型名变了但 activeApiId 没变，或者反过来，
 * 结果界面上显示 A 的模型、实际请求发到 B，用户完全看不出来。
 */
import { settings, initSettings, snapshot, activeApi, updateSettings } from "../.test/settings.js";

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

initSettings({
    apis: [
        { id: "a", name: "中转站A", baseURL: "http://a/v1", apiKey: "ka", models: ["m-a1", "m-a2"], model: "m-a1" },
        { id: "b", name: "中转站B", baseURL: "http://b/v1", apiKey: "kb", models: ["m-b1"], model: "m-b1" },
    ],
    activeApiId: "a",
});

/** 和 ChatPanel.chooseModel 一样的写法（含「目标 API 不存在就不动」的校验） */
function chooseModel(apiId, model) {
    settings.update((s) => {
        if (!s.apis.some((a) => a.id === apiId)) return s;
        const apis = s.apis.map((a) => (a.id === apiId ? { ...a, model } : a));
        const next = { ...s, apis, activeApiId: apiId };
        return next;
    });
}

const cur = () => {
    const s = snapshot();
    const a = activeApi(s);
    return { id: a.id, model: a.model, base: a.baseURL, key: a.apiKey };
};

console.log("初始状态：");
check("当前是 A 的 m-a1", cur(), { id: "a", model: "m-a1", base: "http://a/v1", key: "ka" });

console.log("切到 B 的 m-b1：");
chooseModel("b", "m-b1");
check("id 和模型一起切过去了", cur(), { id: "b", model: "m-b1", base: "http://b/v1", key: "kb" });

console.log("切回 A 换另一个模型：");
chooseModel("a", "m-a2");
check("地址也跟着回到 A", cur(), { id: "a", model: "m-a2", base: "http://a/v1", key: "ka" });

console.log("B 上次选的模型要记住：");
check("B 仍是 m-b1", snapshot().apis.find((x) => x.id === "b").model, "m-b1");

console.log("切到不存在的 API 不能把状态弄坏：");
chooseModel("不存在", "m-x");
check("当前仍是 A", activeApi(snapshot()).id, "a");
check("A 的模型没被改", activeApi(snapshot()).model, "m-a2");

console.log("删掉当前 API 要自动落到另一个：");
{
    const s = snapshot();
    const next = s.apis.filter((x) => x.id !== s.activeApiId);
    updateSettings({ apis: next, activeApiId: next[0].id }, () => {});
    check("落到剩下那套", activeApi(snapshot()).id, "b");
    check("没留下悬空的 activeApiId", snapshot().activeApiId, "b");
}

console.log("");
console.log(`结果：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
