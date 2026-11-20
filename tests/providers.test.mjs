/**
 * 三种协议：请求体构造 + 流式解析
 */
import {
    endpointFor,
    headersFor,
    bodyFor,
    ProviderParser,
} from "../.test/providers.js";

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
    baseURL: "http://192.168.1.8:17864/v1",
    apiKey: "ck_test",
    model: "glm-5.3",
    temperature: 0.7,
    maxTokens: 4096,
    thinking: "high",
};

const msgs = [
    { role: "system", content: "你是助手" },
    { role: "user", content: "你好" },
];

console.log("三种协议的地址：");
check("openai 拼 chat/completions", endpointFor("openai", "http://x/v1"), "http://x/v1/chat/completions");
check("anthropic 拼 messages", endpointFor("anthropic", "http://x/v1"), "http://x/v1/messages");
check("gemini 拼 v1beta/models:streamGenerateContent", endpointFor("gemini", "http://x/v1", "gemini-3.5-flash"), "http://x/v1beta/models/gemini-3.5-flash:streamGenerateContent?alt=sse");
check("gemini 传入已带 v1beta 不重复", endpointFor("gemini", "http://x/v1beta", "gemini-3.5-flash"), "http://x/v1beta/models/gemini-3.5-flash:streamGenerateContent?alt=sse");
check("openai 已有完整路径不重复拼", endpointFor("openai", "http://x/v1/chat/completions"), "http://x/v1/chat/completions");
check("anthropic 已有 /messages 不重复拼", endpointFor("anthropic", "http://x/v1/messages"), "http://x/v1/messages");

console.log("三种协议的请求头：");
check("openai 用 Bearer", headersFor("openai", base).Authorization, "Bearer ck_test");
check("anthropic 用 x-api-key", headersFor("anthropic", base)["x-api-key"], "ck_test");
check("anthropic 带 version 头", headersFor("anthropic", base)["anthropic-version"], "2023-06-01");
check("anthropic 不重复带 Bearer", "Authorization" in headersFor("anthropic", base), false);
check("gemini 用 x-goog-api-key", headersFor("gemini", base)["x-goog-api-key"], "ck_test");

console.log("openai 请求体：");
const ob = bodyFor("openai", base, msgs);
check("模型名", ob.model, "glm-5.3");
check("开启流式", ob.stream, true);
check("glm high 发 high", ob.reasoning_effort, "high");
const obOff = bodyFor("openai", { ...base, thinking: "off" }, msgs);
check("glm off 仍发 low", obOff.reasoning_effort, "low");
check("关思考时不发 thinking 对象", "thinking" in obOff, false);

console.log("anthropic 请求体：");
const ab = bodyFor("anthropic", { ...base, model: "claude-sonnet-4-5" }, msgs);
check("system 单独抽出来", ab.system, "你是助手");
check("system 不在 messages 里", ab.messages.length, 1);
check("messages 第一条是 user", ab.messages[0].role, "user");
check("开启流式", ab.stream, true);
check("打开思考", ab.thinking.type, "enabled");
check("有 budget_tokens", typeof ab.thinking.budget_tokens, "number");
const abOff = bodyFor("anthropic", { ...base, model: "claude-sonnet-4-5", thinking: "off" }, msgs);
check("关思考时不发 thinking", "thinking" in abOff, false);

console.log("gemini 请求体：");
const gb = bodyFor("gemini", { ...base, model: "gemini-3.5-flash" }, msgs);
check("system 放进 systemInstruction", gb.systemInstruction.parts[0].text, "你是助手");
check("用户消息进 contents", gb.contents[0].parts[0].text, "你好");
check("role 用 user", gb.contents[0].role, "user");
check("有思考配置", typeof gb.generationConfig.thinkingConfig, "object");

console.log("openai 流式解析：");
{
    let text = "";
    let think = "";
    const p = new ProviderParser("openai", (t) => (text += t), (t) => (think += t));
    p.push('data: {"choices":[{"delta":{"reasoning_content":"想"}}]}\n\n');
    p.push('data: {"choices":[{"delta":{"content":"答"}}]}\n\n');
    p.push("data: [DONE]\n\n");
    p.end();
    check("正文", text, "答");
    check("思考", think, "想");
}

