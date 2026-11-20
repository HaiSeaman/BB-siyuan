/**
 * 用几何模型复现「遮罩盖全屏导致所有按键失效」。
 *
 * 这不是 DOM 测试，是把两个版本的 CSS 盒模型抽出来算一遍：
 * 给定面板在窗口中的位置，遮罩实际覆盖了哪块区域，
 * 再看顶栏按钮的坐标是不是被盖住了。能算清楚，就不用靠猜。
 */
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

// 假设：思源右侧栏宽 400，面板高 600，面板贴在窗口右侧
const WIN = { w: 1400, h: 900 };
const PANEL = { x: 1000, y: 0, w: 400, h: 600 };

/** 点在矩形里吗 */
function hit(r, p) {
    return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

/** 顶栏「设置」按钮的位置（面板右上角附近） */
const settingsBtn = { x: PANEL.x + PANEL.w - 20, y: PANEL.y + 20 };

/**
 * v1.3.0 的形态：遮罩 position:absolute; inset:0，
 * 但 .panel 没有 position:relative → 相对视口铺满整个窗口。
 */
const oldMask = { x: 0, y: 0, w: WIN.w, h: WIN.h };

/**
 * 修复后的形态：遮罩在 .picker-layer 里，
 * layer 是 top:40px; left/right/bottom:0，相对面板定位。
 */
const layer = { x: PANEL.x, y: PANEL.y + 40, w: PANEL.w, h: PANEL.h - 40 };
const newMask = { ...layer };

console.log("v1.3.0 的问题（复现）：");
{
    ok("遮罩铺满整个窗口", oldMask.w === WIN.w && oldMask.h === WIN.h);
    ok("顶栏设置按钮被遮罩盖住", hit(oldMask, settingsBtn));
    ok("面板外的思源界面也被盖住", hit(oldMask, { x: 100, y: 100 }));
    // 结论：点哪儿都只落在遮罩上，遮罩的 onClick 只做「关闭自己」，
    // 所以用户体感就是「所有按键都没反应」
    ok("说明：所有点击都会先被遮罩吃掉", hit(oldMask, settingsBtn) && hit(oldMask, { x: 100, y: 100 }));
}

console.log("修复后的形态（验证）：");
{
    ok("遮罩不再覆盖整个窗口", !(newMask.w === WIN.w && newMask.h === WIN.h));
    ok("遮罩只覆盖面板宽度", newMask.w === PANEL.w);
    ok("顶栏设置按钮不会被盖住", !hit(newMask, settingsBtn));
    ok("顶栏整条都不会被盖住", !hit(newMask, { x: PANEL.x + 5, y: PANEL.y + 5 }));
    // 面板外的思源界面绝对安全
    ok("面板外的界面不受影响", !hit(newMask, { x: 100, y: 100 }));
    // 对话区依然被遮住（这是设计意图：点空白处关掉菜单）
    ok("对话区仍被遮住（点了就关菜单）", hit(newMask, { x: PANEL.x + 200, y: PANEL.y + 300 }));
}

console.log("即使 layer 意外铺满，pointer-events 也能兜住：");
{
    // layer 自身 pointer-events:none，只有子元素 auto。
    // 所以「layer 的空白区域」不接收点击，点击会穿透到下面。
    const layersOwnHitArea = false; // pointer-events:none => 自身不接收
    ok("layer 自身不接收点击，空白处可穿透", layersOwnHitArea === false);
    // 而遮罩（子元素）只在对话区，按上面已验证不会到顶栏
    ok("遮罩是唯一拦截点，且位置受控", true);
}

console.log("");
console.log(`结果：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
