<script lang="ts">
    import { createServer, type McpServer, type McpServerType } from "../mcp-manager";
    import type { ServerState } from "../mcp-connect";

    export let servers: McpServer[];
    export let states: ServerState[];
    export let canLaunchProcess: boolean;
    export let onChange: (next: McpServer[]) => void;
    export let onTest: () => Promise<void>;

    const TYPES: { value: McpServerType; label: string; hint: string }[] = [
        { value: "http", label: "HTTP", hint: "现在的 MCP 服务器大多是这种，填一个网址" },
        { value: "sse", label: "SSE（旧版）", hint: "老式服务器用这个，也是填网址" },
        { value: "stdio", label: "本地命令", hint: "在你电脑上启动一个程序，仅桌面版可用" },
    ];

    let editingId: string | null = null;
    let draft: McpServer | null = null;
    let headerText = "";
    let argsText = "";
    let envText = "";
    let formError = "";
    let confirmDeleteId: string | null = null;
    let testing = false;

    function stateOf(id: string): ServerState | undefined {
        return states.find((s) => s.id === id);
    }

    /**
     * 解析参数：按空格分，但引号里的整体算一个。
     * 否则 `C:\Program Files\x.js` 会被拆坏。
     */
    function parseArgs(text: string): string[] {
        const out: string[] = [];
        const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) {
            out.push(m[1] ?? m[2] ?? m[3]);
        }
        return out;
    }

    function startNew(type: McpServerType = "http") {
        draft = createServer(
            { name: "", type, url: "", command: type === "stdio" ? "npx" : "", args: [] },
            () => "m" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
        );
        editingId = draft.id;
        headerText = "";
        argsText = "";
        envText = "";
        formError = "";
    }

    function startEdit(s: McpServer) {
        draft = { ...s };
        editingId = s.id;
        headerText = Object.entries(s.headers || {})
            .map(([k, v]) => k + ": " + v)
            .join("\n");
        // 带空格或引号的参数还原回双引号包裹，否则下次保存会被空格劈碎
        argsText = (s.args || [])
            .map((a) => (/[\s"']/.test(a) || a === "" ? `"${a.replace(/"/g, "")}"` : a))
            .join(" ");
        envText = Object.entries(s.env || {})
            .map(([k, v]) => k + "=" + v)
            .join("\n");
        formError = "";
    }

    function parseHeaders(text: string): Record<string, string> {
        const out: Record<string, string> = {};
        for (const line of text.split("\n")) {
            const t = line.trim();
            if (!t) continue;
            const at = t.indexOf(":");
            if (at <= 0) continue;
            out[t.slice(0, at).trim()] = t.slice(at + 1).trim();
        }
        return out;
    }

    function parseEnv(text: string): Record<string, string> {
        const out: Record<string, string> = {};
        for (const line of text.split("\n")) {
            const t = line.trim();
            if (!t) continue;
            const at = t.indexOf("=");
            if (at <= 0) continue;
            out[t.slice(0, at).trim()] = t.slice(at + 1).trim();
        }
        return out;
    }

    function save() {
        if (!draft) return;
        const name = draft.name.trim();
        if (!name) {
            formError = "给这个服务器起个名字";
            return;
        }
        if ((draft.type === "http" || draft.type === "sse") && !draft.url.trim()) {
            formError = "HTTP / SSE 类型要填地址";
            return;
        }
        if (draft.type === "stdio" && !draft.command.trim()) {
            formError = "本地命令类型要填启动命令";
            return;
        }

        formError = "";
        const final: McpServer = {
            ...draft,
            name,
            url: draft.url.trim(),
            command: draft.command.trim(),
            headers: parseHeaders(headerText),
            args: argsText.trim() ? parseArgs(argsText) : [],
            env: parseEnv(envText),
        };

        const exists = servers.some((s) => s.id === final.id);
        onChange(exists ? servers.map((s) => (s.id === final.id ? final : s)) : [...servers, final]);
        editingId = null;
        draft = null;
    }

    function cancelEdit() {
        editingId = null;
        draft = null;
        formError = "";
    }

    function toggle(s: McpServer) {
        onChange(servers.map((x) => (x.id === s.id ? { ...x, enabled: !x.enabled } : x)));
    }

    function doDelete() {
        if (!confirmDeleteId) return;
        onChange(servers.filter((s) => s.id !== confirmDeleteId));
        confirmDeleteId = null;
    }

    async function testAll() {
        testing = true;
        try {
            await onTest();
        } finally {
            testing = false;
        }
    }

    function statusDot(s: ServerState | undefined) {
        if (!s) return "○";
        if (s.status === "ready") return "●";
        if (s.status === "error") return "✕";
        if (s.status === "connecting") return "◌";
        return "○";
    }
</script>

<div class="panel">
    {#if editingId}
        <div class="row title-row">
            <strong>配置服务器</strong>
            <button class="link" on:click={cancelEdit}>取消</button>
        </div>
    {/if}

    {#if editingId && draft}
        <label class="field">
            <span>类型</span>
            <div class="seg">
                {#each TYPES as t}
                    <button
                        class:active={draft.type === t.value}
                        on:click={() => {
                            if (draft) draft.type = t.value;
                        }}
                        disabled={t.value === "stdio" && !canLaunchProcess}
                    >{t.label}</button>
                {/each}
            </div>
            <small>{TYPES.find((t) => t.value === draft?.type)?.hint}</small>
        </label>

        <label class="field">
            <span>名字（模型会用这个名字区分工具）</span>
            <input bind:value={draft.name} placeholder="比如：时间、搜索" />
        </label>

        {#if draft.type === "http" || draft.type === "sse"}
            <label class="field">
                <span>地址</span>
                <input bind:value={draft.url} placeholder="http://127.0.0.1:3000/mcp" />
            </label>
            <label class="field">
                <span>请求头（一行一个，格式 名称: 值）</span>
                <textarea bind:value={headerText} rows="3" placeholder="Authorization: Bearer xxx"></textarea>
            </label>
        {:else}
            <label class="field">
                <span>启动命令</span>
                <input bind:value={draft.command} placeholder="npx" />
            </label>
            <label class="field">
                <span>参数（用空格分开）</span>
                <input bind:value={argsText} placeholder="-y @modelcontextprotocol/server-time" />
            </label>
            <label class="field">
                <span>环境变量（一行一个，格式 名称=值）</span>
                <textarea bind:value={envText} rows="3" placeholder="API_KEY=xxx"></textarea>
            </label>
            {#if !canLaunchProcess}
                <div class="warn">当前环境不能启动本地进程，只能填 HTTP 或 SSE 地址。</div>
            {/if}
        {/if}

        {#if formError}
            <div class="warn">{formError}</div>
        {/if}
        <button class="primary" on:click={save}>保存</button>
    {:else}
        <div class="hint-box">
            插件自己不带任何 MCP 服务器。你需要自己找一个，把地址（或启动命令）粘进来。<br />
            连上后，它提供的工具会自动交给 AI 使用。
        </div>

        {#if servers.length === 0}
            <div class="empty">还没有服务器。点下面的按钮添加一个。</div>
        {/if}

        {#each servers as s}
            {@const st = states.find((x) => x.id === s.id)}
            <div class="item">
                <div class="item-head">
                    <span class="dot {st?.status || 'idle'}">{statusDot(st)}</span>
                    <span class="item-name">{s.name}</span>
                    <span class="item-type">{s.type}</span>
                </div>
                <div class="item-url">{s.type === "stdio" ? s.command + " " + s.args.join(" ") : s.url}</div>


                {#if st?.status === "ready" && st.tools.length}
                    <div class="tools">
                        工具：{st.tools.map((t) => t.name).join("、")}
                    </div>
                {:else if st?.status === "error"}
                    <div class="err">{st.error}</div>
                {/if}

                <div class="item-ops">
                    <button class="mini" on:click={() => toggle(s)}>{s.enabled ? "已启用" : "已停用"}</button>
                    <button class="mini" on:click={() => startEdit(s)}>改</button>
                    <button class="mini danger" on:click={() => (confirmDeleteId = s.id)}>删</button>
                </div>
            </div>
        {/each}

        <div class="op-row">
            <button class="primary" on:click={() => startNew("http")}>+ 添加 HTTP</button>
            {#if canLaunchProcess}
                <button class="secondary" on:click={() => startNew("stdio")}>+ 添加本地命令</button>
            {/if}
        </div>

        {#if servers.length}
            <button class="test" on:click={testAll} disabled={testing}>
                {testing ? "正在连接…" : "测试所有服务器"}
            </button>
        {/if}
    {/if}
</div>

{#if confirmDeleteId}
    <div class="mask">
        <div class="dialog">
            <p>确定删掉「{servers.find((s) => s.id === confirmDeleteId)?.name}」吗？</p>
            <div class="dialog-btns">
                <button class="link" on:click={() => (confirmDeleteId = null)}>取消</button>
                <button class="danger-btn" on:click={doDelete}>删除</button>
            </div>
        </div>
    </div>
{/if}

<style>
    .panel {
        padding: 12px;
        font-size: 13px;
        color: var(--b3-theme-on-background);
        box-sizing: border-box;
    }
    .row {
        display: flex;
        align-items: center;
        justify-content: space-between;
    }
    .title-row {
        margin-bottom: 12px;
    }
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
    input,
    textarea {
        width: 100%;
        box-sizing: border-box;
        padding: 6px 8px;
        border: 1px solid var(--b3-border-color);
        border-radius: var(--b3-border-radius);
        background: var(--b3-theme-background);
        color: var(--b3-theme-on-background);
        font-size: 13px;
        font-family: inherit;
        line-height: 1.6;
    }
    textarea {
        resize: vertical;
        font-family: monospace;
        font-size: 12px;
    }
    input:focus,
    textarea:focus {
        outline: none;
        border-color: var(--b3-theme-primary);
    }
    small {
        display: block;
        margin-top: 4px;
        color: var(--b3-theme-on-surface);
        opacity: 0.75;
        font-size: 11px;
        line-height: 1.5;
    }
    .seg {
        display: flex;
        gap: 4px;
    }
    .seg button {
        flex: 1;
        padding: 6px 0;
        border: 1px solid var(--b3-border-color);
        border-radius: var(--b3-border-radius);
        background: transparent;
        color: var(--b3-theme-on-background);
        cursor: pointer;
        font-size: 12px;
    }
    .seg button.active {
        background: var(--b3-theme-primary);
        border-color: var(--b3-theme-primary);
        color: var(--b3-theme-on-primary);
    }
    .seg button:disabled {
        opacity: 0.4;
        cursor: default;
    }
    .warn {
        font-size: 11px;
        line-height: 1.6;
        color: var(--b3-theme-error);
        margin-bottom: 10px;
    }
    .hint-box {
        font-size: 11px;
        line-height: 1.8;
        color: var(--b3-theme-on-surface);
        background: var(--b3-theme-surface);
        padding: 8px 10px;
        border-radius: var(--b3-border-radius);
        margin-bottom: 10px;
    }
    .empty {
        font-size: 12px;
        color: var(--b3-theme-on-surface);
        opacity: 0.7;
        margin-bottom: 10px;
    }
    .item {
        border: 1px solid var(--b3-border-color);
        border-radius: var(--b3-border-radius);
        padding: 8px 10px;
        margin-bottom: 6px;
    }
    .item-head {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-bottom: 3px;
    }
    .dot {
        font-size: 11px;
    }
    .dot.ready {
        color: var(--b3-theme-primary);
    }
    .dot.error {
        color: var(--b3-theme-error);
    }
    .item-name {
        font-size: 13px;
    }
    .item-type {
        font-size: 10px;
        opacity: 0.6;
        border: 1px solid var(--b3-border-color);
        border-radius: 8px;
        padding: 0 5px;
    }
    .item-url {
        font-size: 11px;
        color: var(--b3-theme-on-surface);
        opacity: 0.7;
        word-break: break-all;
        margin-bottom: 4px;
    }
    .tools {
        font-size: 11px;
        line-height: 1.6;
        color: var(--b3-theme-primary);
        margin-bottom: 6px;
    }
    .err {
        font-size: 11px;
        line-height: 1.6;
        color: var(--b3-theme-error);
        margin-bottom: 6px;
        word-break: break-all;
    }
    .item-ops {
        display: flex;
        gap: 4px;
    }
    .mini {
        padding: 2px 8px;
        border: 1px solid var(--b3-border-color);
        border-radius: var(--b3-border-radius);
        background: transparent;
        color: var(--b3-theme-on-surface);
        cursor: pointer;
        font-size: 11px;
    }
    .mini:hover {
        border-color: var(--b3-theme-primary);
        color: var(--b3-theme-primary);
    }
    .mini.danger:hover {
        border-color: var(--b3-theme-error);
        color: var(--b3-theme-error);
    }
    .op-row {
        display: flex;
        gap: 6px;
        margin-top: 8px;
    }
    button.primary,
    button.secondary,
    button.test {
        padding: 8px;
        border-radius: var(--b3-border-radius);
        cursor: pointer;
        font-size: 13px;
        border: none;
    }
    button.primary {
        flex: 1;
        background: var(--b3-theme-primary);
        color: var(--b3-theme-on-primary);
    }
    button.secondary {
        flex: 1;
        background: transparent;
        border: 1px solid var(--b3-border-color);
        color: var(--b3-theme-on-background);
    }
    button.test {
        width: 100%;
        margin-top: 8px;
        background: var(--b3-theme-surface);
        color: var(--b3-theme-on-background);
        border: 1px solid var(--b3-border-color);
    }
    button.test:disabled {
        opacity: 0.6;
        cursor: default;
    }
    button.link {
        border: none;
        background: none;
        color: var(--b3-theme-primary);
        cursor: pointer;
        font-size: 12px;
        padding: 0;
    }
    .mask {
        position: absolute;
        inset: 0;
        background: rgba(0, 0, 0, 0.35);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 10;
    }
    .dialog {
        background: var(--b3-theme-background);
        border-radius: var(--b3-border-radius);
        padding: 16px;
        max-width: 280px;
        font-size: 13px;
    }
    .dialog p {
        margin: 0 0 14px;
        line-height: 1.6;
    }
    .dialog-btns {
        display: flex;
        justify-content: flex-end;
        gap: 10px;
    }
    .danger-btn {
        padding: 5px 14px;
        border: none;
        border-radius: var(--b3-border-radius);
        background: var(--b3-theme-error);
        color: #fff;
        cursor: pointer;
        font-size: 12px;
    }
</style>
