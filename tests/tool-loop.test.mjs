/**
 * 工具调用循环：模型要工具 → 我们执行 → 结果回灌 → 再问模型。
 * 这是最容易死循环 / 卡死的地方，重点测边界。
 */
import { runToolLoop } from "../.test/tool-loop.js";

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

/** 造一个按顺序回答的模型 */
function fakeModel(responses) {
    let i = 0;
    const calls = [];
    const chat = async (messages, tools) => {
        calls.push({ messages: JSON.parse(JSON.stringify(messages)), tools });
        const r = responses[Math.min(i, responses.length - 1)];
        i++;
        return r;
    };
    return { chat, calls };
}

console.log("模型不需要工具：");
{
    const model = fakeModel([{ content: "直接回答" }]);
    const out = await runToolLoop({
        chat: model.chat,
        messages: [{ role: "user", content: "你好" }],
        tools: [{ type: "function", function: { name: "x", description: "", parameters: {} } }],
        execTool: async () => "不该被调用",
        onText: () => {},
        onReasoning: () => {},
        maxRounds: 5,
    });
    check("没有工具调用就算结束", out.stopReason, "done");
    check("只问了一次模型", model.calls.length, 1);
    check("正文拼起来", out.text, "直接回答");
}

console.log("model 一次流式回调：");
{
    const model = fakeModel([
        {
            content: "",
            onChunk: true,
        },
    ]);
    const texts = [];
    const out = await runToolLoop({
        chat: async (messages, tools, handlers) => {
            handlers.onDelta({ content: "你" });
            handlers.onDelta({ content: "好" });
            return { content: "你好" };
        },
        messages: [{ role: "user", content: "hi" }],
        tools: [],
        execTool: async () => "",
        onText: (t) => texts.push(t),
        onReasoning: () => {},
        maxRounds: 5,
    });
    check("流式片段都转出去了", texts, ["你", "好"]);
    check("累积文本正确", out.text, "你好");
}

console.log("模型要工具，一轮就够：");
{
    let round = 0;
    const calls = [];
    const chat = async (messages) => {
        calls.push(JSON.parse(JSON.stringify(messages)));
        round++;
        if (round === 1) {
            return {
                content: "",
                toolCalls: [{ id: "c1", name: "mcp__时间__now", args: { tz: "Asia/Shanghai" } }],
            };
        }
        return { content: "现在是 21:30" };
    };

    const out = await runToolLoop({
        chat,
        messages: [{ role: "user", content: "现在几点" }],
        tools: [{ type: "function", function: { name: "mcp__时间__now", description: "", parameters: {} } }],
        execTool: async (name, args) => {
            check("工具名传对", name, "mcp__时间__now");
            check("参数传对", args.tz, "Asia/Shanghai");
            return "21:30";
        },
        onText: () => {},
        onReasoning: () => {},
        maxRounds: 5,
    });

    check("两轮后结束", round, 2);
    check("最终文本", out.text, "现在是 21:30");
    check("执行过一次工具", out.toolCallCount, 1);
    check("第二轮带上了工具结果", JSON.stringify(calls[1]).includes("21:30"), true);
    check("第二轮消息里有 tool 角色", calls[1].some((m) => m.role === "tool"), true);
    check("tool 结果带上 call id", calls[1].find((m) => m.role === "tool").tool_call_id, "c1");
}

console.log("模型连续要工具（多轮）：");
{
    let round = 0;
    const chat = async () => {
        round++;
        if (round === 1) return { content: "", toolCalls: [{ id: "c1", name: "mcp__s__a", args: {} }] };
        if (round === 2) return { content: "", toolCalls: [{ id: "c2", name: "mcp__s__b", args: {} }] };
        return { content: "都查完了" };
    };
    const out = await runToolLoop({
        chat,
        messages: [{ role: "user", content: "x" }],
        tools: [],
        execTool: async (name) => "结果:" + name,
        onText: () => {},
        onReasoning: () => {},
        maxRounds: 5,
    });
    check("执行两次工具", out.toolCallCount, 2);
    check("三轮后结束", round, 3);
    check("最终文本", out.text, "都查完了");
}

console.log("死循环保护：");
{
    let round = 0;
    const chat = async () => {
        round++;
        return { content: "", toolCalls: [{ id: "c" + round, name: "mcp__s__loop", args: {} }] };
    };
    const out = await runToolLoop({
        chat,
        messages: [{ role: "user", content: "x" }],
        tools: [],
        execTool: async () => "还是一样",
        onText: () => {},
        onReasoning: () => {},
        maxRounds: 3,
    });
    check("到达上限就停", out.stopReason, "max-rounds");
    check("正好问了三轮", round, 3);
    check("不超过上限", out.toolCallCount, 3);
}

console.log("工具执行出错不影响继续：");
{
    let round = 0;
    const chat = async () => {
        round++;
        if (round === 1) return { content: "", toolCalls: [{ id: "c1", name: "mcp__s__bad", args: {} }] };
        return { content: "工具坏了，我照常回答" };
    };
    const out = await runToolLoop({
        chat,
        messages: [{ role: "user", content: "x" }],
        tools: [],
        execTool: async () => {
            throw new Error("服务器连不上");
        },
        onText: () => {},
        onReasoning: () => {},
        maxRounds: 5,
    });
    check("错误没让整个流程崩掉", out.stopReason, "done");
    check("模型看到了错误信息", out.text.includes("照常回答"), true);
    check("错误被记下来", out.toolErrors.length, 1);
    check("错误信息带原因", out.toolErrors[0].includes("服务器连不上"), true);
}

console.log("模型报错：");
{
    const chat = async () => {
        throw new Error("密钥失效");
    };
    let err = "";
    try {
        await runToolLoop({
            chat,
            messages: [{ role: "user", content: "x" }],
            tools: [],
            execTool: async () => "",
            onText: () => {},
            onReasoning: () => {},
            maxRounds: 5,
        });
    } catch (e) {
        err = e.message;
    }
    check("模型错误往上抛", err, "密钥失效");
}

console.log("思考内容也转出去：");
{
    const out = await runToolLoop({
        chat: async (m, t, h) => {
            h.onDelta({ reasoning: "我想想" });
            h.onDelta({ content: "答案" });
            return { content: "答案" };
        },
        messages: [{ role: "user", content: "x" }],
        tools: [],
        execTool: async () => "",
        onText: () => {},
        onReasoning: (t) => check("思考转出去了", t, "我想想"),
        maxRounds: 2,
    });
    check("正常结束", out.stopReason, "done");
}

console.log("没有工具时不带 tools 字段：");
{
    let gotTools = "没传";
    await runToolLoop({
        chat: async (m, t) => {
            gotTools = t;
            return { content: "ok" };
        },
        messages: [{ role: "user", content: "x" }],
        tools: [],
        execTool: async () => "",
        onText: () => {},
        onReasoning: () => {},
        maxRounds: 2,
    });
    check("空工具传空数组", gotTools, []);
}

console.log("");
console.log(`结果：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
