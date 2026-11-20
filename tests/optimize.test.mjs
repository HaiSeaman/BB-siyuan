/**
 * 「优化」按钮背后的逻辑：洗模型回复、判断空壳、挑选用哪个模型。
 *
 * 这里最容易出的两种事：
 *   1. 模型回了「好的，我来帮你优化：」这种废话，被当成提示词填进输入框
 *   2. 顶栏切到了画图模型，还拿它去优化 —— 必失败，用户完全不知道原因
 */
import {
    OPTIMIZE_SYSTEM,
    OPTIMIZE_MAX_TOKENS,
    optimizeUserPrompt,
    cleanOptimized,
    looksEmpty,
    optimizeHint,
    optimizeErrorMessage,
} from "../.test/optimize.js";

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

console.log("系统提示词必须咬死三件事：");
{
    check("要求只用中文", /只用中文/.test(OPTIMIZE_SYSTEM), true);
    check("要求只输出提示词本身", /只输出提示词本身/.test(OPTIMIZE_SYSTEM), true);
    check("要求不要指令语", /不要写「请画」/.test(OPTIMIZE_SYSTEM), true);
    check("规定了要补哪些要素", /主体细节/.test(OPTIMIZE_SYSTEM) && /光线/.test(OPTIMIZE_SYSTEM), true);
    check("给了字数上限", /180/.test(OPTIMIZE_SYSTEM), true);
    check("token 上限够用但不夸张", OPTIMIZE_MAX_TOKENS >= 300 && OPTIMIZE_MAX_TOKENS <= 2000, true);
}

console.log("用户原话的包装：");
{
    const u = optimizeUserPrompt("  一只猫  ");
    check("原话被单独一段", /一只猫/.test(u), true);
    check("去掉了首尾空格", u.includes("一只猫\n") || u.endsWith("一只猫"), true);

    check("空原话不崩", typeof optimizeUserPrompt(""), "string");
}

console.log("洗模型回复（模型经常加包装）：");
{
    check("去掉代码围栏", cleanOptimized("```text\n一只猫\n```"), "一只猫");
    check("去掉无语言标记的围栏", cleanOptimized("```\n一只猫\n```"), "一只猫");
    check("去掉「提示词：」前缀", cleanOptimized("提示词：一只猫"), "一只猫");
    check("去掉「优化后的提示词：」前缀", cleanOptimized("优化后的提示词：一只猫"), "一只猫");
    check("去掉英文双引号", cleanOptimized('"一只猫"'), "一只猫");
    check("去掉中文弯引号", cleanOptimized("“一只猫”"), "一只猫");
    check("去掉直角引号", cleanOptimized("「一只猫」"), "一只猫");
    check("单引号也去", cleanOptimized("'一只猫'"), "一只猫");

    // 多行压成一句
    check(
        "多行用逗号接起来",
        cleanOptimized("一只猫\n坐在窗台上\n午后阳光"),
        "一只猫，坐在窗台上，午后阳光"
    );
    check("空行被忽略", cleanOptimized("一只猫\n\n\n阳光"), "一只猫，阳光");
    check("连续逗号被合并", cleanOptimized("一只猫，，，阳光"), "一只猫，阳光");
    check("结尾的逗号被去掉", cleanOptimized("一只猫，"), "一只猫");

    check("空串给空", cleanOptimized(""), "");
    check("纯空白给空", cleanOptimized("   \n  "), "");
    check("普通一段原样返回", cleanOptimized("一只橘猫坐在窗台上"), "一只橘猫坐在窗台上");
}

console.log("判断模型是不是在说废话：");
{
    check("空回复算空", looksEmpty(""), true);
    check("纯空白算空", looksEmpty("   "), true);
    check("「好的」算空", looksEmpty("好的"), true);
    check("「收到」算空", looksEmpty("收到"), true);
    check("「我来帮你」这类短话算空", looksEmpty("我来帮你优化"), true);
    check("真的提示词不算空", looksEmpty("一只橘猫坐在老式木窗台上，午后阳光，暖色调，胶片质感"), false);
}

console.log("给主人的提示语：");
{
    const h = optimizeHint("中转站A", "glm-5.3");
    check("说明用了哪个模型", /中转站A/.test(h) && /glm-5.3/.test(h), true);
    check("说明是中文", /中文/.test(h), true);
    check("没名字时兜底", /未命名/.test(optimizeHint("", "m")), true);
}

console.log("错误翻译：");
{
    check("401 指向密钥", /密钥/.test(optimizeErrorMessage("接口返回 401")), true);
    check("403 指向密钥", /密钥/.test(optimizeErrorMessage("403 Forbidden")), true);
    check("404 指向地址", /地址/.test(optimizeErrorMessage("接口返回 404")), true);
    check("429 指向额度", /额度|频繁/.test(optimizeErrorMessage("429 too many")), true);
    check("模型名错指向模型", /聊天模型/.test(optimizeErrorMessage("model not found")), true);
    check("原样保留没聊天模型的提示", optimizeErrorMessage("优化要用聊天模型"), "优化要用聊天模型");
    check("陌生错误带原文", /坏了/.test(optimizeErrorMessage("坏了")), true);
    check("空错误也能给一句", optimizeErrorMessage("").length > 0, true);
    check("不会把错误吞掉变成空串", optimizeErrorMessage("任意") !== "", true);
}

console.log("");
console.log(`结果：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
