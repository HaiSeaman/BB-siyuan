/**
 * 工具消息在三种协议下的映射。
 *
 * 真机审查发现的坑：Claude 原生协议下，如果工具调用/结果被拍平成普通文本，
 * 模型根本看不懂那是工具返回，多轮工具循环会退化。
 */
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

const base = {
    baseURL: "http://x/v1",
    apiKey: "k",
    model: "claude-sonnet-4-5",
    temperature: 0.7,
    maxTokens: 4096,
    thinking: "high",
};

const toolMessages = [
    { role: "user", content: "现在几点" },
    {
        role: "assistant",
        content: "",
        tool_calls: [
            { id: "call_1", type: "function", function: { name: "mcp__s1__now", arguments: '{"tz":"Asia/Shanghai"}' } },
        ],
    },
    { role: "tool", tool_call_id: "call_1", tool_name: "mcp__s1__now", content: "2026-11-18 10:00" },
];

console.log("OpenAI：原样透传，不动结构");
{
    const b = bodyFor("openai", { ...base, model: "glm-5.3" }, toolMessages, "", []);
    check("tool 消息保留 tool_call_id", b.messages[2].tool_call_id, "call_1");
    check("assistant 的 tool_calls 保留", Array.isArray(b.messages[1].tool_calls), true);
    check("工具结果内容还在", b.messages[2].content, "2026-11-18 10:00");
}

console.log("Anthropic：要用 tool_use / tool_result 块");
{
    const b = bodyFor("anthropic", base, toolMessages, "", []);
    const types = [];
    for (const m of b.messages) {
        if (Array.isArray(m.content)) for (const c of m.content) types.push(c.type);
    }
    check("有 tool_use 块", types.includes("tool_use"), true);
    check("有 tool_result 块", types.includes("tool_result"), true);
    check("没有空的 text 块", types.filter((t) => t === "text").length <= 1, true);
    check("tool_result 带对了 id", b.messages.find((m) => Array.isArray(m.content) && m.content.some((c) => c.type === "tool_result")).content.find((c) => c.type === "tool_result").tool_use_id, "call_1");
    check("工具结果内容在里面", JSON.stringify(b.messages).includes("2026-11-18 10:00"), true);
}

console.log("Anthropic：开思考时不能带 temperature（真机踩过的坑）");
{
    const b = bodyFor("anthropic", base, [{ role: "user", content: "hi" }], "", []);
    check("有 thinking", typeof b.thinking, "object");
    check("不能同时发 temperature", "temperature" in b, false);
}
{
    // 关思考时可以带温度
    const b = bodyFor("anthropic", { ...base, thinking: "off" }, [{ role: "user", content: "hi" }], "", []);
    check("关思考时没有 thinking", "thinking" in b, false);
    check("关思考时带温度", b.temperature, 0.7);
}

console.log("Anthropic：空 assistant 不能发出去");
{
    const msgs = [
        { role: "user", content: "问" },
        { role: "assistant", content: "" },
        { role: "user", content: "再问" },
    ];
    const b = bodyFor("anthropic", base, msgs, "", []);
    const emptyAssistant = b.messages.some(
        (m) => m.role === "assistant" && (typeof m.content === "string" ? !m.content.trim() : !m.content.length)
    );
    check("空 assistant 被丢掉", emptyAssistant, false);
}

console.log("Gemini：要用 functionCall / functionResponse");
{
    const b = bodyFor("gemini", { ...base, model: "gemini-3.5-flash" }, toolMessages, "", []);
    const json = JSON.stringify(b.contents);
    check("有 functionCall", json.includes("functionCall"), true);
    check("有 functionResponse", json.includes("functionResponse"), true);
    check("工具结果内容在里面", json.includes("2026-11-18 10:00"), true);
    // 不能出现空的 text part
    const emptyText = b.contents.some(
        (c) => c.parts && c.parts.some((p) => p.text === "")
    );
    check("没有空 text part", emptyText, false);
}

console.log("纯文本对话三种协议都不该出问题");
{
    const msgs = [{ role: "user", content: "你好" }];
    for (const proto of ["openai", "anthropic", "gemini"]) {
        const b = bodyFor(proto, { ...base, model: proto === "openai" ? "glm-5.3" : base.model }, msgs, "系统提示", []);
        check(proto + " 能正常构造", typeof b, "object");
    }
}

console.log("");
console.log(`结果：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
