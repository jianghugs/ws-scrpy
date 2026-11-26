// 验证「群控台画质策略」改动：
// 1. 关键改动都在位（take-small 段已禁用、画质策略常量、preferred 设置）
// 2. 原生尺寸盒子数学：长边正方形、16 对齐、1920 封顶、拿不到时回落 1920×1920
// 3. onDisplayInfo 推送的设置 = 画质策略 + 原生盒子（模拟完整计算）
const fs = require('fs');
const path = require('path');
const ROOT = '/data/ws-scrcpy-new';
const src = fs.readFileSync(path.join(ROOT, 'src/app/googDevice/client/StreamClientScrcpy.ts'), 'utf8');

let failed = 0;
const check = (name, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) failed++;
    console.log(name.padEnd(38), '实际', String(JSON.stringify(actual)).padEnd(40), ok ? 'PASS' : 'FAIL');
};

// ---------- 1. 源码级断言 ----------
console.log('--- 源码断言 ---');
check('take-small 段已禁用标记存在', src.includes('/*take-small-disabled*/'), true);
check('take-small 交集逻辑已移除', src.includes("currentSettings.bounds?.intersect(min.bounds)"), false);
check('MAX_BITRATE=12Mbps', /MAX_BITRATE = 12582912/.test(src), true);
check('MAX_FPS=30', /MAX_FPS = 30/.test(src), true);
check('MAX_BOUNDS_SIDE=1920', /MAX_BOUNDS_SIDE = 1920/.test(src), true);
check('getMaxSize 不再看容器宽度', src.includes('body.clientWidth'), false);
check('getMaxSize 用 displayInfo.size', /displayInfo\.size\.width/.test(src), true);
check('onDisplayInfo 先落 screenInfo', src.indexOf('setScreenInfo(screenInfo)') < src.indexOf('if (this.fitToScreen)'), true);
check('画质策略覆盖码率/帧率', /bitrate: MAX_BITRATE/.test(src) && /maxFps: MAX_FPS/.test(src), true);

// ---------- 2. 盒子数学（与 getNativeBounds 同规则复算）----------
console.log('\n--- 原生尺寸盒子 ---');
const MAX_BOUNDS_SIDE = 1920;
const nativeBox = (w, h) => {
    const maxSide = Math.max(w, h);
    if (!(maxSide > 0)) return null;
    const side = Math.min(maxSide, MAX_BOUNDS_SIDE) & ~15;
    return [side, side];
};
check('1080x1920 手机 → 1920x1920', nativeBox(1080, 1920), [1920, 1920]);
check('1920x1080（旋转后）→ 1920x1920', nativeBox(1920, 1080), [1920, 1920]);
check('1072x592 小屏 → 1072x1072', nativeBox(1072, 592), [1072, 1072]);
check('720x1280 → 1280x1280', nativeBox(720, 1280), [1280, 1280]);
check('1440x3200 → 1920x1920(封顶)', nativeBox(1440, 3200), [1920, 1920]);
check('1073x593 奇数 → 16 对齐', nativeBox(1073, 593), [1072, 1072]);
check('0x0 → null（走回落）', nativeBox(0, 0), null);

// ---------- 3. 四个播放器的 preferred 设置 ----------
console.log('\n--- 播放器默认画质 ---');
for (const p of ['MsePlayer', 'WebCodecsPlayer', 'TinyH264Player', 'BroadwayPlayer']) {
    const psrc = fs.readFileSync(path.join(ROOT, 'src/app/player', `${p}.ts`), 'utf8');
    const block = psrc.slice(psrc.indexOf('preferredVideoSettings'), psrc.indexOf('preferredVideoSettings') + 400);
    check(`${p} bitrate=12Mbps`, /bitrate: 12582912/.test(block), true);
    check(`${p} maxFps=30`, /maxFps: 30/.test(block), true);
    check(`${p} bounds=1920x1920`, /bounds: new Size\(1920, 1920\)/.test(block), true);
}

// ---------- 4. 模拟 onDisplayInfo 的 !oldInfo 推送结果 ----------
console.log('\n--- 推送结果模拟 ---');
// 复算 applyQualityPolicy + createVideoSettingsWithBounds(getMaxSize())
const applyQualityPolicy = (s) => ({ ...s, bitrate: 12582912, maxFps: 30 });
const withBounds = (s, box) => ({ ...s, bounds: box });
// 场景 A：新连接、服务端默认（原生 1080x1920、8Mbps、60fps），displayInfo 1080x1920
let serverSettings = { bitrate: 8000000, maxFps: 60, bounds: null, displayId: 0 };
let pushed = withBounds(applyQualityPolicy({ ...serverSettings }), { width: 1920, height: 1920 });
check('A: 推送 bounds=1920x1920', [pushed.bounds.width, pushed.bounds.height], [1920, 1920]);
check('A: 推送 bitrate=12Mbps', pushed.bitrate, 12582912);
check('A: 推送 maxFps=30', pushed.maxFps, 30);
check('A: displayId 保留', pushed.displayId, 0);
// 场景 B：共享服务端已被压到 720x720，displayInfo 仍是 1080x1920 → 解脱
serverSettings = { bitrate: 524288, maxFps: 24, bounds: { width: 720, height: 720 }, displayId: 0 };
pushed = withBounds(applyQualityPolicy({ ...serverSettings }), { width: 1920, height: 1920 });
check('B: 被压小后仍推 1920 盒子', [pushed.bounds.width, pushed.bounds.height], [1920, 1920]);
// 场景 C：设备 1072x592 工业屏 → 1072x1072
serverSettings = { bitrate: 8000000, maxFps: 60, bounds: null, displayId: 0 };
pushed = withBounds(applyQualityPolicy({ ...serverSettings }), { width: 1072, height: 1072 });
check('C: 1072 屏 → 1072x1072', [pushed.bounds.width, pushed.bounds.height], [1072, 1072]);

console.log('\n' + (failed === 0 ? '全部 PASS' : failed + ' 项 FAIL'));
process.exit(failed === 0 ? 0 : 1);
