import { Plugin } from "siyuan";
import { initSettings, snapshot, type Settings } from "./settings";
import { migrateSettings } from "./migrate";
import { normalizeTemplates, type PromptTemplate } from "./templates";
import { normalizeMcpServers, type McpServer } from "./mcp-manager";
import { normalizeSessions, type Session } from "./sessions";
import { setPluginName } from "./net";
import ChatPanel from "./ui/ChatPanel.svelte";

const STORAGE_SETTINGS = "settings.json";
const STORAGE_TEMPLATES = "templates.json";
const STORAGE_MCP = "mcp.json";
const STORAGE_SESSIONS = "sessions.json";

export default class AIChatPlugin extends Plugin {
    private panel: ChatPanel | null = null;
    private dockType = "ai-chat";
    /** 当前模板列表。用户在面板里改完要同步回来，否则右键菜单一直是旧的 */
    private templates: PromptTemplate[] = [];

    async onload() {
        setPluginName(this.name);

        const [rawSettings, rawTemplates, rawMcp, rawSessions] = await Promise.all([
            this.loadData(STORAGE_SETTINGS).catch(() => null),
            this.loadData(STORAGE_TEMPLATES).catch(() => null),
            this.loadData(STORAGE_MCP).catch(() => null),
            this.loadData(STORAGE_SESSIONS).catch(() => null),
        ]);

        initSettings(migrateSettings(rawSettings));
        const templates = normalizeTemplates(rawTemplates);
        this.templates = templates;
        const mcpServers = normalizeMcpServers(rawMcp);
        const sessions = normalizeSessions(rawSessions);

        const persistSettings = (s: Settings) => this.saveData(STORAGE_SETTINGS, s).catch(() => {});
        const persistTemplates = (list: PromptTemplate[]) => {
            // 同步一份给右键菜单用，否则菜单永远是启动时那份
            this.templates = list;
            return this.saveData(STORAGE_TEMPLATES, list).catch(() => {});
        };
        const persistMcp = (list: McpServer[]) => this.saveData(STORAGE_MCP, list).catch(() => {});
        const persistSessions = (list: Session[]) =>
            this.saveData(STORAGE_SESSIONS, list).catch(() => {});

        this.addDock({
            config: {
                position: "RightBottom",
                size: { width: 400, height: 0 },
                icon: "iconSparkles",
                title: "AI 生成",
                // 手机上 tab 不会被预置在页面里，是靠这个 show 决定默认显不显示。
                // 设成 false 的话，手机侧栏里根本看不见入口（桌面端仍按用户原有布局来）。
                show: true,
            },
            data: {},
            type: this.dockType,
            init: (custom: any) => {
                const el: HTMLElement = custom.element;
                el.innerHTML = "";
                this.panel = new ChatPanel({
                    target: el,
                    props: {
                        initialSettings: snapshot(),
                        persist: persistSettings,
                        initialTemplates: templates,
                        persistTemplates,
                        initialMcpServers: mcpServers,
                        persistMcpServers: persistMcp,
                        initialSessions: sessions,
                        persistSessions,
                    },
                });
            },
            destroy: () => {
                this.panel?.$destroy();
                this.panel = null;
            },
        });

        this.addCommand({
            langKey: "openAiChat",
            langText: "打开 AI 生成面板",
            hotkey: "⌥⌘A",
            callback: () => this.openDock(),
        });

        // 手机端没有右键菜单，也常常摸不到侧栏里的插件面板，
        // 顶栏放一个按钮当固定入口（桌面端也能用，不碍事）。
        this.addTopBar({
            icon: "iconSparkles",
            title: "AI 生成",
            position: "right",
            callback: () => this.openDock(),
        });

        // 右键菜单：选中文字后右键，每个模板给一个入口。
        // 注意要挂 open-menu-content —— 那才是「选中文字→右键」触发的事件；
        // click-blockicon 只在点块前面的小图标时才触发，两个都要挂才能覆盖全。
        this.eventBus.on("open-menu-content", ({ detail }: any) => {
            this.addTemplateMenuItems(detail.menu);
        });

        this.eventBus.on("click-blockicon", ({ detail }: any) => {
            this.addTemplateMenuItems(detail.menu);
        });
    }

    /** 往右键菜单里加「打开面板」和每个模板一条 */
    private addTemplateMenuItems(menu: any) {
        if (!menu?.addItem) return;

        menu.addItem({
            icon: "iconSparkles",
            label: "AI 生成（打开面板）",
            click: () => {
                this.openDock();
            },
        });

        for (const t of this.templates) {
            menu.addItem({
                icon: "iconSparkles",
                label: "  用模板：" + t.name,
                click: () => {
                    this.openDock();
                    this.panel?.runTemplate(t.id);
                },
            });
        }
    }

