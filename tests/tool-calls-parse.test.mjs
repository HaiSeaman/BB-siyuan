/**
 * 三种协议的流式解析要能拼出工具调用（tool_calls）。
 * 这是接入 MCP 的关键：模型要工具时，响应里没有正文，只有工具定义。
 */
import { ProviderParser } from "../.test/providers.js";

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

/** 用解析器跑一段流，收集正文/思考/工具调用 */
function run(protocol, chunks) {
    const text = [];
    const think = [];
    const p = new ProviderParser(protocol, (t) => text.push(t), (t) => think.push(t));
    for (const c of chunks) p.push(c);
    p.end();
    return {
        text: text.join(""),
        reasoning: think.join(""),
        toolCalls: p.toolCalls(),
    };
}

console.log("OpenAI：不完整的工具参数要能拼起来");
{
    // 这是真实接口的做法：参数分好几片发，每片只有一个片段
    const r = run("openai", [
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"mcp__时间__now","arguments":""}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"tz\\""}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"Asia"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"/Shanghai\\"}"}}]}}]}\n\n',
        "data: [DONE]\n\n",
    ]);
    check("拼出 1 个工具调用", r.toolCalls.length, 1);
    check("工具名正确", r.toolCalls[0].name, "mcp__时间__now");
    check("参数被拼完整", r.toolCalls[0].args.tz, "Asia/Shanghai");
    check("有 id", r.toolCalls[0].id, "call_1");
    check("正文是空的", r.text, "");
}

console.log("OpenAI：两个工具同时调");
{
    const r = run("openai", [
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"t1","arguments":"{}"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"b","function":{"name":"t2","arguments":"{}"}}]}}]}\n\n',
        "data: [DONE]\n\n",
    ]);
    check("两个都拿到", r.toolCalls.length, 2);
    check("第一个名", r.toolCalls[0].name, "t1");
    check("第二个名", r.toolCalls[1].name, "t2");
}

console.log("OpenAI：参数是空串时不要崩");
{
    const r = run("openai", [
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"t","arguments":""}}]}}]}\n\n',
        "data: [DONE]\n\n",
    ]);
    check("参数兜底成空对象", r.toolCalls[0].args, {});
}

console.log("OpenAI：参数坏了也不要崩");
{
    const r = run("openai", [
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"t","arguments":"{不是json"}}]}}]}\n\n',
        "data: [DONE]\n\n",
    ]);
    check("坏参数兜底成空对象", r.toolCalls[0].args, {});
}

console.log("Anthropic：tool_use 块");
{
    const r = run("anthropic", [
        'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"mcp__s__t","input":{}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"a\\":1}"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
    ]);
    check("拿到一个工具调用", r.toolCalls.length, 1);
    check("工具名", r.toolCalls[0].name, "mcp__s__t");
    check("有 id", r.toolCalls[0].id, "toolu_1");
}

console.log("Anthropic：正文和工具混在一起");
{
    const r = run("anthropic", [
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"我先查一下"}}\n\n',
        'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t1","name":"q","input":{}}}\n\n',
        'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{}"}}\n\n',
    ]);
    check("正文保留", r.text, "我先查一下");
    check("工具也在", r.toolCalls.length, 1);
}

console.log("Gemini：functionCall");
{
    const r = run("gemini", [
        'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"mcp__s__t","args":{"q":"x"}}}]}}]}\n\n',
    ]);
    check("拿到工具调用", r.toolCalls.length, 1);
    check("工具名", r.toolCalls[0].name, "mcp__s__t");
    check("参数", r.toolCalls[0].args.q, "x");
  check("Gemini 的调用没有 id 也得给个", typeof r.toolCalls[0].id, "string");
}

console.log("没有工具调用时：");
{
    const r = run("openai", [
        'data: {"choices":[{"delta":{"content":"普通回答"}}]}\n\n',
        "data: [DONE]\n\n",
    ]);
    check("工具列表为空", r.toolCalls, []);
    check("正文正常", r.text, "普通回答");
}

console.log("");
console.log(`结果：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
