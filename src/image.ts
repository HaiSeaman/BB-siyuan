/**
 * 生图：尺寸换算 + 请求构造 + 返回解析。
 *
 * 这一层不碰 DOM，也不直接发请求（发请求由调用方注入 fetcher），
 * 所以能在 Node 里完整测一遍。
 *
 * 只做 OpenAI 标准接口：
 *   文生图  POST {base}/images/generations   { model, prompt, size, n, response_format }
 *   图生图  POST {base}/images/edits         multipart/form-data（image + prompt + size）
 */

/** 界面上可选的比例。顺序就是菜单里的顺序 */
export const RATIOS = [
    "1:1",
    "4:3",
    "3:4",
    "16:9",
    "9:16",
    "3:2",
    "2:3",
    "5:4",
    "4:5",
    "21:9",
] as const;

export type Ratio = (typeof RATIOS)[number];

/**
 * 界面上可选的大小。指的是"能铺满多大的屏幕"（长边像素）。
 *
 * 这是消费级屏幕的通用叫法，不是 AI 生图圈那个"长边 1024"的算法：
 *   1K   = 1920 长边 → 16:9 正好 1920×1080，铺满 1080p 屏
 *   2K   = 2560 长边 → 16:9 正好 2560×1440
 *   4K   = 3840 长边 → 16:9 正好 3840×2160
 *   4K+  = 4096 长边 → 电影行业 DCI 4K，比 3840 略大
 */
export const SIZES = ["1K", "2K", "4K", "4K+"] as const;

export type SizeLevel = (typeof SIZES)[number];

/** 长边像素，按屏幕分辨率基准 */
export const LONG_EDGE: Record<SizeLevel, number> = {
    "1K": 1920,
    "2K": 2560,
    "4K": 3840,
    "4K+": 4096,
};

/** 像素必须是 8 的倍数，很多模型都对奇数/非 8 倍数报错 */
function round8(n: number): number {
    return Math.max(8, Math.round(n / 8) * 8);
}

export interface ImageSize {
    width: number;
    height: number;
    /** "2048x1152"，直接塞进请求体的那个字符串 */
    api: string;
    /** 给用户看的 "2048 × 1152" */
    label: string;
}

/** 这一档长边是多少像素（菜单里显示用，不用算整组宽高） */
export function longEdgeOf(level: SizeLevel): number {
    return LONG_EDGE[level] || LONG_EDGE["2K"];
}

/** 把「2K + 16:9」换算成具体像素 */
export function computeSize(level: SizeLevel, ratio: Ratio | string): ImageSize {
    const long = LONG_EDGE[level] || LONG_EDGE["2K"];
    const parts = String(ratio || "1:1").split(":");
    let w = Number(parts[0]);
    let h = Number(parts[1]);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
        w = 1;
        h = 1;
    }

    let width: number;
    let height: number;
    if (w >= h) {
        width = long;
        height = round8((long * h) / w);
    } else {
        height = long;
        width = round8((long * w) / h);
    }
    return {
        width,
        height,
        api: width + "x" + height,
        label: width + " × " + height,
    };
}

/**
 * 几个有硬性尺寸表的大厂模型。
 *
 * 注意：这里的数字是厂商写死的，和界面上的 1K/2K/4K 不是一回事 ——
 * 界面选 2K+16:9 想要 2560×1440，但 gpt-image-1 只给 1536×1024，
 * 所以会换成最接近的并明确告诉主人"已换"。
 * 名字对不上的模型，一律按"服务商什么都收"处理。
 */
const OFFICIAL_SIZES: { test: RegExp; sizes: { w: number; h: number }[] }[] = [
    {
        // 只锁官方 gpt-image-1 这一个名字。
        // 不能写 /gpt-image/i：那样会把 gpt-image-2.6-sunburst 这类
        // 中转站/第三方模型一起锁死，而它们通常能吃任意尺寸。
        test: /^gpt-image-1$/i,
        sizes: [
            { w: 1024, h: 1024 },
            { w: 1536, h: 1024 },
            { w: 1024, h: 1536 },
        ],
    },
    {
        test: /^dall-e-3$/i,
        sizes: [
            { w: 1024, h: 1024 },
            { w: 1792, h: 1024 },
            { w: 1024, h: 1792 },
        ],
    },
];

