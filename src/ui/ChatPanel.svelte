<script lang="ts">
    import { onMount, onDestroy, tick } from "svelte";
    import { settings, updateSettings, updateSettingsWith, activeApi, initSettings, isInitialized, type Settings } from "../settings";
    import { endpointFor, headersFor, bodyFor, ProviderParser } from "../providers";
    import { supportsThinking, type ThinkingLevel } from "../thinking";
    import { streamChat, channelInfo, fetchOnce } from "../net";
    import { makeContext } from "../template";
    import { buildTurnPlan, type TurnPlan } from "../turnplan";
    import { estimateTokens, isTooLong, tooLongMessage } from "../tokens";
    import { findTemplate, normalizeTemplates, type PromptTemplate } from "../templates";
    import { normalizeMcpServers, toolDisplayName, type McpServer } from "../mcp-manager";
    import { McpManager } from "../mcp-connect";
    import type { ServerState } from "../mcp-connect";
    import { makeSpawner } from "../mcp-spawn";
    import { runToolLoop } from "../tool-loop";
    import { friendlyError } from "../errors";
    import {
        normalizeSessions,
        upsertSession,
        removeSession,
        sessionTitle,
        sameMessages,
        type Session,
    } from "../sessions";
    import SettingsPanel from "./Settings.svelte";
    import TemplateManager from "./TemplateManager.svelte";
    import McpSettings from "./McpSettings.svelte";

    export let initialSettings: Settings;
    export let persist: (s: Settings) => void;
    export let initialTemplates: PromptTemplate[];
    export let persistTemplates: (list: PromptTemplate[]) => void;
    export let initialMcpServers: McpServer[];
    export let persistMcpServers: (list: McpServer[]) => void;
    export let initialSessions: Session[];
    export let persistSessions: (list: Session[]) => void;

    interface Turn {
        role: "user" | "assistant";
        content: string;
        reasoning: string;
    }

    let cfg: Settings = initialSettings;
    $: cfg = $settings;
    /**
     * 当前生效的那套 API（地址、密钥、模型都在里面）。
     *
     * 用可选链：Svelte 的响应式语句不一定按书写顺序求值，
     * cfg 还没赋值时这里会是 undefined，直接取 .apis 会把整个面板搞崩。
     */
    $: api = cfg ? activeApi(cfg) : ({} as any);
    /** 模型切换器：桌面是下拉，手机是从底部弹出的抽屉 */
    let modelPicker = false;

    let messages: Turn[] = [];
    let input = "";
    let streaming = false;
    let statusText = "";
    /** 抽屉：设置 / 模板 / MCP / 历史。null = 都关着 */
    let drawer: "settings" | "templates" | "mcp" | "history" | null = null;
    let abortFn: { abort: () => void } | null = null;
    let scroller: HTMLDivElement;
    let copiedIndex = -1;
    let openReasoning = -1;
    let channelNote = "";

    let templates: PromptTemplate[] = normalizeTemplates(initialTemplates);

    /** 本次对话绑定的模板。追问时沿用同一套规则，避免规则忽然换掉 */
    let activeTemplateId: string | null = null;

    // ---- MCP ----
    let mcpServers: McpServer[] = normalizeMcpServers(initialMcpServers);
    let mcp: McpManager | null = null;
    let mcpStates: ServerState[] = [];
    let canLaunchProcess = false;
    let mcpToolCount = 0;
    /** 手机上没有 Ctrl+Enter，靠这个开关决定要不要显示「发送」按钮旁边的大按钮 */
    let isMobile = false;
    /** 通道提示：桌面端通常为空，手机端会说明「由内核转发、非逐字显示」 */
    let channelKind: "native" | "kernel" | "fetch" = "native";

    // ---- 会话存档 ----
    let sessions: Session[] = normalizeSessions(initialSessions);
    /** 当前对话对应的会话 id；新建对话时换新的 */
    let currentSessionId = "";

    onMount(() => {
        // 只在 store 还没被初始化过时才写入。
        // 面板会被反复挂载（切工作区、收起侧栏再打开），
        // 每次都无条件写 initialSettings 会把用户中途改的配置打回旧值。
        if (!isInitialized()) initSettings(initialSettings);
        const info = channelInfo();
        channelKind = info.kind;
        channelNote = info.note;

        // 本地进程能力只有桌面版有；拿不到就禁用 stdio 选项
        canLaunchProcess = typeof (window as any).require === "function";
        // 手机端没有物理键盘，Ctrl+Enter 用不了，界面上要给出能点的入口
        isMobile = typeof (window as any).require !== "function";
        rebuildMcp();
        void autoConnectMcp();
    });

    // 面板被卸载时要把 MCP 子进程收掉，否则会一直挂着
    onDestroy(() => {
        if (mcp) void mcp.closeAll();
    });

    function spawnProcess(cmd: string, args: string[], opts: any): any {
        const req = (window as any).require;
        if (typeof req !== "function") throw new Error("当前环境不能启动本地进程");
        const child_process = req("child_process");
        // 平台判断两个来源都看：navigator.platform 在新版浏览器/WebView 里可能为空
        const nav = navigator as any;
        const sig = [nav.userAgentData?.platform, nav.platform, nav.userAgent].join(" ").toLowerCase();
        const isWin = sig.includes("win");
        // 走适配层：Windows 上补 .cmd，且不开 shell（防注入）
        return makeSpawner(child_process, isWin ? "win32" : "linux")(cmd, args, opts);
    }

    function rebuildMcp() {
        // 先把旧连接关掉：stdio 的子进程不关就会越攒越多
        if (mcp) void mcp.closeAll();
        mcp = new McpManager(mcpServers, fetchOnce as any, canLaunchProcess ? spawnProcess : null);
        mcpStates = mcp.snapshot();
        mcpToolCount = 0;
    }

    /** 有启用的服务器就悄悄连上，连不上只记状态不打扰 */
    async function autoConnectMcp() {
        if (!mcp) return;
        if (!mcpServers.some((s) => s.enabled)) return;
        try {
            mcpStates = await mcp.connectAll();
            mcpToolCount = mcp.toolSpecs().length;
        } catch {}
    }

    // ---- 会话存档 ----

    /**
     * 把当前对话落盘。
     * 只在有正文消息时存 —— 空对话存档只会让历史列表里堆垃圾。
     */
    function saveCurrentSession() {
        const usable = messages.filter((m) => m.content.trim());
        if (!usable.length) return;

        const snapshot = usable.map((m) => ({ role: m.role, content: m.content, reasoning: m.reasoning }));

        const now = Date.now();
        const existing = sessions.find((s) => s.id === currentSessionId);

        // 内容一模一样就别再存：每次都存会让「最近对话」的顺序乱跳
        if (existing && sameMessages(existing.messages, snapshot)) return;

        const firstUser = snapshot.find((m) => m.role === "user");

        const session: Session = {
            id: currentSessionId || "s" + now.toString(36),
            title: existing ? existing.title : sessionTitle(firstUser?.content || snapshot[0].content),
            messages: snapshot,
            updatedAt: now,
        };
        currentSessionId = session.id;

        sessions = upsertSession(sessions, session).slice(0, 30);
        persistSessions(sessions);
    }

    function openSession(id: string) {
        if (streaming) {
            statusText = "正在生成，先点「停止」再切换对话";
            return;
        }
        const s = sessions.find((x) => x.id === id);
        if (!s) return;
        currentSessionId = s.id;
        messages = s.messages.map((m) => ({ role: m.role, content: m.content, reasoning: m.reasoning }));
        drawer = null;
        statusText = "";
        activeTemplateId = null;
        // 下标换了，之前展开的思考区要重置，否则会串到别的消息上
        openReasoning = -1;
        copiedIndex = -1;
        void scrollToEnd();
    }

    function deleteSession(id: string) {
        sessions = removeSession(sessions, id);
        persistSessions(sessions);
        if (currentSessionId === id) {
            currentSessionId = "";
            messages = [];
        }
    }

    /** 一键清空所有历史对话（当前正在聊的内容也一起清，不然会马上又被存回来） */
    function clearAllSessions() {
        if (streaming) {
            statusText = "正在生成，先点「停止」再清空历史";
            return;
        }
        const count = sessions.length;
        if (!count) {
            statusText = "还没有历史对话";
            return;
        }
        if (!confirm(`清空全部 ${count} 个历史对话？删掉就找不回来了。`)) return;

        sessions = [];
        persistSessions(sessions);
        // 当前对话如果不清，下一次生成会把它重新存成一条历史，看起来像“没删干净”
        currentSessionId = "";
        messages = [];
        input = "";
        statusText = `已清空 ${count} 个历史对话`;
        setTimeout(() => {
            if (statusText.startsWith("已清空")) statusText = "";
        }, 3000);
    }

    async function connectMcp() {
        if (!mcp) rebuildMcp();
        if (!mcp) return;
        mcpStates = await mcp.connectAll();
        mcpToolCount = mcp.toolSpecs().length;
    }

    function onMcpChanged(list: McpServer[]) {
        mcpServers = list;
        persistMcpServers(list);
        rebuildMcp();
        // 改完配置马上试着连一次，否则用户要手动点「测试」才生效
        void autoConnectMcp();
    }

    // 用可选链兜住：响应式语句执行顺序不保证，api 可能还没算出来
    $: canThink = supportsThinking(api?.model || "");
    $: levelLabels = { off: "关", minimal: "最小", low: "低", medium: "中", high: "高", max: "最高" } as Record<string, string>;
    $: activeTemplate = activeTemplateId ? findTemplate(templates, activeTemplateId) : undefined;

    /**
     * 切到某个 API 下的某个模型。
     *
     * 两个一起改：光换模型不改 API，模型名对方可能根本不认。
     * 先用一次写入同时把 activeApiId 和那套 API 的 model 定下来，避免中间态。
     * 目标 API 不存在时什么都不做 —— 否则会把 activeApiId 写成一个悬空 id，
     * 之后整个面板都拿不到配置（顶栏会显示「未配置」）。
     */
    function chooseModel(apiId: string, model: string) {
        modelPicker = false;
        if (streaming) {
            statusText = "正在生成，等这一轮结束再换模型";
            return;
        }
        // 和设置页走同一条保存路：直接在 store 里写盘会和它的延迟保存互相覆盖
        updateSettingsWith(
            (s) => {
                if (!s.apis.some((a) => a.id === apiId)) return s;
                const apis = s.apis.map((a) => (a.id === apiId ? { ...a, model } : a));
                return { ...s, apis, activeApiId: apiId };
            },
            (s) => persist(s)
        );
    }

    /** 打开抽屉时顺手把模型切换器收掉，避免两层叠在一起 */
    function openDrawer(which: typeof drawer) {
        modelPicker = false;
        drawer = which;
    }

    /** 抽屉标题 */
    $: drawerTitle =
        drawer === "settings"
            ? "设置"
            : drawer === "templates"
            ? "提示词管理"
            : drawer === "mcp"
            ? "MCP 服务器"
            : drawer === "history"
            ? "历史对话"
            : "";

    $: mcpReady = mcpStates.filter((s) => s.status === "ready").length;
    $: mcpErr = mcpStates.filter((s) => s.status === "error").length;
    $: mcpOff = mcpServers.filter((s) => s.enabled).length === 0;
    $: mcpWarn = mcpErr > 0;

    /** MCP 那一行到底该说人话里的哪种状态 */
    $: mcpSummary = mcpOff
        ? "MCP 还没配置服务器，点这里添加"
        : mcpWarn
        ? `MCP 有 ${mcpErr} 个服务器连接失败，点这里查看`
        : mcpReady === 0
        ? "MCP 正在连接…"
        : `MCP 已连 ${mcpReady} 个服务器 · ${mcpToolCount} 个工具`;

    /** 思考档位循环切换：点一下换下一档 */
    function cycleThinking() {
        const order: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "max"];
        const i = order.indexOf(cfg.thinking as ThinkingLevel);
        const next = order[(i + 1) % order.length];
        patch({ thinking: next });
    }

    function patch(p: Partial<Settings>) {
        updateSettings(p, (s) => persist(s));
    }

    /** 当前打开的文档标题，拿不到就空字符串 */
    function currentDocTitle(): string {
        try {
            const editors = (window as any).siyuan?.getActiveEditor?.();
            const t = editors?.protyle?.title?.editElement?.textContent?.trim();
            if (t) return t;
        } catch {}
        try {
            const el = document.querySelector(".protyle-title__input") as HTMLElement | null;
            return el?.textContent?.trim() || "";
        } catch {}
        return "";
    }

    /** Lute 实例建一次就够，每次新建+整篇重解析会随着内容变长越来越卡 */
    let luteInstance: any = null;

    function renderMd(text: string): string {
        try {
            if (luteInstance === null) {
                luteInstance = (window as any).Lute?.New?.() || false;
            }
            if (luteInstance && luteInstance.Md2HTML) return luteInstance.Md2HTML(text);
        } catch {}
        return text.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" } as any)[c]);
    }

    async function scrollToEnd() {
        await tick();
        if (scroller) scroller.scrollTop = scroller.scrollHeight;
    }

    function stop() {
        // abort 会一路回调到 makeChatFn 的 done("已停止")，这里先置状态，收尾时不会卡在「正在生成」
        abortFn?.abort();
        abortFn = null;
        streaming = false;
        statusText = "已停止";
    }

    /**
     * 手机端专用：让思源的侧栏里出现「AI 生成」这一项。
     *
     * 手机端没有桌面那种「停靠栏」，插件面板属于「侧栏面板」，
     * 用户可以在 设置 → 外观 → 侧栏 里单独开关它。
     * 这里没法替用户改思源自己的设置（那是思源的私有数据），
     * 所以直接把话说明白，别让人对着空白面板发呆。
     */
    function pinToSidebar() {
        statusText = "要固定入口：设置 → 外观 → 侧栏，把「AI 生成」打开。之后侧栏里就有它了。";
    }

    /** 把当前对话的已有轮次转成历史（跳过空壳的助手占位） */
    function historyFor(): { role: "user" | "assistant"; content: string }[] {
        return messages
            .filter((m) => m.content.trim().length > 0)
            .slice(-Math.max(1, cfg.contextMessages))
            .map((m) => ({ role: m.role, content: m.content }));
    }

    /**
     * 组装这一轮要发的请求。超长或没配好就返回 null，并且已经把提示写好。
     * 拆出来是为了「新建」和「重发」共用同一套检查 —— 重发不该绕过长度检查。
     */
    function prepareTurn(
        text: string,
        templateId: string | null,
        history: { role: "user" | "assistant"; content: string }[]
    ): { plan: TurnPlan; } | null {
        if (!(api?.baseURL || "").trim() || !(api?.model || "").trim()) {
            statusText = "先选一套 API 和模型（点顶栏那个模型名）";
            return null;
        }

        const tpl = templateId ? findTemplate(templates, templateId) ?? null : null;
        const ctx = makeContext(currentDocTitle());
        const plan = buildTurnPlan({ template: tpl, userText: text, ctx, history });

        // 超长就别发了，省得等半天只收到一个 400
        const total = estimateTokens(plan.system) + plan.messages.reduce((n, m) => n + estimateTokens(m.content), 0);
        const limit = cfg.contextLimit || 0;
        if (isTooLong(total, limit)) {
            statusText = tooLongMessage(total, limit);
            return null;
        }
        return { plan };
    }

    function startTurn(opts: { text: string; templateId: string | null }) {
        if (streaming) return;

        // 历史必须在插入新消息之前算，否则会把刚加的那条也算进去、重复一次
        const prepared = prepareTurn(opts.text, opts.templateId, historyFor());
        if (!prepared) return;

        const userIndex = messages.length;
        // 界面上只显示用户自己打的那句，下面挂一个空的回答占位
        messages = [
            ...messages,
            { role: "user", content: opts.text || "（按模板生成）", reasoning: "" },
            { role: "assistant", content: "", reasoning: "" },
        ];
        input = "";

        runTurn({ userIndex, plan: prepared.plan });
    }

    /**
     * 真正跑一轮生成。新建和重发共用这一段，区别只在「回答写到哪条消息」。
     */
    function runTurn(opts: { userIndex: number; plan: TurnPlan }) {
        const { userIndex, plan } = opts;
        const index = userIndex + 1;

        streaming = true;
        statusText = "";

        const tools = mcp ? mcp.toolSpecs() : [];
        // 用一个 abort controller 真正能掐断循环，光把 streaming 设成 false 停不下来
        const turnAbort = new AbortController();

        // 必须在下面 finally 用它之前声明：否则 finally 触发时还在暂时性死区
        const myHandle = {
            abort: () => {
                turnAbort.abort();
                streaming = false;
            },
        };
        abortFn = myHandle;

        void runToolLoop({
            chat: makeChatFn(plan.system, index),
            messages: plan.messages,
            tools,
            signal: turnAbort.signal,
            execTool: async (name, args) => {
                if (!mcp) throw new Error("MCP 没有初始化");
                statusText = "正在调用工具：" + toolDisplayName(name, mcpServers, mcp.getBindings());
                const out = await mcp.callTool(name, args);
                statusText = "";
                return out;
            },
            onText: (t) => {
                // 兜底：点「停止」到循环真正结束之间有一小段窗口，
                // 这期间清空对话会让 messages[index] 不存在，直接写就崩了
                const target = messages[index];
                if (!target) return;
                target.content += t;
                messages = messages;
                scrollToEnd();
            },
            onReasoning: (t) => {
                if (!cfg.showReasoning) return;
                const target = messages[index];
                if (!target) return;
                target.reasoning += t;
                messages = messages;
            },
            maxRounds: cfg.maxToolRounds || 8,
        })
            .then((result) => {
                if (result.stopReason === "max-rounds") {
                    statusText = `工具调用达到上限（${cfg.maxToolRounds} 轮），已停下`;
                } else if (result.stopReason === "aborted") {
                    statusText = "已停止";
                } else if (messages[index] && !messages[index].content) {
                    // 消息可能已被清空（停止后立刻开了新对话），这时不该再读它
                    statusText = "接口没返回内容。请检查设置里的模型名是否写对。";
                }
                if (result.toolErrors.length) {
                    statusText = "有工具出错：" + friendlyError({ message: result.toolErrors[0] });
                }
            })
            .catch((e: any) => {
                // 「已停止」是我们自己抛的，不是错，别翻译成报错
                if (String(e?.message || e) === "已停止") {
                    statusText = "已停止";
                    return;
                }
                statusText = friendlyError(e);
            })
            .finally(() => {
                streaming = false;
                // 只有自己还是当前请求时才清 abortFn：
                // 否则会把用户紧接着发起的新一轮的 abortFn 给清掉，导致停不下来
                if (abortFn === myHandle) abortFn = null;
                scrollToEnd();
                // 生成结束（无论成败）都存一次，断线也能留下已有内容
                saveCurrentSession();
            });
    }

    /**
     * 造一个 chat 函数：每次都读最新的配置，把流式片段转出去，
     * 结束时把工具调用交给循环。
     */
    function makeChatFn(system: string, displayIndex: number) {
        // 本轮对话开始时的那套 API 就锁在这里。中途切到别的 API 不该影响已经发出去的这一轮。
        const runApi = activeApi($settings);
        const runCfg = { ...$settings, ...runApi, model: runApi.model };

        return (msgs: any[], tools: any[], handlers: any): Promise<{ content: string; toolCalls: any[] }> => {
            return new Promise((resolve, reject) => {
                const parser = new ProviderParser(
                    runApi.protocol,
                    (t) => handlers.onDelta({ content: t }),
                    (t) => handlers.onDelta({ reasoning: t })
                );

                let raw = "";
                try {
                    raw = JSON.stringify(bodyFor(runApi.protocol, runCfg, msgs, system, tools));
                } catch (e: any) {
                    reject(new Error("拼请求出错：" + (e?.message || e)));
                    return;
                }

                let settled = false;
                const done = (err?: string) => {
                    if (settled) return;
                    settled = true;
                    if (err) {
                        reject(new Error(err));
                        return;
                    }
                    resolve({
                        content: "",
                        toolCalls: parser.toolCalls(),
                    });
                };

                const handle = streamChat(
                    {
                        url: endpointFor(runApi.protocol, runApi.baseURL, runApi.model),
                        headers: headersFor(runApi.protocol, runApi),
                        body: raw,
                    },
                    {
                        onDelta: (chunk) => {
                            if (settled) return;
                            try {
                                parser.push(chunk);
                            } catch (e: any) {
                                done(String(e?.message || e));
                            }
                        },
                        onEnd: (err) => {
                            if (settled) return;
                            try {
                                parser.end();
                            } catch (e: any) {
                                done(String(e?.message || e));
                                return;
                            }
                            done(err);
                        },
                    }
                );

                // 用户点「停止」时，把底层请求也掐掉，不然它还在后台拉数据
                const sig = handlers?.signal as AbortSignal | undefined;
                if (sig) {
                    if (sig.aborted) {
                        handle.abort();
                        done("已停止");
                    } else {
                        sig.addEventListener("abort", () => {
                            handle.abort();
                            done("已停止");
                        }, { once: true });
                    }
                }

                void displayIndex;
            });
        };
    }

    /** 点「发送」：带上当前绑定的模板 */
    function send() {
        if (streaming) return;
        // 输入框里的软键盘还开着时点发送，先把选择器收掉，别挡着结果
        modelPicker = false;
        const text = input.trim();

        if (!text) {
            statusText = activeTemplateId ? "写点什么再发（按 Ctrl+Enter）" : "先写点要求再发";
            return;
        }

        startTurn({ text, templateId: activeTemplateId });
    }

    /**
     * 点模板 = 只绑规则，不发送、不清空对话。
     * 绑定之后，这个框里每一条消息都会自动带上这套规则去问模型。
     */
    function bindTemplate(id: string) {
        if (streaming) {
            statusText = "正在生成，等这一轮结束再换模板";
            return;
        }
        if (activeTemplateId === id) return;

        activeTemplateId = id;
        const name = findTemplate(templates, id)?.name || "";
        statusText = `已套用「${name}」，之后的每条消息都会按它回答`;
        setTimeout(() => {
            if (statusText.startsWith("已套用")) statusText = "";
        }, 4000);
    }

    /**
     * 复制文字。
     *
     * 桌面端 navigator.clipboard 好用；安卓手机的 WebView 里这个接口常常
     * 直接不存在或直接抛错，所以要有两套兜底，否则手机上点「复制」= 没反应。
     */
    async function copyText(text: string): Promise<boolean> {
        // 1) 安卓 App 的原生桥（思源自己也是这么复制的）
        try {
            const bridge = (window as any).JSAndroid;
            if (bridge?.writeClipboard) {
                bridge.writeClipboard(text);
                return true;
            }
            const harmony = (window as any).JSHarmony;
            if (harmony?.writeClipboard) {
                harmony.writeClipboard(text);
                return true;
            }
        } catch {}

        // 2) 标准接口
        try {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(text);
                return true;
            }
        } catch {}

        // 3) 老办法：塞一个看不见的输入框选中再复制
        try {
            const ta = document.createElement("textarea");
            ta.value = text;
            ta.style.position = "fixed";
            ta.style.top = "-1000px";
            ta.style.opacity = "0";
            document.body.appendChild(ta);
            ta.focus();
            ta.select();
            const ok = document.execCommand("copy");
            document.body.removeChild(ta);
            return ok;
        } catch {
            return false;
        }
    }

    async function copyOne(i: number) {
        const ok = await copyText(messages[i]?.content || "");
        if (!ok) {
            statusText = "复制失败，请长按文字手动选中复制";
            return;
        }
        copiedIndex = i;
        statusText = "已复制，去思源里粘贴";
        setTimeout(() => {
            copiedIndex = -1;
            statusText = "";
        }, 2500);
    }

    /**
     * 重发：用这条原话重新生成，回答直接替换原来那一条。
     *
     * 不新增消息 —— 用户要的是「同一条消息换个答案」，
     * 点完聊天记录里还是一组「原话 + 回答」，不会变成两组。
     * 发给模型的历史只截到这条之前，否则等于让它看着自己的旧答案再答一遍。
     */
    function resend(i: number) {
        if (streaming) {
            statusText = "正在生成，等这一轮结束再重发";
            return;
        }
        const text = (messages[i]?.content || "").trim();
        if (!text) {
            statusText = "这条是空的，没东西可重发";
            return;
        }
        // 只有我自己发的消息才配重发；回答那条没有原话可重问，别乱改记录
        if (messages[i]?.role !== "user") {
            statusText = "只能重发自己发的消息";
            return;
        }

        const before = messages.slice(0, i);
        const history = before
            .filter((m) => m.content.trim().length > 0)
            .slice(-Math.max(1, cfg.contextMessages))
            .map((m) => ({ role: m.role, content: m.content }));

        const prepared = prepareTurn(text, activeTemplateId, history);
        if (!prepared) return;

        // 先清空原来那条回答，界面立刻显示「正在生成」，不会先闪一下旧内容。
        // 只有紧跟其后的那条确实是回答才能覆盖；否则（比如历史里只存了用户那句）
        // 必须在 i+1 插入，且不能插到别处 —— runTurn 写的是 messages[i + 1]。
        if (messages[i + 1]?.role === "assistant") {
            messages[i + 1].content = "";
            messages[i + 1].reasoning = "";
            messages = messages;
        } else {
            messages = [...messages.slice(0, i + 1), { role: "assistant", content: "", reasoning: "" }, ...messages.slice(i + 1)];
        }
        openReasoning = -1;
        copiedIndex = -1;

        runTurn({ userIndex: i, plan: prepared.plan });
    }

    function newChat() {
        // 生成中清空会让正在跑的循环读写已不存在的消息，直接崩。先停。
        if (streaming) {
            statusText = "正在生成，先点「停止」再开新对话";
            return;
        }
        // 先存旧的，再清空，否则上一轮白聊了
        saveCurrentSession();
        messages = [];
        statusText = "";
        // 模板不清：主人选定的规则要一直生效，连着整理几篇不用重选。
        // 要取消就点面板上的「退出」。
        currentSessionId = "";
        openReasoning = -1;
        copiedIndex = -1;
    }

    /** 取消当前绑定的模板，回到没规则的自由对话 */
    function unbindTemplate() {
        if (streaming) {
            statusText = "正在生成，等这一轮结束再取消模板";
            return;
        }
        activeTemplateId = null;
        statusText = "已取消模板，恢复自由对话";
        setTimeout(() => {
            if (statusText.startsWith("已取消模板")) statusText = "";
        }, 3000);
    }

    /** 供右键菜单调用：只套用模板，不带任何素材 */
    export function runTemplate(id: string) {
        const tpl = findTemplate(templates, id);
        if (!tpl) return;

        bindTemplate(id);
        statusText = `已套用「${tpl.name}」，写要求后按 Ctrl+Enter 发送`;
    }

    function onTemplatesChanged(list: PromptTemplate[]) {
        templates = list;
        persistTemplates(list);
        // 正在用的模板被删掉了，就退出这个模板
        if (activeTemplateId && !findTemplate(list, activeTemplateId)) activeTemplateId = null;
    }

    function onKeydown(e: KeyboardEvent) {
        // Esc 收掉模型切换器：万一遮罩出了什么意外，这是不依赖鼠标的退路
        if (e.key === "Escape") {
            if (modelPicker) {
                modelPicker = false;
                e.preventDefault();
            }
            return;
        }
        // 只在主面板生效。设置/模板/MCP 页里按 Ctrl+Enter 不该偷偷发请求
        if (drawer) return;
        if (e.key !== "Enter" || !(e.ctrlKey || e.metaKey)) return;
        // 别抢输入框自己的快捷键（模板编辑里也常用 Ctrl+Enter）
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === "INPUT" || (t.tagName === "TEXTAREA" && t.id !== "compose-input"))) {
            return;
        }

        e.preventDefault();
        send();
    }
