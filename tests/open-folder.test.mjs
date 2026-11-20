/**
 * 「图片」按钮的路径测试。
 *
 * 真实故障：dataDir 已经是 .../data 这一层，代码又拼了一层 data\，
 * 得到 Z:\siyuan\data\data\storage\... —— 目录不存在，点按钮必然失败。
 */
import { imagesFolderHint, openImagesFolder } from "../.test/image-store.js";

let pass = 0;
let fail = 0;
function ok(name, cond, extra = "") {
    if (cond) {
        pass++;
        console.log("  OK   " + name);
    } else {
        fail++;
        console.log("  FAIL " + name + (extra ? "  → " + extra : ""));
    }
}

const PLUGIN = "siyuan-plugin-ai-chat";

console.log("路径拼接（核心）：");
{
    // 模拟思源真实环境：dataDir 已经指到 data 这一层
    globalThis.window = { siyuan: { config: { system: { dataDir: "Z:\\siyuan\\data" } } } };

    const got = imagesFolderHint(PLUGIN);
    const want = "Z:\\siyuan\\data\\storage\\petal\\" + PLUGIN + "\\images";
    ok("dataDir 已是 data 层时，不再重复拼 data", got === want, got);
    ok("路径里只有一层 data", (got.match(/\\data\\/g) || []).length === 1, got);
    ok("不含 data\\data", !got.includes("data\\data"), got);
    ok("以 images 结尾", got.endsWith("\\images"), got);
}

console.log("dataDir 带尾部斜杠：");
{
    globalThis.window = { siyuan: { config: { system: { dataDir: "Z:\\siyuan\\data\\" } } } };
    const got = imagesFolderHint(PLUGIN);
    ok("尾部斜杠被去掉，不出现双斜杠", !got.includes("\\\\"), got);
    ok("路径正确", got === "Z:\\siyuan\\data\\storage\\petal\\" + PLUGIN + "\\images", got);
}

console.log("拿不到 dataDir 时给个能看懂的相对路径：");
{
    globalThis.window = { siyuan: {} };
    const got = imagesFolderHint(PLUGIN);
    ok("退回带 data 的相对说法", got.startsWith("data\\"), got);
    ok("仍然以 images 结尾", got.endsWith("\\images"), got);
}

console.log("打开文件夹：目录不存在时要说清楚，不要报莫名其妙的错：");
{
    globalThis.window = { siyuan: { config: { system: { dataDir: "Z:\\siyuan\\data" } } } };
    globalThis.window.require = (name) => {
        if (name === "fs") {
            return {
                existsSync: () => false, // 假装目录不存在
                readFileSync: () => "",
            };
        }
        return {};
    };
    const msg = await openImagesFolder(PLUGIN);
    ok("说明目录还没创建", /还没创建/.test(msg), msg);
    ok("同时给出完整路径", /petal/.test(msg) && /images/.test(msg), msg);
}

console.log("打开文件夹：手机端（没有 require）：");
{
    globalThis.window = {
        siyuan: { config: { system: { dataDir: "Z:\\siyuan\\data" } } },
    };
    const msg = await openImagesFolder(PLUGIN);
    ok("说明手机端不能打开", /手机端/.test(msg), msg);
    ok("给出路径", /petal/.test(msg), msg);
}

console.log("打开文件夹：目录存在、shell.openPath 成功：");
{
    const calls = [];
    globalThis.window = { siyuan: { config: { system: { dataDir: "Z:\\siyuan\\data" } } } };
    globalThis.window.require = (name) => {
        if (name === "fs") return { existsSync: () => true, readFileSync: () => "" };
        if (name === "@electron/remote")
            return {
                shell: {
                    openPath: async (p) => {
                        calls.push(p);
                        return "";
                    },
                },
            };
        return {};
    };
    const msg = await openImagesFolder(PLUGIN);
    ok("调用了一次 openPath", calls.length === 1, "次数 " + calls.length);
    ok("传的是正确路径", calls[0] === "Z:\\siyuan\\data\\storage\\petal\\" + PLUGIN + "\\images", calls[0]);
    ok("返回已打开", /已打开/.test(msg), msg);
}

console.log("打开文件夹：openPath 失败时退回 explorer.exe：");
{
    let spawned = null;
    globalThis.window = { siyuan: { config: { system: { dataDir: "Z:\\siyuan\\data" } } } };
    globalThis.window.require = (name) => {
        if (name === "fs") return { existsSync: () => true, readFileSync: () => "" };
        if (name === "@electron/remote")
            return { shell: { openPath: async () => "权限不足" } };
        if (name === "electron") return { shell: { openPath: async () => "还是不行" } };
        if (name === "child_process")
            return {
                spawn: (cmd, args) => {
                    spawned = { cmd, args };
                    return { unref: () => {} };
                },
            };
        return {};
    };
    const msg = await openImagesFolder(PLUGIN);
    ok("退回了 explorer.exe", !!spawned, "没有调用 spawn");
    ok("命令是 explorer.exe", spawned?.cmd, "explorer.exe");
    ok("参数是图片目录", spawned?.args?.[0] === "Z:\\siyuan\\data\\storage\\petal\\" + PLUGIN + "\\images", spawned?.args?.[0]);
    ok("返回已用资源管理器打开", /资源管理器/.test(msg), msg);
}

console.log("打开文件夹：全失败时至少给出路径：");
{
    globalThis.window = { siyuan: { config: { system: { dataDir: "Z:\\siyuan\\data" } } } };
    globalThis.window.require = (name) => {
        if (name === "fs") return { existsSync: () => true, readFileSync: () => "" };
        if (name === "@electron/remote") return { shell: { openPath: async () => "err" } };
        if (name === "electron") return {};
        if (name === "child_process") return {};
        return {};
    };
    const msg = await openImagesFolder(PLUGIN);
    ok("给出可手动打开的完整路径", msg.includes("Z:\\siyuan\\data\\storage\\petal\\" + PLUGIN + "\\images"), msg);
}

console.log("");
console.log(`结果：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
