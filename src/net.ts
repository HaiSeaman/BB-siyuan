/**
 * 请求通道：优先走主进程（不受跨域限制），拿不到就退回浏览器 fetch。
 * 两条路径都按「文本块」回调，上层不关心底层怎么来的。
 *
 * 手机端没有 require（没有主进程通道），改为「经思源内核转发」：
 * 调到内核自带的 /api/network/forwardProxy，由内核替我们去请求模型接口，
 * 这样跨域、证书、Cookie 这些浏览器限制全都不成问题。代价是回答要等模型写完
 * 才一次性回来（桌面端是逐字显示）。
 */

export interface ChatMessage {
    role: "system" | "user" | "assistant";
    content: string;
}

export interface StreamHandlers {
    /** 收到原始文本块（SSE 原文），由上层负责解析 */
    onDelta: (text: string) => void;
    /**
     * 流正常结束或出错时调用一次；参数为空表示正常结束。
     * status 是 HTTP 状态码（不知道就是 0），用来让上层把报错翻译成人话。
     */
    onEnd: (error?: string, status?: number) => void;
}

export interface RequestHandle {
    abort: () => void;
}

interface ElectronBridge {
    startRequest: (
        options: { url: string; method?: string; headers?: Record<string, string>; body?: string; owner: any },
        onEvent: (type: string, value: any) => void
    ) => RequestHandle;
}

/** 当前实际使用的通道 */
export type Channel = "native" | "kernel" | "fetch";

let pluginName: string | null = null;
let lastLoadError = "";
let cachedBridge: { bridge: ElectronBridge; owner: any } | null | undefined;

/** 由插件入口在 onload 时告知自己的目录名 */
export function setPluginName(name: string) {
    pluginName = name;
}

function nativeRequire(name: string): any {
    const req = (window as any).require;
    if (typeof req !== "function") throw new Error("窗口里没有 require，不是桌面版");
    return req(name);
}

function loadBridge(): { bridge: ElectronBridge; owner: any } | null {
    // 只在第一次尝试加载，之后用缓存，避免每发一条消息都重新 require 一遍
    if (cachedBridge !== undefined) return cachedBridge;

    try {
        if (!pluginName) throw new Error("插件名没传进来");

        const remote = nativeRequire("@electron/remote");
        const owner = remote.getCurrentWebContents?.();
        if (!owner) throw new Error("拿不到当前窗口");

        const dataDir = (window as any).siyuan?.config?.system?.dataDir;
        if (!dataDir) throw new Error("拿不到思源数据目录");

        const path = nativeRequire("path");
        const dir = path.join(dataDir, "plugins", pluginName);
        if (!remote.require) throw new Error("@electron/remote 不支持 require");

        const bridge = remote.require(path.join(dir, "net-proxy.cjs"));
        if (typeof bridge?.startRequest !== "function") {
            throw new Error("net-proxy.cjs 没导出 startRequest");
        }
        lastLoadError = "";
        cachedBridge = { bridge, owner };
        return cachedBridge;
    } catch (e: any) {
        lastLoadError = String(e?.message || e);
        // 不能缓存 null：面板可能比插件 onload 早加载，
        // 或者 remote 模块还没就绪。缓存成 null 会让整个会话期都连不上，
        // 只能重启思源。留 undefined 表示「下次再试」。
        cachedBridge = undefined;
        return null;
    }
}

/**
 * 能不能用内核转发。
 *
 * 条件：有 fetch、不在桌面主进程环境、并且页面地址是 http(s)。
 * 手机 App 里页面就是内核自己发的，所以请求 /api/network/* 属于同源，
 * 会自动带上登录 Cookie，不会被拦。
 */
function kernelUsable(): boolean {
    if (typeof fetch !== "function") return false;
    if (typeof window === "undefined") return false;
    // 桌面端有更快的主进程通道，不用绕内核
    if (typeof (window as any).require === "function") return false;
    const origin = String((window as any).location?.origin || "");
    return /^https?:\/\//i.test(origin);
}

