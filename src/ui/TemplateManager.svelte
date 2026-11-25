<script lang="ts">
    import {
        createTemplate,
        addTemplate,
        updateTemplate,
        removeTemplate,
        moveTemplate,
        findTemplate,
        type PromptTemplate,
    } from "../templates";
    import { VARS } from "../template";

    export let templates: PromptTemplate[];
    export let onChange: (next: PromptTemplate[]) => void;

    let editingId: string | null = null;
    let editName = "";
    let editContent = "";
    let formError = "";
    let confirmDeleteId: string | null = null;

    /** 本地镜像。父组件回传 props 有延迟，直接依赖 props 会读到旧值 */
    let list: PromptTemplate[] = templates;
    $: list = templates;

    function commit(next: PromptTemplate[]) {
        list = next;
        onChange(next);
    }

    function startNew() {
        const t = createTemplate("新模板", "在这里写你的提示词。\n\n这是给 AI 的规则，每次对话都会带上它。");
        const next = addTemplate(list, t);
        commit(next);
        // 直接进编辑，必须是刚建好的那份，不能再去 props 里查
        editingId = t.id;
        editName = t.name;
        editContent = t.content;
        formError = "";
    }

    function startEdit(id: string) {
        const t = findTemplate(list, id);
        if (!t) return;
        editingId = id;
        editName = t.name;
        editContent = t.content;
        formError = "";
    }

    function saveEdit() {
        if (!editingId) return;
        const name = editName.trim();
        if (!name) {
            formError = "模板名不能空";
            return;
        }
        if (!editContent.trim()) {
            formError = "模板正文不能空";
            return;
        }
        formError = "";
        commit(updateTemplate(list, editingId, { name, content: editContent }));
        editingId = null;
    }

    function cancelEdit() {
        editingId = null;
        formError = "";
    }

    function askDelete(id: string) {
        confirmDeleteId = id;
    }

    function doDelete() {
        if (!confirmDeleteId) return;
        commit(removeTemplate(list, confirmDeleteId));
        confirmDeleteId = null;
    }

    function insertVar(v: string) {
        editContent += `{{${v}}}`;
    }

    function move(id: string, delta: number) {
        commit(moveTemplate(list, id, delta));
    }
</script>

<div class="panel">
    {#if editingId}
        <div class="row title-row">
            <strong>编辑模板</strong>
            <button class="link" on:click={cancelEdit}>取消</button>
        </div>
    {/if}

    {#if editingId}
        <label class="field">
            <span>名字</span>
            <input bind:value={editName} placeholder="比如：日记复盘" />
        </label>

        <label class="field">
            <span>提示词正文（会作为系统提示发给 AI）</span>
            <textarea bind:value={editContent} rows="14" placeholder="在这里写你要 AI 怎么做的规则"></textarea>
        </label>

        <div class="field">
            <span>插入变量</span>
            <div class="vars">
                {#each VARS as v}
                    <button class="var" on:click={() => insertVar(v)}>{{v}}</button>
                {/each}
            </div>
            <small>
                <code>&#123;&#123;date&#125;&#125;</code> <code>&#123;&#123;time&#125;&#125;</code> <code>&#123;&#123;weekday&#125;&#125;</code> 是当前日期时间。<br />
                <code>&#123;&#123;doc_title&#125;&#125;</code> 是当前文档标题。
            </small>
        </div>

        {#if formError}
            <div class="warn">{formError}</div>
        {/if}
        <button class="primary" on:click={saveEdit}>保存</button>
    {:else}
        <div class="hint-box">
            点一个模板套用规则，之后每次对话都会带上它。模板正文就是给 AI 的规则。
        </div>

        <div class="list">
            {#each list as t, i}
                <div class="item">
                    <div class="item-main">
                        <div class="item-name">{t.name}</div>
                        <div class="item-preview">{t.content.slice(0, 70)}{t.content.length > 70 ? "…" : ""}</div>
                    </div>
                    <div class="item-ops">
                        <button class="mini" on:click={() => move(t.id, -1)} disabled={i === 0} title="上移">↑</button>
                        <button class="mini" on:click={() => move(t.id, 1)} disabled={i === list.length - 1} title="下移">↓</button>
                        <button class="mini" on:click={() => startEdit(t.id)}>改</button>
                        <button class="mini danger" on:click={() => askDelete(t.id)}>删</button>
                    </div>
                </div>
            {/each}
        </div>

        <button class="primary" on:click={startNew}>+ 新建模板</button>
    {/if}
</div>

{#if confirmDeleteId}
    <div class="mask">
        <div class="dialog">
            <p>确定删掉「{findTemplate(list, confirmDeleteId)?.name}」这个模板吗？</p>
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
        line-height: 1.7;
    }
    .vars {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
    }
    .var {
        padding: 3px 8px;
        border: 1px solid var(--b3-border-color);
        border-radius: 10px;
        background: transparent;
        color: var(--b3-theme-on-surface);
        cursor: pointer;
        font-size: 11px;
        font-family: monospace;
    }
    .var:hover {
        border-color: var(--b3-theme-primary);
        color: var(--b3-theme-primary);
    }
    .hint-box {
        font-size: 11px;
        line-height: 1.7;
        color: var(--b3-theme-on-surface);
        background: var(--b3-theme-surface);
        padding: 8px 10px;
        border-radius: var(--b3-border-radius);
        margin-bottom: 10px;
    }
    .list {
        margin-bottom: 10px;
    }
    .item {
        border: 1px solid var(--b3-border-color);
        border-radius: var(--b3-border-radius);
        padding: 8px 10px;
        margin-bottom: 6px;
    }
    .item-name {
        font-size: 13px;
        margin-bottom: 3px;
    }
    .item-preview {
        font-size: 11px;
        line-height: 1.5;
        color: var(--b3-theme-on-surface);
        opacity: 0.75;
        margin-bottom: 6px;
        word-break: break-word;
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
    .mini:disabled {
        opacity: 0.35;
        cursor: default;
    }
    .mini:hover:not(:disabled) {
        border-color: var(--b3-theme-primary);
        color: var(--b3-theme-primary);
    }
    .mini.danger:hover {
        border-color: var(--b3-theme-error);
        color: var(--b3-theme-error);
    }
    button.primary {
        width: 100%;
        padding: 8px;
        border: none;
        border-radius: var(--b3-border-radius);
        background: var(--b3-theme-primary);
        color: var(--b3-theme-on-primary);
        cursor: pointer;
        font-size: 13px;
    }
    button.link {
        border: none;
        background: none;
        color: var(--b3-theme-primary);
        cursor: pointer;
        font-size: 12px;
        padding: 0;
    }
    .warn {
        font-size: 11px;
        line-height: 1.6;
        color: var(--b3-theme-error);
        margin-bottom: 10px;
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
