// 验证「群控台画质策略」改动（当前版本：videoSize + 长边 1280 上限）：
// 1. 关键改动都在位（take-small 段已禁用、getMaxSize 读 videoSize、1280 上限）
// 2. 盒子数学：长边超 1280 等比缩小（只缩不放）、16 对齐、拿不到时回落 1920×1920
// 3. 播放器 preferred 设置（仅 MSE 应用画质策略，其余为上游默认值）
// 4. 模拟 onDisplayInfo 首次连接的推送结果
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
check('take-small 段已禁用标记存在', src.includes('take-small-disabled'), true);
// 活代码中不得有交集逻辑（注释里保留原代码示例，需逐行排除注释行）
const liveLines = src.split('\n').filter((l) => !l.trim().startsWith('//'));
check('take-small 交集逻辑已移除（活代码）', liveLines.some((l) => l.includes('.intersect(')), false);
check('getMaxSize 不再看容器宽度', src.includes('body.clientWidth'), false);
check('getMaxSize 读 screenInfo.videoSize', /videoSize\.width/.test(src), true);
check('getMaxSize 有 1280 上限', /1280/.test(src), true);
check('getMaxSize 等比缩放（只缩不放）', /longSide > 1280 \? 1280 \/ longSide : 1/.test(src), true);
check('回退 1920x1920 大盒子', /return new Size\(1920, 1920\)/.test(src), true);
check('第二版 displayInfo 实现已移除', src.includes('getNativeBounds'), false);

// ---------- 2. 盒子数学（与 getMaxSize 同规则复算）----------
console.log('\n--- 编码尺寸盒子（videoSize → getMaxSize）---');
const MAX_SIDE = 1280;
const getMaxSizeBox = (w, h) => {
    if (!(w > 0 && h > 0)) return null;
    const longSide = Math.max(w, h);
    const scale = longSide > MAX_SIDE ? MAX_SIDE / longSide : 1;
    return [Math.round(w * scale) & ~15, Math.round(h * scale) & ~15];
};
check('1080x1920 手机 → 720x1280', getMaxSizeBox(1080, 1920), [720, 1280]);
check('1920x1072 横屏 1080p → 1280x704', getMaxSizeBox(1920, 1072), [1280, 704]);
check('720x1280 长边=1280 不缩', getMaxSizeBox(720, 1280), [720, 1280]);
check('1072x592 小屏不缩', getMaxSizeBox(1072, 592), [1072, 592]);
check('1440x3200 → 576x1280', getMaxSizeBox(1440, 3200), [576, 1280]);
check('1073x593 奇数 → 16 对齐', getMaxSizeBox(1073, 593), [1072, 592]);
check('0x0 → null（走回落）', getMaxSizeBox(0, 0), null);

// ---------- 3. 播放器 preferred 设置 ----------
console.log('\n--- 播放器默认画质 ---');
// 仅 MSE 应用画质策略；其余三个保持上游默认值（群控台只用 MSE）
const playerExpect = {
    MsePlayer: { bitrate: 12582912, maxFps: 30, bounds: [1080, 1920], ifi: 10 },
    TinyH264Player: { bitrate: 524288, maxFps: 24, bounds: [480, 480], ifi: 5 },
    WebCodecsPlayer: { bitrate: 524288, maxFps: 24, bounds: [480, 480], ifi: 5 },
    BroadwayPlayer: { bitrate: 524288, maxFps: 24, bounds: [480, 480], ifi: 5 },
};
for (const [p, exp] of Object.entries(playerExpect)) {
    const psrc = fs.readFileSync(path.join(ROOT, 'src/app/player', `${p}.ts`), 'utf8');
    const block = psrc.slice(psrc.indexOf('preferredVideoSettings'), psrc.indexOf('preferredVideoSettings') + 400);
    check(`${p} bitrate`, /bitrate: (\d+)/.exec(block)?.[1] | 0, exp.bitrate);
    check(`${p} maxFps`, /maxFps: (\d+)/.exec(block)?.[1] | 0, exp.maxFps);
    check(`${p} bounds`, /bounds: new Size\((\d+), (\d+)\)/.exec(block)?.slice(1).map(Number), exp.bounds);
    check(`${p} iFrameInterval`, /iFrameInterval: (\d+)/.exec(block)?.[1] | 0, exp.ifi);
}

// ---------- 4. 模拟 onDisplayInfo 首次连接的推送结果 ----------
console.log('\n--- 推送结果模拟（getMaxSize 盒子夹入推送设置）---');
// scrcpy 服务端对 bounds 只缩不放：取 min(请求盒子, 当前编码尺寸) 中更小者生效
const withBounds = (box) => ({ bounds: box });
// 场景 A：新连接，服务端默认 8Mbps/60fps，设备 videoSize 1080x1920
let pushed = withBounds(getMaxSizeBox(1080, 1920));
check('A: 1080p 竖屏推 720x1280', [pushed.bounds[0], pushed.bounds[1]], [720, 1280]);
// 场景 B：共享服务端已被压到 720x720，videoSize 仍报 1080x1920 → 解脱
pushed = withBounds(getMaxSizeBox(1080, 1920));
check('B: 被压小后仍按原生推', [pushed.bounds[0], pushed.bounds[1]], [720, 1280]);
// 场景 C：横屏 1080p 设备，videoSize 1920x1072
pushed = withBounds(getMaxSizeBox(1920, 1072));
check('C: 横屏 1080p 推 1280x704', [pushed.bounds[0], pushed.bounds[1]], [1280, 704]);
// 场景 D：小屏设备 1072x592（长边不足 1280，不缩）
pushed = withBounds(getMaxSizeBox(1072, 592));
check('D: 小屏 1072x592 不缩', [pushed.bounds[0], pushed.bounds[1]], [1072, 592]);

console.log('\n' + (failed === 0 ? '全部 PASS' : failed + ' 项 FAIL'));
process.exit(failed === 0 ? 0 : 1);