let channelCache: Channel | null = null;

/** 当前通道；第一次调用时判定一次，之后沿用（避免每条消息都探测） */
export function currentChannel(): Channel {
    if (channelCache) return channelCache;
    if (loadBridge()) channelCache = "native";
    else if (kernelUsable()) channelCache = "kernel";
    else channelCache = "fetch";
    return channelCache;
}

/**
 * 面板顶部要显示的那句提示。
 * note 为空表示一切正常，不用显示任何警告。
 */
export function channelInfo(): { kind: Channel; note: string } {
    const kind = currentChannel();
    if (kind === "native") return { kind, note: "" };
    if (kind === "kernel") {
        return {
            kind,
            note: "手机端：请求由思源内核转发。回答要等模型全部写完才一次显示（不会逐字出现）。",
        };
    }
    return {
        kind,
        note: "浏览器直连模式：请求可能被跨域限制拦住。若报跨域错误，请改用思源 App。" + (lastLoadError ? "（" + lastLoadError + "）" : ""),
    };
}

interface ForwardResult {
    status: number;
    text: string;
    contentType: string;
}

/**
 * 让思源内核替我们发一次请求。
 *
 * 对应内核接口 /api/network/forwardProxy：把目标地址、请求头、请求体交过去，
 * 内核用 Go 发请求，再把状态码和整段响应体还给我们。
 * 这样手机上不受 CORS 限制，也不用把 API Key 暴露给浏览器。
 */
async function kernelForward(opts: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
}): Promise<ForwardResult> {
    const headers = opts.headers || {};
    // 内核要的是「一个键一个对象的数组」，不能直接给对象
    const headerList = Object.keys(headers).map((k) => ({ [k]: String(headers[k]) }));

    let payload: any = undefined;
    if (typeof opts.body === "string" && opts.body) {
        try {
            payload = JSON.parse(opts.body);
        } catch {
            // 不是 JSON 就原样当字符串交过去
            payload = opts.body;
        }
    }

    // 没有 body 时必须用 text 编码：内核在 json 编码下会把空载荷写成 "null"，
    // 那样 GET / DELETE 会带着四个字符的 body 发出去，部分服务端会直接报错。
    const hasBody = typeof opts.body === "string" && opts.body.length > 0;

    const resp = await fetch("/api/network/forwardProxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: opts.signal,
        body: JSON.stringify({
            url: opts.url,
            method: opts.method || "POST",
            timeout: opts.timeoutMs ?? 60000,
            contentType: headers["Content-Type"] || headers["content-type"] || "application/json",
            headers: headerList,
            payload: hasBody ? payload : "",
            payloadEncoding: hasBody ? "json" : "text",
        }),
    });

    const raw = await resp.text();
    let data: any = null;
    try {
        data = JSON.parse(raw);
    } catch {
        data = null;
    }

    if (!data) {
        throw new Error(`思源内核没有返回可识别的结果（HTTP ${resp.status}）：${raw.slice(0, 120)}`);
    }
    if (data.code !== 0) {
        throw new Error(String(data.msg || "思源内核转发失败（code " + data.code + "）"));
    }

    const d = data.data || {};
    return {
        status: Number(d.status) || 0,
        text: typeof d.body === "string" ? d.body : "",
        contentType: String(d.contentType || ""),
    };
}

/**
 * MCP 用的「一次要完整响应」请求。
 * 不走流式：MCP 一次请求就一个回复，没必要流。
 * 优先走主进程（绕跨域），其次走内核转发，最后才退回浏览器 fetch。
 */
