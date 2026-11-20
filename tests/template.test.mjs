/**
 * 提示词模板：变量替换。
 * 规则来自设计文档 3.4 节：
 *   - {{content}} 不进系统提示，单独作为素材
 *   - {{date}} / {{time}} / {{weekday}} / {{doc_title}} 直接替换
 *   - 未知变量原样保留（不能吃掉用户写的字）
 */
import { renderTemplate, extractVars, VARS } from "../.test/template.js";

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

// 固定时间，保证测试可重复
const ctx = {
    date: "2026-11-18",
    time: "21:30",
    weekday: "星期三",
    docTitle: "今天的日记",
};

console.log("变量替换：");
check("没有变量时原样返回", renderTemplate("帮我写一篇复盘。", ctx), "帮我写一篇复盘。");
check("date 被替换", renderTemplate("今天是 {{date}}。", ctx), "今天是 2026-11-18。");
check("time 被替换", renderTemplate("现在 {{time}}", ctx), "现在 21:30");
check("weekday 被替换", renderTemplate("{{weekday}} 好", ctx), "星期三 好");
check("docTitle 被替换", renderTemplate("标题：{{doc_title}}", ctx), "标题：今天的日记");
check("多个变量一起替换", renderTemplate("{{date}} {{time}}", ctx), "2026-11-18 21:30");
check("同一个变量出现两次都替换", renderTemplate("{{date}}-{{date}}", ctx), "2026-11-18-2026-11-18");

console.log("空格容错：");
check("变量内有空格也能识别", renderTemplate("{{ date }}", ctx), "2026-11-18");
check("变量前后有空格", renderTemplate(" {{ date }} ", ctx), " 2026-11-18 ");

console.log("未知变量不能吃掉：");
check("未知变量原样保留", renderTemplate("{{unknown}}", ctx), "{{unknown}}");
check("拼错的变量原样保留", renderTemplate("{{dates}}", ctx), "{{dates}}");
check("已知变量和未知变量混合", renderTemplate("{{date}} {{unknown}}", ctx), "2026-11-18 {{unknown}}");

console.log("空值和缺失：");
check("doc_title 为空时替换成空字符串", renderTemplate("A{{doc_title}}B", { ...ctx, docTitle: "" }), "AB");
check("doc_title 缺失也不崩", renderTemplate("A{{doc_title}}B", { date: "2026-11-18", time: "1", weekday: "一" }), "AB");

console.log("content 已移除：");
check("content 不再被替换（当未知变量原样保留）", renderTemplate("{{content}}", ctx), "{{content}}");

console.log("提取用到的变量：");
check("什么都没用", extractVars("普通文字"), []);
check("提取到一个", extractVars("{{date}}"), ["date"]);
check("提取到多个且去重", extractVars("{{date}} {{time}} {{date}}"), ["date", "time"]);
check("提取时也容忍空格", extractVars("{{ date }}"), ["date"]);
check("未知变量也提取出来", extractVars("{{unknown}}"), ["unknown"]);

console.log("变量清单：");
check("支持的变量一共 4 个", VARS.length, 4);
check("不再包含 content", VARS.includes("content"), false);
check("包含 doc_title", VARS.includes("doc_title"), true);

console.log("");
console.log(`结果：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
