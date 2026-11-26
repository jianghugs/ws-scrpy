// 验证「多设备同步操控」双向逻辑：上报（本页→父窗口）+ 注入（父窗口→本页）
const fs = require('fs');
const src = fs.readFileSync('/data/ws-scrcpy-new/src/app/index.ts', 'utf8');

const start = src.indexOf('// --- iframe embed: 多设备同步操控');
const end = src.indexOf('// --- end 同步操控 ---');
if (start < 0 || end < 0) { console.log('FAIL: 找不到同步操控代码段'); process.exit(1); }

// 去掉 TS 类型标注，使其可在 node 中直接执行
let code = src.slice(start, end + '// --- end 同步操控 ---'.length)
    .replace(/\(event: MouseEvent\): void =>/g, '(event) =>')
    .replace(/\(event: MouseEvent\) =>/g, '(event) =>')
    .replace(/\(\): HTMLElement \| null =>/g, '() =>')
    .replace(/ as HTMLElement \| null/g, '');

console.log('提取代码:', code.split('\n').length, '行\n');

// ---- mock DOM ----
// .video 容器与里层的 .touch-layer（player.getTouchableElement() 返回的 canvas）分开模拟
const RECT = { left: 100, top: 50, width: 400, height: 800 };
const dispatched = []; // { el, event }
const posted = [];
const makeEl = (name) => ({
    name,
    getBoundingClientRect: () => RECT,
    dispatchEvent: function (e) { e.target = this; dispatched.push({ el: name, event: e }); return true; },
});
const videoEl = makeEl('.video');
const touchLayerEl = makeEl('.touch-layer');
class FakeMouseEvent {
    constructor(type, opts) { this.type = type; this.buttons = 0; Object.assign(this, opts || {}); }
}
const docListeners = {};
const winListeners = {};
const mockDocument = {
    querySelector: (sel) => (sel === '.video .touch-layer' ? touchLayerEl : sel === '.video' ? videoEl : null),
    addEventListener: (t, f) => { (docListeners[t] = docListeners[t] || []).push(f); },
};
const mockWindow = {
    parent: { postMessage: (m) => posted.push(m) }, // 注意：不是 mockWindow 自身
    addEventListener: (t, f) => { (winListeners[t] = winListeners[t] || []).push(f); },
};

new Function('document', 'window', 'MouseEvent', code)(mockDocument, mockWindow, FakeMouseEvent);

let failed = 0;
const check = (name, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) failed++;
    console.log(name.padEnd(30), '实际', JSON.stringify(actual).padEnd(42), ok ? 'PASS' : 'FAIL');
};
const fireDoc = (type, ev) => (docListeners[type] || []).forEach((f) => f(ev));

// 1. 上报：mousedown 在画面内 25%/50% 处
fireDoc('mousedown', new FakeMouseEvent('mousedown', { clientX: 200, clientY: 450, buttons: 1 }));
check('上报 mousedown 比例', posted[posted.length - 1], 'touch_report_mousedown_0.2500_0.5000');

// 2. 上报：mouseup
fireDoc('mouseup', new FakeMouseEvent('mouseup', { clientX: 200, clientY: 450 }));
check('上报 mouseup 比例', posted[posted.length - 1], 'touch_report_mouseup_0.2500_0.5000');

// 3. mousemove 只在按住时上报
const n0 = posted.length;
fireDoc('mousemove', new FakeMouseEvent('mousemove', { clientX: 200, clientY: 450, buttons: 0 }));
check('未按住不上报', posted.length, n0);
fireDoc('mousemove', new FakeMouseEvent('mousemove', { clientX: 300, clientY: 450, buttons: 1 }));
check('按住拖动上报', posted[posted.length - 1], 'touch_report_mousemove_0.5000_0.5000');

// 4. 点在画面外不上报
const n1 = posted.length;
fireDoc('mousedown', new FakeMouseEvent('mousedown', { clientX: 9999, clientY: 9999, buttons: 1 }));
check('画面外不上报', posted.length, n1);

// 5. 注入：父窗口下发 → 必须派发在 .touch-layer 上（坐标按容器尺寸还原）
//    回归测试：曾经误派发在 .video 容器上，被 FeaturedInteractionHandler 的
//    event.target !== this.tag 校验丢弃，导致从机完全没反应
const d0 = dispatched.length;
winListeners['message'].forEach((f) =>
    f({ data: 'touch_inject_mousedown_0.2500_0.5000' }));
check('注入产生 1 个事件', dispatched.length - d0, 1);
const last = dispatched[dispatched.length - 1];
const ev = last.event;
check('注入目标元素', last.el, '.touch-layer');
check('注入事件 target 正确', ev.target === touchLayerEl, true);
check('注入事件类型', ev.type, 'mousedown');
check('注入 clientX', ev.clientX, 200); // 100 + 0.25*400
check('注入 clientY', ev.clientY, 450); // 50 + 0.5*800
check('注入可冒泡', ev.bubbles, true);
check('mousedown buttons', ev.buttons, 1);

// 5b. mouseup 时 buttons 应为 0（按键已松开）
winListeners['message'].forEach((f) =>
    f({ data: 'touch_inject_mouseup_0.2500_0.5000' }));
check('mouseup buttons', dispatched[dispatched.length - 1].event.buttons, 0);

// 5c. 模拟 FeaturedInteractionHandler 的 target 校验：只有 target === touch-layer 才被处理
const handled = dispatched.filter((d) => d.event.target === touchLayerEl).length;
check('通过 handler 校验的事件数', handled, dispatched.length);

// 6. 完整滑动序列
dispatched.length = 0;
['mousedown_0.1000_0.2000', 'mousemove_0.3000_0.4000', 'mouseup_0.3000_0.4000'].forEach((m) =>
    winListeners['message'].forEach((f) => f({ data: 'touch_inject_' + m })));
check('滑动序列事件数', dispatched.length, 3);
check('滑动全部命中 touch-layer', dispatched.every((d) => d.el === '.touch-layer'), true);
check('滑动末点 X', dispatched[dispatched.length - 1].event.clientX, 220); // 100+0.3*400
check('滑动末点 Y', dispatched[dispatched.length - 1].event.clientY, 370); // 50+0.4*800

// 7. 非法消息忽略
const d1 = dispatched.length;
winListeners['message'].forEach((f) => f({ data: 'touch_inject_mousedown_abc_def' }));
winListeners['message'].forEach((f) => f({ data: 'something_else' }));
winListeners['message'].forEach((f) => f({ data: 12345 }));
check('非法消息不派发', dispatched.length, d1);

console.log('\n' + (failed === 0 ? '全部 PASS' : failed + ' 项 FAIL'));
process.exit(failed === 0 ? 0 : 1);
