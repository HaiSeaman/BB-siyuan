/**
 * 把各种技术报错翻译成人话。
 * 主人看不懂英文和状态码，报错必须能直接指导他下一步做什么。
 */
import { friendlyError } from "../.test/errors.js";

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

function includes(name, text, piece) {
    if (typeof text === "string" && text.includes(piece)) {
        pass++;
        console.log("  OK   " + name);
    } else {
        fail++;
        console.log("  FAIL " + name);
        console.log("       实际: " + JSON.stringify(text));
        console.log("       应包含: " + JSON.stringify(piece));
    }
}

/** 几条都不想命中同一句套话，这里顺手查一下确实给出了可操作建议 */
function actionable(name, text) {
    if (typeof text === "string" && /请|检查|确认|试|核对|换|等|重试/.test(text)) {
        pass++;
        console.log("  OK   " + name);
    } else {
        fail++;
        console.log("  FAIL " + name + " —— 没给出下一步动作：" + JSON.stringify(text));
    }
}

console.log("HTTP 状态码：");
includes("401 说密钥", friendlyError({ status: 401 }), "密钥");
includes("403 说权限", friendlyError({ status: 403 }), "权限");
includes("404 说地址", friendlyError({ status: 404 }), "地址");
includes("429 说频繁", friendlyError({ status: 429 }), "频繁");
includes("500 说服务商", friendlyError({ status: 500 }), "服务商");
includes("502 说服务商", friendlyError({ status: 502 }), "服务商");
actionable("500 给了下一步", friendlyError({ status: 500 }));

console.log("网络层错误：");
includes("连不上", friendlyError({ message: "connect ECONNREFUSED 127.0.0.1:17864" }), "连不上");
includes("DNS 失败", friendlyError({ message: "getaddrinfo ENOTFOUND api.xxx.com" }), "地址");
includes("等太久", friendlyError({ message: "连接超时（30000 毫秒）" }), "等太久");
includes("被中断", friendlyError({ message: "连接被中断" }), "中断");
includes("跨域", friendlyError({ message: "Failed to fetch" }), "跨域");

console.log("模型/接口业务错误：");
includes("没有模型", friendlyError({ message: "no AI provider configured" }), "模型");
includes("模型不存在", friendlyError({ message: "model not found" }), "模型");
includes("额度", friendlyError({ message: "insufficient quota" }), "额度");
includes("上下文太长", friendlyError({ message: "context length exceeded" }), "太长");
includes("内容被拦", friendlyError({ message: "content filter" }), "安全策略");
actionable("模型不存在给了下一步", friendlyError({ message: "model not found" }));

console.log("真机踩过的坑：模型名写错时服务端只说 param is invalid");
{
    // 实测这台中转站对错误模型名返回 400 + "the param is invalid"
    const msg = friendlyError({
        status: 400,
        message: '{"error":{"code":"upstream_error","message":"upstream code=4001 msg=We\'re sorry, the param is invalid."}}',
    });
    includes("400 指向模型名", msg, "模型名");
    actionable("400 给了下一步", msg);
}
{
    // 但更具体的错误要先被认出来，不能被 400 兜底盖掉
    includes("400 + 上下文太长 → 说太长", friendlyError({ status: 400, message: "context length exceeded" }), "太长");
    includes("400 + 内容过滤 → 说安全策略", friendlyError({ status: 400, message: "content filter triggered" }), "安全策略");
    includes("400 + 模型不存在 → 说模型", friendlyError({ status: 400, message: "model not found" }), "模型名");
}

console.log("MCP 错误：");
includes("MCP 进程退出", friendlyError({ message: "本地 MCP 进程退出了（code 1）" }), "本地");
includes("MCP 超时", friendlyError({ message: "本地 MCP 没有在 30000 毫秒内回应：tools/list" }), "没有回应");
includes("找不到工具", friendlyError({ message: "Tool get_sum not found" }), "工具");
includes("找不到服务器", friendlyError({ message: "服务器「x」没有连上" }), "没有连上");

console.log("兜底：");
{
    const msg = friendlyError({ message: "some weird internal error xyz" });
    check("看不懂的保留原文", msg.includes("some weird internal error xyz"), true);
}
{
    const msg = friendlyError({ message: "" });
    includes("空错误给个通用提示", msg, "出错");
}
{
    const msg = friendlyError(null);
    includes("null 也给通用提示", msg, "出错");
}
{
    const msg = friendlyError("纯字符串错误");
    check("字符串错误也能处理", msg.includes("纯字符串错误"), true);
}

console.log("反例：不要过度翻译");
{
    // 不要把一个正常的技术提示硬改成看不懂的话
    const msg = friendlyError({ status: 200, message: "什么也没返回" });
    check("正常消息不被乱改", msg.includes("什么也没返回"), true);
}

console.log("");
console.log(`结果：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