/**
 * 带版本号的官方模型（如 gpt-image-1.5）也按官方表处理。
 * 但带额外后缀的（gpt-image-2.6-sunburst 这种）视为第三方，不限制。
 */
const OFFICIAL_LIKE = /^gpt-image-\d+(\.\d+)?$/i;

/**
 * 这个模型有没有官方尺寸限制。
 * 有就返回它的清单，没有返回 null（表示用户可以随便要）。
 */
export function officialSizes(model: string): { w: number; h: number }[] | null {
    const m = String(model || "").trim();
    if (!m) return null;
    for (const o of OFFICIAL_SIZES) {
        if (o.test.test(m)) return o.sizes;
    }
    // gpt-image-1.5 这种带小版本号的官方模型，同样按官方表
    if (OFFICIAL_LIKE.test(m)) return OFFICIAL_SIZES[0].sizes;
    return null;
}

/** 两组像素的长宽比差多少（越小越接近） */
function ratioDistance(a: { width: number; height: number }, b: { w: number; h: number }): number {
    const ra = a.width / a.height;
    const rb = b.w / b.h;
    return Math.abs(Math.log(ra) - Math.log(rb));
}

export interface SizePlan extends ImageSize {
    /** 是不是被官方尺寸表改过 */
    adjusted: boolean;
    /** 一句话说明，没改过就是空 */
    note: string;
}

/**
 * 最终要发出去的尺寸。
 *
 * 模型有官方尺寸表时，换成最接近的那个（宁可接近也别让请求 400），
 * 并且给一句人话说明换了什么 —— 不能让主人以为选 4K 就真拿到 4K。
 */
export function planSize(level: SizeLevel, ratio: Ratio | string, model: string): SizePlan {
    const wanted = computeSize(level, ratio);
    const official = officialSizes(model);
    if (!official) return { ...wanted, adjusted: false, note: "" };

    let best = official[0];
    let bestD = Infinity;
    for (const s of official) {
        const d = ratioDistance(wanted, s);
        if (d < bestD) {
            bestD = d;
            best = s;
        }
    }

    const api = best.w + "x" + best.h;
    const wasExact = api === wanted.api;
    return {
        width: best.w,
        height: best.h,
        api,
        label: best.w + " × " + best.h,
        adjusted: !wasExact,
        note: wasExact
            ? ""
            : `这个模型只支持固定尺寸，已从 ${wanted.width}×${wanted.height} 换成最接近的 ${best.w}×${best.h}`,
    };
}

export interface GenerateOptions {
    protocol: "openai" | "anthropic" | "gemini";
    baseURL: string;
    apiKey: string;
    model: string;
    prompt: string;
    /** 已经是 "1024x1024" 这种字符串 */
    size: string;
    /** 一次出几张。界面上固定 1 */
    n?: number;
    /** 参考图（图生图）。没有就是文生图 */
    reference?: { data: Uint8Array; mime: string; name: string };
}

function trimBase(baseURL: string): string {
    return String(baseURL || "").trim().replace(/\/+$/, "");
}

/**
 * 生图接口地址。
 *
 * 地址可能填到 /v1，也可能有人直接填到 /images/generations，
 * 两种都要能对上，别拼出 /images/generations/images/generations。
 */
export function imageEndpoint(baseURL: string, mode: "generations" | "edits"): string {
    let base = trimBase(baseURL).replace(/\/chat\/completions$/, "");
    if (/\/images\/(generations|edits)$/.test(base)) return base;
    if (/\/v1$/.test(base)) return base + "/images/" + mode;
    // 中转站常让人把地址填成裸域名，官方是 /v1/images/...
    return base + "/v1/images/" + mode;
}

/** 生图请求头。带 JSON 的那种，图生图会自己换成 multipart */
export function imageHeaders(apiKey: string): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
    if (apiKey) h.Authorization = "Bearer " + apiKey;
    return h;
}

