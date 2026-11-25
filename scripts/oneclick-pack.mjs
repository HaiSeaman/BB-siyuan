/**
 * 一键打包的 BAT 会调用这个小脚本。
 *
 * 为什么不用 `npm run pack`：
 *   在部分 Windows 环境下 npm + shell 子进程会直接卡死（vite 一行输出都不出），
 *   主人双击后就一直等，只能 Ctrl+C 结束。这里改成直接用 node 跑，
 *   不经过 npm、不经过 cmd，从根上避免卡死。
 *
 * 用法（BAT 里调用）：
 *   node scripts/oneclick-pack.mjs
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const nodeModules = join(root, "node_modules");
const mainDir = "D:\\AI\\Github\\BBS\\BBS\\BB-siyuan";
const mainModules = join(mainDir, "node_modules");

function line(text = "") {
    console.log(text);
}

/** 自建目录联接，不用外部命令，避免权限/编码问题 */
function makeJunction(link, target) {
    const r = spawnSync("cmd", ["/d", "/c", "mklink", "/J", link, target], {
        encoding: "utf8",
        windowsHide: true,
    });
    return r.status === 0 && existsSync(join(link, ".bin"));
}

/** 只删联接本身，绝不递归删内容 */
function removeJunction(link) {
    try {
        const st = lstatSync(link);
        // 目录联接在 Windows 上表现为符号链接/重解析点
        if (!st.isSymbolicLink()) {
            // 不是链接：说明是真实依赖目录，不能动
            return { removed: false, reason: "real-dir" };
        }
    } catch {
        return { removed: false, reason: "missing" };
    }
    try {
        execFileSync("cmd", ["/d", "/c", "rmdir", link], { stdio: "ignore", windowsHide: true });
        return { removed: !existsSync(link), reason: existsSync(link) ? "failed" : "ok" };
    } catch {
        return { removed: !existsSync(link), reason: "failed" };
    }
}

function doCleanup() {
    if (!existsSync(nodeModules)) return;
    const r = removeJunction(nodeModules);
    if (r.removed) line("  已清理临时依赖联接");
    else if (r.reason === "real-dir") line("  当前目录是真实依赖，不需要清理");
    else if (r.reason === "failed") line("  [提醒] 临时联接没删掉，请手动删除：" + nodeModules);
}

function doPrepare() {
    if (existsSync(join(nodeModules, ".bin"))) {
        line("[1/3] 依赖已就绪");
        return 0;
    }
    if (!existsSync(join(mainModules, ".bin"))) {
        line("[错误] 当前目录没有依赖，主仓库也没装。");
        line("       请先运行：cd /d \"" + mainDir + "\" && npm install");
        return 1;
    }
    if (root.toLowerCase() === mainDir.toLowerCase()) {
        line("[错误] 主仓库的依赖不完整，请重新运行 npm install。");
        return 1;
    }
    line("[1/3] 当前目录没有依赖，正在从主仓库借用...");
    if (!makeJunction(nodeModules, mainModules)) {
        line("[错误] 借用依赖失败。请确认磁盘可写，或手动运行：");
        line("       mklink /J \"" + nodeModules + "\" \"" + mainModules + "\"");
        return 1;
    }
    line("      借用成功（打包完会自动删掉）");
    return 0;
}

/**
 * 直接用 node 跑脚本，不经过 npm、不经过 cmd。
 * 这是修掉「双击卡死」的关键：npm + shell 子进程在某些机器上会挂住。
 */
function runNode(scriptPath, args = [], extraEnv = {}) {
    const r = spawnSync(process.execPath, [scriptPath, ...args], {
        cwd: root,
        stdio: "inherit",
        windowsHide: false,
        env: { ...process.env, ...extraEnv },
    });
    if (r.error) {
        line("[错误] 启动失败：" + r.error.message);
        return 1;
    }
    return r.status === 0 ? 0 : 1;
}

function doPack() {
    if (!existsSync(join(root, "plugin.json"))) {
        line("[错误] 当前文件夹没有 plugin.json，不是插件根目录。");
        return 1;
    }

    const viteBin = join(nodeModules, "vite", "bin", "vite.js");
    if (!existsSync(viteBin)) {
        line("[错误] 找不到 vite：" + viteBin);
        line("       依赖可能不完整，请到主仓库运行 npm install。");
        return 1;
    }

    line("[2/3] 正在构建并打包，请稍等...");
    line();

    // 第一步：构建（等价于 cross-env NODE_ENV=production vite build）
    const built = runNode(viteBin, ["build"], { NODE_ENV: "production" });
    if (built !== 0) {
        line();
        line("[错误] 构建失败，请把上面最后几行报错发给主人。");
        return 1;
    }

    // 第二步：打包（等价于 node scripts/pack.mjs）
    const packScript = join(here, "pack.mjs");
    if (!existsSync(packScript)) {
        line("[错误] 找不到打包脚本：" + packScript);
        return 1;
    }
    const packed = runNode(packScript);
    if (packed !== 0) {
        line();
        line("[错误] 打包失败，请把上面最后几行报错发给主人。");
        return 1;
    }

    let version = "";
    try {
        version = JSON.parse(readFileSync(join(root, "plugin.json"), "utf8")).version;
    } catch {
        version = "";
    }
    if (!version) {
        line();
        line("[错误] 读不到 plugin.json 里的版本号，不敢瞎猜文件名，先停下来。");
        return 1;
    }
    const zipName = `siyuan-plugin-ai-chat-v${version}.zip`;
    const zipPath = join(root, zipName);

    if (!existsSync(zipPath)) {
        line();
        line("[错误] 打包脚本说成功了，但没看到 " + zipName);
        return 1;
    }

    line();
    line("[3/3] 打包完成");
    line();
    line("  压缩包：" + zipPath);
    line("  大小：  " + statSync(zipPath).size + " 字节");
    line("  版本：  " + version);

    // 工作树里打包时，顺手放到主仓库，主人在常用目录就能拿到
    if (root.toLowerCase() !== mainDir.toLowerCase() && existsSync(mainDir)) {
        const dst = join(mainDir, zipName);
        try {
            execFileSync("cmd", ["/d", "/c", "copy", "/y", zipPath, dst], {
                stdio: "ignore",
                windowsHide: true,
            });
            if (existsSync(dst)) {
                line();
                line("  已另存一份到常用目录：");
                line("  " + dst);
            }
        } catch {
            // 复制失败不影响打包本身
        }
    }
    return 0;
}

// 准备 → 打包 → 清理
const prepared = doPrepare();
if (prepared !== 0) {
    doCleanup();
    process.exit(prepared);
}

const packed = doPack();
doCleanup();
process.exit(packed);
