/**
 * 粗略估算一次请求大概多少 token，用来在明显超长时提醒用户。
 * 不对应任何真实分词器，只求数量级正确。
 */
import { estimateTokens, isTooLong, tooLongMessage } from "../.test/tokens.js";

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

console.log("基础：");
check("空串 0", estimateTokens(""), 0);
check("null 当 0", estimateTokens(null), 0);
check("undefined 当 0", estimateTokens(undefined), 0);
check("10 个字符约 5", estimateTokens("1234567890"), 5);
check("中文按字算", estimateTokens("今天开会讨论了计划"), 5);

console.log("判断是否超长：");
check("小请求不超", isTooLong(1000, 64000), false);
check("刚好等于上限也算超（没有输出空间）", isTooLong(64000, 64000), true);
check("超出上限算超", isTooLong(64001, 64000), true);
check("留出 15% 后仍然不超", isTooLong(50000, 64000), false);
check("超过 85% 就算超", isTooLong(55000, 64000), true);
check("上限为 0 时不判超（未知上限别误报）", isTooLong(999999, 0), false);

console.log("提示文案：");
{
    const msg = tooLongMessage(120000, 64000);
    check("说清用了多少", msg.includes("120000"), true);
    check("说清可用上限", msg.includes("54400"), true);
    check("给出建议", msg.includes("清空") || msg.includes("减少"), true);
}

console.log("");
console.log(`结果：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
