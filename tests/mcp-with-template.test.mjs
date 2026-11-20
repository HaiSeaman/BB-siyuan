/**
 * 验证：用自定义提示词（模板）对话时，MCP 工具是否仍然正常传出。
 *
 * 结论要求：模板只影响 system 提示，绝不吞掉 tools。
 * 三种协议（OpenAI / Anthropic / Gemini）都要成立。
 */
import { buildTurnPlan } from "../.test/turnplan.js";
import { bodyFor } from "../.test/providers.js";

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

const ctx = { date: "2026-11-18", time: "21:30", weekday: "星期三", docTitle: "日记" };

const mcpTools = [
    {
        type: "function",
        function: {
            name: "time_get_current_time",
            description: "获取当前北京时间",
            parameters: { type: "object", properties: {} },
        },
    },
];

const cfg = {
    baseURL: "http://x/v1",
    apiKey: "k",
    model: "m",
    temperature: 0.7,
    maxTokens: 100,
    thinking: "off",
};

const tpl = {
    id: "t",
    name: "日记模板",
    content: "你是日记助手。今天 {{date}}。",
    order: 0,
};

console.log("带模板 + 有 MCP 工具（OpenAI）：");
{
    const plan = buildTurnPlan({ template: tpl, userText: "帮我整理", ctx, history: [] });
    const body = bodyFor("openai", cfg, plan.messages, plan.system, mcpTools);
    check("模板进了 system", String(body.messages[0].content).includes("你是日记助手"), true);
    check("tools 没有被模板吞掉", Array.isArray(body.tools) && body.tools.length, 1);
    check("工具名原样传出", body.tools[0].function.name, "time_get_current_time");
}

console.log("带模板但没有 MCP 工具：");
{
    const plan = buildTurnPlan({ template: tpl, userText: "帮我整理", ctx, history: [] });
    const body = bodyFor("openai", cfg, plan.messages, plan.system, []);
    check("不出现空的 tools 字段", Object.prototype.hasOwnProperty.call(body, "tools"), false);
    check("模板照样生效", String(body.messages[0].content).includes("你是日记助手"), true);
}

console.log("不带模板但有 MCP 工具：");
{
    const plan = buildTurnPlan({ template: null, userText: "现在几点", ctx, history: [] });
    const body = bodyFor("openai", cfg, plan.messages, plan.system, mcpTools);
    check("没有 system", body.messages.some((m) => m.role === "system"), false);
    check("tools 仍然传出", Array.isArray(body.tools) && body.tools.length, 1);
}

console.log("Anthropic 协议：");
{
    const plan = buildTurnPlan({ template: tpl, userText: "帮我整理", ctx, history: [] });
    const body = bodyFor("anthropic", cfg, plan.messages, plan.system, mcpTools);
    check("模板进 system 字段", String(body.system).includes("你是日记助手"), true);
    check("tools 用 input_schema 格式", body.tools[0].input_schema !== undefined, true);
    check("工具名原样传出", body.tools[0].name, "time_get_current_time");
}

console.log("Gemini 协议：");
{
    const plan = buildTurnPlan({ template: tpl, userText: "帮我整理", ctx, history: [] });
    const body = bodyFor("gemini", cfg, plan.messages, plan.system, mcpTools);
    check(
        "模板进 systemInstruction",
        String(body.systemInstruction?.parts?.[0]?.text).includes("你是日记助手"),
        true
    );
    check("tools 用 functionDeclarations", Array.isArray(body.tools[0].functionDeclarations), true);
}

console.log("追问时 MCP 仍然在：");
{
    const plan = buildTurnPlan({
        template: tpl,
        userText: "再改一下",
        ctx,
        history: [
            { role: "user", content: "第一句" },
            { role: "assistant", content: "第一版" },
        ],
    });
    const body = bodyFor("openai", cfg, plan.messages, plan.system, mcpTools);
    check("追问时模板仍在", String(body.messages[0].content).includes("你是日记助手"), true);
    check("追问时 tools 仍在", Array.isArray(body.tools) && body.tools.length, 1);
}

console.log("");
console.log(`结果：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
