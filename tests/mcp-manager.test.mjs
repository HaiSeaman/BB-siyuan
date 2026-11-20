/**
 * MCP 聚合层：多服务器管理 + 工具清单合并 + 配置清洗
 */
import {
    normalizeMcpServers,
    createServer,
    buildToolSpecs,
    toolDisplayName,
} from "../.test/mcp-manager.js";

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

console.log("配置清洗：");
check("null 得到空列表", normalizeMcpServers(null), []);
check("字符串得到空列表", normalizeMcpServers("abc"), []);
{
    const raw = [
        { id: "a", name: "时间", type: "http", url: "http://x/mcp", enabled: true },
        { name: "没 id" },
        null,
        { id: "b", name: "", type: "http", url: "http://y" },
    ];
    const clean = normalizeMcpServers(raw);
    check("脏数据被过滤", clean.length, 1);
    check("留下合法那条", clean[0].id, "a");
    check("启用的保留", clean[0].enabled, true);
}
{
    // 类型不认识就退回 http，别让配置坏了就跑不起来
    const clean = normalizeMcpServers([{ id: "x", name: "X", type: "乱写", url: "http://x" }]);
    check("类型乱写退回 http", clean[0].type, "http");
}
{
    // http 缺 url 视为无效
    const clean = normalizeMcpServers([{ id: "x", name: "X", type: "http" }]);
    check("http 没地址被丢掉", clean.length, 0);
}
{
    // stdio 缺 command 视为无效
    const clean = normalizeMcpServers([{ id: "x", name: "X", type: "stdio" }]);
    check("stdio 没命令被丢掉", clean.length, 0);
}
{
    const clean = normalizeMcpServers([{ id: "x", name: "X", type: "stdio", command: "npx", args: "不是数组" }]);
    check("args 不是数组时清空", clean[0].args, []);
}
{
    const clean = normalizeMcpServers([
        { id: "x", name: "X", type: "http", url: "http://a", headers: { A: "1" } },
    ]);
    check("headers 保留", clean[0].headers.A, "1");
}

console.log("新建服务器：");
{
    const s = createServer({ name: "  时间服务器  ", type: "http", url: "  http://x/mcp  " }, () => "fixed");
    check("id 用工厂给的", s.id, "fixed");
    check("名字去空格", s.name, "时间服务器");
    check("地址去空格", s.url, "http://x/mcp");
    check("默认启用", s.enabled, true);
    check("默认超时", typeof s.timeoutMs, "number");
}
{
    const s = createServer({ name: "本地", type: "stdio", command: "npx", args: ["-y", "srv"] }, () => "z");
    check("stdio 命令保留", s.command, "npx");
    check("stdio 参数保留", s.args, ["-y", "srv"]);
}

console.log("工具清单合并：");
{
    const built = buildToolSpecs([
        {
            server: { id: "s1", name: "时间", type: "http", url: "u", enabled: true },
            tools: [
                { name: "now", description: "当前时间", inputSchema: { type: "object", properties: {} } },
                { name: "today", description: "今天日期", inputSchema: { type: "object", properties: {} } },
            ],
        },
        {
            server: { id: "s2", name: "搜索", type: "http", url: "u2", enabled: true },
            tools: [{ name: "search", description: "搜网页", inputSchema: { type: "object", properties: { q: { type: "string" } } } }],
        },
    ]);
    const tools = built.specs;

    check("一共三个工具", tools.length, 3);
    check("前缀用服务器 id（保证 ASCII 且唯一）", tools[0].function.name, "mcp__s1__now");
    check("描述保留", tools[0].function.description, "当前时间");
    check("参数 schema 保留", tools[2].function.parameters.properties.q.type, "string");
    check("格式是 OpenAI 的 tools", tools[0].type, "function");
    check("同时给出对照表", built.bindings.length, 3);
    check("对照表记着服务器真名", built.bindings[0].serverName, "时间");
}

console.log("原始工具名里的横线不能被弄丢（真机踩过的坑）：");
{
    const built = buildToolSpecs([
        {
            server: { id: "s1", name: "计算", type: "http", url: "u", enabled: true },
            tools: [{ name: "get-sum", description: "求和", inputSchema: { type: "object" } }],
        },
    ]);
    check("发给模型的名字把横线换成下划线", built.specs[0].function.name, "mcp__s1__get_sum");
    check("对照表里保留原始横线名", built.bindings[0].original, "get-sum");
}

console.log("两个中文服务器名不会撞车（真机踩过的坑）：");
{
    const built = buildToolSpecs([
        {
            server: { id: "m1", name: "时间", type: "http", url: "u", enabled: true },
            tools: [{ name: "now", description: "", inputSchema: { type: "object" } }],
        },
        {
            server: { id: "m2", name: "时间2", type: "http", url: "u2", enabled: true },
            tools: [{ name: "now", description: "", inputSchema: { type: "object" } }],
        },
    ]);
    check("两个都保留", built.specs.length, 2);
    check("名字不同", built.specs[0].function.name !== built.specs[1].function.name, true);
    check("都是合法 ASCII 名", built.specs.every((s) => /^[A-Za-z0-9_-]{1,64}$/.test(s.function.name)), true);
}

console.log("同一服务器内同名工具：");
{
    const built = buildToolSpecs([
        {
            server: { id: "a", name: "甲", type: "http", url: "u", enabled: true },
            tools: [
                { name: "dup", description: "第一个", inputSchema: { type: "object" } },
                { name: "dup", description: "第二个", inputSchema: { type: "object" } },
            ],
        },
    ]);
    check("重名只留第一个", built.specs.length, 1);
    check("留的是第一个", built.specs[0].function.description, "第一个");
}

console.log("不同服务器同名工具不冲突：");
{
    const built = buildToolSpecs([
        { server: { id: "a", name: "甲", type: "http", url: "u", enabled: true }, tools: [{ name: "same", description: "", inputSchema: { type: "object" } }] },
        { server: { id: "b", name: "乙", type: "http", url: "u2", enabled: true }, tools: [{ name: "same", description: "", inputSchema: { type: "object" } }] },
    ]);
    check("两个都保留", built.specs.length, 2);
    check("前缀不同", built.specs[0].function.name !== built.specs[1].function.name, true);
}

console.log("没启用的服务器不贡献工具：");
{
    const built = buildToolSpecs([
        {
            server: { id: "off", name: "关掉的", type: "http", url: "u", enabled: false },
            tools: [{ name: "x", description: "", inputSchema: { type: "object" } }],
        },
    ]);
    check("关掉的服务器工具不算", built.specs.length, 0);
}

console.log("工具显示名：");
{
    const built = buildToolSpecs([
        {
            server: { id: "m1", name: "计算器", type: "http", url: "u", enabled: true },
            tools: [{ name: "get-sum", description: "", inputSchema: { type: "object" } }],
        },
    ]);
    const shown = toolDisplayName(built.specs[0].function.name, [{ id: "m1", name: "计算器" }], built.bindings);
    check("按对照表显示真名和原始工具名", shown, "计算器 / get-sum");
}
check("没有对照表时按 id 查", toolDisplayName("mcp__m1__x", [{ id: "m1", name: "时间" }]), "时间 / x");
check("找不到服务器就用原名", toolDisplayName("mcp__xxx__y", []), "xxx / y");
check("不是 mcp 工具原样返回", toolDisplayName("other_tool", []), "other_tool");

console.log("");
console.log(`结果：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
