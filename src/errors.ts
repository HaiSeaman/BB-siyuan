/**
 * 把技术报错翻译成人话。
 *
 * 原则：
 *   - 能判断出原因的，说清「是什么问题」+「你该怎么做」
 *   - 判断不出来的，保留原文（别把有用信息抹掉），只补一句提示
 *   - 绝不为了好看而编造原因
 */

interface ErrLike {
    status?: number;
    message?: string;
    code?: string;
}

function textOf(e: unknown): string {
    if (e == null) return "";
    if (typeof e === "string") return e;
    const o = e as ErrLike;
    return String(o?.message || "");
}

function statusOf(e: unknown): number {
    if (e == null || typeof e === "string") return 0;
    return Number((e as ErrLike).status) || 0;
}

/** 各种规则：命中就返回一句人话 */
const RULES: { test: (msg: string, status: number, raw: unknown) => boolean; say: string }[] = [
    // 鉴权
    {
        test: (_m, s) => s === 401,
        say: "密钥不对或已失效。请到设置里检查 API Key，确认没有多余空格，也没有过期。",
    },
    {
        test: (_m, s) => s === 403,
        say: "接口拒绝了这个请求。可能是密钥没有该模型的权限，或者这个 IP 被限制了。",
    },
    {
        test: (_m, s) => s === 404,
        say: "接口地址找不到。请检查设置里的地址，注意末尾是 /v1 还是 /v1/chat/completions，别多写也别少写。",
    },
    {
        test: (_m, s) => s === 429,
        say: "请求太频繁或额度用完了。等一会儿再试，或者去服务商后台看看余额。",
    },
    {
        test: (_m, s) => s >= 500 && s < 600,
        say: "服务商那边出错了。这不是你的配置问题，等几分钟再试。",
    },

    // 网络
    {
        test: (m) => /ECONNREFUSED|EHOSTUNREACH|ENETUNREACH/i.test(m),
        say: "连不上这个地址。请确认地址里的 IP 和端口对不对，服务是否开着，以及你和它是否在同一网络。",
    },
    {
        test: (m) => /ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(m),
        say: "这个地址解析不出来。请检查地址是否拼错，或者网络是否需要代理。",
    },
    {
        test: (m) => /超时|timeout|ETIMEDOUT/i.test(m),
        say: "等太久了没有回应。可能是网络慢，或服务端卡住了，过一会儿再试。",
    },
    {
        test: (m) => /连接被中断|aborted|ECONNRESET/i.test(m),
        say: "连接被中断了。常见原因是网络抖动，或者服务端提前关闭。重试一次通常就好。",
    },
    {
        test: (m) => /Failed to fetch|NetworkError|CORS/i.test(m),
        say: "浏览器层面拦住了这个请求（通常是跨域）。这个插件一般走本机通道，如果看到这句，说明本机通道也不可用，请看面板顶部的红色提示。",
    },

    // 模型/接口业务
    {
        test: (m) => /no AI provider|no provider|provider .* not (found|configured)/i.test(m),
        say: "接口说没有可用的模型。请到设置里检查模型名是否写对。",
    },
    {
        // 注意别写 `model .* not (found|exist)`：那要求 not 前后各有一个空格，
        // 而 "model not found" 里 `.*` 只能匹配空，就漏了。
        test: (m) =>
            /model.*(not\s*found|not\s*exist|not\s*available)|model_not_found|invalid\s*model|unknown\s*model|模型不存在|模型.*不可用/i.test(
                m
            ),
        say: "接口不认识这个模型名。请到设置里核对模型名，注意大小写和中划线。",
    },
    {
        test: (m) => /quota|balance|insufficient|余额|额度/i.test(m),
        say: "额度不够了。请去服务商后台充值或换一个密钥。",
    },
    {
        test: (m) => /context length|too many tokens|maximum context|上下文.*长/i.test(m),
        say: "内容太长了，超出模型上限。请点「新对话」清空历史，或者少选一点笔记内容。",
    },
    {
        test: (m) => /content filter|content_filter|safety|违规|拦截/i.test(m),
        say: "内容被服务商的安全策略拦下了。换个说法或删掉敏感部分再试。",
    },

    // MCP
    {
        test: (m) => /本地 MCP 进程退出|ENOENT.*npx|spawn .*ENOENT/i.test(m),
        say: "本地 MCP 程序没能启动。请确认命令名写对了（比如 npx），参数完整，而且这台电脑装了 Node.js。",
    },
    {
        test: (m) => /没有在 \d+ 毫秒内回应/.test(m),
        say: "本地 MCP 程序没有回应。它可能启动失败或卡住了。请点「测试所有服务器」看具体错误。",
    },
    {
        test: (m) => /Tool .* not found|工具.*找不到/i.test(m),
        say: "模型要求调用的工具在服务器上不存在。这通常是工具清单过期了，去 MCP 页点一次「测试所有服务器」。",
    },
    {
        test: (m) => /没有连上|not connected/i.test(m),
        say: "这个 MCP 服务器没有连上。请到 MCP 页点「测试所有服务器」，看它报什么错。",
    },

    // 放在最后的兜底规则，优先级最低：
    // 只有前面那些更具体的判断都没命中，才落到这里。
    {
        // 实测：模型名写错时，很多中转站回的是「param is invalid」而不是 model not found，
        // 状态码 400。这种情况别笼统说"出错了"，要指向最可能的原因。
        test: (_m, s) => s === 400,
        say: "请求被拒绝（400）。最常见的原因是模型名写错，其次是参数超范围。请先到设置里核对模型名。",
    },
];

export function friendlyError(e: unknown): string {
    const msg = textOf(e);
    const status = statusOf(e);

    for (const r of RULES) {
        if (r.test(msg, status, e)) return r.say;
    }

    // 兜底：有原文就带上原文，让人能搜
    if (msg.trim()) return "出错了：" + msg;
    return "出错了，但没有拿到具体原因。请重试一次，还不行就重启思源。";
}
