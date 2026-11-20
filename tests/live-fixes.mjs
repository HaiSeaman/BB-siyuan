/**
 * 修复后的真机验证：
 *   1. Anthropic 协议开思考（不能带 temperature）真的能通
 *   2. 带工具调用的两轮对话在 Anthropic 下能通
 *   3. 中文服务器名产出的工具名能被接口接受
 */
import { bodyFor, endpointFor, headersFor, ProviderParser } from "../.test/providers.js";
import { buildToolSpecs } from "../.test/mcp-manager.js";

const base = process.env.SIYUAN_AI_BASE || "http://192.168.1.8:17864/v1";
const key = process.env.SIYUAN_AI_KEY || "";

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

const cfg = {
    baseURL: base,
    apiKey: key,
    model: "glm-5.3",
    temperature: 0.7,
    maxTokens: 1500,
};

async function call(protocol, c, messages, system, tools) {
    const url = endpointFor(protocol, c.baseURL, c.model);
    const resp = await fetch(url, {
        method: "POST",
        headers: headersFor(protocol, c),
        body: JSON.stringify(bodyFor(protocol, c, messages, system, tools)),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} ${(await resp.text()).slice(0, 250)}`);

    let text = "";
    const p = new ProviderParser(protocol, (t) => (text += t), () => {});
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        p.push(dec.decode(value, { stream: true }));
    }
    p.end();
    return { text, toolCalls: p.toolCalls() };
}

console.log("1. Anthropic 开思考（修复前这里必定 400）");
try {
    const r = await call("anthropic", { ...cfg, thinking: "high" }, [
        { role: "user", content: "3*8=?只回答数字" },
    ]);
    if (r.text.includes("24")) ok("开思考也能通了", JSON.stringify(r.text.trim()));
    else bad("开思考", "没拿到 24：" + r.text.slice(0, 100));
} catch (e) {
    bad("Anthropic 开思考", e.message);
}

console.log("2. Anthropic 关思考（带 temperature）");
try {
    const r = await call("anthropic", { ...cfg, thinking: "off" }, [
        { role: "user", content: "5+5=?只回答数字" },
    ]);
    if (r.text.includes("10")) ok("关思考正常", JSON.stringify(r.text.trim()));
    else bad("关思考", "没拿到 10：" + r.text.slice(0, 100));
} catch (e) {
    bad("Anthropic 关思考", e.message);
}

console.log("3. Anthropic 带工具，模型能发起调用");
{
    const server = { id: "m1", name: "时间", type: "http", url: "", enabled: true };
    const built = buildToolSpecs([
        {
            server,
            tools: [
                {
                    name: "get-time",
                    description: "获取当前时间",
                    inputSchema: { type: "object", properties: { tz: { type: "string" } }, required: [] },
                },
            ],
        },
    ]);
    console.log("   工具名：" + built.specs[0].function.name);

    try {
        const r = await call(
            "anthropic",
            { ...cfg, thinking: "off" },
            [{ role: "user", content: "用 get-time 工具查一下现在几点" }],
            "",
            built.specs
        );
        if (r.toolCalls.length > 0) {
            ok("模型要求调用工具", r.toolCalls.map((c) => c.name).join(","));
            check("名字和我们发的一致", r.toolCalls[0].name, built.specs[0].function.name);

            // 第二轮：把工具结果回灌，确认不会 400
            const messages = [
                { role: "user", content: "用 get-time 工具查一下现在几点" },
                {
                    role: "assistant",
                    content: "",
                    tool_calls: [
                        {
                            id: r.toolCalls[0].id,
                            type: "function",
                            function: { name: r.toolCalls[0].name, arguments: JSON.stringify(r.toolCalls[0].args) },
                        },
                    ],
                },
                { role: "tool", tool_call_id: r.toolCalls[0].id, tool_name: r.toolCalls[0].name, content: "现在是 22:15" },
            ];
            try {
                const r2 = await call("anthropic", { ...cfg, thinking: "off" }, messages, "", built.specs);
                ok("工具结果回灌没被拒", JSON.stringify(r2.text.slice(0, 60)));
            } catch (e2) {
                bad("工具结果回灌", e2.message);
            }
        } else {
            bad("工具调用", "模型没发起调用，正文：" + r.text.slice(0, 100));
        }
    } catch (e) {
        bad("Anthropic 带工具", e.message);
    }
}

console.log("4. 中文服务器名的工具名不会让接口报错");
{
    const built = buildToolSpecs([
        {
            server: { id: "m2", name: "计算器", type: "http", url: "", enabled: true },
            tools: [{ name: "求-和", description: "求和", inputSchema: { type: "object", properties: {} } }],
        },
    ]);
    const name = built.specs[0].function.name;
    console.log("   生成的名字：" + name);
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
        bad("名字合法性", name);
    } else {
        ok("名字是合法 ASCII");
        try {
            const r = await call("openai", { ...cfg, thinking: "off" }, [{ role: "user", content: "你好" }], "", built.specs);
            ok("带这个名字请求没被拒", JSON.stringify(r.text.slice(0, 40)));
        } catch (e) {
            bad("中文工具名请求", e.message);
        }
    }
}

function check(n, a, b) {
    if (a === b) {
        pass++;
        console.log("  OK   " + n);
    } else {
        bad(n, "实际 " + JSON.stringify(a) + " 期望 " + JSON.stringify(b));
    }
}

console.log("");
console.log(`结果：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
