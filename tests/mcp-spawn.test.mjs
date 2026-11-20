/**
 * Windows 上启动本地进程的适配。
 *
 * 两个必须覆盖的点：
 *   1. npx / npm 是 .cmd，要补扩展名
 *   2. 新版 Node 不许直接 spawn .cmd，得用 cmd /c 包一层
 *   3. 全程不要开 shell:true（那是字符串拼接，有注入风险）
 */
import { resolveCommand, needsCmdWrapper, makeSpawner } from "../.test/mcp-spawn.js";

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

console.log("Windows 补扩展名：");
check("npx 补 .cmd", resolveCommand("npx", "win32"), "npx.cmd");
check("npm 补 .cmd", resolveCommand("npm", "win32"), "npm.cmd");
check("uvx 补 .cmd", resolveCommand("uvx", "win32"), "uvx.cmd");
check("node 补 .exe", resolveCommand("node", "win32"), "node.exe");
check("已带扩展名不动", resolveCommand("x.cmd", "win32"), "x.cmd");
check("完整路径不动", resolveCommand("C:\\a\\b.exe", "win32"), "C:\\a\\b.exe");
check("不认识的原样", resolveCommand("my-srv", "win32"), "my-srv");
check("linux 不改", resolveCommand("npx", "linux"), "npx");

console.log("哪些需要 cmd 包一层：");
check("npx.cmd 需要", needsCmdWrapper("npx.cmd", "win32"), true);
check("任意 .bat 需要", needsCmdWrapper("run.bat", "win32"), true);
check("node.exe 不需要", needsCmdWrapper("node.exe", "win32"), false);
check("linux 上都不需要", needsCmdWrapper("npx.cmd", "linux"), false);

console.log("spawn 行为：");
{
    const calls = [];
    const fake = { spawn: (c, a, o) => (calls.push({ c, a, o }), {}) };
    makeSpawner(fake, "win32")("npx", ["-y", "server"], { env: {} });
    check("走 cmd.exe", calls[0].c, "cmd.exe");
    check("用 /d /s /c 开头（/d 跳过 AutoRun，/s 改引号规则）", calls[0].a.slice(0, 3), ["/d", "/s", "/c"]);
    check("命令补成 .cmd", calls[0].a[3], "npx.cmd");
    check("参数在后面", calls[0].a.slice(4), ["-y", "server"]);
    check("绝不用 shell:true", calls[0].o.shell, false);
}
{
    const calls = [];
    const fake = { spawn: (c, a, o) => (calls.push({ c, a, o }), {}) };
    makeSpawner(fake, "win32")("node", ["x.js"], {});
    check("node.exe 直接起", calls[0].c, "node.exe");
    check("不套 cmd", calls[0].a, ["x.js"]);
}
{
    const calls = [];
    const fake = { spawn: (c, a, o) => (calls.push({ c, a, o }), {}) };
    makeSpawner(fake, "linux")("npx", ["-y"], {});
    check("linux 直接起", calls[0].c, "npx");
    check("linux 不套 cmd", calls[0].a, ["-y"]);
}
{
    // 怪字符必须留在参数数组里，但交给 cmd 时要转义，否则会被 cmd 拆开
    const calls = [];
    const fake = { spawn: (c, a, o) => (calls.push({ c, a, o }), {}) };
    makeSpawner(fake, "win32")("npx", ["-y", "a&b|c", "带 空格"], {});
    check("& 和 | 被转义", calls[0].a[5], "a^&b^|c");
    check("带空格的参数原样（cmd 会当整体）", calls[0].a[6], "带 空格");
}
{
    // URL 查询串里的 & 不转义会被 cmd 拆成两条命令
    const calls = [];
    const fake = { spawn: (c, a, o) => (calls.push({ c, a, o }), {}) };
    makeSpawner(fake, "win32")("npx", ["https://x.test/a?foo=1&bar=2"], {});
    check("URL 里的 & 被转义", calls[0].a[4], "https://x.test/a?foo=1^&bar=2");
}
{
    const calls = [];
    const fake = { spawn: (c, a, o) => (calls.push({ c, a, o }), {}) };
    makeSpawner(fake, "win32")("npx", ["%USERPROFILE%\\x"], {});
    check("百分号被转义（不让 cmd 展开）", calls[0].a[4], "^%USERPROFILE^%\\x");
}

console.log("");
console.log(`结果：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
