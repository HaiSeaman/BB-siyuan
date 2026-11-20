/**
 * MCP JSON-RPC 层：消息构造、响应解析、工具名变换。
 */
import {
    makeRequest,
    makeNotification,
    parseMessage,
    toolNameFor,
    splitToolName,
    extractText,
    isWriteLike,
} from "../.test/mcp-jsonrpc.js";

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

console.log("请求构造：");
{
    const r = makeRequest(1, "initialize", { protocolVersion: "2025-06-18" });
    check("有 jsonrpc 版本", r.jsonrpc, "2.0");
    check("有 id", r.id, 1);
    check("有 method", r.method, "initialize");
    check("有 params", r.params.protocolVersion, "2025-06-18");
}
{
    const r = makeRequest(2, "tools/list");
    check("无 params 时不带该字段", "params" in r, false);
}
{
    const n = makeNotification("notifications/initialized");
    check("通知没有 id", "id" in n, false);
    check("通知方法名正确", n.method, "notifications/initialized");
}

console.log("响应解析：");
check("正常结果", parseMessage('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}').kind, "result");
check("结果内容正确", parseMessage('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}').result.ok, true);
check("错误响应被识别", parseMessage('{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"没这个方法"}}').kind, "error");
check("错误消息带出来", parseMessage('{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"没这个方法"}}').errorText, "没这个方法");
check("通知被识别", parseMessage('{"jsonrpc":"2.0","method":"notifications/progress"}').kind, "notification");
check("坏 JSON 返回 null", parseMessage("{不是json"), null);
check("空串返回 null", parseMessage(""), null);
check("没有 jsonrpc 字段也当坏消息", parseMessage('{"id":1}'), null);

console.log("工具名加前缀：");
check("单服务器正常", toolNameFor("time", "get_current_time"), "mcp__time__get_current_time");
check("服务器名里的横线变下划线", toolNameFor("my-server", "get"), "mcp__my_server__get");
check("工具名里的点变下划线", toolNameFor("s", "a.b"), "mcp__s__a_b");
check("中文名换成下划线（接口只认 ASCII）", /^[A-Za-z0-9_-]+$/.test(toolNameFor("时间", "现在几点")), true);
{
    const n = toolNameFor("时间", "get-sum");
    check("中文服务器名产出纯 ASCII", /^[A-Za-z0-9_-]+$/.test(n), true);
    check("中文服务器名不超过 64", n.length <= 64, true);
    check("能拆回去", splitToolName(n) !== null, true);
}
{
    const n = toolNameFor("时间服务器", "get_sum");
    check("中文全换掉后仍是合法名", /^[A-Za-z0-9_-]{1,64}$/.test(n), true);
}
{
    // 超长名字要被截断，且仍然能拆回
    const longServer = "s".repeat(40);
    const longTool = "t".repeat(40);
    const n = toolNameFor(longServer, longTool);
    check("超长被截到 64 以内", n.length <= 64, true);
    check("超长也能拆回去", splitToolName(n) !== null, true);
}
{
    const n = toolNameFor("", "");
    check("全空也不产生非法名", /^[A-Za-z0-9_-]+$/.test(n), true);
}

console.log("工具名拆回去：");
check("拆出服务器和工具", splitToolName("mcp__time__get_current_time"), { server: "time", tool: "get_current_time" });
check("不是我们的前缀返回 null", splitToolName("get_weather"), null);
check("前缀对但缺分隔符返回 null", splitToolName("mcp__onlyserver"), null);
check("空字符串返回 null", splitToolName(""), null);

console.log("工具结果取文本：");
{
    const r = { content: [{ type: "text", text: "现在 21:30" }] };
    check("取到文本", extractText(r), "现在 21:30");
}
{
    const r = { content: [{ type: "text", text: "第一段" }, { type: "text", text: "第二段" }] };
    check("多段拼起来", extractText(r), "第一段\n第二段");
}
{
    const r = { content: [{ type: "image", data: "xxx", mimeType: "image/png" }] };
    check("纯图片给个说明", extractText(r).includes("图片"), true);
}
{
    const r = { content: [{ type: "text", text: "出错了" }], isError: true };
    check("错误结果要标出来", extractText(r).startsWith("[工具报错]"), true);
}
check("空结果不崩", extractText({}), "");
check("null 不崩", extractText(null), "");

console.log("识别写操作：");
check("delete 算写", isWriteLike("delete_file"), true);
check("write 算写", isWriteLike("writeData"), true);
check("update 算写", isWriteLike("update_record"), true);
check("remove 算写", isWriteLike("remove_item"), true);
check("insert 算写", isWriteLike("insert_row"), true);
check("create 算写", isWriteLike("create_doc"), true);
check("get 不算写", isWriteLike("get_weather"), false);
check("search 不算写", isWriteLike("search_web"), false);
check("list 不算写", isWriteLike("list_files"), false);
check("read 不算写（readonly 里有 read）", isWriteLike("read_file"), false);

console.log("");
console.log(`结果：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
