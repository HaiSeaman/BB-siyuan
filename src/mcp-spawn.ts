/**
 * 启动本地 MCP 进程。
 *
 * Windows 上有两层坑：
 *   1. `npx` 实际是 `npx.cmd`
 *   2. 新版 Node 拒绝直接 spawn `.cmd` / `.bat`（报 EINVAL，这是 `spawn` 的漏洞修复）
 *
 * 解法：Windows 上把 `.cmd` / `.bat` 交给 `cmd /c` 执行。
 * 这比 `shell:true` 安全 —— 命令和参数仍然分开传，不会被拼成一整条命令行。
 */

export interface SpawnOptionsLike {
    env?: Record<string, string>;
    cwd?: string;
    stdio?: any;
}

export type SpawnFn = (cmd: string, args: string[], opts: any) => any;

const WIN_EXE = new Set(["node", "nodejs", "python", "python3", "deno"]);
const WIN_CMD = new Set(["npx", "npm", "pnpm", "yarn", "tsx", "uvx", "pipx", "corepack"]);

/** 判断这个命令在 Windows 上是不是 .cmd 类（需要 cmd 包一层） */
export function needsCmdWrapper(cmd: string, platform: string): boolean {
    if (platform !== "win32") return false;
    const base = cmd.split(/[\\/]/).pop() || cmd;
    if (/\.(cmd|bat)$/i.test(base)) return true;
    if (/[\\/]/.test(cmd)) return false; // 完整路径的 .exe 不用包
    return WIN_CMD.has(base.toLowerCase());
}

/** Windows 上给裸命令补扩展名，方便判定类别 */
export function resolveCommand(cmd: string, platform: string): string {
    if (platform !== "win32") return cmd;
    if (/[\\/]/.test(cmd)) return cmd;
    if (/\.(exe|cmd|bat)$/i.test(cmd)) return cmd;
    if (WIN_EXE.has(cmd.toLowerCase())) return cmd + ".exe";
    if (WIN_CMD.has(cmd.toLowerCase())) return cmd + ".cmd";
    return cmd;
}

/**
 * cmd.exe 会二次解释参数：& | < > ^ % 都会被它当语法处理。
 * 实测 `https://x/a?foo=1&bar=2` 会被拆成两段，`%USERPROFILE%` 会被展开。
 * 所以交给 cmd 之前，每个参数都要用 ^ 转义这些字符。
 */
export function escapeForCmd(arg: string): string {
    // 先用 ^ 转义 cmd 的元字符；引号要保留原样（成对出现时 cmd 会自己处理）
    return arg.replace(/([&|<>^%])/g, "^$1");
}

export function makeSpawner(childProcess: any, platform: string): SpawnFn {
    return (cmd: string, args: string[], opts: SpawnOptionsLike) => {
        const resolved = resolveCommand(cmd, platform);

        if (needsCmdWrapper(resolved, platform)) {
            // cmd /c 后面的参数仍然一个个传，但要先转义，免得被 cmd 拆开
            const escaped = args.map(escapeForCmd);
            return childProcess.spawn("cmd.exe", ["/d", "/s", "/c", resolved, ...escaped], {
                ...opts,
                shell: false,
                windowsHide: true,
            });
        }

        return childProcess.spawn(resolved, args, {
            ...opts,
            shell: false,
            windowsHide: true,
        });
    };
}
