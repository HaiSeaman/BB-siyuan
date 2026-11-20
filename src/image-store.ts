/**
 * 图片存盘。
 *
 * 为什么不塞进 settings.json / sessions.json：
 * 一张 4K 图的 base64 就有十几兆，塞进 JSON 会让设置和历史越来越慢，
 * 最后连面板都打不开。所以图片单独存成文件，存档里只记路径。
 *
 * 存的位置：<工作空间>/data/storage/petal/<插件名>/images/
 * 也就是插件自己的数据文件夹里新开一个 images 目录。
 *
 * 走思源内核的 /api/file/putFile 和 /api/file/getFile：
 * 桌面端和手机端都能用，不用碰 Electron 的 require。
 */

/** 图片在插件数据目录里的相对位置（相对插件数据目录） */
export const IMAGE_DIR = "images";

export interface SavedImage {
    /** 相对插件数据目录的路径，如 images/img-xxx.png */
    path: string;
    bytes: number;
}

function dataRoot(pluginName: string): string {
    return `data/storage/petal/${pluginName}`;
}

/**
 * 把内核返回的 {code,msg} 变成异常。
 * 内核在权限不足、路径非法时也会返回 200 + code:-1，必须看 code。
 */
function checkKernelJson(json: any, what: string): void {
    if (!json || typeof json !== "object") throw new Error(what + "：内核没有返回可识别的结果");
    if (json.code !== 0) throw new Error(what + "：" + (json.msg || "code " + json.code));
}

/**
 * 存一张图。
 *
 * 用 FormData 交给内核，内核自己建目录（putFile 会自动 mkdir -p），
 * 所以第一次用的时候不需要先手工建 images 文件夹。
 */
export async function saveImage(
    pluginName: string,
    fileName: string,
    bytes: Uint8Array,
    mime = "image/png"
): Promise<SavedImage> {
    if (!pluginName) throw new Error("插件名没传进来，存不了图片");
    if (!bytes?.length) throw new Error("图片是空的，存不了");

    const rel = IMAGE_DIR + "/" + fileName;
    const fd = new FormData();
    // Blob 要拷一份独立缓冲：传进去的 Uint8Array 可能是别处复用的视图
    const copy = new Uint8Array(bytes.length);
    copy.set(bytes);
    fd.append("file", new Blob([copy], { type: mime }), fileName);
    fd.append("path", dataRoot(pluginName) + "/" + rel);
    fd.append("isDir", "false");

    const resp = await fetch("/api/file/putFile", { method: "POST", body: fd });
    if (!resp.ok) {
        throw new Error(`保存图片失败（HTTP ${resp.status}）`);
    }
    const text = await resp.text();
    let json: any = null;
    try {
        json = JSON.parse(text);
    } catch {
        throw new Error("保存图片失败：内核返回的不是 JSON");
    }
    checkKernelJson(json, "保存图片失败");
    return { path: rel, bytes: bytes.length };
}

/** 读一张图，返回能直接放进 <img src> 的 data URL */
export async function loadImageDataUrl(pluginName: string, rel: string): Promise<string> {
    if (!pluginName || !rel) return "";
    try {
        const resp = await fetch("/api/file/getFile", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: dataRoot(pluginName) + "/" + rel }),
        });

        const type = String(resp.headers.get("content-type") || "");
        if (!resp.ok) return "";

        // 内核在"文件不存在/没权限"时返回 JSON 错误体。
        // 但有的版本给的是 application/octet-stream，所以不能只看 content-type，
        // 要再用字节头确认到底是不是图。
        const buf = await resp.arrayBuffer();
        if (!buf.byteLength) return "";
        const bytes = new Uint8Array(buf);

        if (/application\/json|text\/html/i.test(type)) return "";
        // 前 4 个字节看起来不像任何图片、且响应体明显是个 JSON 对象，就当失败
        const head = new TextDecoder().decode(bytes.subarray(0, 1));
        if (head === "{" || head === "[") return "";

        return bufferToDataUrl(buf, sniffImageMime(bytes, mimeOfPath(rel)));
    } catch {
        return "";
    }
}

/**
 * 按名字/地址推断图片类型。
 *
 * 两种输入都吃：
 *   - data URL：`data:image/jpeg;base64,....` → 取中间那段
 *   - 普通路径或文件名：`a.jpg` / `images/a.webp` → 看扩展名
 *
 * 注意：这只是"看起来是什么"，真相永远以字节为准（见 sniffImageMime）。
 * 这里保留导出是因为界面上要按名字给出初始值，之后会被嗅探结果覆盖。
 */
export function mimeOfName(name: string): string {
    const s = String(name || "").trim();
    const dataMime = /^data:([^;,]+)[;,]/.exec(s);
    if (dataMime) return dataMime[1];
    const p = s.toLowerCase();
    if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
    if (p.endsWith(".webp")) return "image/webp";
    if (p.endsWith(".gif")) return "image/gif";
    return "image/png";
}

/** 旧名字，保留一行别名：调用点不用全改 */
export const mimeOfPath = mimeOfName;

/**
 * 按文件头字节判断真实图片类型。
 *
 * 为什么必须嗅探：服务商返回的可能是 JPEG，但我们按时间戳起了个 .png 的名字，
 * 结果 data URL 写成 image/png 却装着 JPEG 字节。多数浏览器能容错，
 * 但思源的 WebView 在部分版本上会直接拒绝渲染 —— 表现就是"图明明在，却显示不出来"。
 */
