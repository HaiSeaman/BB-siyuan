/**
 * 验证「绑定模板后，每条消息都经过模板」这条需求。
 * 模拟：绑定模板 → 发第一条 → 追问第二条 → 再追问第三条，
 * 逐条检查 system 里是否都带着模板规则。
 */
import { buildTurnPlan } from "../.test/turnplan.js";
import { bodyFor } from "../.test/providers.js";

const ctx = { date: "2026-11-18", time: "21:30", weekday: "星期三", docTitle: "我的日记" };
const tpl = {
    id: "t-diary",
    name: "日记整理",
    content: "你是日记整理助手。严格按规则输出。",
    order: 0,
};

const cfg = {
    baseURL: "http://x/v1",
    apiKey: "k",
    model: "m",
    temperature: 0.7,
    maxTokens: 100,
    thinking: "off",
};

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

// 模拟界面里的 messages 累积（和历史裁剪逻辑一致）
const shown = [];

// ---- 第 1 条 ----
let plan = buildTurnPlan({
    template: tpl,
    userText: "",
    ctx,
    history: [],
});
let body = bodyFor("openai", cfg, plan.messages, plan.system, []);
const sys1 = body.messages.find((m) => m.role === "system");
check("第1条：带模板规则", sys1.content.includes("你是日记整理助手"), true);

shown.push({ role: "user", content: "（按模板生成）" });
shown.push({ role: "assistant", content: "第一版整理结果" });

// ---- 第 2 条：追问 ----
plan = buildTurnPlan({
    template: tpl,
    userText: "把语气改得更轻松一点",
    ctx,
    history: shown.map((m) => ({ role: m.role, content: m.content })),
});
body = bodyFor("openai", cfg, plan.messages, plan.system, []);
const sys2 = body.messages.find((m) => m.role === "system");
check("第2条：模板规则仍在", sys2.content.includes("你是日记整理助手"), true);
check("第2条：最后一条是用户新要求", body.messages[body.messages.length - 1].content, "把语气改得更轻松一点");

shown.push({ role: "user", content: "把语气改得更轻松一点" });
shown.push({ role: "assistant", content: "第二版" });

// ---- 第 3 条：再追问 ----
plan = buildTurnPlan({
    template: tpl,
    userText: "再写一段结尾",
    ctx,
    history: shown.map((m) => ({ role: m.role, content: m.content })),
});
body = bodyFor("openai", cfg, plan.messages, plan.system, []);
const sys3 = body.messages.find((m) => m.role === "system");
check("第3条：模板规则仍在", sys3.content.includes("你是日记整理助手"), true);

// ---- 没绑定模板时不带任何规则 ----
plan = buildTurnPlan({
    template: null,
    userText: "随便聊一句",
    ctx,
    history: [],
});
body = bodyFor("openai", cfg, plan.messages, plan.system, []);
check("退出模板后：没有 system 消息", body.messages.some((m) => m.role === "system"), false);
check("退出模板后：用户那句话照发", body.messages[body.messages.length - 1].content, "随便聊一句");

console.log("");
console.log(`结果：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
