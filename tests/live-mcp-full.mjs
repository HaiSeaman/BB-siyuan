/**
 * 全链路验证：真模型 + 真 MCP 服务器 + 真工具调用。
 *
 * 这是阶段四的最终验收：
 *   模型看到工具清单 → 决定调用 → 我们执行 → 结果回灌 → 模型给出答案
 */
import { spawn } from "node:child_process";
import { StdioMcpClient } from "../.test/mcp-stdio.js";
import { makeSpawner } from "../.test/mcp-spawn.js";
import { ProviderParser } from "../.test/providers.js";
import { runToolLoop } from "../.test/tool-loop.js";
import { buildToolSpecs } from "../.test/mcp-manager.js";
import { splitToolName } from "../.test/mcp-jsonrpc.js";

const spawner = makeSpawner({ spawn }, process.platform);
const base = process.env.SIYUAN_AI_BASE || "http://192.168.1.8:17864/v1";
const key = process.env.SIYUAN_AI_KEY || "";
const chatUrl = base.replace(/\/+$/, "") + "/chat/completions";

let pass = 0;
let fail = 0;
function ok(n, e) {
    pass++;
    console.log("  OK   " + n + (e ? " —— " + e : ""));
}
function bad(n, w) {
    fail++;
    console.log("  FAIL " + n + " —— " + w);
}

let client = null;
try {
    console.log("1. 连上本地 MCP 服务器");
    client = new StdioMcpClient({
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-everything", "stdio"],
        spawn: spawner,
        timeoutMs: 90000,
    });
    const info = await client.connect();
    ok("连接成功", info.serverName + " / " + client.tools.length + " 个工具");

    // 只挑 get-sum 这一个工具，避免模型乱选
    const sumTool = client.tools.find((t) => t.name === "get-sum");
    if (!sumTool) {
        throw new Error("测试服务器里没有 get-sum，实际有：" + client.tools.map((t) => t.name).join(","));
    }

    const server = { id: "s1", name: "计算", type: "http", url: "", enabled: true };
    const built = buildToolSpecs([{ server, tools: [sumTool] }]);
    const tools = built.specs;
    console.log("   给模型的工具名：" + tools[0].function.name);
    console.log("   执行时用的原始名：" + built.bindings[0].original);

    console.log("");
    console.log("2. 让模型真的去调这个工具");

    const chat = async (msgs, toolSpecs, handlers) => {
        const resp = await fetch(chatUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: "Bearer " + key,
                Accept: "text/event-stream",
            },
            body: JSON.stringify({
                model: "glm-5.3",
                messages: msgs,
                tools: toolSpecs,
                stream: true,
                max_tokens: 800,
                reasoning_effort: "low",
            }),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status} ${(await resp.text()).slice(0, 150)}`);

        let text = "";
        const p = new ProviderParser(
            "openai",
            (t) => {
                text += t;
                handlers.onDelta({ content: t });
            },
            (t) => handlers.onDelta({ reasoning: t })
        );

        const reader = resp.body.getReader();
        const dec = new TextDecoder();
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            p.push(dec.decode(value, { stream: true }));
        }
        p.end();
        return { content: text, toolCalls: p.toolCalls() };
    };

    const result = await runToolLoop({
        chat,
        messages: [
            {
                role: "user",
                content: "请用 get-sum 工具算 37 加 5 等于多少。算完直接告诉我结果，不要说别的。",
            },
        ],
        tools,
        execTool: async (name, args) => {
            const hit = built.bindings.find((b) => b.exposed === name);
            const original = hit ? hit.original : splitToolName(name)?.tool;
            if (!original) throw new Error("不是 MCP 工具");
            console.log("   模型要求调用：" + name + " → 原始名 " + original + " " + JSON.stringify(args));
            const out = await client.callTool(original, args);
            console.log("   工具返回：" + JSON.stringify(out.slice(0, 80)));
            return out;
        },
        onText: () => {},
        onReasoning: () => {},
        maxRounds: 4,
    });

    console.log("");
    console.log("3. 检查结果");
    console.log("   模型最终回答：" + JSON.stringify(result.text.trim().slice(0, 120)));
    console.log("   工具调用次数：" + result.toolCallCount);

    if (result.toolCallCount > 0) ok("模型真的调用了工具");
    else bad("工具调用", "模型没有调用工具（可能不支持 function calling）");

    if (result.text.includes("42")) ok("最终答案正确（42）");
    else bad("最终答案", "没看到 42：" + result.text.slice(0, 100));

    if (result.toolErrors.length === 0) ok("工具执行无错误");
    else bad("工具执行", result.toolErrors.join("; "));
} catch (e) {
    bad("全链路", e.message);
} finally {
    try {
        await client?.close();
    } catch {}
}

console.log("");
console.log(`结果：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