export function sniffImageMime(bytes: Uint8Array, fallback = "image/png"): string {
    if (!bytes || bytes.length < 12) return fallback;
    // JPEG: FF D8 FF
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
    // WebP: "RIFF"...."WEBP"
    if (
        bytes[0] === 0x52 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46 &&
        bytes[3] === 0x46 &&
        bytes[8] === 0x57 &&
        bytes[9] === 0x45 &&
        bytes[10] === 0x42 &&
        bytes[11] === 0x50
    ) {
        return "image/webp";
    }
    // GIF: "GIF8"
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return "image/gif";
    return fallback;
}

/**
 * 字节 → base64 字符串。
 *
 * 分块拼（0x8000 一段）：一次把几 MB 的字节塞进 String.fromCharCode
 * 会撞调用栈上限，实测 1MB 图片直接抛 RangeError。
 * net.ts 和这里共用一份，避免两套同样的循环。
 */
export function bytesToBase64(bytes: Uint8Array): string {
    const CHUNK = 0x8000;
    const parts: string[] = [];
    for (let i = 0; i < bytes.length; i += CHUNK) {
        parts.push(String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)) as any));
    }
    return btoa(parts.join(""));
}

/** ArrayBuffer → data URL（不依赖 FileReader，Node 里也能跑） */
export function bufferToDataUrl(buf: ArrayBuffer | Uint8Array, mime = "image/png"): string {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    return `data:${mime};base64,` + bytesToBase64(bytes);
}

/** 删一张图。删不掉不算错（可能已经被用户手动清掉了） */
export async function deleteImage(pluginName: string, rel: string): Promise<boolean> {
    if (!pluginName || !rel) return false;
    try {
        const resp = await fetch("/api/file/removeFile", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: dataRoot(pluginName) + "/" + rel }),
        });
        const text = await resp.text();
        const json = JSON.parse(text);
        return json?.code === 0;
    } catch {
        return false;
    }
}

/**
 * 插件数据目录在磁盘上的绝对路径。
 * 只用于给用户看"图存在哪儿"，以及桌面端「另存为」的默认目录。
 */
export function absoluteDataDir(): string {
    try {
        const dataDir = (window as any).siyuan?.config?.system?.dataDir;
        if (!dataDir) return "";
        return String(dataDir).replace(/[\\/]+$/, "");
    } catch {
        return "";
    }
}

/**
 * 图片文件夹在磁盘上的绝对路径。
 *
 * 注意 dataDir 的含义：思源的 system.dataDir 已经指到「.../data」这一层
 * （实测 Z:\siyuan\data），所以这里只能再接 storage/petal/...，
 * 绝不能再拼一个 data 前缀 —— 那会得到 Z:\siyuan\data\data\storage\...，
 * 目录不存在，打开文件夹必然失败。
 */
export function imagesFolderHint(pluginName: string): string {
    const root = absoluteDataDir();
    const tail = `storage\\petal\\${pluginName}\\${IMAGE_DIR}`;
    if (!root) {
        // 拿不到 dataDir 时退回相对说法，至少能让人看懂
        return `data\\` + tail;
    }
    // dataDir 在思源 3.8.x 里已经指到 ".../data" 这一层；
    // 但老版本/少数配置可能只到工作空间根。按最后一段判断，避免多一层或少一层。
    const last = root.split(/[\\/]/).filter(Boolean).pop() || "";
    if (last.toLowerCase() === "data") return root + "\\" + tail;
    return root + "\\data\\" + tail;
}

/**
 * 在系统文件管理器里打开图片文件夹。
 *
 * 返回一句给人看的结果，调用方直接丢到状态栏。
 * 桌面版走 Electron 的 shell.openPath；手机端没有这个能力，给出路径让主人自己去翻。
 */
export async function openImagesFolder(pluginName: string): Promise<string> {
    if (!pluginName) return "插件名没传进来，找不到图片文件夹";

    const dir = imagesFolderHint(pluginName);
    const req = (window as any).require;
    if (typeof req !== "function") {
        return "手机端不能直接打开文件夹。图片存在这里（用文件管理 App 找得到）：" + dir;
    }

    // 先确认目录存在：没生成过图片时目录还不存在，
    // 这时 openPath 只会给个莫名其妙的错，不如直接说清楚。
    let exists = false;
    try {
        const fs = req("fs");
        exists = !!(fs && fs.existsSync && fs.existsSync(dir));
    } catch {}
    if (!exists) {
        return "图片文件夹还没创建（这张图可能还没生成过）。路径是：" + dir;
    }

    // 1) @electron/remote 的 shell
    try {
        const remote = req("@electron/remote");
        const shell = remote?.shell;
        if (shell?.openPath) {
            const err = await shell.openPath(dir);
            if (!err) return "已打开图片文件夹：" + dir;
            // 记录一下，继续试下一条
        }
    } catch {}

    // 2) electron 模块的 shell
    try {
        const shell = req("electron")?.shell;
        if (shell?.openPath) {
            const err = await shell.openPath(dir);
            if (!err) return "已打开图片文件夹：" + dir;
        }
    } catch {}

    // 3) Windows 原生：explorer.exe 打开目录（不经过 shell，最不容易被拦）
    try {
        const cp = req("child_process");
        if (cp?.spawn) {
            // 用 spawn 而不是 execSync：不阻塞界面，也不用拼字符串命令
            const child = cp.spawn("explorer.exe", [dir], { detached: true, stdio: "ignore" });
            if (child && typeof child.unref === "function") child.unref();
            return "已用资源管理器打开：" + dir;
        }
    } catch {}

    // 4) 都不行：至少把路径给全，让人能手动粘贴
    return "打不开文件夹。请手动打开这个路径：" + dir;
}
