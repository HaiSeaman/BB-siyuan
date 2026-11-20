/**
 * 模板套用到对话。
 * 关键规则：
 *   - 模板正文进 system
 *   - 没有「素材」概念，也没有 {{content}}
 *   - 追问时模板仍然生效
 */
import { buildTurnPlan } from "../.test/turnplan.js";

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

const ctx = {
    date: "2026-11-18",
    time: "21:30",
    weekday: "星期三",
    docTitle: "今天的日记",
};

console.log("没有模板时：");
{
    const p = buildTurnPlan({
        template: null,
        userText: "帮我扩写",
        ctx,
        history: [],
    });
    check("没有 system", p.system, "");
    check("只有一条用户消息", p.messages.length, 1);
    check("第一条是 user", p.messages[0].role, "user");
    check("内容就是用户原话", p.messages[0].content, "帮我扩写");
}

console.log("有模板时：");
{
    const tpl = {
        id: "t1",
        name: "复盘",
        content: "你是教练。今天是 {{date}}。",
        order: 0,
    };
    const p = buildTurnPlan({
        template: tpl,
        userText: "",
        ctx,
        history: [],
    });
    check("模板进 system", p.system.startsWith("你是教练。"), true);
    check("system 里日期被替换", p.system.includes("2026-11-18"), true);
    check("system 里不残留占位符", p.system.includes("{{"), false);
    check("用户消息是触发词而不是空字符串", p.messages[0].content.length > 0, true);
}

console.log("模板里写了 {{content}} 也不会特殊处理：");
{
    const tpl = {
        id: "t2",
        name: "旧模板",
        content: "你是教练。\n{{content}}",
        order: 0,
    };
    const p = buildTurnPlan({
        template: tpl,
        userText: "帮我写",
        ctx,
        history: [],
    });
    check("素材概念已移除，素材不会再作为单独消息", p.messages.length, 1);
    check("用户原话照发", p.messages[0].content, "帮我写");
    check("{{content}} 原样留在 system 里", p.system.includes("{{content}}"), true);
}

console.log("用户还写了额外要求：");
{
    const tpl = {
        id: "t3",
        name: "复盘",
        content: "你是教练。",
        order: 0,
    };
    const p = buildTurnPlan({
        template: tpl,
        userText: "顺便列个待办",
        ctx,
        history: [],
    });
    check("只有一条用户消息", p.messages.length, 1);
    check("内容就是用户原话", p.messages[0].content, "顺便列个待办");
}

console.log("追问（已有历史）：");
{
    const tpl = {
        id: "t4",
        name: "复盘",
        content: "你是教练。",
        order: 0,
    };
    const p = buildTurnPlan({
        template: tpl,
        userText: "再简短一点",
        ctx,
        history: [
            { role: "user", content: "帮我复盘" },
            { role: "assistant", content: "第一版答案" },
        ],
    });
    check("追问时 system 仍然带着模板", p.system.includes("你是教练。"), true);
    check("追问时历史被带上", p.messages.length, 3);
    check("历史顺序不乱", p.messages.map((m) => m.role), ["user", "assistant", "user"]);
}

console.log("模板里没有变量也没选素材：");
{
    const tpl = { id: "t5", name: "纯指令", content: "只回答是或否。", order: 0 };
    const p = buildTurnPlan({
        template: tpl,
        userText: "天空是蓝的吗",
        ctx,
        history: [],
    });
    check("只有一条用户消息", p.messages.length, 1);
    check("用户消息就是原话", p.messages[0].content, "天空是蓝的吗");
    check("system 就是模板", p.system, "只回答是或否。");
}

console.log("极端输入：");
{
    const p = buildTurnPlan({ template: null, userText: "", ctx, history: [] });
    check("什么都没有时给个触发词", p.messages.length, 1);
    check("触发词不为空", p.messages[0].content.length > 0, true);
}
{
    const tpl = { id: "t6", name: "空模板", content: "", order: 0 };
    const p = buildTurnPlan({ template: tpl, userText: "你好", ctx, history: [] });
    check("空模板不会崩", Array.isArray(p.messages), true);
    check("空模板时没有 system", p.system, "");
    check("用户原话照发", p.messages[0].content, "你好");
}

console.log("");
console.log(`结果：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
