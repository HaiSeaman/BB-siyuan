/**
 * 工具清单要按三种协议各自的格式塞进请求体。
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
    model: "glm-5.3",
    temperature: 0.7,
    maxTokens: 4096,
    thinking: "off",
};

const specs = [
    {
        type: "function",
        function: {
            name: "mcp__时间__now",
            description: "当前时间",
            parameters: { type: "object", properties: { tz: { type: "string" } } },
        },
    },
];

const msgs = [{ role: "user", content: "现在几点" }];

console.log("OpenAI 格式：");
{
    const b = bodyFor("openai", base, msgs, "", specs);
    check("有 tools", Array.isArray(b.tools), true);
    check("保留 type:function", b.tools[0].type, "function");
    check("名字正确", b.tools[0].function.name, "mcp__时间__now");
}
{
    const b = bodyFor("openai", base, msgs, "", []);
    check("空工具不带 tools 字段", "tools" in b, false);
}
{
    const b = bodyFor("openai", base, msgs, "", undefined);
    check("undefined 也不带", "tools" in b, false);
}

console.log("Anthropic 格式：");
{
    const b = bodyFor("anthropic", { ...base, model: "claude-sonnet-4-5" }, msgs, "", specs);
    check("有 tools", Array.isArray(b.tools), true);
    check("Anthropic 不要 type 字段", "type" in b.tools[0], false);
    check("名字在顶层", b.tools[0].name, "mcp__时间__now");
    check("描述在顶层", b.tools[0].description, "当前时间");
    check("参数叫 input_schema", typeof b.tools[0].input_schema, "object");
    check("没有 function 包层", "function" in b.tools[0], false);
}

console.log("Gemini 格式：");
{
    const b = bodyFor("gemini", { ...base, model: "gemini-3.5-flash" }, msgs, "", specs);
    check("放在 tools 数组里", Array.isArray(b.tools), true);
    check("有一组 functionDeclarations", Array.isArray(b.tools[0].functionDeclarations), true);
    const fd = b.tools[0].functionDeclarations[0];
    check("名字正确", fd.name, "mcp__时间__now");
    check("有描述", fd.description, "当前时间");
    check("参数叫 parameters", typeof fd.parameters, "object");
}

console.log("工具名含中文：");
{
    // Gemini 的函数名有字符限制，中文可能不被接受，但我们要保证不改名（改了模型就对不上）
    const b = bodyFor("gemini", { ...base, model: "g" }, msgs, "", specs);
    check("保留原名（不做激进替换）", b.tools[0].functionDeclarations[0].name.includes("mcp__"), true);
}

console.log("");
console.log(`结果：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
