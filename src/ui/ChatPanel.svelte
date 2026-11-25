<script lang="ts">
    import { onMount, onDestroy, tick } from "svelte";
    import {
        settings,
        updateSettings,
        updateSettingsWith,
        activeApi,
        initSettings,
        isInitialized,
        packModelRef,
        chatApiFor,
        type Settings,
    } from "../settings";
    import { endpointFor, headersFor, bodyFor, ProviderParser } from "../providers";
    import { supportsThinking, type ThinkingLevel } from "../thinking";
    import { streamChat, channelInfo, fetchOnce, fetchBinary } from "../net";
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
    import { isChatModel, isChatModelOf, isImageModel, isImageModelOf, modelKindLabelOf, visibleModels } from "../apis";
    import {
        RATIOS,
        SIZES,
        planSize,
        longEdgeOf,
        computeSize,
        imageEndpoint,
        imageHeaders,
        imageBody,
        editParts,
        buildMultipart,
        parseImageResponse,
        imageErrorOf,
        checkReference,
        imageFileName,
        sizeSlug,
        dataUrlToBytes,
        type Ratio,
        type SizeLevel,
        type RefFile,
        type ImageResult,
    } from "../image";
    import { saveImage, loadImageDataUrl, deleteImage, imagesFolderHint, openImagesFolder, mimeOfName, mimeOfPath, sniffImageMime } from "../image-store";
    import { splitInlineImages, isHeavyInlineImage } from "../inline-image";
    import {
        OPTIMIZE_SYSTEM,
        OPTIMIZE_MAX_TOKENS,
        optimizeUserPrompt,
        cleanOptimized,
        looksEmpty,
        optimizeHint,
        optimizeFallbackHint,
        optimizeErrorMessage,
    } from "../optimize";
    import {
        normalizeSessions,
        upsertSession,
        removeSession,
        sessionTitle,
        sameMessages,
        type Session,
        type SessionImage,
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
    /**
     * 插件目录名。图片要靠它定位插件数据目录。
     * 测试里不传也行，这时存图会报一句"插件名没传进来"。
     */
    export let pluginName: string = "";

    interface Turn {
        role: "user" | "assistant";
        content: string;
        reasoning: string;
        /** 这条消息里的图片（生图模式才有）。只存路径，不存图片数据 */
        images?: SessionImage[];
        /** 我发消息时带的参考图文件名 */
        refName?: string;
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

    // ---- 生图 / 对话 双模式 ----
    /** 用户手动定的模式。null 表示"跟随当前模型自动判断" */
    let modeOverride: "chat" | "image" | null = null;
    /** 生图参数：直接存进设置，重开面板还在 */
    $: imageSize = (cfg?.imageSize || "2K") as SizeLevel;
    $: imageRatio = (cfg?.imageRatio || "16:9") as Ratio;

    /** 换大小档位 */
    function pickSize(s: SizeLevel) {
        updateSettings({ imageSize: s }, (x) => persist(x));
    }

    /** 换比例 */
    function pickRatio(r: Ratio) {
        updateSettings({ imageRatio: r }, (x) => persist(x));
    }

    /** 比例菜单里那个小方框图标的宽高（只影响观感，14px 是基准） */
    function ratioIcon(r: string): { w: number; h: number } {
        const [a, b] = String(r).split(":").map(Number);
        const box = 14;
        if (!a || !b) return { w: box, h: box };
        if (a >= b) return { w: box, h: Math.max(5, Math.round((box * b) / a)) };
        return { h: box, w: Math.max(5, Math.round((box * a) / b)) };
    }
    /** 参考图（图生图用的那张本地图片） */
    let refFile: RefFile | null = null;
    let refError = "";
    let fileInput: HTMLInputElement | null = null;
    let refThumbs: Record<string, string> = {};
    let optimizing = false;
    let generating = false;
    let optAbort: { abort: () => void } | null = null;
    let confirmClearHist: { count: number; imgNote: string; paths: string[] } | null = null;
    /** 正在等回复的那张图（占位用） */
    let imgPickerMenus: "size" | "ratio" | null = null;

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
        void hydrateImages();
        // 上次没关掉面板就退出的旧数据：图混在正文里，挂载时也整理一遍，
        // 整理完存一次，下次打开就不用再搬
        void absorbAllInlineImages().then(() => saveCurrentSession());
    });

    // 面板被卸载时要把 MCP 子进程收掉，否则会一直挂着
    onDestroy(() => {
        if (mcp) void mcp.closeAll();
        // 生图这一轮要掐掉
        if (genAbort) {
            try {
                genAbort.abort();
            } catch {}
        }
        // 优化提示词这一轮也要掐掉
        if (optAbort) {
            try {
                optAbort.abort();
            } catch {}
            optAbort = null;
        }
        // 聊天这一轮也要掐掉：不然面板已经销毁了，流还在跑，
        // 每一小段都往已销毁的组件里写状态（白耗流量，控制台一堆错）
        if (abortFn) {
            try {
                abortFn.abort();
            } catch {}
            abortFn = null;
        }
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
        // 带图的消息即使没文字也要留着 —— 图片本身就是结果
        const usable = messages.filter((m) => m.content.trim() || m.images?.length);
        if (!usable.length) return;

        const snapshot = usable.map((m) => {
            const row: any = { role: m.role, content: m.content, reasoning: m.reasoning };
            if (m.images?.length) row.images = m.images;
            if (m.refName) row.refName = m.refName;
            return row;
        });

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

        const nextSessions = upsertSession(sessions, session);
        const evicted = nextSessions.slice(30);
        sessions = nextSessions.slice(0, 30);
        persistSessions(sessions);
        if (evicted.length) {
            // 超过 30 条被挤掉的旧会话：把不再被保留会话用到的图一并清理，免得占满硬盘
            const kept = new Set(collectImagePaths(sessions));
            const gone = collectImagePaths(evicted).filter((p) => !kept.has(p));
            void removeImageFiles(gone);
        }
    }

    function openSession(id: string) {
        if (busyAny) {
            statusText = "正在生成，先点「停止」再切换对话";
            return;
        }
        const s = sessions.find((x) => x.id === id);
        if (!s) return;
        currentSessionId = s.id;
        messages = s.messages.map((m) => ({
            role: m.role,
            content: m.content,
            reasoning: m.reasoning,
            images: m.images,
            refName: m.refName,
        }));
        drawer = null;
        confirmClearHist = null;
        statusText = "";
        activeTemplateId = null;
        // 下标换了，之前展开的思考区要重置，否则会串到别的消息上
        openReasoning = -1;
        copiedIndex = -1;
        void scrollToEnd();
        void hydrateImages();
        // 老存档里的图是 base64 混在正文里的：打开时整理成卡片，顺手搬盘。
        // 整理完必须再存一次，否则搬盘结果丢了，下次打开又要重搬一遍、
        // 存档里也一直留着那段 base64。
        void absorbAllInlineImages().then(() => saveCurrentSession());
    }

    function deleteSession(id: string) {
        // 先把这个会话用到的图片文件删掉，否则磁盘上会攒一堆没主的图
        const doomed = sessions.find((s) => s.id === id);
        sessions = removeSession(sessions, id);
        persistSessions(sessions);
        const kept = new Set(collectImagePaths(sessions));
        const paths = collectImagePaths(doomed ? [doomed] : []).filter((p) => !kept.has(p));
        if (currentSessionId === id) {
            currentSessionId = "";
            messages = [];
        }
        void removeImageFiles(paths);
    }

    /** 从若干会话里收集所有图片路径（用于删文件） */
    function collectImagePaths(list: Session[]): string[] {
        const out: string[] = [];
        for (const s of list) {
            for (const m of s.messages) {
                for (const img of m.images || []) {
                    if (img.path && !out.includes(img.path)) out.push(img.path);
                }
            }
        }
        return out;
    }

    /**
     * 删掉一批图片文件。
     *
     * 不能因为某张删失败就中断：可能用户自己在资源管理器里删过了，
     * 也可能某张是"只给了网址"没有本地文件的。逐张试，失败就跳过。
     */
    async function removeImageFiles(paths: string[]) {
        if (!paths.length) return;
        for (const p of paths) {
            try {
                await deleteImage(pluginName, p);
            } catch {}
        }
        // 内存里缓存的缩略图也清掉，别留着占内存
        const next = { ...refThumbs };
        for (const p of paths) delete next[p];
        refThumbs = next;
    }

    /** 一键清空所有历史对话（先在抽屉内二次确认，避免原生 confirm 弹窗卡住焦点） */
    function clearAllSessions() {
        if (busyAny) {
            statusText = "正在生成，先点「停止」再清空历史";
            return;
        }
        const count = sessions.length;
        if (!count) {
            statusText = "还没有历史对话";
            return;
        }
        // 连当前屏幕上这段对话的图也算进去：它马上也会被清掉
        const inUse: Session = {
            id: currentSessionId || "current",
            title: "",
            updatedAt: 0,
            messages: messages.map((m) => ({
                role: m.role,
                content: m.content,
                reasoning: m.reasoning,
                images: m.images,
                refName: m.refName,
            })),
        };
        const paths = collectImagePaths([...sessions, inUse]);
        const imgNote = paths.length ? `，同时删掉 ${paths.length} 张图片文件` : "";
        confirmClearHist = { count, imgNote, paths };
    }

    function confirmDoClearHist() {
        if (!confirmClearHist) return;
        const { count, imgNote, paths } = confirmClearHist;
        confirmClearHist = null;
        sessions = [];
        persistSessions(sessions);
        // 当前对话如果不清，下一次生成会把它重新存成一条历史，看起来像“没删干净”
        currentSessionId = "";
        messages = [];
        input = "";
        void removeImageFiles(paths);
        statusText = `已清空 ${count} 个历史对话${imgNote}`;
        setTimeout(() => {
            if (statusText.startsWith("已清空")) statusText = "";
        }, 3000);
    }

    function cancelClearHist() {
        confirmClearHist = null;
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

    // ---- 当前是什么模式 ----
    /**
     * 手动标成画图的名字（设置里那个名单）。
     *
     * 名字判断一定会漏（比如 gemini-3.1-flash-image 以前就漏了），
     * 所以给主人留了一个"我告诉你这是画图模型"的开关。
     */
    $: manualImage = Array.isArray($settings?.imageModels) ? $settings.imageModels : [];

    /**
     * 当前模型是不是画图模型。
     *
     * 先看名字像不像（dall-e、gpt-image、*image*、flux、sd、imagen 这类），
     * 再看主人有没有手动标过。
     */
    $: currentIsImage = isImageModelOf(api?.model || "", manualImage);
    /** 最终生效的模式：手动定过就听手动的，否则跟着模型走 */
    $: imageMode = modeOverride ? modeOverride === "image" : currentIsImage;
    /** 生图模式下算好的最终尺寸（含"被官方尺寸表改过"的说明） */
    $: sizePlan = planSize(imageSize, imageRatio, api?.model || "");
    /** 生图/优化正在进行，界面上所有会打架的按钮都禁用 */
    $: busyAny = streaming || generating || optimizing;

    /**
     * 切模式。
     *
     * 光改一个布尔值是不够的：模式最终由 currentIsImage 和 modeOverride 一起决定。
     * 切到生图时要去找一个画图模型，切回对话时要去找一个聊天模型 ——
     * 否则会出现"点在生图模式，但顶栏还是聊天模型"这种自相矛盾的界面。
     */
    function switchMode(target: "chat" | "image") {
        if (busyAny) {
            statusText = "正在生成，等这一轮结束再切模式";
            return;
        }
        if (target === "image") {
            const drawApi = findModelApi((m) => isImageModelOf(m, manualImage));
            if (!drawApi) {
                statusText = "还没有画图模型。去「⚙ 设置」里给某套 API 加一个，比如 gpt-image-1。";
                return;
            }
            chooseModel(drawApi.apiId, drawApi.model);
            modeOverride = "image";
            statusText = "";
            return;
        }

        // 切回对话：优先回到上次用的聊天模型
        const back = chatApiFor($settings, isChatModel, manualImage);
        if (back) chooseModel(back.api.id, back.model);
        modeOverride = "chat";
        statusText = "";
    }

    /** 在所有 API 的模型清单里找一个满足条件的模型 */
    function findModelApi(match: (model: string) => boolean): { apiId: string; model: string } | null {
        const list = $settings?.apis || [];
        for (const a of list) {
            const m = (a.models || []).find((x) => match(x));
            if (m) return { apiId: a.id, model: m };
        }
        return null;
    }

    /**
     * 切到某个 API 下的某个模型。
     *
     * 两个一起改：光换模型不改 API，模型名对方可能根本不认。
     * 先用一次写入同时把 activeApiId 和那套 API 的 model 定下来，避免中间态。
     * 目标 API 不存在时什么都不做 —— 否则会把 activeApiId 写成一个悬空 id，
     * 之后整个面板都拿不到配置（顶栏会显示「未配置」）。
     *
     * 另外两件事一起做：
     *   1. 切到聊天模型时记下 lastChatModel，「优化」按钮要用它
     *   2. 切模型后把模式下调回"跟随模型"，不然手动切了模式再点模型会打架
     */
    function chooseModel(apiId: string, model: string) {
        modelPicker = false;
        if (streaming || generating) {
            statusText = "正在生成，等这一轮结束再换模型";
            return;
        }
        // 直接读 store 的名单，不经 $: 派生值：响应式语句的执行顺序不保证
        const manual = Array.isArray($settings?.imageModels) ? $settings.imageModels : [];
        const chatty = isChatModelOf(model, manual);
        // 和设置页走同一条保存路：直接在 store 里写盘会和它的延迟保存互相覆盖
        updateSettingsWith(
            (s) => {
                if (!s.apis.some((a) => a.id === apiId)) return s;
                const apis = s.apis.map((a) => (a.id === apiId ? { ...a, model } : a));
                const next: any = { ...s, apis, activeApiId: apiId };
                if (chatty) next.lastChatModel = packModelRef(apiId, model);
                return next;
            },
            (s) => persist(s)
        );
        modeOverride = null;
    }

    /** 点「图片」：打开自动保存图片的文件夹 */
    async function openFolder() {
        statusText = await openImagesFolder(pluginName);
        setTimeout(() => {
            if (/已打开|已在文件管理器|图片存在这里/.test(statusText)) statusText = "";
        }, 6000);
    }

    // ---- 参考图 ----

    /** 点「上传」：打开系统的选文件框 */
    function pickReference() {
        if (busyAny) {
            statusText = "正在生成，等这一轮结束再传图";
            return;
        }
        fileInput?.click();
    }

    /** 用户选好文件之后 */
    async function onReferenceChosen(e: Event) {
        const inputEl = e.currentTarget as HTMLInputElement;
        const file = inputEl?.files?.[0];
        // 选完清空 value：不然连着选同一个文件不会触发 change
        if (inputEl) inputEl.value = "";
        if (!file) return;

        refError = "";
        const bad = checkReference({ name: file.name, type: file.type, size: file.size });
        if (bad) {
            refError = bad;
            statusText = bad;
            return;
        }

        try {
            const buf = new Uint8Array(await file.arrayBuffer());
            const mime = file.type || mimeOfName(file.name);
            refFile = { name: file.name, mime, data: buf };
            statusText = `已选参考图「${file.name}」，会连同文字一起发出去`;
        } catch (err: any) {
            refFile = null;
            statusText = "读取这张图失败：" + (err?.message || err);
        }
    }

    function clearReference() {
        refFile = null;
        refError = "";
        statusText = "";
    }

    // ---- 生图 ----

    /** 生图请求正在跑时用它中止 */
    let genAbort: AbortController | null = null;

    /**
     * 点「发送」（生图模式）。
     *
     * 一段话发出去，回来一张（或多张）图：
     *   1. 先把占位消息插进对话区，让主人立刻看到"在做事"
     *   2. 请求发出去（有参考图就是 /images/edits，没有就是 /images/generations）
     *   3. 拿到的图片字节存进插件数据目录的 images/，对话里只记路径
     *   4. 存不下来（比如路径不可写）也要显示出来，不能白花钱
     */
    async function generateImage(prompt: string, replaceAt?: number) {
        if (generating) return;
        const text = String(prompt || "").trim();
        if (!text) {
            statusText = "先写点你想要画什么";
            return;
        }

        const runApi = activeApi($settings);
        if (!(runApi.baseURL || "").trim() || !(runApi.model || "").trim()) {
            statusText = "先选一套 API 和模型（点顶栏那个模型名）";
            return;
        }
        if (runApi.protocol !== "openai") {
            statusText = "生图目前只支持 OpenAI 兼容接口。请把这套 API 的协议改成「OpenAI 兼容」。";
            return;
        }

        const isResend = typeof replaceAt === "number";
        const plan = planSize(imageSize, imageRatio, runApi.model);
        const n = 1;
        const runRef = isResend ? null : refFile ? { ...refFile } : null;

        let userIndex = messages.length;
        if (isResend) {
            userIndex = replaceAt!;
            // 重发：原地清空这一条的旧回答，绝不在末尾追加重复气泡，也不截断后面的对话
            if (messages[userIndex + 1]?.role === "assistant") {
                messages[userIndex + 1].content = "";
                messages[userIndex + 1].images = [];
                messages[userIndex + 1].reasoning = "";
                messages = messages;
            } else {
                messages = [
                    ...messages.slice(0, userIndex + 1),
                    { role: "assistant", content: "", reasoning: "" },
                    ...messages.slice(userIndex + 1),
                ];
            }
        } else {
            // 新发：在末尾插一对「我问 + 空回答占位」
            messages = [
                ...messages,
                {
                    role: "user",
                    content: text,
                    reasoning: "",
                    refName: runRef?.name,
                },
                { role: "assistant", content: "", reasoning: "" },
            ];
            input = "";
            refFile = null;
        }

        generating = true;
        genAbort = new AbortController();
        // 记住这一轮的 controller：用户点停止后，晚到的结果不能再往界面里写
        const myAbort = genAbort;
        const answerIndex = userIndex + 1;

        /** 这一轮是不是已经被用户停掉了 */
        const isStopped = () => myAbort.signal.aborted;

        try {
            statusText = runRef
                ? `正在按参考图生成图片（${plan.label}）…`
                : `正在生成图片（${plan.label}）…`;
            if (plan.adjusted) statusText += " " + plan.note;

            const result = await requestImages(runApi, text, plan.api, n, runRef, myAbort.signal);
            // 用户已经点了停止：结果直接丢掉，别把"停止前的半张图"塞进对话。
            // 新发时把占位的空白 assistant 删掉（重发时不能截断后面的对话）。
            if (isStopped()) {
                const ph = messages[answerIndex];
                if (ph && !ph.images?.length && !ph.content.trim()) {
                    if (!isResend) {
                        messages = messages.slice(0, answerIndex);
                        messages = messages;
                    }
                }
                return;
            }
            if (!result.dataUrls.length && !result.urls.length) {
                throw new Error(imageErrorOf(null));
            }

            // 存盘。存不下来也要显示 —— 至少能让主人手动保存
            const saved: SessionImage[] = [];
            let saveFail = "";
            // 每条消息里图片的编号从 1 开始；一张一回出多张时，
            // 存盘失败的那张要按"本次第几张"记，才不会和前面的串号
            let idx = 0;
            for (const dataUrl of result.dataUrls) {
                idx++;
                const decoded = dataUrlToBytes(dataUrl);
                if (!decoded) continue;
                // 以真实字节为准：中转站常把 JPEG 塞在写着 png 的 data URL 里，
                // 照 data URL 起名会让文件"名不副实"，之后显示会被 WebView 拒绝
                const realMime = sniffImageMime(decoded.bytes, decoded.mime);
                let relPath = "";
                try {
                    const name = imageFileName(new Date(), plan.api, idx, realMime);
                    const s = await saveImage(pluginName, name, decoded.bytes, realMime);
                    relPath = s.path;
                } catch (err: any) {
                    saveFail = String(err?.message || err);
                }
                // 存盘成功就走文件；失败就挂在图片自己身上（只在内存里，不进存档）
                saved.push({
                    path: relPath,
                    size: plan.label,
                    prompt: result.revisedPrompt || text,
                    url: "",
                    mem: relPath ? "" : dataUrl,
                });
            }
            // 有的中转站只给网址：这些没法存盘，先记下网址
            let urlIdx = 0;
            for (const u of result.urls) {
                urlIdx++;
                saved.push({ path: "", url: u, size: plan.label, prompt: result.revisedPrompt || text });
            }

            const target = messages[answerIndex];
            if (target) {
                target.images = saved;
                target.content = ""; // 图片消息不需要文字，界面按 images 渲染
                messages = messages;
            }

            if (saveFail) {
                statusText =
                    "图片已生成，但存文件失败：" + saveFail + "。可以用图片下面的「保存到电脑」自己存一份。";
            } else if (saved.some((x) => x.url)) {
                statusText = "图片已生成（服务商直接给了网址，这张没存进本地 images 文件夹）";
            } else {
                statusText = `已生成 ${saved.length} 张，自动存到：${imagesFolderHint(pluginName)}`;
            }
            void hydrateImages();
        } catch (e: any) {
            const msg = String(e?.message || e);
            if (isStopped() || /已停止|aborted/i.test(msg)) {
                statusText = "已停止";
            } else {
                statusText = explainImageError(msg);
            }
            // 新发失败时删掉末尾空占位；重发时不动后面的消息
            const target = messages[answerIndex];
            if (!isResend && target && !target.images?.length && !target.content.trim()) {
                messages = messages.slice(0, answerIndex);
                messages = messages;
            }
        } finally {
            // 只有这一轮还是"当前这轮"时才清状态。
            // 用户停止后马上又点了一次生成时，旧一轮的 finally 会晚到，
            // 那时无条件清 generating 会把新一轮的按钮/输入框提前解锁，
            // 表现成"能重复发送"、"停止按钮闪一下就没了"。
            if (genAbort === myAbort) {
                generating = false;
                genAbort = null;
            }
            void scrollToEnd();
            saveCurrentSession();
        }
    }

    /**
     * 真正发请求。
     *
     * 图生图必须用 multipart，两种通道都得照顾到：
     * 电脑端把原始字节目传给主进程，手机端由内核按 base64 解码后原样发出。
     */
    async function requestImages(
        runApi: { baseURL: string; apiKey: string; model: string },
        prompt: string,
        size: string,
        n: number,
        ref: RefFile | null,
        signal: AbortSignal | undefined
    ): Promise<ImageResult> {
        const opts = {
            protocol: "openai" as const,
            baseURL: runApi.baseURL,
            apiKey: runApi.apiKey,
            model: runApi.model,
            prompt,
            size,
            n,
            reference: ref || undefined,
        };

        const mode = ref ? "edits" : "generations";
        const url = imageEndpoint(runApi.baseURL, mode);

        let headers: Record<string, string>;
        let body: string | undefined;
        let rawBody: Uint8Array | undefined;

        if (ref) {
            // 图生图：multipart
            const built = buildMultipart(editParts(opts));
            rawBody = built.body;
            headers = { ...imageHeaders(runApi.apiKey) };
            headers["Content-Type"] = built.contentType;
            delete headers.Accept;
        } else {
            headers = imageHeaders(runApi.apiKey);
            body = JSON.stringify(imageBody(opts));
        }

        // 真中止：signal 一路传到三条通道，点「停止」会掐断底层请求，
        // 而不是像以前那样只是让上层不等了（后台还在跑满 5 分钟）。
        const result = await fetchBinary(url, {
            method: "POST",
            headers,
            body,
            rawBody,
            // 生图慢，给足时间；4K 有时要两三分钟
            timeoutMs: 300000,
            signal,
        });

        const text = await result.text();
        if (!result.ok) {
            // 服务商的报错就在响应体里，尽量原样带出来
            let detail = text;
            try {
                const j = JSON.parse(text);
                detail = imageErrorOf(j);
            } catch {}
            throw new Error(`接口返回 ${result.status}${detail ? "：" + detail.slice(0, 300) : ""}`);
        }

        let json: any = null;
        try {
            json = JSON.parse(text);
        } catch {
            throw new Error("接口返回的不是 JSON，可能这个地址不是生图接口");
        }
        if (json?.error) throw new Error(imageErrorOf(json));
        return parseImageResponse(json);
    }

    /** 生图报错的人话翻译。生图这行的坑和聊天完全不一样 */
    function explainImageError(raw: string): string {
        const m = String(raw || "");
        if (/401|403/.test(m)) return "生图失败：密钥不对或没权限。去设置里检查这套 API 的 Key。";
        if (/Invalid URL|404/i.test(m)) {
            // 最常见：地址填了裸域名（少了 /v1），中转站只会回 404 Invalid URL
            const base = String(activeApi($settings)?.baseURL || "").trim();
            if (base && !/\/v\d+[a-z]*$/i.test(base) && !/\/chat\/completions$/i.test(base)) {
                return `生图失败：地址少了 /v1。现在填的是「${base}」，改成「${base}/v1」再试。`;
            }
            return "生图失败：接口地址找不到。确认地址末尾是 /v1（插件会自动接 /images/generations）。";
        }
        if (/429/.test(m)) return "生图失败：请求太频繁或额度用完了，等一会儿再试。";
        if (/size|尺寸|dimension/i.test(m)) {
            return "生图失败：这个模型不接受这个尺寸。把「大小」调小一点，或者换成 1:1 试试。";
        }
        if (/multipart|form-data|boundary/i.test(m)) {
            return "生图失败：这个服务商不支持图生图（传参考图）。把参考图去掉，只用文字生成。";
        }
        if (/image/i.test(m) && /(invalid|unsupported|not\s*support)/i.test(m)) {
            return "生图失败：这个模型不支持传参考图。去掉参考图再试。";
        }
        if (/model.*not.*found|模型不存在|invalid\s*model/i.test(m)) {
            return "生图失败：这个模型名不对。去设置里重新选一个画图模型。";
        }
        if (/content|safety|违规|拦截/i.test(m)) {
            return "生图失败：内容被服务商的安全策略拦下了。换个说法再试。";
        }
        return "生图失败：" + (m || "原因不明");
    }

    /** 中止生图 */
    function stopGenerate() {
        genAbort?.abort();
        generating = false;
        statusText = "已停止";
    }

    // ---- 优化提示词 ----

    /**
     * 点「优化」：用聊天模型把输入框里的话改写成中文提示词。
     *
     * 必须用聊天模型 —— 画图模型不会写字。
     * 所以这里不看顶栏当前是什么模型，而是走 chatApiFor：
     * 找到上次用的聊天模型 / 第一个能聊天的模型。
     */
    async function optimizePrompt() {
        if (optimizing) return;
        const text = (input || "").trim();
        if (!text) {
            statusText = "先写点你想要画什么，再点优化";
            return;
        }

        // 必须把手动标记的名单一起传进去，否则手动标成画图模型的
        // 会被当成聊天模型选去优化，必然报错
        const manual = Array.isArray($settings?.imageModels) ? $settings.imageModels : [];
        const target = chatApiFor($settings, isChatModel, manual);
        if (!target) {
            statusText = "优化要用聊天模型，但现在一套都没有。去设置里加一个，比如 glm-5.3。";
            return;
        }

        optimizing = true;
        statusText = `正在用 ${target.api.name || "未命名"} · ${target.model} 优化提示词…`;

        try {
            const out = await runOptimize(target.api, target.model, text);
            const clean = cleanOptimized(out);
            if (looksEmpty(clean)) {
                statusText = optimizeFallbackHint();
                return;
            }
            input = clean;
            statusText = optimizeHint(target.api.name, target.model);
        } catch (e: any) {
            statusText = optimizeErrorMessage(String(e?.message || e));
        } finally {
            optimizing = false;
            void tick().then(() => {
                // 优化完把光标放回输入框末尾，方便接着改
                const ta = document.querySelector("#compose-input") as HTMLTextAreaElement | null;
                ta?.focus();
            });
        }
    }

    /**
     * 发一次不计入对话的"旁路"请求，只为拿回一段文字。
     *
     * 不写进 messages、不调工具、不存历史：
     * 优化只是改一句话，不该在聊天记录里留下痕迹。
     */
    function runOptimize(apiCfg: any, model: string, text: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const runCfg = {
                ...$settings,
                ...apiCfg,
                model,
                temperature: 0.7,
                maxTokens: OPTIMIZE_MAX_TOKENS,
                // 优化是短任务，思考档位调低一点更快，也不容易把思考内容混进结果
                thinking: "low" as ThinkingLevel,
            };

            let out = "";
            let settled = false;
            let timer: any = null;
            let handle: { abort: () => void } | null = null;
            const done = (err?: string) => {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);
                if (handle && optAbort === handle) optAbort = null;
                if (err) reject(new Error(err));
                else resolve(out);
            };

            const parser = new ProviderParser(
                apiCfg.protocol,
                (t) => {
                    out += t;
                },
                () => {}
            );

            let raw = "";
            try {
                raw = JSON.stringify(
                    bodyFor(
                        apiCfg.protocol,
                        runCfg,
                        [{ role: "user", content: optimizeUserPrompt(text) }],
                        OPTIMIZE_SYSTEM
                    )
                );
            } catch (e: any) {
                reject(new Error("拼请求出错：" + (e?.message || e)));
                return;
            }

            handle = streamChat(
                {
                    url: endpointFor(apiCfg.protocol, apiCfg.baseURL, model),
                    headers: headersFor(apiCfg.protocol, apiCfg),
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
            optAbort = handle;

            // 兜底：90 秒还没结果就放弃，避免按钮一直转
            timer = setTimeout(() => {
                if (settled) return;
                try {
                    handle?.abort();
                } catch {}
                done("优化超时（90 秒没有回应）");
            }, 90000);
        });
    }

    // ---- 图片的显示 / 复制 / 保存 ----

    /** 每张图读取失败的原因，界面上能说清楚到底哪一步断了 */
    let imgErrors: Record<string, string> = {};

    /**
     * 把会话里所有"只有路径"的图片读成能显示的数据。
     *
     * 读不到时把原因记下来，不再静默失败 —— 否则界面上只有一句
     * "这张图找不到了"，主人根本分不清是文件删了还是接口出错。
     */
    /**
     * 读图失败时，如果发现"文件名说 png、实际是 jpeg"，换正确的后缀再读一次。
     *
     * 老版本是按 data URL 里的 mime 起名的，中转站把 JPEG 塞在 png 里，
     * 于是磁盘上全是 .png 装着 JPEG。这类文件在部分 WebView 里渲染不出来，
     * 但复制/保存走字节直通所以是好的 —— 表现就是"看不见但能存"。
     */
    async function retryWithRealExt(path: string): Promise<{ path: string; dataUrl: string } | null> {
        const base = path.replace(/\.[^.]+$/, "");
        const cur = (path.split(".").pop() || "").toLowerCase();
        // 只试和当前不同的后缀，顺序按"最可能是 JPEG"排（中转站最常给 jpeg）
        for (const ext of ["jpg", "jpeg", "png", "webp"]) {
            if (ext === cur) continue;
            const tryPath = base + "." + ext;
            try {
                const d = await loadImageDataUrl(pluginName, tryPath);
                if (d) return { path: tryPath, dataUrl: d };
            } catch {}
        }
        return null;
    }

    async function hydrateImages() {
        const need: string[] = [];
        for (const m of messages) {
            for (const img of m.images || []) {
                if (img.path && !refThumbs[img.path] && !imgErrors[img.path]) need.push(img.path);
            }
        }
        if (!need.length) return;

        const updates: Record<string, string> = {};
        const errs: Record<string, string> = {};
        let pathFixed = false;
        for (const p of need) {
            try {
                const d = await loadImageDataUrl(pluginName, p);
                if (d) {
                    updates[p] = d;
                    continue;
                }
                // 读不到时试着换后缀读：历史数据里常见"png 装着 jpeg"
                const alt = await retryWithRealExt(p);
                if (alt) {
                    updates[alt.path] = alt.dataUrl;
                    // 把会话里的路径也改过去，下次打开就直接能读
                    for (const m of messages) {
                        for (const img of m.images || []) {
                            if (img.path === p) {
                                img.path = alt.path;
                                pathFixed = true;
                            }
                        }
                    }
                    messages = messages;
                } else {
                    errs[p] = "读不到这个文件（也试过换后缀）";
                }
            } catch (e: any) {
                errs[p] = String(e?.message || e);
            }
        }
        if (Object.keys(updates).length) refThumbs = { ...refThumbs, ...updates };
        if (Object.keys(errs).length) imgErrors = { ...imgErrors, ...errs };
        if (pathFixed) saveCurrentSession();
    }

    /** 手动重试一次：清掉失败记录再读 */
    async function retryImage(path: string) {
        if (!path) return;
        const next = { ...imgErrors };
        delete next[path];
        imgErrors = next;
        await hydrateImages();
        if (!refThumbs[path]) statusText = "还是读不出来：" + (imgErrors[path] || "未知原因");
    }

    /**
     * 每张"图片数据"当前该用什么地址显示，键是 path / url / mem 标识。
     *
     * 为什么要有这张表：模板里如果直接调 imageSrc(img, gi)，
     * Svelte 看不到函数内部读了 refThumbs，refThumbs 更新后模板不会重算，
     * 图就永远停在最初那个（读不到的）地址上 —— 表现正是"看不见但能存"。
     */
    $: imgSrcMap = (() => {
        const map: Record<string, string> = {};
        for (const m of messages) {
            for (const img of m.images || []) {
                const key = img.path || img.url || img.mem || "";
                if (!key) continue;
                const src = imageSourceOf(img, refThumbs, imgErrors);
                if (src.kind === "data" || src.kind === "url") map[key] = src.value;
                else if (src.kind === "file" && pluginName) map[key] = storageUrl(pluginName, src.value);
                else map[key] = "";
            }
        }
        return map;
    })();

    /**
     * 一张图该从哪儿取。
     *
     * 显示和"复制/保存"必须用同一套优先级，否则会出现
     * "界面看得到、保存说找不到"这种自相矛盾。
     */
    function imageSourceOf(
        img: SessionImage,
        thumbs: Record<string, string>,
        errors: Record<string, string>
    ): { kind: "data" | "url" | "file" | "none"; value: string } {
        // 已经读成 data URL 的最可靠
        if (img.path && thumbs[img.path]) return { kind: "data", value: thumbs[img.path] };
        // 服务商给的网址
        if (img.url) return { kind: "url", value: img.url };
        // 存盘失败时留在内存里的副本
        if (img.mem) return { kind: "data", value: img.mem };
        // 明确读失败了：别再拿静态地址硬顶，让界面显示原因
        if (img.path && errors[img.path]) return { kind: "none", value: "" };
        // 还没读完：先用静态地址占位
        if (img.path) return { kind: "file", value: img.path };
        return { kind: "none", value: "" };
    }

    /**
     * 思源对插件数据目录的静态访问地址。
     * 形如 /storage/petal/<插件名>/images/xxx.png，由内核直接当文件发。
     */
    function storageUrl(plugin: string, rel: string): string {
        const clean = String(rel || "")
            .split("/")
            .filter(Boolean)
            .map((seg) => encodeURIComponent(seg))
            .join("/");
        return "/storage/petal/" + encodeURIComponent(plugin) + "/" + clean;
    }

    /** 把一张图拿到手（用于复制/保存），拿不到返回 null */
    async function fetchImageBlob(img: SessionImage): Promise<{ bytes: Uint8Array; mime: string } | null> {
        if (img.path) {
            const du = await loadImageDataUrl(pluginName, img.path);
            const dec = du ? dataUrlToBytes(du) : null;
            if (dec) return dec;
        }
        if (img.url) {
            // 小于 20KB 的内嵌 data URL 会留在 url 字段里，直接解码，不走 HTTP 代理
            if (/^data:/i.test(img.url)) {
                const dec = dataUrlToBytes(img.url);
                if (dec) return dec;
            } else {
                try {
                    const r = await fetchBinary(img.url, { method: "GET", headers: {} });
                    if (r.ok) {
                        const bytes = await r.bytes();
                        // 以字节为准：服务商"图片网址"有时返回的是 JSON 错误体，
                        // 直接当图片存下去会得到一个打不开的文件
                        const sniffed = sniffImageMime(bytes, "");
                        if (!sniffed) return null;
                        return { bytes, mime: sniffed };
                    }
                } catch {}
            }
        }
        // 存盘失败的那张：用它自己携带的内存副本
        if (img.mem) {
            const dec = dataUrlToBytes(img.mem);
            if (dec) return dec;
        }
        return null;
    }

    /**
     * 复制图片本身到剪贴板。
     *
     * 走 navigator.clipboard.write（要 ClipboardItem + Blob），
     * 电脑上的 Electron 支持；手机上多半不行，那就退回"复制图片地址/提示手动保存"。
     */
    async function copyImage(img: SessionImage) {
        const got = await fetchImageBlob(img);
        if (!got) {
            statusText = "这张图找不到了（可能被手动删掉了）";
            return;
        }
        try {
            const nav: any = navigator;
            if (nav.clipboard?.write && typeof (window as any).ClipboardItem === "function") {
                const blob = new Blob([got.bytes as any], { type: got.mime });
                // 有的环境只认 png，两种都试一遍
                const items: any[] = [new (window as any).ClipboardItem({ [got.mime]: blob })];
                try {
                    await nav.clipboard.write(items);
                    statusText = "图片已复制，去笔记里粘贴";
                    return;
                } catch {
                    const pngBlob = new Blob([got.bytes as any], { type: "image/png" });
                    await nav.clipboard.write([new (window as any).ClipboardItem({ "image/png": pngBlob })]);
                    statusText = "图片已复制，去笔记里粘贴";
                    return;
                }
            }
        } catch {}
        statusText = "这个环境不能把图片放进剪贴板。请点「保存到电脑」，再把文件拖进笔记。";
    }

    /**
     * 保存到电脑：弹系统的「另存为」。
     *
     * 浏览器/手机没有真正的"选文件夹"能力，就用 <a download> —— 系统会自己
     * 弹下载框让主人选位置。桌面端思源里也一样能弹出保存对话框。
     */
    async function saveImageToDisk(img: SessionImage) {
        const got = await fetchImageBlob(img);
        if (!got) {
            statusText = "这张图找不到了。可能被手动删掉了，也可能是服务商给的网址过期了。";
            return;
        }
        const mime = got.mime || "image/png";
        const name = imageFileName(new Date(), sizeSlug(img.size || ""), 1, mime);

        // 1) 桌面版：走 Electron 原生「另存为」，主人能自己选文件夹。
        //    思源桌面里 <a download> 经常静默失败（不弹窗、也不落盘），必须走这条。
        const req = (window as any).require;
        if (typeof req === "function") {
            try {
                const remote = req("@electron/remote");
                const dialog = remote?.dialog;
                const fs = req("fs");
                if (dialog?.showSaveDialog && fs) {
                    const picked = await dialog.showSaveDialog({
                        title: "保存图片",
                        defaultPath: name,
                        filters: [
                            {
                                name: "图片",
                                extensions: [mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : "png"],
                            },
                        ],
                    });
                    if (picked?.canceled || !picked?.filePath) {
                        statusText = "已取消保存";
                        return;
                    }
                    // 不写 Buffer：渲染进程里没有这个全局，fs 直接接受 Uint8Array
                    fs.writeFileSync(picked.filePath, got.bytes);
                    statusText = "已保存到 " + picked.filePath;
                    return;
                }
            } catch (e: any) {
                // 拿不到原生对话框就往下走下载兜底，原因留在状态栏
                statusText = "原生保存不可用，改用下载：" + (e?.message || e);
            }
        }

        // 2) 兜底：浏览器下载（手机、或 remote 不可用）
        try {
            const blob = new Blob([got.bytes as any], { type: mime });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = name;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => {
                try {
                    URL.revokeObjectURL(url);
                } catch {}
            }, 10000);
            statusText = "已保存「" + name + "」。图片同时也留在 " + imagesFolderHint(pluginName);
        } catch (e: any) {
            statusText = "保存失败：" + (e?.message || e);
        }
    }

    /** 打开抽屉时顺手把模型切换器收掉，避免两层叠在一起 */
    function openDrawer(which: typeof drawer) {
        modelPicker = false;
        confirmClearHist = null;
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

    /** 过滤危险标签与内联事件脚本，防外部 MCP 网页或模型回复里夹带恶意 HTML */
    function sanitizeHtml(html: string): string {
        return String(html || "")
            .replace(/<\s*(script|iframe|object|embed|style|meta|link|base)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
            .replace(/<\s*(script|iframe|object|embed|style|meta|link|base)\b[^>]*\/?>/gi, "")
            .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
            .replace(/(href|src|xlink:href)\s*=\s*(["'])\s*(?:javascript:|vbscript:|data\s*:\s*text\/html)[\s\S]*?\2/gi, '$1=$2#$2');
    }

    function renderMd(text: string): string {
        try {
            if (luteInstance === null) {
                luteInstance = (window as any).Lute?.New?.() || false;
            }
            if (luteInstance && luteInstance.Md2HTML) return sanitizeHtml(luteInstance.Md2HTML(text));
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

    /** 点「停止」时一次收掉两条路：聊天和生图 */
    function stopAll() {
        if (generating) {
            stopGenerate();
            return;
        }
        stop();
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
                // 有的服务商把图混在文字里返回：整理成图片卡片再存盘
                void absorbAllInlineImages().then(() => saveCurrentSession());
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
                let roundContent = "";
                const parser = new ProviderParser(
                    runApi.protocol,
                    (t) => {
                        roundContent += t;
                        handlers.onDelta({ content: t });
                    },
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
                    // 把这一轮模型吐出的文字一起带回工具循环，保证下一轮历史记忆完整
                    resolve({
                        content: roundContent,
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

    /** 点「发送」：按当前模式分流 */
    function send() {
        if (busyAny) return;
        // 输入框里的软键盘还开着时点发送，先把选择器收掉，别挡着结果
        modelPicker = false;
        imgPickerMenus = null;
        const text = input.trim();

        if (!text) {
            statusText = imageMode
                ? "写点你想要画什么"
                : activeTemplateId
                ? "写点什么再发（按 Ctrl+Enter）"
                : "先写点要求再发";
            return;
        }

        // 生图模式：走生图接口，不碰聊天那条路
        if (imageMode) {
            void generateImage(text);
            return;
        }

        startTurn({ text, templateId: activeTemplateId });
    }

    /**
     * 点模板 = 只绑规则，不发送、不清空对话。
     * 绑定之后，这个框里每一条消息都会自动带上这套规则去问模型。
     */
    function bindTemplate(id: string) {
        if (busyAny) {
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
     *
     * 生图模式下的重发：原话就是提示词，重新画一张替换旧图。
     */
    function resend(i: number) {
        if (busyAny) {
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

        // 生图：原地重画这一条替换旧图，不再额外追加气泡
        if (imageMode) {
            openReasoning = -1;
            copiedIndex = -1;
            void generateImage(text, i);
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
        if (busyAny) {
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
        refFile = null;
        refError = "";
    }

    /** 取消当前绑定的模板，回到没规则的自由对话 */
    function unbindTemplate() {
        if (busyAny) {
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
        // Esc：先收掉生图的两个下拉，再收掉模型切换器
        if (e.key === "Escape") {
            if (imgPickerMenus) {
                imgPickerMenus = null;
                e.preventDefault();
                return;
            }
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

    /** 点面板空白处把生图的下拉收掉（和模型切换器的行为保持一致） */
    function closeImgMenus(e: MouseEvent) {
        if (!imgPickerMenus) return;
        const t = e.target as HTMLElement | null;
        if (t?.closest?.(".menu-anchor")) return;
        imgPickerMenus = null;
    }

    /**
     * 把正文里的图片抽出来（服务商把图混在文字里返回的那种）。
     *
     * 真实场景：gemini-3.1-flash-image 返回的是
     *   ![image](data:image/jpeg;base64,...)   整条消息 964KB
     * 以前它只会当文字渲染，底下一个「复制」，既没法保存，base64 还把存档撑爆。
     * 现在抽成标准图片，走统一卡片（复制 + 保存），大图同时搬进 images/。
     */
    async function absorbInlineImages(index: number) {
        const m = messages[index];
        if (!m || m.role !== "assistant") return;
        if (m.images?.length) return;
        const { images, rest } = splitInlineImages(m.content || "");
        if (!images.length) return;

        const saved: SessionImage[] = [];
        // 图都有了去处（磁盘或内存）之后，正文才敢把 base64 扔掉，否则图就没了
        let imgIdx = 0;
        for (const img of images) {
            imgIdx++;
            let path = "";
            let mem = "";
            if (isHeavyInlineImage(img.src)) {
                try {
                    const decoded = dataUrlToBytes(img.src);
                    if (decoded) {
                        const realMime = sniffImageMime(decoded.bytes, decoded.mime);
                        // 必须带下标：同一条消息里常有多张图，
                        // 全传 1 会让它们在同一秒内撞名，后一张覆盖前一张（丢图）。
                        // 尺寸位传 "msg" 是为了让搬盘来的图与生图目录里的图一眼分得开。
                        const name = imageFileName(new Date(), "msg", imgIdx, realMime);
                        const s = await saveImage(pluginName, name, decoded.bytes, realMime);
                        path = s.path;
                    }
                } catch {
                    mem = img.src;
                }
            }
            saved.push({
                path,
                size: "",
                prompt: rest.slice(0, 80),
                url: path || mem ? "" : img.src,
                mem,
            });
        }

        // 每张图都必须有去处，才能把正文里的 base64 摘掉
        const allSafe = saved.every((x) => x.path || x.mem || x.url);
        if (!allSafe) return;

        const target = messages[index];
        if (!target) return;
        target.images = saved;
        target.content = rest;
        messages = messages;
        if (saved.some((x) => x.path)) void hydrateImages();
    }

    /** 把当前对话里所有"图混在正文里"的消息整理一遍 */
    async function absorbAllInlineImages() {
        for (let i = 0; i < messages.length; i++) {
            await absorbInlineImages(i);
        }
    }

</script>

<svelte:window on:keydown={onKeydown} on:click={closeImgMenus} />

<div class="panel">
    <!-- 顶栏：品牌 / 模型 / 历史 / 管理 / 设置 -->
    <div class="topbar">
        <span class="brand">AI 生成</span>
        <button
            class="model-btn"
            class:open={modelPicker}
            class:img={imageMode}
            on:click|stopPropagation={() => (modelPicker = !modelPicker)}
            title="切换 API 和模型"
        >
            <span class="dot-api" class:draw={imageMode}></span>
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
                        <em>{visibleModels(a).length} / {a.models.length} 个已勾选</em>
                    </div>
                    {#if a.models.length === 0}
                        <div class="api-empty">还没填模型（去设置里加）</div>
                    {:else if visibleModels(a).length === 0}
                        <div class="api-empty">还没勾选模型（去设置里勾一下）</div>
                    {/if}
                    {#each visibleModels(a) as m}
                        {@const kind = modelKindLabelOf(m, manualImage)}
                        <button
                            class="model-row"
                            class:active={a.id === cfg.activeApiId && a.model === m}
                            class:img={kind === "画图"}
                            class:bad={kind === "不能聊天"}
                            on:click={() => chooseModel(a.id, m)}
                        >
                            <span class="m-name">{m}</span>
                            {#if kind}<span class="m-kind" class:img={kind === "画图"}>{kind}</span>{/if}
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

    <!-- 生图模式提示条 -->
    {#if imageMode}
        <div class="img-banner">
            <span class="ib-tag">生图</span>
            <span>描述你想要的画面；点「优化」可以把你写的话润色成中文提示词</span>
        </div>
    {/if}

    <!-- 提示词：生图模式下藏起来（图片模型不吃系统提示，留着只会点错） -->
    {#if !imageMode}
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

        <!-- MCP：常驻一行状态条。生图模式下也藏起来，图片模型不会调工具 -->
        <button class="mcp-bar" class:warn={mcpWarn} class:off={mcpOff} on:click={() => openDrawer("mcp")}>
            <span class="dot" class:ok={!mcpWarn && !mcpOff} class:err={mcpWarn}></span>
            <span class="mcp-text">{mcpSummary}</span>
            <span class="grow"></span>
            <span class="chev">›</span>
        </button>
    {/if}

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
                            {#if m.images?.length}
                                <!-- 生成的图片：一张卡片带复制 / 保存 -->
                                {#each m.images as img, gi}
                                    <div class="img-card">
                                        {#if imgSrcMap[img.path || img.url || img.mem || ""]}
                                            <img class="img-thumb" src={imgSrcMap[img.path || img.url || img.mem || ""]} alt={img.prompt || "生成的图片"} />
                                        {:else}
                                            <div class="img-missing">
                                                <div>这张图暂时显示不出来</div>
                                                {#if img.path && imgErrors[img.path]}
                                                    <span class="tiny">原因：{imgErrors[img.path]}</span>
                                                {:else if img.path}
                                                    <span class="tiny">正在读取文件…</span>
                                                {:else if img.url}
                                                    <span class="tiny">服务商给的网址打不开，可能已过期</span>
                                                {:else}
                                                    <span class="tiny">这张图没有可用的本地文件或网址</span>
                                                {/if}
                                                {#if img.path}
                                                    <div style="margin-top:6px">
                                                        <button class="retry-img" on:click={() => retryImage(img.path)}>重试</button>
                                                    </div>
                                                {/if}
                                            </div>
                                        {/if}
                                        <div class="img-body">
                                            {#if img.prompt}
                                                <div class="img-prompt">{img.prompt}</div>
                                            {/if}
                                            <div class="img-meta">
                                                {#if img.size}{img.size}{/if}
                                                {#if img.path} · 已存到 images/{/if}
                                                {#if img.url && !img.path} · 服务商给的网址{/if}
                                            </div>
                                            <div class="img-actions">
                                                <button on:click={() => copyImage(img)}>复制图片</button>
                                                <button class="primary2" on:click={() => saveImageToDisk(img)}>保存到电脑</button>
                                            </div>
                                        </div>
                                    </div>
                                {/each}
                            {/if}
                            {#if m.content}
                                {#if streaming && i === messages.length - 1}
                                    <!-- 生成中先用纯文本：每来一小段就整篇重解析 Markdown 会越来越卡 -->
                                    <div class="md streaming-text">{m.content}</div>
                                {:else}
                                    <div class="md">{@html renderMd(m.content)}</div>
                                {/if}
                            {/if}
                            {#if m.content && !streaming && !m.images?.length}
                                <button class="copy" on:click={() => copyOne(i)}>
                                    {copiedIndex === i ? "已复制" : "复制"}
                                </button>
                            {/if}
                        {:else}
                            {#if m.refName}
                                <div class="ref-chip">
                                    <span class="ref-dot"></span>
                                    参考图：{m.refName}
                                </div>
                            {/if}
                            <div class="plain">{m.content}</div>
                            <div class="mine-actions">
                                <button class="copy" on:click={() => copyOne(i)} title="复制我发的这句话">
                                    {copiedIndex === i ? "已复制" : "复制"}
                                </button>
                                <button class="copy" on:click={() => resend(i)} title={imageMode ? "用这句话重新画一张" : "把这句话原样再发一次"}>
                                    重发
                                </button>
                            </div>
                        {/if}
                    </div>
                </div>
            {/each}
            {#if streaming}
                <div class="typing">正在生成<span class="dots">…</span></div>
            {:else if generating}
                <div class="typing">正在画图，4K 可能要等一两分钟<span class="dots">…</span></div>
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
                        <SettingsPanel {persist} busy={busyAny} />
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
                                {#if confirmClearHist}
                                    <div class="confirm-hist">
                                        <span>清空全部 {confirmClearHist.count} 个历史对话{confirmClearHist.imgNote}？删掉就找不回来了。</span>
                                        <div class="confirm-hist-btns">
                                            <button class="confirm-hist-no" on:click={cancelClearHist}>取消</button>
                                            <button class="confirm-hist-yes" on:click={confirmDoClearHist}>确认清空</button>
                                        </div>
                                    </div>
                                {:else}
                                    <button class="clear-hist" on:click={clearAllSessions}>
                                        清空全部历史（{sessions.length} 个）
                                    </button>
                                {/if}
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

    <!-- 输入区上方：左边是思考档位，右边是生图的 4 个按钮（一直在，不分模式） -->
    <div class="ctrl-bar" class:img={imageMode}>
        <!-- 左：思考档位 + 退出模板 -->
        {#if canThink}
            <button class="pill" on:click={() => cycleThinking()}>思考：{levelLabels[cfg.thinking]}<span class="caret">▾</span></button>
        {:else}
            <span class="pill disabled">该模型不支持思考</span>
        {/if}
        {#if activeTemplate}
            <button class="unbind" on:click={unbindTemplate} title="取消当前提示词规则">退出「{activeTemplate.name}」</button>
        {/if}

        <span class="grow"></span>

        <!-- 右：图片 / 上传 / 大小 / 尺寸 / 优化，模式开关放在最末 -->
        <!-- 图片：打开自动保存图片的文件夹 -->
        <button
            class="pill folder"
            on:click={() => void openFolder()}
            title="打开自动保存图片的文件夹"
        >图片</button>

        <!-- 上传 -->
        <button
            class="pill upload"
            class:on={!!refFile}
            on:click={pickReference}
            title="选一张本地图片当参考图（图生图）"
            disabled={busyAny}
        >{refFile ? "换图" : "上传"}</button>

        <!-- 大小 -->
        <div class="menu-anchor">
            <button
                class="pill"
                class:on={imgPickerMenus === "size"}
                on:click={(e) => { e.stopPropagation(); imgPickerMenus = imgPickerMenus === "size" ? null : "size"; }}
                title="图片大小（长边像素）"
                disabled={busyAny}
            >{imageSize} <span class="caret">▾</span></button>
            {#if imgPickerMenus === "size"}
                <div class="menu">
                    <div class="menu-title">图片大小（长边）</div>
                    {#each SIZES as s}
                        <button class="menu-item" class:active={imageSize === s} on:click={() => { pickSize(s); imgPickerMenus = null; }}>
                            {s}
                            <span class="px">长边 {longEdgeOf(s)}</span>
                        </button>
                    {/each}
                    <div class="menu-foot">
                        换算后：<b>{sizePlan.label}</b><br />
                        只认固定尺寸的模型会自动换成最接近的官方尺寸。
                    </div>
                </div>
            {/if}
        </div>

        <!-- 尺寸（比例） -->
        <div class="menu-anchor">
            <button
                class="pill"
                class:on={imgPickerMenus === "ratio"}
                on:click={(e) => { e.stopPropagation(); imgPickerMenus = imgPickerMenus === "ratio" ? null : "ratio"; }}
                title="图片比例"
                disabled={busyAny}
            >{imageRatio} <span class="caret">▾</span></button>
            {#if imgPickerMenus === "ratio"}
                <div class="menu ratio-menu">
                    <div class="menu-title">图片比例</div>
                    <div class="ratio-grid">
                        {#each RATIOS as r}
                            <button
                                class="menu-item"
                                class:active={imageRatio === r}
                                on:click={() => { pickRatio(r); imgPickerMenus = null; }}
                            >
                                <span class="ratio-icon" style={`width:${ratioIcon(r).w}px;height:${ratioIcon(r).h}px`}></span>
                                {r}
                            </button>
                        {/each}
                    </div>
                    <div class="menu-foot">当前：<b>{imageSize} · {imageRatio} → {sizePlan.label}</b></div>
                </div>
            {/if}
        </div>

        <!-- 优化 -->
        <button class="pill opt" on:click={() => void optimizePrompt()} disabled={busyAny} title="用聊天模型把你写的话改写成中文提示词">
            {optimizing ? "优化中…" : "优化"}
        </button>

        <!-- 模式开关：一句话切过去，切过去之后按钮还是这一排 -->
        {#if imageMode}
            <button class="pill mode" on:click={() => switchMode("chat")} title="切回聊天模型" disabled={busyAny}>
                💬 对话
            </button>
        {:else}
            <button class="pill mode" on:click={() => switchMode("image")} title="切到画图模型" disabled={busyAny}>
                🎨 生图
            </button>
        {/if}

        <!-- 实际会出多大的图：一直显示，被官方尺寸表改过就用橙色强调 -->
        {#if sizePlan.adjusted}
            <span class="px-hint warn-size" title={sizePlan.note}>实际 {sizePlan.label}（已换）</span>
        {:else}
            <span class="px-hint">{sizePlan.label}</span>
        {/if}
    </div>

    <!-- 参考图预览：选了图才出现 -->
    {#if imageMode && (refFile || refError)}
        <div class="ref-bar">
            {#if refFile}
                <span class="ref-name" title={refFile.name}>参考图：{refFile.name}</span>
                <button class="ref-x" on:click={clearReference} title="去掉参考图">×</button>
            {:else}
                <span class="ref-err">{refError}</span>
            {/if}
        </div>
    {/if}

    <!-- 输入区 -->
    <div class="compose" class:mobile={isMobile}>
        <textarea
            id="compose-input"
            bind:value={input}
            placeholder={imageMode ? "描述你想要的画面…" : "写内容或要求…"}
            rows="3"
            enterkeyhint={isMobile ? "send" : undefined}
            disabled={streaming || generating}
        ></textarea>
        {#if streaming || generating}
            <button class="danger" on:click={stopAll}>停止</button>
        {:else}
            <button class="primary" on:click={send}>{imageMode ? "生成" : "发送"}</button>
        {/if}
    </div>

    <!-- 选文件用的隐藏 input -->
    <input
        class="file-input"
        type="file"
        accept="image/png,image/jpeg,image/webp"
        bind:this={fileInput}
        on:change={onReferenceChosen}
    />
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
    /* 画图模式：小圆点换橙色，一眼看出跟聊天不是一套 */
    .dot-api.draw {
        background: #e08b2d;
    }
    .model-btn.img {
        border-color: #d9a25c;
        color: #b87413;
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
    /* 画图模型：橙色字 + 一个「画图」小标签，和聊天模型不会点混 */
    .model-row.img {
        color: #b87413;
    }
    .model-row.img.active {
        color: #c8760a;
    }
    .model-row.bad {
        opacity: 0.55;
    }
    .m-kind {
        font-size: 9px;
        border: 1px solid var(--b3-border-color);
        border-radius: 6px;
        padding: 0 4px;
        line-height: 13px;
        opacity: 0.75;
        flex-shrink: 0;
    }
    .m-kind.img {
        border-color: #d9a25c;
        background: rgba(224, 139, 45, 0.12);
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

    /* ---------- 生图模式提示条 ---------- */
    .img-banner {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 6px 12px;
        font-size: 11px;
        line-height: 1.5;
        color: #96641a;
        background: rgba(224, 139, 45, 0.13);
        border-bottom: 1px solid var(--b3-border-color);
        flex-shrink: 0;
    }
    .ib-tag {
        background: #e08b2d;
        color: #fff;
        border-radius: 8px;
        padding: 0 6px;
        font-size: 10px;
        line-height: 16px;
        flex-shrink: 0;
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

    /* ---------- 生成的图片卡片 ---------- */
    .img-card {
        width: 100%;
        border: 1px solid var(--b3-border-color);
        border-radius: 10px;
        overflow: hidden;
        background: var(--b3-theme-background);
    }
    .img-thumb {
        display: block;
        width: 100%;
        height: auto;
        /* 4K 图直接铺满会把面板撑得老长，限个高，点开看原图的事交给「保存到电脑」 */
        max-height: 320px;
        object-fit: contain;
        background: var(--b3-theme-surface);
    }
    .img-missing {
        padding: 24px 12px;
        text-align: center;
        font-size: 11.5px;
        line-height: 1.7;
        color: var(--b3-theme-on-surface);
        background: var(--b3-theme-surface);
        opacity: 0.8;
    }
    .retry-img {
        padding: 3px 12px;
        font-size: 10.5px;
        font-family: inherit;
        border: 1px solid var(--b3-border-color);
        background: var(--b3-theme-background);
        color: var(--b3-theme-primary);
        border-radius: 6px;
        cursor: pointer;
    }
    .retry-img:hover {
        border-color: var(--b3-theme-primary);
    }
    .img-body {
        padding: 8px 10px 10px;
    }
    .img-prompt {
        font-size: 11.5px;
        line-height: 1.65;
        color: var(--b3-theme-on-background);
    }
    .img-meta {
        margin-top: 4px;
        font-size: 10px;
        color: var(--b3-theme-on-surface);
        opacity: 0.75;
        word-break: break-all;
    }
    .img-actions {
        display: flex;
        gap: 7px;
        margin-top: 8px;
    }
    .img-actions button {
        flex: 1;
        padding: 5px 0;
        font-size: 11.5px;
        font-family: inherit;
        border: 1px solid var(--b3-border-color);
        background: var(--b3-theme-background);
        color: var(--b3-theme-on-surface);
        border-radius: 6px;
        cursor: pointer;
    }
    .img-actions button:hover {
        border-color: var(--b3-theme-primary);
        color: var(--b3-theme-primary);
    }
    .img-actions button.primary2 {
        background: var(--b3-theme-primary);
        border-color: var(--b3-theme-primary);
        color: var(--b3-theme-on-primary);
    }
    .img-actions button.primary2:hover {
        filter: brightness(1.08);
        color: var(--b3-theme-on-primary);
    }
    /* 我发的消息里那句"参考图：xxx" */
    .ref-chip {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        background: rgba(255, 255, 255, 0.2);
        border-radius: 6px;
        padding: 2px 7px;
        font-size: 10.5px;
        margin-bottom: 5px;
    }
    .ref-dot {
        width: 8px;
        height: 8px;
        border-radius: 2px;
        background: rgba(255, 255, 255, 0.75);
        flex-shrink: 0;
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
    .confirm-hist {
        padding: 8px;
        margin-bottom: 8px;
        border: 1px solid var(--b3-theme-error);
        border-radius: var(--b3-border-radius);
        font-size: 11px;
        line-height: 1.6;
    }
    .confirm-hist-btns {
        display: flex;
        justify-content: flex-end;
        gap: 6px;
        margin-top: 6px;
    }
    .confirm-hist-no,
    .confirm-hist-yes {
        border: 1px solid var(--b3-border-color);
        background: none;
        border-radius: 4px;
        padding: 3px 9px;
        font-size: 11px;
        cursor: pointer;
        font-family: inherit;
    }
    .confirm-hist-yes {
        border-color: var(--b3-theme-error);
        background: var(--b3-theme-error);
        color: #fff;
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
    /* 当前生效的按钮给个淡底，一眼看出现在选的是哪档 */
    .pill.on {
        border-color: var(--b3-theme-primary);
        color: var(--b3-theme-primary);
        background: var(--b3-theme-surface);
    }
    /* 模式开关用虚线边，和功能按钮区分开 */
    .pill.mode {
        border-style: dashed;
        font-weight: 500;
    }
    /* 「图片」按钮：打开自动保存图片的文件夹 */
    .pill.folder {
        border-color: var(--b3-theme-primary);
        color: var(--b3-theme-primary);
    }
    .pill.folder:hover {
        background: var(--b3-theme-surface);
    }
    .pill.upload {
        border-color: var(--b3-theme-primary);
        color: var(--b3-theme-primary);
    }
    .pill.opt {
        border-color: #d9a25c;
        color: #b87413;
    }
    .pill.opt:hover {
        border-color: #c8760a;
        color: #c8760a;
    }
    .pill:disabled {
        opacity: 0.5;
        cursor: default;
        border-color: var(--b3-border-color);
        color: var(--b3-theme-on-surface);
    }
    /* 生图控制条：橙色底，和聊天的灰底区分开 */
    .ctrl-bar.img {
        background: rgba(224, 139, 45, 0.07);
    }
    /* 实际尺寸提示：排在控制条最右边 */
    .px-hint {
        font-size: 10px;
        color: var(--b3-theme-on-surface);
        opacity: 0.55;
        white-space: nowrap;
    }
    .warn-size {
        color: #b87413;
        opacity: 0.9;
    }

    /* ---------- 控制条里的下拉菜单 ---------- */
    .menu-anchor {
        position: relative;
        display: inline-flex;
    }
    .menu {
        position: absolute;
        bottom: 28px;
        left: 0;
        z-index: 25;
        background: var(--b3-theme-background);
        border: 1px solid var(--b3-border-color);
        border-radius: 10px;
        box-shadow: 0 10px 28px rgba(0, 0, 0, 0.18);
        padding: 6px;
        min-width: 150px;
        max-height: 320px;
        overflow-y: auto;
    }
    .menu.ratio-menu {
        min-width: 232px;
    }
    .menu-title {
        font-size: 10px;
        color: var(--b3-theme-on-surface);
        opacity: 0.7;
        padding: 2px 6px 5px;
    }
    .menu-item {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        border: none;
        background: none;
        text-align: left;
        padding: 6px 8px;
        border-radius: 6px;
        font-size: 12px;
        color: var(--b3-theme-on-background);
        cursor: pointer;
        font-family: inherit;
    }
    .menu-item:hover {
        background: var(--b3-theme-surface);
    }
    .menu-item.active {
        color: var(--b3-theme-primary);
        font-weight: 600;
    }
    .menu-item .px {
        margin-left: auto;
        font-size: 10px;
        color: var(--b3-theme-on-surface);
        opacity: 0.65;
        font-weight: 400;
    }
    .ratio-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 2px;
    }
    .ratio-grid .menu-item {
        padding: 5px 7px;
        font-size: 11.5px;
    }
    .ratio-icon {
        display: inline-block;
        border: 1.5px solid currentColor;
        border-radius: 2px;
        opacity: 0.5;
        flex-shrink: 0;
        box-sizing: border-box;
    }
    .menu-foot {
        margin-top: 4px;
        padding: 5px 6px 2px;
        border-top: 1px solid var(--b3-border-color);
        font-size: 10px;
        line-height: 1.6;
        color: var(--b3-theme-on-surface);
    }

    /* 参考图预览条 */
    .ref-bar {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 4px 12px;
        font-size: 10.5px;
        background: var(--b3-theme-surface);
        border-top: 1px solid var(--b3-border-color);
        flex-shrink: 0;
    }
    .ref-name {
        color: var(--b3-theme-on-surface);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        flex: 1;
    }
    .ref-err {
        color: var(--b3-theme-error);
        line-height: 1.5;
    }
    .ref-x {
        border: none;
        background: none;
        color: var(--b3-theme-on-surface);
        font-size: 14px;
        line-height: 1;
        cursor: pointer;
        padding: 0 2px;
        flex-shrink: 0;
    }
    .ref-x:hover {
        color: var(--b3-theme-error);
    }
    /* 选文件用的 input 必须藏起来，但不能用 display:none —— 有的 WebView 里点不动 */
    .file-input {
        position: absolute;
        width: 1px;
        height: 1px;
        opacity: 0;
        pointer-events: none;
        left: -9999px;
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