</script>

<svelte:window on:keydown={onKeydown} />

<div class="panel">
    <!-- 顶栏：品牌 / 模型 / 历史 / 管理 / 设置 -->
    <div class="topbar">
        <span class="brand">AI 生成</span>
        <button
            class="model-btn"
            class:open={modelPicker}
            on:click|stopPropagation={() => (modelPicker = !modelPicker)}
            title="切换 API 和模型"
        >
            <span class="dot-api"></span>
            <span class="mb-text">{api.name || "未命名"} · {api.model || "未选模型"}</span>
            <span class="caret">▾</span>
        </button>
        <span class="grow"></span>
        {#if isMobile}
            <button class="icon-btn" on:click={pinToSidebar} title="显示在侧栏">显示在侧栏</button>
        {/if}
        <button class="icon-btn" on:click={newChat} title="开始一个新对话（保留当前提示词）">新对话</button>
        <button class="icon-btn" on:click={() => openDrawer(drawer === "history" ? null : "history")}>
            历史{#if sessions.length}<span class="pill-num">{sessions.length}</span>{/if}
        </button>
        <button class="icon-btn" on:click={() => openDrawer("templates")}>管理</button>
        <button class="icon-btn gear" on:click={() => openDrawer("settings")} title="设置">⚙</button>
    </div>

    <!-- 模型切换：桌面是顶栏下拉，手机是从底部弹出 -->
    {#if modelPicker}
        <!--
          遮罩和菜单都放在 .picker-layer 里。
          .picker-layer 只覆盖「顶栏以下、输入区以上」这一块，
          所以就算哪天定位祖先又出问题，遮罩也绝不会盖住顶栏和发送按钮，
          不会出现「所有按键都点不动」这种整片失效。
        -->
        <div class="picker-layer">
            <button class="picker-mask" on:click={() => (modelPicker = false)} aria-label="关闭"></button>
            <div class="picker" class:sheet={isMobile}>
            {#if isMobile}<div class="sheet-bar"></div>{/if}
            <div class="picker-title">切换模型</div>
            {#each cfg.apis as a}
                <div class="api-group">
                    <div class="api-name">
                        <span class="dot" class:ok={a.id === cfg.activeApiId}></span>
                        {a.name || "未命名"}
                        <em>{a.models.length} 个模型</em>
                    </div>
                    {#if a.models.length === 0}
                        <div class="api-empty">还没填模型（去设置里加）</div>
                    {/if}
                    {#each a.models as m}
                        <button
                            class="model-row"
                            class:active={a.id === cfg.activeApiId && a.model === m}
                            on:click={() => chooseModel(a.id, m)}
                        >
                            <span class="m-name">{m}</span>
                            <span class="m-check">{a.id === cfg.activeApiId && a.model === m ? "✓" : ""}</span>
                        </button>
                    {/each}
                </div>
            {/each}
            <button class="picker-foot" on:click={() => openDrawer("settings")}>
                管理 API 与模型 →
            </button>
            </div>
        </div>
    {/if}

    <!-- 提示词：一直平铺 -->
    <div class="tpl-bar">
        <span class="tpl-label">提示词</span>
        <div class="tpl-list">
            {#each templates as t}
                <button
                    class="tpl"
                    class:active={activeTemplateId === t.id}
                    on:click={() => bindTemplate(t.id)}
                    title={t.content.slice(0, 120)}
                >{t.name}</button>
            {/each}
            <button class="tpl add" on:click={() => openDrawer("templates")} title="新建或管理模板">+</button>
        </div>
    </div>

    <!-- MCP：常驻一行状态条 -->
    <button class="mcp-bar" class:warn={mcpWarn} class:off={mcpOff} on:click={() => openDrawer("mcp")}>
        <span class="dot" class:ok={!mcpWarn && !mcpOff} class:err={mcpWarn}></span>
        <span class="mcp-text">{mcpSummary}</span>
        <span class="grow"></span>
        <span class="chev">›</span>
    </button>

    {#if channelNote}
        <div class="warn-note" class:info={channelKind === "kernel"}>{channelNote}</div>
    {/if}

    <!-- 对话区 + 抽屉 -->
    <div class="stage">
        <div class="msgs" bind:this={scroller}>
            {#if messages.length === 0}
                <div class="empty">
                    {#if activeTemplate}
                        <p>模板「{activeTemplate.name}」已套用。</p>
                        <p>在下面写内容，{isMobile ? "点「发送」" : "按 Ctrl+Enter 发送"}。</p>
                    {:else}
                        <p>① 点上面任意一个提示词套用规则</p>
                        <p>② 在下面写内容，{isMobile ? "点「发送」" : "按 Ctrl+Enter 发送"}</p>
                    {/if}
                </div>
            {/if}
            {#each messages as m, i}
                <div class="row" class:me={m.role === "user"} class:ai={m.role === "assistant"}>
                    <div class="bubble" class:me={m.role === "user"} class:ai={m.role === "assistant"}>
                        {#if m.reasoning}
                            <button class="reason-toggle" on:click={() => (openReasoning = openReasoning === i ? -1 : i)}>
                                {openReasoning === i ? "收起思考过程" : "查看思考过程（" + m.reasoning.length + " 字）"}
                            </button>
                            {#if openReasoning === i}
                                <div class="reasoning">{m.reasoning}</div>
                            {/if}
                        {/if}
                        {#if m.role === "assistant"}
                            {#if streaming && i === messages.length - 1}
                                <!-- 生成中先用纯文本：每来一小段就整篇重解析 Markdown 会越来越卡 -->
                                <div class="md streaming-text">{m.content}</div>
                            {:else}
                                <div class="md">{@html renderMd(m.content)}</div>
                            {/if}
                            {#if m.content && !streaming}
                                <button class="copy" on:click={() => copyOne(i)}>
                                    {copiedIndex === i ? "已复制" : "复制"}
                                </button>
                            {/if}
                        {:else}
                            <div class="plain">{m.content}</div>
                            <div class="mine-actions">
                                <button class="copy" on:click={() => copyOne(i)} title="复制我发的这句话">
                                    {copiedIndex === i ? "已复制" : "复制"}
                                </button>
                                <button class="copy" on:click={() => resend(i)} title="把这句话原样再发一次">
                                    重发
                                </button>
                            </div>
                        {/if}
                    </div>
                </div>
            {/each}
            {#if streaming}
                <div class="typing">正在生成<span class="dots">…</span></div>
            {/if}
        </div>

        <!-- 抽屉：从右侧滑出，不遮掉整块对话 -->
        {#if drawer}
            <button class="drawer-mask" on:click={() => (drawer = null)} aria-label="关闭抽屉"></button>
            <div class="drawer">
                <div class="drawer-head">
                    <span>{drawerTitle}</span>
                    <button class="x" on:click={() => (drawer = null)} title="关闭">×</button>
                </div>
                <div class="drawer-body">
                    {#if drawer === "settings"}
                        <SettingsPanel {persist} busy={streaming} />
                    {:else if drawer === "templates"}
                        <TemplateManager {templates} onChange={onTemplatesChanged} />
                    {:else if drawer === "mcp"}
                        <McpSettings
                            servers={mcpServers}
                            states={mcpStates}
                            {canLaunchProcess}
                            onChange={onMcpChanged}
                            onTest={connectMcp}
                        />
                    {:else if drawer === "history"}
                        <div class="hist-list">
                            <button class="new-chat" on:click={() => { newChat(); drawer = null; }}>+ 新对话</button>
                            {#if sessions.length}
                                <button class="clear-hist" on:click={clearAllSessions}>
                                    清空全部历史（{sessions.length} 个）
                                </button>
                            {/if}
                            {#if sessions.length === 0}
                                <div class="hist-empty">还没有历史对话。聊过一次就会自动存下来。</div>
                            {:else}
                                {#each sessions as s}
                                    <div class="hist-item" class:current={s.id === currentSessionId}>
                                        <button class="hist-main" on:click={() => { openSession(s.id); drawer = null; }}>
                                            <span class="hist-title">{s.title}</span>
                                            <span class="hist-meta">{s.messages.length} 条</span>
                                        </button>
                                        <button class="hist-del" on:click={() => deleteSession(s.id)} title="删除">×</button>
                                    </div>
                                {/each}
                            {/if}
                        </div>
                    {/if}
                </div>
            </div>
        {/if}
    </div>

    {#if statusText}
        <div class="status">{statusText}</div>
    {/if}

    <!-- 输入区上方：思考档位 -->
    <div class="ctrl-bar">
        {#if canThink}
            <button class="pill" on:click={() => cycleThinking()}>思考：{levelLabels[cfg.thinking]}<span class="caret">▾</span></button>
        {:else}
            <span class="pill disabled">该模型不支持思考</span>
        {/if}
        {#if activeTemplate}
            <button class="unbind" on:click={unbindTemplate} title="取消当前提示词规则">退出「{activeTemplate.name}」</button>
        {/if}
        <span class="grow"></span>
        {#if isMobile}
            <span class="tiny">点右下角「发送」</span>
        {:else}
            <span class="tiny">Ctrl+Enter 发送</span>
        {/if}
    </div>

    <!-- 输入区 -->
    <div class="compose" class:mobile={isMobile}>
        <textarea
            id="compose-input"
            bind:value={input}
            placeholder="写内容或要求…"
            rows="3"
            enterkeyhint={isMobile ? "send" : undefined}
            disabled={streaming}
        ></textarea>
        {#if streaming}
            <button class="danger" on:click={stop}>停止</button>
        {:else}
            <button class="primary" on:click={send}>发送</button>
        {/if}
    </div>
</div>

<style>
    .panel {
        display: flex;
        flex-direction: column;
        height: 100%;
        font-size: 13px;
        color: var(--b3-theme-on-background);
        background: var(--b3-theme-background);
        /* 模型切换器和它的遮罩是 absolute，必须有个定位祖先，否则会跑到视口左上角 */
        position: relative;
    }

    /* ---------- 顶栏 ---------- */
    .topbar {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 12px;
        border-bottom: 1px solid var(--b3-border-color);
        flex-shrink: 0;
    }
    .brand {
        font-size: 12.5px;
        font-weight: 600;
        color: var(--b3-theme-on-background);
        flex-shrink: 0;
    }
    .grow {
        flex: 1;
    }
    .model-btn {
        border: 1px solid var(--b3-border-color);
        background: var(--b3-theme-surface);
        color: var(--b3-theme-on-surface);
        font-size: 11px;
        border-radius: 6px;
        padding: 2px 7px;
        cursor: pointer;
        max-width: 130px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .model-btn:hover {
        border-color: var(--b3-theme-primary);
        color: var(--b3-theme-primary);
    }
    .model-btn.open {
        border-color: var(--b3-theme-primary);
        color: var(--b3-theme-primary);
    }
    .dot-api {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: #34a853;
        flex-shrink: 0;
    }
    .mb-text {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    /* ---------- 模型切换器 ---------- */
    /*
     * 只覆盖「顶栏以下」这一层。顶栏和输入区不在里面，
     * 所以遮罩再怎么写错也点不掉它们，不会整片失效。
     */
    .picker-layer {
        position: absolute;
        top: 40px;
        left: 0;
        right: 0;
        bottom: 0;
        z-index: 30;
        pointer-events: none;
    }
    .picker-layer > * {
        pointer-events: auto;
    }
    .picker-mask {
        position: absolute;
        inset: 0;
        background: rgba(0, 0, 0, 0.12);
        border: none;
        padding: 0;
        cursor: default;
    }
    .picker {
        position: absolute;
        top: 0;
        left: 78px;
        width: 268px;
        /* 在 layer 内部滚动，永远不超出面板 */
        max-height: 100%;
        overflow-y: auto;
        -webkit-overflow-scrolling: touch;
        background: var(--b3-theme-background);
        border: 1px solid var(--b3-border-color);
        border-radius: 10px;
        box-shadow: 0 10px 28px rgba(0, 0, 0, 0.18);
        padding: 8px 0 0;
    }
    /* 手机端：从底部弹出，条目加大好点 */
    .picker.sheet {
        top: auto;
        left: 0;
        right: 0;
        bottom: 0;
        width: auto;
        max-height: 100%;
        border-radius: 16px 16px 0 0;
        border-left: none;
        border-right: none;
        border-bottom: none;
        box-shadow: 0 -8px 30px rgba(0, 0, 0, 0.22);
        padding-top: 5px;
    }
    .sheet-bar {
        width: 36px;
        height: 4px;
        border-radius: 2px;
        background: var(--b3-border-color);
        margin: 2px auto 8px;
    }
    .picker-title {
        font-size: 11px;
        color: var(--b3-theme-on-surface);
        opacity: 0.65;
        padding: 2px 12px 6px;
    }
    .api-group {
        border-top: 1px solid var(--b3-border-color);
        padding: 6px 0;
    }
    .api-name {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 11px;
        color: var(--b3-theme-on-surface);
        opacity: 0.8;
        padding: 2px 12px 4px;
    }
    .api-name em {
        font-style: normal;
        opacity: 0.6;
        font-size: 10px;
    }
    .api-empty {
        font-size: 11px;
        color: var(--b3-theme-on-surface);
        opacity: 0.55;
        padding: 2px 12px 4px;
    }
    .model-row {
        display: flex;
        align-items: center;
        width: 100%;
        border: none;
        background: none;
        text-align: left;
        padding: 6px 12px;
        font-size: 12.5px;
        color: var(--b3-theme-on-background);
        cursor: pointer;
        gap: 8px;
        font-family: inherit;
    }
    .model-row:hover {
        background: var(--b3-theme-surface);
    }
    .model-row.active {
        color: var(--b3-theme-primary);
        font-weight: 600;
    }
    .m-name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .m-check {
        margin-left: auto;
        font-size: 12px;
        color: var(--b3-theme-primary);
        flex-shrink: 0;
    }
    .picker-foot {
        display: block;
        width: 100%;
        border: none;
        border-top: 1px solid var(--b3-border-color);
        background: none;
        text-align: left;
        padding: 8px 12px;
        font-size: 11px;
        color: var(--b3-theme-primary);
        cursor: pointer;
        font-family: inherit;
        border-radius: 0 0 10px 10px;
    }
    .picker-foot:hover {
        background: var(--b3-theme-surface);
    }
    .picker.sheet .picker-title,
    .picker.sheet .api-name,
    .picker.sheet .api-empty {
        padding-left: 16px;
    }
    .picker.sheet .model-row {
        padding: 11px 16px;
        font-size: 14px;
    }
    .picker.sheet .picker-foot {
        padding: 12px 16px;
        font-size: 12.5px;
        border-radius: 0;
    }
    .caret {
        font-size: 9px;
        opacity: 0.6;
        margin-left: 2px;
    }
    .icon-btn {
        border: 1px solid transparent;
        background: none;
        color: var(--b3-theme-on-surface);
        font-size: 11px;
        padding: 3px 7px;
        border-radius: 6px;
        cursor: pointer;
        white-space: nowrap;
        flex-shrink: 0;
    }
    .icon-btn:hover {
        background: var(--b3-theme-surface);
        color: var(--b3-theme-primary);
        border-color: var(--b3-border-color);
    }
    .icon-btn.gear {
        font-size: 13px;
    }
    .pill-num {
        display: inline-block;
        margin-left: 3px;
        padding: 0 4px;
        border-radius: 6px;
        background: var(--b3-theme-primary);
        color: var(--b3-theme-on-primary);
        font-size: 9px;
        line-height: 13px;
    }

    /* ---------- 提示词：平铺 ---------- */
    .tpl-bar {
        display: flex;
        gap: 6px;
        align-items: flex-start;
        padding: 7px 12px;
        background: var(--b3-theme-surface);
        border-bottom: 1px solid var(--b3-border-color);
        flex-shrink: 0;
    }
    .tpl-label {
        font-size: 10.5px;
        color: var(--b3-theme-on-surface);
        opacity: 0.7;
        padding-top: 4px;
        flex-shrink: 0;
    }
    .tpl-list {
        display: flex;
        flex-wrap: wrap;
        gap: 5px;
        flex: 1;
    }
    .tpl {
        border: 1px solid var(--b3-border-color);
        background: var(--b3-theme-background);
        border-radius: 11px;
        padding: 3px 10px;
        font-size: 11px;
        color: var(--b3-theme-on-surface);
        cursor: pointer;
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .tpl:hover {
        border-color: var(--b3-theme-primary);
        color: var(--b3-theme-primary);
    }
    .tpl.active {
        background: var(--b3-theme-primary);
        border-color: var(--b3-theme-primary);
        color: var(--b3-theme-on-primary);
        font-weight: 500;
    }
    .tpl.add {
        border-style: dashed;
        color: var(--b3-theme-on-surface);
        opacity: 0.7;
        padding: 3px 9px;
    }

    /* ---------- MCP 状态条 ---------- */
    .mcp-bar {
        display: flex;
        align-items: center;
        gap: 7px;
        width: 100%;
        text-align: left;
        padding: 6px 12px;
        font-size: 11px;
        color: var(--b3-theme-on-surface);
        background: var(--b3-theme-surface);
        border: none;
        border-bottom: 1px solid var(--b3-border-color);
        cursor: pointer;
        flex-shrink: 0;
        font-family: inherit;
    }
    .mcp-bar:hover {
        background: var(--b3-theme-background);
    }
    .mcp-bar.warn {
        color: var(--b3-theme-error);
    }
    .mcp-bar.off {
        opacity: 0.7;
    }
    .dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: var(--b3-theme-on-surface);
        opacity: 0.4;
        flex-shrink: 0;
    }
    .dot.ok {
        background: #34a853;
        opacity: 1;
    }
    .dot.err {
        background: #e67e22;
        opacity: 1;
    }
    .mcp-text {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .chev {
        opacity: 0.4;
    }
    .warn-note {
        padding: 6px 12px;
        font-size: 11px;
        line-height: 1.6;
        color: var(--b3-theme-error);
        background: var(--b3-theme-surface);
        border-bottom: 1px solid var(--b3-border-color);
        word-break: break-all;
    }
    /* 手机端通道说明不是错误，用中性色，别吓人 */
    .warn-note.info {
        color: var(--b3-theme-on-surface);
        opacity: 0.85;
    }

    /* ---------- 对话区 + 抽屉 ---------- */
    .stage {
        flex: 1;
        position: relative;
        overflow: hidden;
        min-height: 0;
    }
    .msgs {
        position: absolute;
        inset: 0;
        overflow-y: auto;
        padding: 12px;
        display: flex;
        flex-direction: column;
        gap: 10px;
    }
    .empty {
        color: var(--b3-theme-on-surface);
        font-size: 12px;
        line-height: 1.9;
        opacity: 0.8;
    }
    .empty p {
        margin: 0 0 6px;
    }

    .row {
        display: flex;
    }
    .row.me {
        justify-content: flex-end;
    }
    .row.ai {
        justify-content: flex-start;
    }
    .bubble {
        max-width: 82%;
        font-size: 13px;
        line-height: 1.7;
        padding: 8px 11px;
        border-radius: 10px;
        word-break: break-word;
        min-width: 0;
    }
    .bubble.me {
        background: var(--b3-theme-primary);
        color: var(--b3-theme-on-primary);
        border-bottom-right-radius: 3px;
        white-space: pre-wrap;
    }
    .bubble.ai {
        background: var(--b3-theme-surface);
        color: var(--b3-theme-on-background);
        border-bottom-left-radius: 3px;
    }

    .md {
        line-height: 1.75;
        word-break: break-word;
    }
    .streaming-text {
        white-space: pre-wrap;
    }
    .md :global(p) {
        margin: 0 0 8px;
    }
    .md :global(p:last-child) {
        margin-bottom: 0;
    }
    .md :global(h1),
    .md :global(h2),
    .md :global(h3) {
        font-size: 14px;
        margin: 12px 0 6px;
    }
    .md :global(ul),
    .md :global(ol) {
        padding-left: 20px;
        margin: 0 0 8px;
    }
    .md :global(code) {
        background: var(--b3-theme-background);
        padding: 1px 4px;
        border-radius: 3px;
        font-size: 12px;
    }
    .md :global(pre) {
        background: var(--b3-theme-background);
        padding: 8px;
        border-radius: var(--b3-border-radius);
        overflow-x: auto;
    }
    .md :global(table) {
        border-collapse: collapse;
        margin: 8px 0;
        max-width: 100%;
    }
    .md :global(th),
    .md :global(td) {
        border: 1px solid var(--b3-border-color);
        padding: 4px 8px;
        font-size: 12px;
    }
    .reason-toggle {
        border: none;
        background: none;
        color: var(--b3-theme-on-surface);
        cursor: pointer;
        font-size: 11px;
        padding: 0;
        margin-bottom: 6px;
        opacity: 0.7;
    }
    .reasoning {
        font-size: 11px;
        line-height: 1.7;
        color: var(--b3-theme-on-surface);
        background: var(--b3-theme-background);
        padding: 8px;
        border-radius: var(--b3-border-radius);
        margin-bottom: 8px;
        white-space: pre-wrap;
        max-height: 200px;
        overflow-y: auto;
    }
    .copy {
        margin-top: 6px;
        padding: 3px 10px;
        border: 1px solid var(--b3-border-color);
        border-radius: var(--b3-border-radius);
        background: var(--b3-theme-background);
        color: var(--b3-theme-on-surface);
        cursor: pointer;
        font-size: 11px;
    }
    .copy:hover {
        border-color: var(--b3-theme-primary);
        color: var(--b3-theme-primary);
    }
    /* 我发出的消息：复制 / 重发 并排一行，颜色跟着气泡反色走 */
    .mine-actions {
        display: flex;
        gap: 6px;
        justify-content: flex-end;
    }
    .bubble.me .copy {
        background: transparent;
        border-color: rgba(255, 255, 255, 0.45);
        color: var(--b3-theme-on-primary);
        opacity: 0.85;
    }
    .bubble.me .copy:hover {
        background: rgba(255, 255, 255, 0.15);
        border-color: var(--b3-theme-on-primary);
        color: var(--b3-theme-on-primary);
        opacity: 1;
    }
    .typing {
        font-size: 11px;
        color: var(--b3-theme-on-surface);
        opacity: 0.7;
        align-self: flex-start;
    }

    /* ---------- 抽屉 ---------- */
    .drawer-mask {
        position: absolute;
        inset: 0;
        background: rgba(0, 0, 0, 0.18);
        z-index: 5;
        border: none;
        padding: 0;
        cursor: pointer;
    }
    .drawer {
        position: absolute;
        top: 0;
        right: 0;
        bottom: 0;
        width: 82%;
        background: var(--b3-theme-background);
        border-left: 1px solid var(--b3-border-color);
        box-shadow: -6px 0 18px rgba(0, 0, 0, 0.12);
        display: flex;
        flex-direction: column;
        z-index: 6;
    }
    .drawer-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 9px 12px;
        border-bottom: 1px solid var(--b3-border-color);
        font-size: 12px;
        font-weight: 600;
        flex-shrink: 0;
    }
    .x {
        border: none;
        background: none;
        font-size: 17px;
        color: var(--b3-theme-on-surface);
        cursor: pointer;
        line-height: 1;
        padding: 0 2px;
    }
    .x:hover {
        color: var(--b3-theme-error);
    }
    .drawer-body {
        flex: 1;
        overflow-y: auto;
        min-height: 0;
    }

    /* 历史列表（放在抽屉里） */
    .hist-list {
        padding: 10px 12px;
    }
    .new-chat {
        width: 100%;
        padding: 7px;
        margin-bottom: 8px;
        border: 1px dashed var(--b3-border-color);
        border-radius: var(--b3-border-radius);
        background: transparent;
        color: var(--b3-theme-primary);
        cursor: pointer;
        font-size: 12px;
    }
    .new-chat:hover {
        border-color: var(--b3-theme-primary);
        background: var(--b3-theme-surface);
    }
    /* 清空全部历史：危险操作，用错误色但保持低调 */
    .clear-hist {
        width: 100%;
        padding: 6px;
        margin-bottom: 8px;
        border: 1px solid var(--b3-border-color);
        border-radius: var(--b3-border-radius);
        background: transparent;
        color: var(--b3-theme-on-surface);
        cursor: pointer;
        font-size: 11px;
        font-family: inherit;
        opacity: 0.8;
    }
    .clear-hist:hover {
        border-color: var(--b3-theme-error);
        color: var(--b3-theme-error);
        opacity: 1;
    }
    .hist-empty {
        font-size: 11px;
        line-height: 1.7;
        color: var(--b3-theme-on-surface);
        opacity: 0.7;
        padding: 6px 2px;
    }
    .hist-item {
        display: flex;
        align-items: center;
        border-radius: var(--b3-border-radius);
    }
    .hist-item:hover {
        background: var(--b3-theme-surface);
    }
    .hist-item.current .hist-title {
        color: var(--b3-theme-primary);
    }
    .hist-main {
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 6px;
        border: none;
        background: none;
        cursor: pointer;
        text-align: left;
        color: var(--b3-theme-on-background);
        font-size: 12px;
        min-width: 0;
    }
    .hist-title {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .hist-meta {
        flex-shrink: 0;
        font-size: 10px;
        color: var(--b3-theme-on-surface);
        opacity: 0.6;
    }
    .hist-del {
        flex-shrink: 0;
        width: 20px;
        height: 20px;
        border: none;
        background: none;
        color: var(--b3-theme-on-surface);
        cursor: pointer;
        font-size: 14px;
        line-height: 1;
        border-radius: 4px;
        opacity: 0.5;
    }
    .hist-del:hover {
        color: var(--b3-theme-error);
        opacity: 1;
    }

    /* ---------- 输入区 ---------- */
    .status {
        padding: 6px 12px;
        font-size: 11px;
        color: var(--b3-theme-on-surface);
        background: var(--b3-theme-surface);
        border-top: 1px solid var(--b3-border-color);
        word-break: break-all;
        flex-shrink: 0;
    }
    .ctrl-bar {
        display: flex;
        align-items: center;
        gap: 7px;
        padding: 5px 12px;
        border-top: 1px solid var(--b3-border-color);
        background: var(--b3-theme-surface);
        flex-shrink: 0;
    }
    .pill {
        border: 1px solid var(--b3-border-color);
        background: var(--b3-theme-background);
        color: var(--b3-theme-on-surface);
        font-size: 10px;
        border-radius: 10px;
        padding: 2px 9px;
        cursor: pointer;
        font-family: inherit;
        white-space: nowrap;
    }
    .pill:hover {
        border-color: var(--b3-theme-primary);
        color: var(--b3-theme-primary);
    }
    .pill.disabled {
        opacity: 0.5;
        cursor: default;
    }
    .unbind {
        border: 1px solid var(--b3-border-color);
        background: transparent;
        color: var(--b3-theme-on-surface);
        font-size: 10px;
        border-radius: 10px;
        padding: 2px 9px;
        cursor: pointer;
        max-width: 160px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-family: inherit;
    }
    .unbind:hover {
        border-color: var(--b3-theme-error);
        color: var(--b3-theme-error);
    }
    .tiny {
        font-size: 10px;
        color: var(--b3-theme-on-surface);
        opacity: 0.5;
        white-space: nowrap;
    }
    .compose {
        display: flex;
        gap: 7px;
        align-items: flex-end;
        padding: 8px 12px 10px;
        border-top: 1px solid var(--b3-border-color);
        flex-shrink: 0;
    }
    /* 手机端：按钮放大、点击区域够大，软键盘弹出时也别把输入框顶没了 */
    .compose.mobile textarea {
        font-size: 16px; /* iOS 小于 16px 会触发自动放大，安卓也不会乱跳 */
        min-height: 52px;
    }
    .compose.mobile button.primary,
    .compose.mobile button.danger {
        padding: 12px 18px;
        font-size: 14px;
        min-width: 64px;
    }
    textarea {
        flex: 1;
        box-sizing: border-box;
        resize: vertical;
        padding: 7px 9px;
        border: 1px solid var(--b3-border-color);
        border-radius: var(--b3-border-radius);
        background: var(--b3-theme-background);
        color: var(--b3-theme-on-background);
        font-size: 13px;
        font-family: inherit;
        line-height: 1.6;
        min-height: 38px;
    }
    textarea:focus {
        outline: none;
        border-color: var(--b3-theme-primary);
    }
    button.primary,
    button.danger {
        padding: 7px 16px;
        border: none;
        border-radius: var(--b3-border-radius);
        cursor: pointer;
        font-size: 13px;
        flex-shrink: 0;
    }
    button.primary {
        background: var(--b3-theme-primary);
        color: var(--b3-theme-on-primary);
    }
    button.danger {
        background: var(--b3-theme-error);
        color: #fff;
    }
</style>
