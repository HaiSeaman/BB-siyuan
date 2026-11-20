/**
 * 面板布局的「不许盖住可点击区域」守卫。
 *
 * 背景（真实故障）：v1.3.0 里模型切换器的遮罩是 position:absolute; inset:0，
 * 但面板根元素没有 position:relative，遮罩就相对整个窗口铺满，
 * 把思源主界面连同面板所有按钮一起盖住 —— 表现是「所有按键都没反应」。
 *
 * 这类 bug 看不出来（遮罩是透明的），只能靠规则检查 + 结构约束防。
 * 这里直接读 .svelte 源码和编译后的 CSS，断言几条硬规矩。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const panelSrc = readFileSync(join(root, "src/ui/ChatPanel.svelte"), "utf8");
const distCss = readFileSync(join(root, "dist/index.css"), "utf8");
const distJs = readFileSync(join(root, "dist/index.js"), "utf8");

let pass = 0;
let fail = 0;

function ok(name, cond) {
    if (cond) {
        pass++;
        console.log("  OK   " + name);
    } else {
        fail++;
        console.log("  FAIL " + name);
    }
}

/** 从编译后的 CSS 里取某条规则 */
function rule(selector) {
    const re = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[^{]*\\{([^}]*)\\}");
    const m = distCss.match(re);
    return m ? m[1] : "";
}

console.log("面板根元素必须是定位祖先：");
{
    // 找 ChatPanel 那条 .panel 规则（它带 flex-direction: column，别的组件的 .panel 只是 padding）
    const m = distCss.match(/\.panel\.svelte-[a-z0-9]+\.svelte-[a-z0-9]+\{[^}]*flex-direction:column[^}]*\}/);
    const body = m ? m[0] : "";
    ok("找得到 ChatPanel 的 .panel 规则", !!body);
    ok(".panel 有 position:relative", /position:\s*relative/.test(body));
}

console.log("遮罩必须包在只覆盖对话区的层里：");
{
    ok("模板里有 .picker-layer", panelSrc.includes('class="picker-layer"'));
    ok("遮罩在 picker-layer 内部", /picker-layer[\s\S]{0,400}?picker-mask/.test(panelSrc));

    const layer = rule(".picker-layer.svelte");
    ok("layer 是绝对定位", /position:\s*absolute/.test(layer));
    // 关键：只从顶栏下方开始，顶栏（40px）永远露出来
    ok("layer 从顶栏下方开始（top:40px）", /top:\s*40px/.test(layer));
    // 双保险：layer 本身不吃点击
    ok("layer 自身不吃点击（pointer-events:none）", /pointer-events:\s*none/.test(layer));
    ok("子元素恢复可点击", /pointer-events:\s*auto/.test(distCss));
}

console.log("遮罩本身不再是无条件全屏覆盖：");
{
    const mask = rule(".picker-mask.svelte");
    ok("遮罩有定位", /position:\s*absolute/.test(mask));
    // 它相对 layer 铺满，而 layer 不覆盖顶栏 —— 这才是正确形态
    ok("遮罩在 layer 内铺满（有 inset 或四边 0）", /inset:\s*0|top:\s*0[^}]*left:\s*0/.test(mask));
    // 不再自带一个高 z-index 去压过一切
    ok("遮罩不再自带 z-index 去压全场", !/z-index:\s*(3[0-9]|[4-9][0-9])/.test(mask));
}

console.log("手机上也能靠键盘/手势退出：");
{
    ok("有 Esc 关闭切换器的处理", /Escape/.test(panelSrc) && /modelPicker\s*=\s*false/.test(panelSrc));
}

console.log("产物里确实带上了这些新规则：");
{
    ok("dist 有 picker-layer", distCss.includes("picker-layer"));
    ok("dist 有 pointer-events", distCss.includes("pointer-events"));
}

console.log("");
console.log(`结果：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
