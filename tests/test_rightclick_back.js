// 验证「右键 = 返回键」逻辑：contextmenu 拦截、KEYCODE_BACK 下发、
// 右键鼠标事件抑制、以及多设备同步分支（touch_report_back / touch_inject_back）
const fs = require('fs');
const src = fs.readFileSync('/data/ws-scrcpy-new/src/app/index.ts', 'utf8');

const rcStart = src.indexOf('// --- iframe embed: 右键 = 返回键');
const rcEnd = src.indexOf('// --- end 右键返回 ---');
const syncStart = src.indexOf('// --- iframe embed: 多设备同步操控');
const syncEnd = src.indexOf('// --- end 同步操控 ---');
if (rcStart < 0 || rcEnd < 0 || syncStart < 0 || syncEnd < 0) {
    console.log('FAIL: 找不到右键返回/同步操控代码段');
    process.exit(1);
}

// 去掉 TS 类型标注，使其可在 node 中直接执行
let code = [
    src.slice(rcStart, rcEnd + '// --- end 右键返回 ---'.length),
    src.slice(syncStart, syncEnd + '// --- end 同步操控 ---'.length),
].join('\n')
    .replace(/\(event: MouseEvent\): void =>/g, '(event) =>')
    .replace(/\(event: MouseEvent\) =>/g, '(event) =>')
    .replace(/\(event: Event\) =>/g, '(event) =>')
    .replace(/\(target: EventTarget \| null\): boolean =>/g, '(target) =>')
    .replace(/\(\): void =>/g, '() =>')
    .replace(/\(\): HTMLElement \| null =>/g, '() =>')
    .replace(/ as HTMLElement \| null/g, '')
    .replace(/ as MouseEvent/g, '')
    .replace(/ as Node/g, '');

console.log('提取代码:', code.split('\n').length, '行\n');

// ---- mock DOM ----
const sent = [];      // streamClient.sendMessage 收到的控制消息
const posted = [];    // 向父窗口 postMessage 的消息
const dispatched = [];// 元素上 dispatchEvent 的事件
let prevented = 0;    // preventDefault 次数

const insideTarget = { name: 'touch-layer' };
const outsideTarget = { name: 'toolbar' };
const videoEl = {
    contains: (t) => t === insideTarget,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 800 }),
    dispatchEvent: (e) => { dispatched.push(e); return true; },
};
const docListeners = {};
const winListeners = {};
const streamClient = { sendMessage: (m) => sent.push(m) };
class KeyCodeControlMessage {
    constructor(action, keycode, repeat, metaState) {
        this.action = action;
        this.keycode = keycode;
        this.repeat = repeat;
        this.metaState = metaState;
    }
}
const KeyEvent = { ACTION_DOWN: 0, ACTION_UP: 1, KEYCODE_BACK: 4 };
const mockDocument = {
    querySelector: (sel) => (sel === '.video' || sel === '.video .touch-layer' ? videoEl : null),
    addEventListener: (t, f) => { (docListeners[t] = docListeners[t] || []).push(f); },
};
const mockWindow = {
    parent: { postMessage: (m) => posted.push(m) },
    addEventListener: (t, f) => { (winListeners[t] = winListeners[t] || []).push(f); },
};

new Function(
    'document', 'window', 'streamClient', 'KeyCodeControlMessage', 'KeyEvent', 'MouseEvent',
    code,
)(mockDocument, mockWindow, streamClient, KeyCodeControlMessage, KeyEvent, class {});

let failed = 0;
const check = (name, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) failed++;
    console.log(name.padEnd(32), '实际', String(JSON.stringify(actual)).padEnd(46), ok ? 'PASS' : 'FAIL');
};
const fireDoc = (type, ev) => (docListeners[type] || []).forEach((f) => f(ev));
const mkMouse = (props) => ({
    stopPropagation() { this.stopped = true; },
    preventDefault() { prevented++; },
    ...props,
});

// 1. 画面内右键（contextmenu）→ 返回键 DOWN+UP + 上报父窗口
const n0 = sent.length;
fireDoc('contextmenu', mkMouse({ target: insideTarget }));
check('返回键下发 2 条消息', sent.length - n0, 2);
check('第 1 条 action=DOWN', sent[sent.length - 2].action, 0);
check('第 1 条 keycode=BACK', sent[sent.length - 2].keycode, 4);
check('第 2 条 action=UP', sent[sent.length - 1].action, 1);
check('第 2 条 keycode=BACK', sent[sent.length - 1].keycode, 4);
check('屏蔽浏览器右键菜单', prevented > 0, true);
check('向父窗口上报 touch_report_back', posted[posted.length - 1], 'touch_report_back');

// 2. 画面外右键（如工具栏）→ 不发送返回键
const n1 = sent.length;
fireDoc('contextmenu', mkMouse({ target: outsideTarget }));
check('画面外右键不发返回键', sent.length, n1);

// 3. 右键 mousedown/mouseup 被抑制（不进触控链路）
// 用单独的事件对象验证 stopped 标记
const evDown = mkMouse({ target: insideTarget, button: 2 });
fireDoc('mousedown', evDown);
check('右键 mousedown stopPropagation', evDown.stopped, true);
const evUp = mkMouse({ target: insideTarget, button: 2 });
fireDoc('mouseup', evUp);
check('右键 mouseup stopPropagation', evUp.stopped, true);
const evMove = mkMouse({ target: insideTarget, buttons: 2 });
fireDoc('mousemove', evMove);
check('右键拖动 stopPropagation', evMove.stopped, true);

// 4. 左键事件不被抑制
const evLeftDown = mkMouse({ target: insideTarget, button: 0 });
fireDoc('mousedown', evLeftDown);
check('左键 mousedown 不抑制', evLeftDown.stopped, undefined);
const evLeftMove = mkMouse({ target: insideTarget, buttons: 1 });
fireDoc('mousemove', evLeftMove);
check('左键拖动不抑制', evLeftMove.stopped, undefined);
const evOutside = mkMouse({ target: outsideTarget, button: 2 });
fireDoc('mousedown', evOutside);
check('画面外右键不抑制', evOutside.stopped, undefined);

// 5. 多设备同步：父窗口下发 touch_inject_back → 本机同样返回
const n2 = sent.length;
winListeners['message'].forEach((f) => f({ data: 'touch_inject_back' }));
check('注入返回下发 2 条消息', sent.length - n2, 2);
check('注入返回 keycode=BACK', sent[sent.length - 1].keycode, 4);

// 6. 普通注入消息不应触发返回键
const n3 = sent.length;
winListeners['message'].forEach((f) => f({ data: 'touch_inject_mousedown_0.5000_0.5000' }));
check('普通注入不触发返回键', sent.length, n3);
check('普通注入仍派发 1 个事件', dispatched.length, 1);

console.log('\n' + (failed === 0 ? '全部 PASS' : failed + ' 项 FAIL'));
process.exit(failed === 0 ? 0 : 1);