console.log("anthropic 流式解析：");
{
    let text = "";
    let think = "";
    const p = new ProviderParser("anthropic", (t) => (text += t), (t) => (think += t));
    p.push('event: content_block_start\ndata: {"content_block":{"text":"","type":"text"},"index":0,"type":"content_block_start"}\n\n');
    p.push('event: content_block_delta\ndata: {"delta":{"text":"39","type":"text_delta"},"index":0,"type":"content_block_delta"}\n\n');
    p.push('event: content_block_delta\ndata: {"delta":{"text":"1","type":"text_delta"},"index":0,"type":"content_block_delta"}\n\n');
    p.push('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    p.end();
    check("正文拼起来", text, "391");
    check("没有思考内容", think, "");
}

console.log("anthropic 思考块解析：");
{
    let text = "";
    let think = "";
    const p = new ProviderParser("anthropic", (t) => (text += t), (t) => (think += t));
    p.push('event: content_block_start\ndata: {"content_block":{"thinking":"","type":"thinking"},"index":0,"type":"content_block_start"}\n\n');
    p.push('event: content_block_delta\ndata: {"delta":{"thinking":"我先算","type":"thinking_delta"},"index":0,"type":"content_block_delta"}\n\n');
    p.push('event: content_block_delta\ndata: {"delta":{"signature":"abc"},"index":0,"type":"content_block_delta"}\n\n');
    p.push('event: content_block_delta\ndata: {"delta":{"text":"156","type":"text_delta"},"index":1,"type":"content_block_delta"}\n\n');
    p.end();
    check("思考进思考区", think, "我先算");
    check("正文只有答案", text, "156");
    check("signature 不混进正文", text.includes("abc"), false);
}

console.log("anthropic 报错：");
{
    let err = null;
    const p = new ProviderParser("anthropic", () => {}, () => {});
    try {
        p.push('event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"服务器忙"}}\n\n');
    } catch (e) {
        err = e.message;
    }
    check("错误消息被抛出", err, "服务器忙");
}

console.log("gemini 流式解析：");
{
    let text = "";
    let think = "";
    const p = new ProviderParser("gemini", (t) => (text += t), (t) => (think += t));
    p.push('data: {"candidates":[{"content":{"parts":[{"text":"你"}],"role":"model"}}]}\n\n');
    p.push('data: {"candidates":[{"content":{"parts":[{"text":"好"}],"role":"model"}}]}\n\n');
    p.end();
    check("正文拼接", text, "你好");
}

console.log("gemini 跳过思考片段：");
{
    let text = "";
    let think = "";
    const p = new ProviderParser("gemini", (t) => (text += t), (t) => (think += t));
    p.push('data: {"candidates":[{"content":{"parts":[{"text":"想一下","thought":true}]}}]}\n\n');
    p.push('data: {"candidates":[{"content":{"parts":[{"text":"答案"}]}}]}\n\n');
    p.end();
    check("思考进思考区", think, "想一下");
    check("正文不含思考", text, "答案");
}

console.log("被切成两半的数据：");
{
    let text = "";
    const p = new ProviderParser("openai", (t) => (text += t), () => {});
    p.push('data: {"choices":[{"delta":{"content":"半');
    check("第一半没出来", text, "");
    p.push('截"}}]}\n\n');
    check("补齐后出来", text, "半截");
}

console.log("空响应不崩：");
{
    let text = "";
    const p = new ProviderParser("openai", (t) => (text += t), () => {});
    p.push("");
    p.push("\n\n");
    p.end();
    check("什么都没出", text, "");
}

console.log("审查发现的三个 bug：");
{
    // bug 1：Anthropic 官方要求 budget_tokens 必须小于 max_tokens，写等于也会 400。
    const b = bodyFor("anthropic", { ...base, model: "claude-sonnet-4-5", maxTokens: 8000, thinking: "max" }, msgs);
    check("预算必须小于 max_tokens", b.thinking.budget_tokens < 8000, true);
    check("预算不浪费太小", b.thinking.budget_tokens >= 3000, true);
}
{
    // bug 1b：max_tokens 小到放不下 1024 预算时，宁可不发 thinking
    const b = bodyFor("anthropic", { ...base, model: "claude-sonnet-4-5", maxTokens: 1024, thinking: "high" }, msgs);
    check("放不下预算时不发 thinking 免得 400", "thinking" in b, false);
    check("但 effort 还是发了", b.effort, "high");
}
{
    // bug 2：对话中间夹 system 消息会被弄进 user，
    // 更糟糕的是 assistant 变成 user 后，同一角色连在一起。
    // 这里验证：连续同角色消息必须被合并，否则 Claude 会拒。
    const b = bodyFor(
        "anthropic",
        { ...base, model: "claude-sonnet-4-5", thinking: "off" },
        [
            { role: "user", content: "第一句" },
            { role: "user", content: "第二句" },
        ]
    );
    check("连续 user 被合并成一条", b.messages.length, 1);
    check("合并后内容都在", b.messages[0].content.includes("第一句") && b.messages[0].content.includes("第二句"), true);
}
{
    // bug 3：gemini 的地址里若带 /v1（用户常见填法），
    // 之前 replace 会把 /v1 去掉再拼 v1beta，看起来对；
    // 但若 base 是 .../v1beta 已存在，也要能正确拼接。
    check("gemini 带 /v1 能拼对", endpointFor("gemini", "http://x/v1", "m"), "http://x/v1beta/models/m:streamGenerateContent?alt=sse");
    check("gemini 带 /v1beta 能拼对", endpointFor("gemini", "http://x/v1beta", "m"), "http://x/v1beta/models/m:streamGenerateContent?alt=sse");
    check("gemini 不带版本号也能拼", endpointFor("gemini", "http://x", "m"), "http://x/v1beta/models/m:streamGenerateContent?alt=sse");
}

console.log("gemini 模型名为空：");
{
    // bug 3b：模型名为空时路径会变成 /models/:streamGenerateContent，必然 404
    const url = endpointFor("gemini", "http://x/v1", "");
    check("空模型名时不算出畸形地址", url.includes("/models/:stream"), false);
}

console.log("模板作为系统提示（第四参数）：");
{
    const sys = "你是写作教练。";
    const ob = bodyFor("openai", base, [{ role: "user", content: "你好" }], sys);
    check("openai 把 system 放在最前面", ob.messages[0].role, "system");
    check("openai system 内容正确", ob.messages[0].content, sys);
    check("openai 用户消息还在", ob.messages[1].content, "你好");
}
{
    const sys = "你是写作教练。";
    const ab = bodyFor("anthropic", { ...base, model: "claude-sonnet-4-5" }, [{ role: "user", content: "你好" }], sys);
    check("anthropic 用独立的 system 字段", ab.system, sys);
    check("anthropic messages 里不含 system", JSON.stringify(ab.messages).includes("写作教练"), false);
}
{
    const sys = "你是写作教练。";
    const gb = bodyFor("gemini", { ...base, model: "gemini-3.5-flash" }, [{ role: "user", content: "你好" }], sys);
    check("gemini 用 systemInstruction", gb.systemInstruction.parts[0].text, sys);
    check("gemini contents 里不含 system", JSON.stringify(gb.contents).includes("写作教练"), false);
}
{
    // 空 system 不应该凭空多出一条空消息
    const ob = bodyFor("openai", base, [{ role: "user", content: "你好" }], "");
    check("空 system 不产生多余消息", ob.messages.length, 1);
    const ob2 = bodyFor("openai", base, [{ role: "user", content: "你好" }], "   ");
    check("全空格 system 也不产生多余消息", ob2.messages.length, 1);
}

console.log("");
console.log(`结果：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