/** 文生图的请求体 */
export function imageBody(opts: GenerateOptions): Record<string, any> {
    const body: Record<string, any> = {
        model: opts.model,
        prompt: opts.prompt,
        n: opts.n && opts.n > 0 ? opts.n : 1,
        size: opts.size,
        // 要 b64 才能保证拿得到图片数据；有的模型只认这个写法
        response_format: "b64_json",
    };
    return body;
}

// ---------- multipart：图生图要它 ----------

const CRLF = "\r\n";

function randomBoundary(): string {
    let s = "----siyuanai";
    for (let i = 0; i < 24; i++) s += Math.floor(Math.random() * 16).toString(16);
    return s;
}

export interface MultipartPart {
    name: string;
    value?: string;
    file?: { data: Uint8Array; mime: string; name: string };
}

/** 拼 multipart/form-data 的原始字节。图生图必须用它，不能用 JSON */
export function buildMultipart(
    parts: MultipartPart[],
    boundary = randomBoundary()
): { body: Uint8Array; contentType: string } {
    const encoder = new TextEncoder();
    const chunks: Uint8Array[] = [];

    for (const p of parts) {
        chunks.push(encoder.encode("--" + boundary + CRLF));
        if (p.file) {
            chunks.push(
                encoder.encode(
                    `Content-Disposition: form-data; name="${p.name}"; filename="${p.file.name}"` + CRLF
                )
            );
            chunks.push(encoder.encode("Content-Type: " + p.file.mime + CRLF + CRLF));
            chunks.push(p.file.data);
            chunks.push(encoder.encode(CRLF));
        } else {
            chunks.push(encoder.encode(`Content-Disposition: form-data; name="${p.name}"` + CRLF + CRLF));
            chunks.push(encoder.encode(p.value ?? ""));
            chunks.push(encoder.encode(CRLF));
        }
    }
    chunks.push(encoder.encode("--" + boundary + "--" + CRLF));

    let total = 0;
    for (const c of chunks) total += c.length;
    const body = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
        body.set(c, at);
        at += c.length;
    }
    return { body, contentType: "multipart/form-data; boundary=" + boundary };
}

/** 图生图的各个字段。顺序按 OpenAI 文档排 */
export function editParts(opts: GenerateOptions): MultipartPart[] {
    const parts: MultipartPart[] = [{ name: "model", value: opts.model }, { name: "prompt", value: opts.prompt }];
    if (opts.reference) parts.push({ name: "image", file: opts.reference });
    parts.push({ name: "n", value: String(opts.n && opts.n > 0 ? opts.n : 1) });
    parts.push({ name: "size", value: opts.size });
    return parts;
}

// ---------- 返回解析 ----------

export interface ImageResult {
    /** data:image/png;base64,... 这种，可以直接塞进 <img src> */
    dataUrls: string[];
    /** 服务商直接给了网址（有的中转站只给 url） */
    urls: string[];
    /** 服务商改写过提示词（gpt-image-1 会） */
    revisedPrompt: string;
}

/** 把 base64 图片拼成能显示的 data URL */
export function toDataUrl(b64: string, mime = "image/png"): string {
    const clean = String(b64 || "").replace(/\s+/g, "");
    if (!clean) return "";
    if (/^data:/i.test(clean)) return clean;
    return `data:${mime};base64,${clean}`;
}

/**
 * 解析 /images/generations 的返回。
 *
 * 三种形态都要认：
 *   1. { data: [{ b64_json }] }  ← 官方
 *   2. { data: [{ url }] }       ← 有的中转站默认只给网址
 *   3. { images: ["base64"] }    ← 个别国产中转站的自造格式
 */