export async function fetchOnce(
    url: string,
    opts: { method: string; headers: Record<string, string>; body?: string }
): Promise<{ ok: boolean; status: number; headers: Map<string, string>; text: () => Promise<string> }> {
    const channel = currentChannel();

    if (channel === "native") {
        const native = loadBridge();
        if (native) return fetchOnceViaNative(native, url, opts);
    }

    if (channel === "kernel") {
        const r = await kernelForward({
            url,
            method: opts.method,
            headers: opts.headers,
            body: opts.body,
            timeoutMs: 60000,
        });
        const headers = new Map<string, string>();
        if (r.contentType) headers.set("content-type", r.contentType);
        return {
            ok: r.status >= 200 && r.status < 300,
            status: r.status,
            headers,
            text: async () => r.text,
        };
    }

    const resp = await fetch(url, {
        method: opts.method,
        headers: opts.headers,
        body: opts.body,
    });
    const text = await resp.text();
    const headers = new Map<string, string>();
    resp.headers.forEach((v, k) => headers.set(k.toLowerCase(), v));
    return { ok: resp.ok, status: resp.status, headers, text: async () => text };
}

function fetchOnceViaNative(
    native: { bridge: ElectronBridge; owner: any },
    url: string,
    opts: { method: string; headers: Record<string, string>; body?: string }
): Promise<{ ok: boolean; status: number; headers: Map<string, string>; text: () => Promise<string> }> {
    return new Promise((resolve, reject) => {
        let chunks: string[] = [];
        let statusCode = 0;
        const headers = new Map<string, string>();
        let settled = false;
        // 先声明再在 finish 里用：const 有暂时性死区，放后面会炸
        let timeoutTimer: any = null;

        const finish = (err?: string) => {
            if (settled) return;
            settled = true;
            // 正常结束也要清掉兜底超时，否则闭包会多持有 60 秒
            if (timeoutTimer) clearTimeout(timeoutTimer);
            if (err) return reject(new Error(err));
            const body = chunks.join("");
            resolve({
                ok: statusCode >= 200 && statusCode < 300,
                status: statusCode,
                headers,
                text: async () => body,
            });
        };

        const handle = native.bridge.startRequest(
            {
                url,
                method: opts.method,
                headers: opts.headers,
                body: opts.body,
                owner: native.owner,
            },
            (type, value) => {
                if (settled) return;
                if (type === "response") {
                    statusCode = value?.statusCode ?? 0;
                    for (const [k, v] of Object.entries(value?.headers || {})) {
                        const key = k.toLowerCase();
                        headers.set(key, Array.isArray(v) ? String(v[0]) : String(v));
                    }
                } else if (type === "data") {
                    chunks.push(String(value));
                } else if (type === "end") {
                    finish();
                } else if (type === "error") {
                    finish(value?.message || "网络请求失败");
                }
            }
        );

        // 兜底：MCP 请求不该无限等
        timeoutTimer = setTimeout(() => {
            if (settled) return;
            settled = true;
            try {
                handle?.abort();
            } catch {}
            reject(new Error("请求超时"));
        }, 60000);
    });
}

/** 发起请求；返回的对象可用来中止 */
export function streamChat(
    opts: { url: string; headers: Record<string, string>; body: string },
    handlers: StreamHandlers
): RequestHandle {
    const channel = currentChannel();
    if (channel === "native") {
        const native = loadBridge();
        if (native) return streamViaNative(native, opts, handlers);
    }
    if (channel === "kernel") return streamViaKernel(opts, handlers);
    return streamViaFetch(opts, handlers);
}

/**
 * 手机端：整段等内核把响应收完，再一次性交给上层解析。
 *
 * 为什么不边收边显示：内核的 /api/network/proxy 会经过压缩和缓冲，
 * 逐字推送那头拿不到及时数据，显示出来反而是一顿一顿的。
 * 老老实实等完整结果，至少不会出现「卡住不动」的假象。
 */
