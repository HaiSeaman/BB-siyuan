<script lang="ts">
    import { settings, updateSettings, updateSettingsWith, packModelRef, type Settings } from "../settings";
    import { endpointFor, headersFor, bodyFor, ProviderParser, type Protocol } from "../providers";
    import { THINKING_LEVELS, supportsThinking, type ThinkingLevel } from "../thinking";
    import { streamChat, fetchOnce } from "../net";
    import {
        createApi,
        togglePick,
        isPicked,
        fetchModels,
        isChatModel,
        isChatModelOf,
        isImageModel,
        isImageModelOf,
        mergeModels,
        type ApiConfig,
    } from "../apis";

    export let persist: (s: Settings) => void;
    /** 生成中：能看能改，只是这一轮已经发出去了 */
    export let busy = false;

    const PROTOCOLS: { value: Protocol; label: string; hint: string }[] = [
        { value: "openai", label: "OpenAI 兼容", hint: "绝大多数中转站用这个" },
        { value: "anthropic", label: "Claude 原生", hint: "走 /v1/messages" },
        { value: "gemini", label: "Gemini 原生", hint: "走 /v1beta/models" },
    ];

    const LEVEL_LABEL: Record<ThinkingLevel, string> = {
        off: "关",
        minimal: "最小",
        low: "低",
        medium: "中",
        high: "高",
        max: "最高",
    };

    $: cfg = $settings;
    // 直接读 store，不走 cfg：
    // Svelte 的响应式语句按依赖顺序执行，cfg 可能还没赋值，
    // 从它身上取 apis 会抛 "Cannot read properties of undefined"，
    // 整个设置面板就崩了（表现为打开设置什么都没反应）。
    $: canThink = supportsThinking(currentModel($settings));

    /** 哪张卡片是展开的；null 表示全部收起 */
    let openId = "";
    /** 每张卡片的测试/拉取状态，用 id 分开存，避免互相串 */
    let testing: Record<string, boolean> = {};
    let testResult: Record<string, string> = {};
    let pulling: Record<string, boolean> = {};
    let newModelText: Record<string, string> = {};
    let confirmDropApiId = "";
    let confirmClearMap: Record<string, { drop: number; tail: string }> = {};

    /** 当前选中的模型名；入参给 store 值，别读可能还没就绪的 cfg */
    function currentModel(s = $settings): string {
        const list = Array.isArray(s?.apis) ? s.apis : [];
        const a = list.find((x) => x.id === s.activeApiId) || list[0];
        return a?.model || "";
    }

    /**
     * 改某一套 API 的字段。
     *
     * 必须基于 store 里的最新值来改，不能用渲染用的 cfg 快照：
     * cfg 要等下一帧才更新，连续输入（比如地址框里快速打字）时
     * 后一次会用旧的列表覆盖前一次，表现成「打字丢字符」。
     */
    function patchApi(id: string, patch: Partial<ApiConfig>) {
        updateSettingsWith(
            (s) => {
                if (!s.apis.some((a) => a.id === id)) return s;
                const apis = s.apis.map((a) => (a.id === id ? { ...a, ...patch } : a));
                return { ...s, apis };
            },
            (s) => persist(s)
        );
    }

    /** 在 store 最新值上改某一个 API，避免并发输入时互相覆盖 */
    function updateApiWith(id: string, fn: (api: ApiConfig, all: ApiConfig[]) => Partial<ApiConfig> | null) {
        updateSettingsWith(
            (s) => {
                const target = s.apis.find((a) => a.id === id);
                if (!target) return s;
                const patch = fn(target, s.apis);
                if (!patch) return s;
                const apis = s.apis.map((a) => (a.id === id ? { ...a, ...patch } : a));
                return { ...s, apis };
            },
            (s) => persist(s)
        );
    }

    function addApi() {
        const api = createApi({ name: "新 API " + ($settings.apis.length + 1) });
        updateSettingsWith((s) => ({ ...s, apis: [...s.apis, api] }), (s) => persist(s));
        openId = api.id;
    }

    function removeApi(id: string) {
        const latest = $settings;
        if (latest.apis.length <= 1) {
            confirmDropApiId = "";
            testResult = { ...testResult, [id]: "至少要留一套 API，不能全删" };
            return;
        }
        if (confirmDropApiId !== id) {
            confirmDropApiId = id;
            return;
        }
        confirmDropApiId = "";
        const next = latest.apis.filter((a) => a.id !== id);
        const activeApiId = latest.activeApiId === id ? next[0].id : latest.activeApiId;
        updateSettingsWith((s) => ({ ...s, apis: next, activeApiId }), (s) => persist(s));
    }

    function useApi(id: string) {
        updateSettingsWith((s) => ({ ...s, activeApiId: id }), (s) => persist(s));
    }

    /** 把输入框里的名字加进这套 API 的模型清单 */
    function addModel(id: string) {
        const text = (newModelText[id] || "").trim();
        if (!text) return;
        newModelText = { ...newModelText, [id]: "" };
        updateApiWith(id, (api) => {
            if (api.models.includes(text)) return null;
            return {
                models: [...api.models, text],
                // 这套 API 还没有选中模型时，顺手选上
                model: api.model || text,
            };
        });
        testResult = { ...testResult, [id]: addModelHint(text) };
    }

    /** 手动添加也能标出用途，加完给一句人话 */
    function addModelHint(text: string): string {
        if (isImageModelOf(text, manualImage)) return `已加入画图模型：${text}。在面板里选它就会进生图模式。`;
        if (!isChatModelOf(text, manualImage)) return `已加入：${text}。注意这个名字看起来不能聊天，也不能生图。`;
        return `已加入聊天模型：${text}`;
    }

    /** 手动标成"这是画图模型"的名单。名字判断一定会漏，这是兜底 */
    $: manualImage = Array.isArray($settings?.imageModels) ? $settings.imageModels : [];

    /** 把某个模型标记/取消标记成画图模型 */
    function toggleManualImage(apiId: string, name: string) {
        const on = manualImage.includes(name);
        updateSettingsWith(
            (s) => {
                const list = (Array.isArray(s.imageModels) ? s.imageModels : []).filter((m) => m !== name);
                if (!on) list.push(name);
                return { ...s, imageModels: list };
            },
            (s) => persist(s)
        );
        testResult = {
            ...testResult,
            [apiId]: on
                ? `已取消标记「${name}」`
                : `已把「${name}」标成画图模型。回到面板点「🎨 生图」就能用它。`,
        };
    }

    /** 这个名字（综合手动标记）是不是画图模型 */
    function isImg(m: string): boolean {
        return isImageModelOf(m, manualImage);
    }
    /** 这个名字（综合手动标记）能不能聊天 */
    function isChat(m: string): boolean {
        return isChatModelOf(m, manualImage);
    }

    /** 勾选/取消一个模型（多选，出现在顶栏的切换列表里） */
    function pickToggle(apiId: string, name: string) {
        updateSettingsWith(
            (st) => {
                const target = st.apis.find((a) => a.id === apiId);
                if (!target) return st;
                const next = togglePick(target, name);
                if (next === target) {
                    testResult = { ...testResult, [apiId]: `「${name}」正在用，不能取消勾选。先切到别的模型。` };
                    return st;
                }
                const apis = st.apis.map((a) => (a.id === apiId ? next : a));
                return { ...st, apis };
            },
            (x) => persist(x)
        );
    }

    /** 删模型后该留哪个当当前模型：能聊天的最合适，其次画图的，一个都没有就留空 */
    function fallbackModel(models: string[]): string {
        const usable = models.find((m) => isChatModelOf(m, manualImage));
        if (usable) return usable;
        const drawable = models.find((m) => isImageModelOf(m, manualImage));
        if (drawable) return drawable;
        return models[0] || "";
    }

    /** 卡片里的模型按用途分成三组，界面上一眼能分清 */
    function chatModelsOf(api: ApiConfig): string[] {
        return (api?.models || []).filter((m) => isChat(m));
    }
    function imageModelsOf(api: ApiConfig): string[] {
        return (api?.models || []).filter((m) => isImg(m));
    }
    function deadModelsOf(api: ApiConfig): string[] {
        return (api?.models || []).filter((m) => !isChat(m) && !isImg(m));
    }

    function removeModel(id: string, model: string) {
        updateApiWith(id, (api) => {
            const models = api.models.filter((m) => m !== model);
            // 删掉的正好是当前模型：退回下一个能聊天的，别留不存在的名字、
            // 也别退回 embedding 那种一发就 400 的
            return { models, model: models.includes(api.model) ? api.model : fallbackModel(models) };
        });
    }

    /**
     * 点模型名 = 设为当前，并且把「当前用哪套 API」也一起切过去。
     *
     * 以前只改了 model 字段，activeApiId 没动：在 B 卡片点模型，
     * 顶栏还显示 A 的模型，发出去的还是 A 的模型，用户看到的就是「点了没反应」。
     *
     * 另外：点到能聊天的模型时，顺手记一笔「上次用的聊天模型」，
     * 之后切到画图模型了，「优化提示词」还能找回它。
     */
    function pickModel(id: string, model: string) {
        const chatty = isChatModelOf(model, manualImage);
        const drawy = isImageModelOf(model, manualImage);
        updateSettingsWith(
            (s) => {
                if (!s.apis.some((a) => a.id === id)) return s;
                const apis = s.apis.map((a) => (a.id === id ? { ...a, model } : a));
                const next: any = { ...s, apis, activeApiId: id };
                if (chatty) next.lastChatModel = packModelRef(id, model);
                return next;
            },
            (s) => persist(s)
        );
        testResult = {
            ...testResult,
            [id]: busy
                ? `已切到 ${model}。这一轮已经发出去了，下一轮生效。`
                : drawy
                ? `已切到 ${model}。这是画图模型，在面板里会进入生图模式。`
                : `已切到 ${model}。点「测试这个 API」可以验证它能不能用。`,
        };
    }

    function clearModelsPlan(
        id: string
    ):
        | { error: string }
        | { api: ApiConfig | undefined; all: string[]; pickedList: string[]; keepSet: Set<string>; drop: number; tail: string } {
        const api = $settings.apis.find((a) => a.id === id);
        const all = api?.models || [];
        if (!all.length) return { error: "这套 API 本来就没有模型" };

        // 勾选的（老对象没有 picked 时按"全选"处理，此时没有可清除的）
        const pickedList = Array.isArray(api?.picked) ? api.picked : all;
        const keepSet = new Set<string>([
            ...pickedList,
            ...all.filter((m) => isImageModelOf(m, manualImage)),
        ]);
        if (api?.model) keepSet.add(api.model);

        const drop = all.length - keepSet.size;
        if (drop <= 0) {
            return { error: "所有模型都被勾选/在用/是画图模型，没有可清除的" };
        }

        const keptPicked = pickedList.filter((m) => all.includes(m)).length;
        const keptImage = all.filter((m) => isImageModelOf(m, manualImage) && !pickedList.includes(m)).length;
        const parts: string[] = [];
        if (keptPicked) parts.push(`勾选的 ${keptPicked} 个`);
        if (keptImage) parts.push(`画图模型 ${keptImage} 个`);
        const tail = parts.length ? `（保留：${parts.join("、")}）` : "";

        return { api, all, pickedList, keepSet, drop, tail };
    }

    function clearModels(id: string) {
        const plan = clearModelsPlan(id);
        if ("error" in plan) {
            const next = { ...confirmClearMap };
            delete next[id];
            confirmClearMap = next;
            testResult = { ...testResult, [id]: plan.error };
            return;
        }
        confirmClearMap = { ...confirmClearMap, [id]: { drop: plan.drop, tail: plan.tail } };
    }

    function cancelClearModels(id: string) {
        const next = { ...confirmClearMap };
        delete next[id];
        confirmClearMap = next;
    }

    function confirmClearModels(id: string) {
        cancelClearModels(id);
        const plan = clearModelsPlan(id);
        if ("error" in plan) {
            testResult = { ...testResult, [id]: plan.error };
            return;
        }
        const nextModels = plan.all.filter((m) => plan.keepSet.has(m));
        const nextPicked = plan.pickedList.filter((m) => nextModels.includes(m));
        updateApiWith(id, () => ({
            models: nextModels,
            picked: nextPicked,
            // 当前模型一定还在（上面已经加进 keepSet）
            model: plan.api?.model && nextModels.includes(plan.api.model) ? plan.api.model : nextModels[0] || "",
        }));
        testResult = { ...testResult, [id]: `已清除 ${plan.drop} 个没勾选的${plan.tail}` };
    }

    function patch(p: Partial<Settings>) {
        updateSettings(p, (s) => persist(s));
    }

    /**
     * 数字输入框的写入。
     *
     * 坑：用户把框里的数字全选删掉准备重打时，bind:value 会得到 null，
     * `+null` 变成 0 直接存盘 —— 于是 max_tokens 从 4096 变成 0，之后每次请求都 400。
     * 所以这里拦一道：值不合法就当作"用户还在编辑"，不覆盖已有设置。
     */
    function setNumber(key: keyof Settings, min: number, max: number, allowZero = false) {
        return () => {
            const v = $settings[key] as unknown as number;
            if (v === null || v === undefined || Number.isNaN(v)) return;
            const n = Math.round(Number(v) * 100) / 100;
            if (!Number.isFinite(n)) return;
            if (!allowZero && n === 0) return;
            patch({ [key]: Math.min(max, Math.max(min, n)) } as Partial<Settings>);
        };
    }

    /**
     * 从服务商拉模型清单。
     * 走和发消息同一条通道（桌面主进程 / 手机内核转发），手机上也能用。
     *
     * 只往清单里加，绝不自动选中：中转站的清单头一个常是 embedding，
     * 自动选上就会发一次必失败的请求，用户以为是「拉来的不能用」。
     *
     * 画图模型也会一起拉进来（以前是被当垃圾丢掉的），
     * 主人要拿它们生图，丢了等于生图功能没入口。
     */
    async function pullModels(api: ApiConfig) {
        if (pulling[api.id]) return;
        pulling = { ...pulling, [api.id]: true };
        testResult = { ...testResult, [api.id]: "正在拉取模型清单…" };
        try {
            const r = await fetchModels(api, fetchOnce as any);
            if (r.error) {
                testResult = { ...testResult, [api.id]: "拉取失败：" + r.error };
                return;
            }
            const incoming = [...r.models, ...r.imageModels];
            let added = 0;
            updateApiWith(api.id, (current) => {
                const merged = mergeModels(current.models, incoming);
                added = merged.length - current.models.length;
                // 一个模型都没有时才顺手选第一个能聊天的；已经选过就不动它
                const model = current.model || fallbackModel(r.models.length ? r.models : incoming);
                return { models: merged, model };
            });
            const skippedNote = r.skipped ? `，另有 ${r.skipped} 个不能用的已跳过` : "";
            const imageNote = r.imageModels.length ? `，其中 ${r.imageModels.length} 个是画图模型` : "";
            const nextNote = added
                ? "。点模型名选用，再点「测试这个 API」验证"
                : "。这些之前都拉过了，点模型名选用";
            testResult = {
                ...testResult,
                [api.id]: `拉到 ${incoming.length} 个模型（新增 ${added} 个）${imageNote}${skippedNote}${nextNote}`,
            };
        } finally {
            pulling = { ...pulling, [api.id]: false };
        }
    }

    /** 测试这一套能不能通：用它的第一个模型发一句「回两个字」 */
    async function testConn(api: ApiConfig) {
        if (testing[api.id]) return;
        testing = { ...testing, [api.id]: true };
        testResult = { ...testResult, [api.id]: "正在测试…" };

        if (!api.baseURL.trim()) {
            testing = { ...testing, [api.id]: false };
            testResult = { ...testResult, [api.id]: "先填接口地址" };
            return;
        }
        const model = api.model || api.models[0] || "";
        if (!model) {
            testing = { ...testing, [api.id]: false };
            testResult = { ...testResult, [api.id]: "先加一个模型名" };
            return;
        }

        let text = "";
        let done = false;
        let timer: any = null;
        let handle: { abort: () => void } | null = null;
        const settle = (msg: string) => {
            if (done) return;
            done = true;
            if (timer) clearTimeout(timer);
            testing = { ...testing, [api.id]: false };
            testResult = { ...testResult, [api.id]: msg };
        };

        const parser = new ProviderParser(
            api.protocol,
            (t) => (text += t),
            () => {}
        );

        // 全局偏好（温度/上限/思考）跟当前设置走，只是把模型换成这套 API 的
        const runCfg = { ...$settings, ...api, model };

        handle = streamChat(
            {
                url: endpointFor(api.protocol, api.baseURL, model),
                headers: headersFor(api.protocol, api),
                body: JSON.stringify(
                    bodyFor(api.protocol, { ...runCfg, maxTokens: 256 }, [
                        { role: "user", content: "回复两个字：收到" },
                    ])
                ),
            },
            {
                onDelta: (chunk) => {
                    try {
                        parser.push(chunk);
                    } catch (e: any) {
                        settle("失败：" + (e?.message || e));
                    }
                },
                onEnd: (err) => {
                    if (err) return settle("失败：" + err);
                    try {
                        parser.end();
                    } catch (e: any) {
                        return settle("失败：" + (e?.message || e));
                    }
                    settle(text ? "通了，模型回了：" + text.trim().slice(0, 40) : "通了，但没返回内容，检查模型名");
                },
            }
        );

        // 兜底：30 秒还没结果就报超时，同时真正掐断底层请求
        timer = setTimeout(() => {
            if (done) return;
            try {
                handle?.abort();
            } catch {}
            settle("失败：30 秒内没有响应，检查地址是否可达");
        }, 30000);
    }