export function parseImageResponse(raw: any): ImageResult {
    const out: ImageResult = { dataUrls: [], urls: [], revisedPrompt: "" };

    const pick = (item: any): string => {
        if (!item) return "";
        if (typeof item === "string") {
            if (/^https?:\/\//i.test(item)) {
                out.urls.push(item);
                return "";
            }
            return toDataUrl(item);
        }
        if (typeof item.b64_json === "string" && item.b64_json) return toDataUrl(item.b64_json);
        if (typeof item.image === "string" && item.image) return toDataUrl(item.image);
        if (typeof item.url === "string" && item.url) {
            out.urls.push(item.url);
            return "";
        }
        return "";
    };

    const list = Array.isArray(raw?.data) ? raw.data : Array.isArray(raw?.images) ? raw.images : [];
    for (const item of list) {
        const url = pick(item);
        if (url) out.dataUrls.push(url);
        if (item && typeof item.revised_prompt === "string" && item.revised_prompt) {
            out.revisedPrompt = item.revised_prompt;
        }
    }
    return out;
}

/** 返回里有没有图；没有就拿这句话去报错 */
export function imageErrorOf(raw: any): string {
    if (!raw) return "接口没返回图片数据。可能是这个模型不支持生图，或者参数不对。";
    const err = raw.error;
    if (err) return typeof err === "string" ? err : err.message || err.msg || JSON.stringify(err);
    if (typeof raw.message === "string" && raw.message) return raw.message;
    return "接口没返回图片。可能是这个模型不支持生图，或者参数不对。";
}

// ---------- 参考图 ----------

/** 参考图最大多少字节。太大接口会拒，也拖慢上传 */
export const MAX_REF_BYTES = 8 * 1024 * 1024;

export interface RefFile {
    name: string;
    mime: string;
    data: Uint8Array;
}

/** 只看类型和大小，不合规就返回一句人话；合规返回空 */
export function checkReference(file: { name: string; type: string; size: number }): string {
    const mime = String(file.type || "").toLowerCase();
    if (!/^image\/(png|jpe?g|webp)$/.test(mime)) {
        return "只能传 PNG、JPG、WEBP 这三种图片";
    }
    if (file.size > MAX_REF_BYTES) {
        return `图片太大了（${(file.size / 1024 / 1024).toFixed(1)} MB），请压到 8 MB 以内`;
    }
    if (file.size <= 0) return "这个文件是空的，换一张";
    return "";
}



// ---------- 保存到文件 ----------

/** 文件名里的时间戳：20261120-213045 */
export function stampOf(d: Date): string {
    const p = (n: number) => String(n).padStart(2, "0");
    return (
        d.getFullYear().toString() +
        p(d.getMonth() + 1) +
        p(d.getDate()) +
        "-" +
        p(d.getHours()) +
        p(d.getMinutes()) +
        p(d.getSeconds())
    );
}

/**
 * 把尺寸清洗成文件名里能用的片段。
 *
 * "1024 × 1024" 这种中间有空格和乘号的写法，直接去掉非数字字符会变成
 * "10241024"，看不出是两个数。所以先把所有分隔符统一成 x，再合并重复的。
 */
export function sizeSlug(size: string): string {
    const s = String(size || "")
        .replace(/[×*✕✖]/g, "x")
        .replace(/[^0-9x]/gi, "")
        .replace(/x+/gi, "x")
        .replace(/^x|x$/gi, "");
    return s || "size";
}

/** 存图用的文件名。带上尺寸和序号，一眼能看出是哪张 */
export function imageFileName(d: Date, size: string, index: number, mime = "image/png"): string {
    const ext = /jpe?g/i.test(mime) ? "jpg" : /webp/i.test(mime) ? "webp" : "png";
    const tail = index > 1 ? "-" + index : "";
    return `img-${stampOf(d)}-${sizeSlug(size)}${tail}.${ext}`;
}

/** 把 data URL 拆回字节，保存文件要用 */
export function dataUrlToBytes(dataUrl: string): { bytes: Uint8Array; mime: string } | null {
    const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(String(dataUrl || ""));
    if (!m) return null;
    const mime = m[1] || "image/png";
    const payload = m[3] || "";
    if (!m[2]) return null; // 非 base64 的 data URL 这里不处理
    try {
        const bin = atob(payload);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return { bytes, mime };
    } catch {
        return null;
    }
}