function streamViaKernel(
    opts: { url: string; headers: Record<string, string>; body: string },
    handlers: StreamHandlers
): RequestHandle {
    const controller = new AbortController();
    let settled = false;

    (async () => {
        try {
            const r = await kernelForward({
                url: opts.url,
                method: "POST",
                headers: opts.headers,
                body: opts.body,
                timeoutMs: 300000,
                signal: controller.signal,
            });
            if (settled) return;
            if (r.status < 200 || r.status >= 300) {
                handlers.onEnd(
                    `接口返回 ${r.status}${r.text ? "：" + r.text.slice(0, 200) : ""}`,
                    r.status
                );
                return;
            }
            if (r.text) handlers.onDelta(r.text);
            handlers.onEnd();
        } catch (e: any) {
            if (settled) return;
            if (e?.name === "AbortError") {
                handlers.onEnd("已停止");
                return;
            }
            handlers.onEnd(String(e?.message || e));
        }
    })();

    return {
        abort: () => {
            if (settled) return;
            settled = true;
            try {
                controller.abort();
            } catch {}
            handlers.onEnd("已停止");
        },
    };
}

function streamViaNative(
    native: { bridge: ElectronBridge; owner: any },
    opts: { url: string; headers: Record<string, string>; body: string },
    handlers: StreamHandlers
): RequestHandle {
    let settled = false;
    let handle: RequestHandle | null = null;

    const stopUnderlying = () => {
        try {
            handle?.abort();
        } catch {}
    };

    const finish = (err?: string, code?: number) => {
        if (settled) return;
        settled = true;
        // 出错时把底层请求也掐掉，不然它还在后台拉数据
        if (err) stopUnderlying();
        handlers.onEnd(err, code);
    };

    handle = native.bridge.startRequest(
        { url: opts.url, method: "POST", headers: opts.headers, body: opts.body, owner: native.owner },
        (type, value) => {
            if (settled) return;
            if (type === "response") {
                const code = value?.statusCode ?? 0;
                if (code < 200 || code >= 300) {
                    finish(`接口返回 ${code}，请检查地址、密钥和模型名`, code);
                }
            } else if (type === "data") {
                // 上层解析抛错时不能让流悬挂，要收尾
                try {
                    handlers.onDelta(String(value));
                } catch (e: any) {
                    finish(String(e?.message || e));
                }
            } else if (type === "end") {
                finish();
            } else if (type === "error") {
                finish(value?.message || "网络请求失败");
            }
        }
    );

    return {
        abort: () => {
            if (settled) return;
            settled = true;
            stopUnderlying();
            // 必须回调：否则调用方的 Promise 永远没有出口
            handlers.onEnd("已停止", 0);
        },
    };
}

function streamViaFetch(
    opts: { url: string; headers: Record<string, string>; body: string },
    handlers: StreamHandlers
): RequestHandle {
    const controller = new AbortController();

    (async () => {
        try {
            const resp = await fetch(opts.url, {
                method: "POST",
                headers: opts.headers,
                body: opts.body,
                signal: controller.signal,
            });
            if (!resp.ok || !resp.body) {
                const detail = await resp.text().catch(() => "");
                handlers.onEnd(
                    `接口返回 ${resp.status}${detail ? "：" + detail.slice(0, 200) : ""}`,
                    resp.status
                );
                return;
            }
            const reader = resp.body.getReader();
            const decoder = new TextDecoder();
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                try {
                    handlers.onDelta(decoder.decode(value, { stream: true }));
                } catch (e: any) {
                    // 上层解析抛错时先取消读取，再收尾，避免流悬挂
                    await reader.cancel().catch(() => {});
                    handlers.onEnd(String(e?.message || e));
                    return;
                }
            }
            handlers.onEnd();
        } catch (e: any) {
            if (e?.name === "AbortError") {
                // abort 也要回调，否则调用方永远等不到结果
                handlers.onEnd("已停止");
                return;
            }
            handlers.onEnd(String(e?.message || e));
        }
    })();

    return { abort: () => controller.abort() };
}
