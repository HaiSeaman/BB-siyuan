/**
 * 交付前核对 1.4.0 安装包：解压逐项检查。
 * 这是独立于打包脚本的第二道检查。
 */
import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

const zipPath = process.argv[2] || "siyuan-plugin-ai-chat-v1.4.0.zip";
const buf = readFileSync(zipPath);

let eocd = -1;
for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
    }
}
if (eocd < 0) {
    console.error("不是有效的 zip");
    process.exit(1);
}

const count = buf.readUInt16LE(eocd + 10);
let off = buf.readUInt32LE(eocd + 16);
const files = {};
const names = [];

for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString("utf8");
    let data;
    if (method === 0) {
        data = buf.subarray(localOff, localOff + compSize);
    } else {
        const lNameLen = buf.readUInt16LE(localOff + 26);
        const lExtraLen = buf.readUInt16LE(localOff + 28);
        const start = localOff + 30 + lNameLen + lExtraLen;
        data = inflateRawSync(buf.subarray(start, start + compSize));
    }
    files[name] = data.toString("utf8");
    names.push(name);
    off += 46 + nameLen + extraLen + commentLen;
}

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

console.log("包内文件：" + names.sort().join(", "));
const js = files["index.js"] || "";
const css = files["index.css"] || "";
const pj = JSON.parse(files["plugin.json"] || "{}");

console.log("\n【基础】");
ok("正好 5 个文件", names.length === 5, String(names.length));
ok("plugin.json 在根部", names.includes("plugin.json"));
ok("版本是 1.4.0", pj.version === "1.4.0", pj.version);
ok("声明了 mobile", pj.frontends.includes("mobile"), JSON.stringify(pj.frontends));
ok("没有测试依赖", !names.some((n) => /test|node_modules|\.map$|\.ts$|\.svelte$/.test(n)));

console.log("\n【生图】");
ok("文生图接口", js.includes("images/generations"));
ok("图生图接口（拼接形式）", js.includes('"/images/"') && js.includes("generations|edits"));
ok("multipart", js.includes("multipart/form-data"));
ok("四档尺寸", js.includes("1K") && js.includes("4K+"));
ok("长边 1920", js.includes("1920"));
ok("长边 2560", js.includes("2560"));
ok("长边 3840", js.includes("3840"));
ok("长边 4096", js.includes("4096"));
ok("10 种比例", ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "5:4", "4:5", "21:9"].every((r) => js.includes(r)));

console.log("\n【图片管理】");
ok("复制图片", js.includes("复制图片"));
ok("保存到电脑", js.includes("保存到电脑"));
ok("原生另存为", js.includes("showSaveDialog"));
ok("打开文件夹", js.includes("openPath"));
ok("explorer 兜底", js.includes("explorer.exe"));
ok("字节嗅探", js.includes("image/jpeg"));
ok("写插件目录", js.includes("/api/file/putFile"));
ok("读插件目录", js.includes("/api/file/getFile"));
ok("删插件文件", js.includes("/api/file/removeFile"));
ok("响应式图片表（模板不靠函数调用）", js.includes("storage\\/petal") || js.includes("/storage/petal/"));

console.log("\n【多选模型】");
ok("picked 字段", js.includes("picked"));
ok("勾选文案", js.includes("已勾选") || js.includes("勾选"));

console.log("\n【模型分类】");
ok("画图标签", js.includes("画图"));
ok("标为画图", js.includes("标为画图"));
ok("手动名单字段", js.includes("imageModels"));

console.log("\n【本轮修复的特征串】");
ok("停止是真中止（AbortSignal）", js.includes('addEventListener("abort"'));
ok("5 分钟流式兜底", js.includes("等太久了"));
ok("正文图片搬盘带序号", js.includes("msg"));
ok("尺寸提示（实际/已换）", js.includes("实际") && js.includes("已换"));

console.log("\n【样式】");
ok("图片卡片", css.includes("img-card"));
ok("按钮行", css.includes("img-actions"));
ok("勾选框", css.includes("chip-pick"));
ok("图片按钮", css.includes("pill"));
ok("像素提示", css.includes("px-hint"));

console.log("\n【不该在包里的】");
ok("无 linkedom", !Object.values(files).some((v) => v.includes("linkedom")));
ok("无 esbuild-svelte", !Object.values(files).some((v) => v.includes("esbuild-svelte")));
ok("无 sourcemap", !names.some((n) => n.endsWith(".map")));

console.log("");
console.log(`结果：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
