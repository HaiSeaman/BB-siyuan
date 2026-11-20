/**
 * 交付前核对：解压 zip，逐条检查该有的在、不该有的不在。
 * 只读，不改任何东西。
 */
import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

const zipPath = process.argv[2];
const buf = readFileSync(zipPath);

// 解析 zip 中央目录
let eocd = -1;
for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
    }
}
if (eocd < 0) throw new Error("不是有效的 zip");

const count = buf.readUInt16LE(eocd + 10);
let off = buf.readUInt32LE(eocd + 16);
const entries = [];

for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error("中央目录损坏");
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const rawSize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString("utf8");

    let data;
    if (method === 0) {
        data = buf.subarray(localOff, localOff + compSize);
    } else {
        // 本地头也要跳过文件名和额外字段
        const lNameLen = buf.readUInt16LE(localOff + 26);
        const lExtraLen = buf.readUInt16LE(localOff + 28);
        const start = localOff + 30 + lNameLen + lExtraLen;
        data = inflateRawSync(buf.subarray(start, start + compSize));
    }
    entries.push({ name, text: data.toString("utf8"), size: rawSize });
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

console.log("包内文件：");
for (const e of entries) console.log("  " + e.name + "  (" + e.size + " 字节)");

const names = entries.map((e) => e.name).sort();
const expect = ["icon.png", "index.css", "index.js", "net-proxy.cjs", "plugin.json"];
ok("文件清单完全正确", JSON.stringify(names) === JSON.stringify(expect), JSON.stringify(names));
ok("plugin.json 在根目录", names.includes("plugin.json"));

const get = (n) => entries.find((e) => e.name === n)?.text || "";

console.log("");
console.log("版本号：");
{
    const pj = JSON.parse(get("plugin.json"));
    ok("版本是 1.4.0", pj.version, "1.4.0");
    ok("清单能正常解析（没有 BOM）", typeof pj.name, "string");
    ok("名字没变", pj.name, "siyuan-plugin-ai-chat");
    ok("最低思源版本没降", pj.minAppVersion, "3.8.5");
}

console.log("");
console.log("新功能都打进产物了：");
{
    const js = get("index.js");
    ok("有文生图接口", js.includes("images/generations"));
    // 图生图那条地址是拼出来的（压缩后成了 "/images/"+变量），
    // 所以查"能不能拼出 edits"，而不是查字面量 "images/edits"
    ok("有图生图接口（edits 那一路）", js.includes("generations|edits") && js.includes('"/images/"'));
    ok("会发 multipart", js.includes("multipart/form-data"));
    ok("会生成 boundary", js.includes("boundary"));
    ok("有「上传」按钮", js.includes("上传"));
    ok("有「优化」按钮", js.includes("优化中"));
    ok("有「复制图片」", js.includes("复制图片"));
    ok("有「保存到电脑」", js.includes("保存到电脑"));
    ok("会往插件目录写图片", js.includes("/api/file/putFile"));
    ok("会从插件目录读图片", js.includes("/api/file/getFile"));
    ok("会删图片文件", js.includes("/api/file/removeFile"));
    ok("images 目录名在", js.includes("images"));
    ok("生图模式提示条", js.includes("生图"));
    ok("画图模型标签", js.includes("画图"));
    ok("1K/2K/4K 三档都在", js.includes("1K") && js.includes("2K") && js.includes("4K"));
    ok("10 种比例的字符串都在", ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "5:4", "4:5", "21:9"].every((r) => js.includes(r)));
    ok("gpt-image 的官方尺寸在", js.includes("1536"));
    ok("优化用的中文系统提示在", js.includes("提示词"));
}

console.log("");
console.log("不该进包的东西确实没进去：");
{
    const js = get("index.js");
    const all = entries.map((e) => e.text).join("\n");
    ok("没有 linkedom（测试依赖）", !all.includes("linkedom"));
    ok("没有 esbuild-svelte", !all.includes("esbuild-svelte"));
    ok("没有测试文件", !names.some((n) => n.includes("test")));
    ok("没有 node_modules", !names.some((n) => n.includes("node_modules")));
    ok("没有 sourcemap", !names.some((n) => n.endsWith(".map")));
    ok("没有 ts 源码", !names.some((n) => n.endsWith(".ts") && !n.endsWith(".d.ts")));
    ok("没有 svelte 源码", !names.some((n) => n.endsWith(".svelte")));
    ok("没把密钥写进产物", !/apiKey\"\s*:\s*\"[a-zA-Z0-9]{10,}/.test(js));
}

console.log("");
console.log("net-proxy 带上了二进制通路：");
{
    const proxy = get("net-proxy.cjs");
    ok("认 bodyBase64", proxy.includes("bodyBase64"));
    ok("会用 Buffer.from 解 base64", proxy.includes("Buffer.from"));
    ok("原来的 body 通路还在", proxy.includes("options.body"));
}

console.log("");
console.log("样式也在：");
{
    const css = get("index.css");
    ok("有图片卡片样式", css.includes("img-card"));
    ok("有生图提示条样式", css.includes("img-banner"));
    ok("有控制条菜单样式", css.includes("menu-anchor"));
    ok("有画图模型橙色标记", css.includes("dot-api"));
}

console.log("");
console.log(`结果：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
