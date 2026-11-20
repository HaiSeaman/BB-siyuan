/**
 * 打包：把 dist/ 打成思源能直接安装的 zip。
 *
 * 思源安装包的约定：plugin.json 必须在 zip 的**根目录**，
 * 不能套一层文件夹，否则集市/手动安装会找不到清单。
 *
 * 用法：npm run pack
 * 产出：siyuan-plugin-ai-chat-v<plugin.json 里的版本号>.zip（放项目根目录）
 */
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync, crc32 } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const distDir = join(root, "dist");

if (!existsSync(distDir)) {
    console.error("没有 dist 目录，先跑 npm run build");
    process.exit(1);
}

const manifest = JSON.parse(readFileSync(join(distDir, "plugin.json"), "utf8"));
const version = manifest.version;
const outName = `siyuan-plugin-ai-chat-v${version}.zip`;
const outPath = join(root, outName);

/** 递归列出 dist 下所有文件（相对路径用 / 分隔，zip 规范要求） */
function walk(dir) {
    const out = [];
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        const st = statSync(full);
        if (st.isDirectory()) out.push(...walk(full));
        else out.push({ full, rel: relative(distDir, full).split(sep).join("/") });
    }
    return out;
}

const files = walk(distDir);

/**
 * 自己写 zip，不引第三方依赖。
 * 只需要「不压缩」和「deflate」两种，用 zlib 的原始 deflate 即可。
 * 单个文件超过 4GB 才会用到 zip64，这里不可能。
 */
function dosDateTime(d) {
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
    const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    return { time, date };
}

const now = new Date();
const { time: dosTime, date: dosDate } = dosDateTime(now);

const localParts = [];
const centralParts = [];
let offset = 0;

for (const f of files) {
    const raw = readFileSync(f.full);
    const compressed = deflateRawSync(raw);
    // 压缩没变小就直接存原文
    const useStore = compressed.length >= raw.length;
    const data = useStore ? raw : compressed;
    const method = useStore ? 0 : 8;

    const nameBuf = Buffer.from(f.rel, "utf8");
    const crc = crc32(raw) >>> 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // 本地文件头签名
    local.writeUInt16LE(20, 4); // 解压所需版本
    local.writeUInt16LE(0x0800, 6); // 通用标志：文件名用 UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // 额外字段长度

    localParts.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // 中央目录签名
    central.writeUInt16LE(20, 4); // 创建版本
    central.writeUInt16LE(20, 6); // 解压所需版本
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // 额外字段
    central.writeUInt16LE(0, 32); // 注释
    central.writeUInt16LE(0, 34); // 磁盘号
    central.writeUInt16LE(0, 36); // 内部属性
    central.writeUInt32LE(0, 38); // 外部属性
    central.writeUInt32LE(offset, 42); // 本地头偏移

    centralParts.push(central, nameBuf);

    offset += local.length + nameBuf.length + data.length;
}

const centralDir = Buffer.concat(centralParts);
const centralSize = centralDir.length;
const centralOffset = offset;

const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); // 中央目录结束签名
end.writeUInt16LE(0, 4);
end.writeUInt16LE(0, 6);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralSize, 12);
end.writeUInt32LE(centralOffset, 16);
end.writeUInt16LE(0, 20);

mkdirSync(root, { recursive: true });

// 同步写入：旧版用 createWriteStream 异步写，失败时既不报错也不产出文件
// （zip 被杀毒软件扫描、或被资源管理器占用时就会这样）。
// 同步写 + 明确报错，出问题能立刻看见。
const payload = Buffer.concat([...localParts, centralDir, end]);

let finalPath = outPath;
let finalName = outName;
try {
    writeFileSync(finalPath, payload);
} catch (e) {
    // 目标文件被占用（杀毒/预览/旧进程未释放），换一个带时间戳的名字，
    // 不让主人对着“显示成功却没有包”发愣。
    const stamp = String(Date.now()).slice(-6);
    finalName = `siyuan-plugin-ai-chat-v${version}-${stamp}.zip`;
    finalPath = join(root, finalName);
    try {
        writeFileSync(finalPath, payload);
        console.log("注意：原文件名被占用，已改存为：" + finalName);
    } catch (e2) {
        console.error("写 zip 失败：" + (e2?.message || e2));
        console.error("目标路径：" + finalPath);
        process.exit(1);
    }
}

// 写完立刻核对：大小必须和内存里的一致，否则就是没写全
const writtenSize = statSync(finalPath).size;
if (writtenSize !== payload.length) {
    console.error("zip 写入不完整：期望 " + payload.length + " 字节，实际 " + writtenSize);
    process.exit(1);
}

console.log("");
console.log("打包完成：" + finalName);
console.log("文件数：" + files.length);
console.log("大小：" + (writtenSize / 1024).toFixed(1) + " KB");
console.log("路径：" + finalPath);
console.log("");
console.log("清单里的版本：" + version);
console.log("包内结构（应为 plugin.json 在根）：");
for (const f of files) console.log("  " + f.rel);