    /**
     * 打开停靠栏面板。
     *
     * 桌面端：不能直接调 rightDock.toggleModel —— dock 在哪个边、哪个位置是用户拖出来的，
     * 而且 toggleModel 本身是「按 data-type 找元素再切」，得先找到真正持有它的 dock。
     * 参考本机 copilot 的写法：三个 dock 挨个查 data[type]，找到再调。
     *
     * 手机端：根本没有 window.siyuan.layout，侧栏是另一套（#sidebar / #sidebarRight
     * 里的 .side-panel），插件面板的 tab 形如 data-type="sidebar-<插件名+类型>-tab"。
     * 所以手机端单独走 openDockMobile。
     */
    private openDock() {
        const layout = (this.app as any)?.layout;
        const type = this.dockType;

        if (layout) {
            const candidates = [layout.leftDock, layout.rightDock, layout.bottomDock];
            for (const dock of candidates) {
                if (dock?.data?.[type] && typeof dock.toggleModel === "function") {
                    try {
                        dock.toggleModel(type, false, true);
                    } catch {}
                    return;
                }
            }
            // 还没渲染出来就退回点击按钮
            try {
                const btn = document.querySelector(`.dock__item[data-type="${type}"]`) as HTMLElement | null;
                if (btn) {
                    btn.click();
                    return;
                }
            } catch {}
        }

        this.openDockMobile();
    }

    /**
     * 手机端打开侧栏里的插件面板。
     *
     * 手机端不像桌面端有 layout 对象可查，只能照思源自己的做法来：
     *   1. 用 plugin.name + dockType 拼出 tab 的 data-type（思源内部就是这么拼的）
     *   2. 找到 tab 所在的 .side-panel，把它滑出来
     *   3. 往工具栏派发一次 click（detail 带类型），思源就会创建并显示面板
     *
     * 找不到 tab 说明用户在侧栏设置里把它隐藏了，这时给一句明确提示，
     * 而不是让按钮「点了没反应」。
     */
    private openDockMobile() {
        const fullType = this.name + this.dockType;

        const find = () =>
            document.querySelector(`[data-type="sidebar-${fullType}-tab"]`) as HTMLElement | null;

        const tab = find();
        if (tab) {
            this.revealMobileTab(tab);
            return;
        }

        // 插件刚启用、或者侧栏还没渲染完时，dom 里暂时没有这个 tab。
        // 等一小会儿再找一次，别让用户以为按钮坏了。
        setTimeout(() => {
            const again = find();
            if (again) {
                this.revealMobileTab(again);
                return;
            }
            // 兜底：按 title 找（万一是别的版本改了命名）
            const byTitle = Array.from(
                document.querySelectorAll("[data-type^='sidebar-'][data-type$='-tab']")
            ).find((el) => el.getAttribute("title") === "AI 生成") as HTMLElement | undefined;
            if (byTitle) {
                this.revealMobileTab(byTitle);
                return;
            }
            this.showTip("没找到「AI 生成」入口。请到「设置 → 外观 → 侧栏」里把它打开，然后重启思源。");
        }, 300);
    }

    /** 把手机端侧栏滑出来，并切到指定的 tab */
    private revealMobileTab(tab: HTMLElement) {
        if (tab.classList.contains("fn__none")) {
            this.showTip("「AI 生成」面板被隐藏了，到「设置 → 外观 → 侧栏」里打开它。");
            return;
        }

        const panel = tab.closest(".side-panel") as HTMLElement | null;
        if (!panel) {
            this.showTip("找到了面板图标，但打不开侧栏。请重启思源后再试。");
            return;
        }

        // 另一侧收起来，避免两侧同时打开
        const otherId = panel.id === "sidebar" ? "sidebarRight" : "sidebar";
        const other = document.getElementById(otherId);
        if (other) other.style.transform = "";

        // 抬高层级，否则可能被正文盖住
        const z = (window as any).siyuan;
        if (z && typeof z.zIndex === "number") {
            z.zIndex += 1;
            panel.style.zIndex = String(z.zIndex);
        }
        panel.style.transform = "translateX(0px)";

        // 触发思源自己去创建/切换面板内容
        const toolbar = panel.firstElementChild as HTMLElement | null;
        const type = tab.dataset.mobilePluginDockTab || tab.getAttribute("data-type")?.replace(/^sidebar-/, "").replace(/-tab$/, "") || "";
        if (toolbar && type) {
            try {
                toolbar.dispatchEvent(new CustomEvent("click", { detail: type }));
            } catch {}
        }
    }

    /** 弹一句提示。手机上没控制台，必须让用户看得见 */
    private showTip(msg: string) {
        try {
            // 思源没有向插件暴露 showMessage，这里自己造一条浮层，
            // 沿用它的主题变量，深浅色都能看清
            const el = document.createElement("div");
            el.className = "b3-snackbar b3-snackbar--error";
            el.style.cssText =
                "position:fixed;left:8%;right:8%;bottom:48px;z-index:99999;padding:10px 14px;" +
                "border-radius:6px;background:var(--b3-theme-surface);color:var(--b3-theme-on-surface);" +
                "box-shadow:0 2px 12px rgba(0,0,0,.25);font-size:13px;line-height:1.6;word-break:break-word;";
            el.textContent = msg;
            document.body.appendChild(el);
            setTimeout(() => {
                try {
                    el.remove();
                } catch {}
            }, 8000);
            return;
        } catch {}
        try {
            alert(msg);
        } catch {}
    }

    onunload() {
        this.panel?.$destroy();
        this.panel = null;
    }
}