</script>

<div class="panel">
    <div class="head">
        <span>API 与模型</span>
        <button class="add-api" on:click={addApi}>+ 添加 API</button>
    </div>
    <small class="hint">写 2–3 套常用的就行。面板顶栏的模型名可以直接切，不用每次进来改。</small>

    {#each cfg.apis as api (api.id)}
        <div class="api-card" class:active={api.id === cfg.activeApiId}>
            <div class="card-top">
                <span class="dot" class:ok={api.id === cfg.activeApiId}></span>
                <input
                    class="card-name"
                    value={api.name}
                    placeholder="给这套起个名，比如中转站A"
                    on:input={(e) => patchApi(api.id, { name: e.currentTarget.value })}
                />
                {#if api.id === cfg.activeApiId}
                    <span class="tag">当前使用</span>
                {:else}
                    <button class="card-btn" on:click={() => useApi(api.id)}>设为当前</button>
                {/if}
                {#if confirmDropApiId === api.id}
                    <button class="card-del confirm" on:click={() => removeApi(api.id)}>确认删</button>
                    <button class="card-btn" on:click={() => (confirmDropApiId = "")}>取消</button>
                {:else}
                    <button class="card-del" on:click={() => removeApi(api.id)} title="删除这套 API">删除</button>
                {/if}
            </div>

            {#if openId === api.id}
                <div class="seg">
                    {#each PROTOCOLS as p}
                        <button
                            class:active={api.protocol === p.value}
                            on:click={() => patchApi(api.id, { protocol: p.value })}
                        >{p.label}</button>
                    {/each}
                </div>
                <small class="seg-hint">{PROTOCOLS.find((p) => p.value === api.protocol)?.hint}</small>

                <label class="f">
                    <span>接口地址</span>
                    <input
                        value={api.baseURL}
                        placeholder="http://192.168.1.8:17864/v1"
                        on:input={(e) => patchApi(api.id, { baseURL: e.currentTarget.value })}
                    />
                </label>

                <label class="f">
                    <span>API Key</span>
                    <input
                        type="password"
                        value={api.apiKey}
                        placeholder="ck_..."
                        on:input={(e) => patchApi(api.id, { apiKey: e.currentTarget.value })}
                    />
                </label>

                <div class="f">
                    <div class="model-head">
                        <span>这个 API 的模型（{api.models.length}）</span>
                        {#if api.models.length > 1}
                            <button class="clear-all" on:click={() => clearModels(api.id)} title="清掉没选中的模型，只留当前选中的那个">
                                清除其他模型
                            </button>
                        {/if}
                    </div>
                    {#if confirmClearMap[api.id]}
                        <div class="confirm-bar">
                            <span>清除 {confirmClearMap[api.id].drop} 个没勾选的模型{confirmClearMap[api.id].tail}？</span>
                            <button class="confirm-yes" on:click={() => confirmClearModels(api.id)}>确认清除</button>
                            <button class="confirm-no" on:click={() => cancelClearModels(api.id)}>取消</button>
                        </div>
                    {/if}
                    {#if chatModelsOf(api).length}
                        <div class="group-label">聊天模型 <em>（优化提示词也用这一组）</em></div>
                        <div class="model-list">
                            {#each chatModelsOf(api) as m}
                                <span class="model-chip" class:active={api.model === m} class:unpicked={!isPicked(api, m)}>
                                    <button
                                        class="chip-pick"
                                        class:on={isPicked(api, m)}
                                        on:click={() => pickToggle(api.id, m)}
                                        title={isPicked(api, m) ? "已勾选：会出现在顶栏的切换列表里。点一下取消" : "点一下勾选，它就会出现在顶栏的切换列表里"}
                                    >{isPicked(api, m) ? "✓" : ""}</button>
                                    <button
                                        class="chip-name"
                                        on:click={() => pickModel(api.id, m)}
                                        title="点一下，切换到这个模型"
                                    >{m}</button>
                                    <button
                                        class="chip-mark"
                                        on:click={() => toggleManualImage(api.id, m)}
                                        title={manualImage.includes(m) ? "取消「画图」标记，改回当聊天模型" : "它其实是画图模型？点这里标记"}
                                    >{manualImage.includes(m) ? "✓画图" : "标为画图"}</button>
                                    <button class="chip-x" on:click={() => removeModel(api.id, m)} title="删掉这个模型">×</button>
                                </span>
                            {/each}
                        </div>
                    {/if}
                    {#if imageModelsOf(api).length}
                        <div class="group-label image">画图模型 <em>（在面板里选它就会切到生图模式）</em></div>
                        <div class="model-list">
                            {#each imageModelsOf(api) as m}
                                <span class="model-chip image" class:active={api.model === m} class:unpicked={!isPicked(api, m)}>
                                    <button
                                        class="chip-pick"
                                        class:on={isPicked(api, m)}
                                        on:click={() => pickToggle(api.id, m)}
                                        title={isPicked(api, m) ? "已勾选：会出现在顶栏的切换列表里。点一下取消" : "点一下勾选，它就会出现在顶栏的切换列表里"}
                                    >{isPicked(api, m) ? "✓" : ""}</button>
                                    <button
                                        class="chip-name"
                                        on:click={() => pickModel(api.id, m)}
                                        title="点一下，切换到这个画图模型"
                                    >{m}</button>
                                    <button
                                        class="chip-mark"
                                        on:click={() => toggleManualImage(api.id, m)}
                                        title={manualImage.includes(m) ? "取消「画图」标记" : "它本来就是画图模型（名字认出来的），也能手动标记"}
                                    >{manualImage.includes(m) ? "✓画图" : "画图"}</button>
                                    <button class="chip-x" on:click={() => removeModel(api.id, m)} title="删掉这个模型">×</button>
                                </span>
                            {/each}
                        </div>
                    {/if}
                    {#if deadModelsOf(api).length}
                        <div class="group-label dead">用不了的模型 <em>（嵌入、语音这类，选了一发就报错）</em></div>
                        <div class="model-list">
                            {#each deadModelsOf(api) as m}
                                <span class="model-chip bad" class:active={api.model === m}>
                                    <button
                                        class="chip-pick"
                                        class:on={isPicked(api, m)}
                                        on:click={() => pickToggle(api.id, m)}
                                        title="勾选后也会出现在顶栏"
                                    >{isPicked(api, m) ? "✓" : ""}</button>
                                    <button
                                        class="chip-name"
                                        on:click={() => pickModel(api.id, m)}
                                        title="这类模型不能聊天，也不能生图"
                                    >{m}</button>
                                    <button
                                        class="chip-mark"
                                        on:click={() => toggleManualImage(api.id, m)}
                                        title="名字没认出来但它其实是画图模型？点这里手动标记"
                                    >标为画图</button>
                                    <button class="chip-x" on:click={() => removeModel(api.id, m)} title="删掉这个模型">×</button>
                                </span>
                            {/each}
                        </div>
                    {/if}
                    {#if api.models.length === 0}
                        <div class="model-list"><span class="none">还没有模型</span></div>
                    {/if}
                    <div class="model-add">
                        <input
                            value={newModelText[api.id] || ""}
                            placeholder="输入模型名，例如 glm-5.3 或 gpt-image-1"
                            on:input={(e) => (newModelText = { ...newModelText, [api.id]: e.currentTarget.value })}
                            on:keydown={(e) => { if (e.key === "Enter") { e.preventDefault(); addModel(api.id); } }}
                        />
                        <button on:click={() => addModel(api.id)}>添加</button>
                        <button class="pull" on:click={() => pullModels(api)} disabled={pulling[api.id]}>
                            {pulling[api.id] ? "拉取中…" : "从接口拉取"}
                        </button>
                    </div>
                    <small>
                        <b>勾选框 = 这个模型要不要出现在顶栏的切换列表里。</b>
                        可以勾多个，勾几个顶栏就显示几个；没勾的名字会变淡。
                        点模型名 = 立刻切到它（正在用的那个不能取消勾选）。
                        × 删掉单个；「清除其他模型」只清没在用的。
                        聊天模型和画图模型可以放在同一张卡里，它们共用地址和密钥。
                        灰底的是嵌入/语音模型，聊不了天也画不了图。
                    </small>
                </div>

                <div class="card-foot">
                    <button class="test" on:click={() => testConn(api)} disabled={testing[api.id]}>
                        {testing[api.id] ? "测试中…" : "测试这个 API"}
                    </button>
                    <span class="grow"></span>
                    <button class="collapse" on:click={() => (openId = "")}>收起</button>
                </div>
                {#if testResult[api.id]}
                    <div class="res">{testResult[api.id]}</div>
                {/if}
            {:else}
                <button class="collapsed" on:click={() => (openId = api.id)}>
                    <span class="collapsed-line">
                        {PROTOCOLS.find((p) => p.value === api.protocol)?.label}
                        · {api.baseURL || "未填地址"}
                        · {api.models.length ? api.models.join("、") : "还没模型"}
                    </span>
                    <span class="edit-hint">展开编辑</span>
                </button>
                {#if testResult[api.id]}
                    <div class="res">{testResult[api.id]}</div>
                {/if}
            {/if}
        </div>
    {/each}

    <div class="sep"></div>

    <div class="field">
        <span>思考强度</span>
        <div class="grid3">
            {#each THINKING_LEVELS as lv}
                <button class:active={cfg.thinking === lv} on:click={() => patch({ thinking: lv })}>
                    {LEVEL_LABEL[lv]}
                </button>
            {/each}
        </div>
        {#if canThink}
            <small>
                档位会自动翻译成当前模型认识的写法。glm 只有 低/高/最高，
                所以「最小」和「低」都发 low，「中」会升到 high。
            </small>
        {:else}
            <small>当前模型名看起来不支持思考，这个设置不会生效。</small>
        {/if}
    </div>

    <label class="field checkbox">
        <input type="checkbox" bind:checked={$settings.showReasoning} on:change={() => patch({ showReasoning: $settings.showReasoning })} />
        <span>显示思考过程</span>
    </label>

    <div class="grid2">
        <label class="field">
            <span>温度</span>
            <input type="number" min="0" max="2" step="0.1" bind:value={$settings.temperature} on:input={setNumber("temperature", 0, 2)} />
        </label>
        <label class="field">
            <span>最大输出 tokens</span>
            <input type="number" min="256" max="64000" step="256" bind:value={$settings.maxTokens} on:input={setNumber("maxTokens", 256, 64000)} />
        </label>
    </div>

    <label class="field">
        <span>带几条历史</span>
        <input type="number" min="1" max="50" bind:value={$settings.contextMessages} on:input={setNumber("contextMessages", 1, 50)} />
        <small>数值越大越费钱，10 条够日常用。</small>
    </label>

    <label class="field">
        <span>上下文上限（token）</span>
        <input type="number" min="0" step="1000" bind:value={$settings.contextLimit} on:input={setNumber("contextLimit", 0, 4000000, true)} />
        <small>
            超过这个数的大部分时会提醒你先清空对话。填 0 表示不检查。<br />
            glm-5.3 这类长上下文模型填 200000 就行，不用太精确。
        </small>
    </label>

    <div class="sep"></div>
    <div class="hint">改动会自动保存。地址和密钥存在本机的插件数据目录里，不加密，注意别公开截图。</div>
</div>

<style>
    .panel {
        padding: 12px;
        font-size: 13px;
        color: var(--b3-theme-on-background);
        box-sizing: border-box;
    }
    .head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        font-size: 13px;
        font-weight: 600;
    }
    .add-api {
        border: 1px dashed var(--b3-border-color);
        background: none;
        border-radius: 6px;
        padding: 4px 10px;
        font-size: 12px;
        color: var(--b3-theme-primary);
        cursor: pointer;
        font-family: inherit;
    }
    .add-api:hover {
        border-color: var(--b3-theme-primary);
        background: var(--b3-theme-surface);
    }
    .hint {
        display: block;
        margin: 6px 0 12px;
        font-size: 11px;
        line-height: 1.6;
        color: var(--b3-theme-on-surface);
        opacity: 0.75;
    }

    /* ---------- API 卡片 ---------- */
    .api-card {
        border: 1px solid var(--b3-border-color);
        border-radius: 8px;
        padding: 10px;
        margin-bottom: 10px;
        background: var(--b3-theme-surface);
    }
    .api-card.active {
        border-color: var(--b3-theme-primary);
        background: var(--b3-theme-background);
    }
    .card-top {
        display: flex;
        align-items: center;
        gap: 7px;
    }
    .dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: var(--b3-border-color);
        flex-shrink: 0;
    }
    .dot.ok {
        background: #34a853;
    }
    .card-name {
        flex: 1;
        border: none;
        background: none;
        font-size: 13px;
        font-weight: 600;
        padding: 2px 4px;
        border-radius: 4px;
        min-width: 0;
        color: var(--b3-theme-on-background);
        font-family: inherit;
    }
    .card-name:hover,
    .card-name:focus {
        background: var(--b3-theme-background);
        outline: none;
    }
    .tag {
        font-size: 10px;
        background: var(--b3-theme-primary);
        color: var(--b3-theme-on-primary);
        border-radius: 8px;
        padding: 1px 7px;
        flex-shrink: 0;
    }
    .card-btn {
        border: 1px solid var(--b3-border-color);
        background: none;
        border-radius: 5px;
        font-size: 11px;
        padding: 2px 7px;
        cursor: pointer;
        color: var(--b3-theme-on-surface);
        font-family: inherit;
        flex-shrink: 0;
    }
    .card-btn:hover {
        border-color: var(--b3-theme-primary);
        color: var(--b3-theme-primary);
    }
    .card-del {
        border: none;
        background: none;
        color: var(--b3-theme-on-surface);
        opacity: 0.6;
        font-size: 11px;
        cursor: pointer;
        font-family: inherit;
        flex-shrink: 0;
    }
    .card-del:hover,
    .card-del.confirm {
        color: var(--b3-theme-error);
        opacity: 1;
    }
    .confirm-bar {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 6px;
        padding: 5px 8px;
        margin-bottom: 6px;
        border: 1px solid var(--b3-theme-error);
        border-radius: 5px;
        font-size: 11px;
        line-height: 1.5;
    }
    .confirm-bar span {
        flex: 1;
        min-width: 120px;
    }
    .confirm-yes,
    .confirm-no {
        border: 1px solid var(--b3-border-color);
        background: none;
        border-radius: 4px;
        padding: 2px 8px;
        font-size: 11px;
        cursor: pointer;
        font-family: inherit;
    }
    .confirm-yes {
        border-color: var(--b3-theme-error);
        background: var(--b3-theme-error);
        color: #fff;
    }
    .collapsed {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        border: none;
        background: none;
        text-align: left;
        padding: 6px 0 0 16px;
        cursor: pointer;
        font-family: inherit;
    }
    .collapsed-line {
        flex: 1;
        font-size: 11px;
        color: var(--b3-theme-on-surface);
        opacity: 0.8;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .edit-hint {
        font-size: 10px;
        color: var(--b3-theme-primary);
        flex-shrink: 0;
    }

    .seg {
        display: flex;
        gap: 4px;
        margin: 9px 0 4px;
    }
    .seg button {
        flex: 1;
        padding: 5px 0;
        border: 1px solid var(--b3-border-color);
        border-radius: 5px;
        background: transparent;
        color: var(--b3-theme-on-background);
        cursor: pointer;
        font-size: 11.5px;
        font-family: inherit;
    }
    .seg button.active {
        background: var(--b3-theme-primary);
        border-color: var(--b3-theme-primary);
        color: var(--b3-theme-on-primary);
    }
    .seg-hint {
        display: block;
        margin-bottom: 8px;
        font-size: 10.5px;
        color: var(--b3-theme-on-surface);
        opacity: 0.7;
    }

    .f {
        display: block;
        margin-bottom: 9px;
    }
    .f > span {
        display: block;
        margin-bottom: 3px;
        color: var(--b3-theme-on-surface);
        font-size: 11px;
    }
    .f small {
        display: block;
        margin-top: 4px;
        color: var(--b3-theme-on-surface);
        opacity: 0.7;
        font-size: 10.5px;
        line-height: 1.5;
    }
    input {
        width: 100%;
        box-sizing: border-box;
        padding: 6px 8px;
        border: 1px solid var(--b3-border-color);
        border-radius: var(--b3-border-radius);
        background: var(--b3-theme-background);
        color: var(--b3-theme-on-background);
        font-size: 12px;
        font-family: inherit;
    }
    input:focus {
        outline: none;
        border-color: var(--b3-theme-primary);
    }
    .card-top .card-name {
        padding: 2px 4px;
    }

    .model-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 3px;
        color: var(--b3-theme-on-surface);
        font-size: 11px;
    }
    /* 模型分组小标题：聊天 / 画图 / 用不了 */
    .group-label {
        font-size: 10px;
        color: var(--b3-theme-on-surface);
        opacity: 0.75;
        margin: 6px 0 3px;
    }
    .group-label em {
        font-style: normal;
        opacity: 0.8;
    }
    .group-label.image {
        color: #b87413;
    }
    .group-label.dead {
        opacity: 0.55;
    }
    .clear-all {
        border: 1px solid var(--b3-border-color);
        background: none;
        border-radius: 5px;
        padding: 1px 7px;
        font-size: 10.5px;
        color: var(--b3-theme-on-surface);
        cursor: pointer;
        font-family: inherit;
        flex-shrink: 0;
    }
    .clear-all:hover {
        border-color: var(--b3-theme-error);
        color: var(--b3-theme-error);
    }
    .model-list {
        display: flex;
        flex-wrap: wrap;
        gap: 5px;
        margin-bottom: 6px;
    }
    .model-chip {
        display: inline-flex;
        align-items: center;
        gap: 2px;
        border: 1px solid var(--b3-border-color);
        background: var(--b3-theme-background);
        border-radius: 11px;
        padding: 1px 3px 1px 4px;
        font-size: 11px;
    }
    .model-chip.active {
        border-color: var(--b3-theme-primary);
        background: var(--b3-theme-surface);
    }
    /* 勾选框：决定这个模型会不会出现在顶栏的切换列表里 */
    .chip-pick {
        width: 13px;
        height: 13px;
        flex-shrink: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border: 1px solid var(--b3-border-color);
        background: var(--b3-theme-background);
        border-radius: 3px;
        font-size: 9px;
        line-height: 1;
        color: transparent;
        cursor: pointer;
        padding: 0;
        font-family: inherit;
    }
    .chip-pick:hover {
        border-color: var(--b3-theme-primary);
    }
    .chip-pick.on {
        background: var(--b3-theme-primary);
        border-color: var(--b3-theme-primary);
        color: var(--b3-theme-on-primary);
    }
    /* 没勾选的模型名字淡一点，一眼看出"它不在顶栏里" */
    .model-chip.unpicked .chip-name {
        opacity: 0.55;
    }

    /* 手动标记按钮：小一号，放在模型名和 × 之间 */
    .chip-mark {
        border: none;
        background: none;
        color: var(--b3-theme-on-surface);
        font-size: 9.5px;
        cursor: pointer;
        padding: 0 3px;
        font-family: inherit;
        opacity: 0.6;
        white-space: nowrap;
    }
    .chip-mark:hover {
        color: #b87413;
        opacity: 1;
    }
    .model-chip.image .chip-mark {
        opacity: 0.9;
    }
    /* 画图模型：橙色底，和聊天模型一眼分得开 */
    .model-chip.image {
        border-color: #d9a25c;
        background: rgba(224, 139, 45, 0.12);
    }
    .model-chip.image.active {
        border-color: #c8760a;
        background: #c8760a;
    }
    .model-chip.image.active .chip-name {
        color: #fff;
    }
    /* 看起来不能聊天的名字给个灰底，点之前就能看出不对劲 */
    .model-chip.bad {
        border-style: dashed;
        background: var(--b3-theme-surface);
        opacity: 0.72;
    }
    .chip-name {
        border: none;
        background: none;
        color: inherit;
        font-size: 11px;
        cursor: pointer;
        padding: 0 4px;
        font-family: inherit;
        max-width: 160px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .model-chip.active .chip-name {
        color: var(--b3-theme-primary);
        font-weight: 600;
    }
    .chip-x {
        border: none;
        background: none;
        cursor: pointer;
        color: var(--b3-theme-on-surface);
        opacity: 0.55;
        font-size: 12px;
        line-height: 1;
        padding: 0 2px;
        font-family: inherit;
    }
    .chip-x:hover {
        color: var(--b3-theme-error);
        opacity: 1;
    }
    .none {
        font-size: 11px;
        color: var(--b3-theme-on-surface);
        opacity: 0.6;
    }
    .model-add {
        display: flex;
        gap: 5px;
    }
    .model-add input {
        flex: 1;
        min-width: 0;
    }
    .model-add button {
        flex-shrink: 0;
        border: 1px solid var(--b3-border-color);
        background: none;
        border-radius: 5px;
        padding: 5px 9px;
        font-size: 11px;
        cursor: pointer;
        color: var(--b3-theme-on-background);
        font-family: inherit;
        white-space: nowrap;
    }
    .model-add button:hover {
        border-color: var(--b3-theme-primary);
        color: var(--b3-theme-primary);
    }
    .model-add .pull {
        color: var(--b3-theme-primary);
    }
    .model-add button:disabled {
        opacity: 0.5;
        cursor: default;
    }

    .card-foot {
        display: flex;
        align-items: center;
        gap: 8px;
        border-top: 1px solid var(--b3-border-color);
        padding-top: 8px;
        margin-top: 4px;
    }
    .card-foot .test {
        border: 1px solid var(--b3-theme-primary);
        background: none;
        color: var(--b3-theme-primary);
        border-radius: 5px;
        padding: 4px 10px;
        font-size: 11.5px;
        cursor: pointer;
        font-family: inherit;
    }
    .card-foot .test:disabled {
        opacity: 0.5;
        cursor: default;
    }
    .collapse {
        border: none;
        background: none;
        font-size: 11px;
        color: var(--b3-theme-on-surface);
        opacity: 0.7;
        cursor: pointer;
        font-family: inherit;
    }
    .res {
        margin-top: 6px;
        font-size: 11px;
        line-height: 1.6;
        color: var(--b3-theme-on-surface);
        word-break: break-all;
    }
    .grow {
        flex: 1;
    }

    /* ---------- 全局偏好 ---------- */
    .field {
        display: block;
        margin-bottom: 12px;
    }
    .field > span {
        display: block;
        margin-bottom: 4px;
        color: var(--b3-theme-on-surface);
        font-size: 12px;
    }
    .field small {
        display: block;
        margin-top: 4px;
        color: var(--b3-theme-on-surface);
        opacity: 0.75;
        font-size: 11px;
        line-height: 1.5;
    }
    .grid3 {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 4px;
    }
    .grid3 button {
        padding: 6px 0;
        border: 1px solid var(--b3-border-color);
        border-radius: var(--b3-border-radius);
        background: transparent;
        color: var(--b3-theme-on-background);
        cursor: pointer;
        font-size: 12px;
        font-family: inherit;
    }
    .grid3 button.active {
        background: var(--b3-theme-primary);
        border-color: var(--b3-theme-primary);
        color: var(--b3-theme-on-primary);
    }
    .grid2 {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 10px;
    }
    .checkbox {
        display: flex;
        align-items: center;
        gap: 8px;
    }
    .checkbox input {
        width: auto;
        margin: 0;
    }
    .checkbox span {
        margin: 0;
    }
    .sep {
        height: 1px;
        background: var(--b3-border-color);
        margin: 12px 0;
    }
</style>
