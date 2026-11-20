/**
 * 一键安装：构建 + 复制到思源插件目录。
 *
 * 用法：npm run install-plugin
 *
 * 会自动找思源的数据目录；找不到就让你手动指定。
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, copyFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// 这个文件在 scripts/ 下，项目根目录要往上退一级
const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const distDir = join(root, "dist");
const pluginName = "siyuan-plugin-ai-chat";

/** 从思源的 workspace.json 里读出工作空间路径 */
function findWorkspace() {
    const home = process.env.USERPROFILE || process.env.HOME || "";
    const candidates = [
        join(home, ".config", "siyuan", "workspace.json"),
        join(home, "SiYuan", "workspace.json"),
        join(process.env.APPDATA || "", "siyuan", "workspace.json"),
        join(process.env.LOCALAPPDATA || "", "SiYuan", "workspace.json"),
    ];

    for (const f of candidates) {
        if (!existsSync(f)) continue;
        try {
            const raw = readFileSync(f, "utf8");
            const list = JSON.parse(raw);
            if (Array.isArray(list) && list.length > 0 && typeof list[0] === "string") {
                return list[0];
            }
        } catch {
            // 这个文件坏了就试下一个
        }
    }
    return null;
}

function copyDir(from, to) {
    mkdirSync(to, { recursive: true });
    for (const name of readdirSync(from)) {
        const src = join(from, name);
        const dst = join(to, name);
        if (statSync(src).isDirectory()) copyDir(src, dst);
        else copyFileSync(src, dst);
    }
}

console.log("1) 构建…");
execSync("npm run build", { cwd: root, stdio: "inherit" });

if (!existsSync(distDir)) {
    console.error("构建完没看到 dist 目录，停下来。");
    process.exit(1);
}

const workspace = process.argv[2] || findWorkspace();
if (!workspace) {
    console.error(
        "找不到思源工作空间。请手动指定，例如：\n" +
            "  npm run install-plugin -- Z:\\siyuan"
    );
    process.exit(1);
}

const pluginsDir = join(workspace, "data", "plugins", pluginName);
console.log("2) 安装到：" + pluginsDir);
copyDir(distDir, pluginsDir);

console.log("");
console.log("装好了。重启思源，或者在「设置 → 集市 → 已下载」里重新启用一次插件。");
