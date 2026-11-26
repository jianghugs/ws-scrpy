/* 直连设备端 scrcpy server 验证编码尺寸（自包含版）：
 * 用法: node verify_encode_direct.js <udid>
 *
 * 关键教训（都踩过）：
 * 1. scrcpy server 进程一生只服务一个 ws 客户端；残留进程占着端口但不吐数据
 *    → 表现为 ws 握手成功却 60s 无数据（幽灵监听）。必须先杀干净再起新的。
 * 2. 设备会清空 /data/local/tmp，jar 会丢 → 启动报 ClassNotFoundException。
 *    脚本会自动检测并重推。
 * 3. 服务器收到 SetVideoSettings 后才开始编码；initial-info 的魔术字节是
 *    'scrcpy_initial'（14 字节）。
 *
 * 流程：清理残留 → 起 scrcpy server（adb shell 长连接保活）→ adb forward →
 * ws 直连 → 读 initial-info → 推画质策略（12 Mbps/30fps/原生盒子）→
 * 解析推送后的 SPS → 与 adb 物理分辨率对比。
 */
const WebSocket = require('/data/ws-scrcpy-new/node_modules/ws');
const H264Parser = require('/data/ws-scrcpy-new/node_modules/h264-converter/dist/h264-parser').default;
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 设备端辅助脚本（自包含，避免依赖宿主机 /tmp 文件）
const DEV_CLEAN_SH = `#!/system/bin/sh
for p in /proc/[0-9]*; do
  c=$(tr '\\0' ' ' < $p/cmdline 2>/dev/null)
  case "$c" in
    *scrcpy.Server*) kill -9 $(basename $p) 2>/dev/null;;
  esac
done
echo "clean done"
`;
const DEV_PROBE_SH = `#!/system/bin/sh
n=0
for p in /proc/[0-9]*; do
  c=$(tr '\\0' ' ' < $p/cmdline 2>/dev/null)
  case "$c" in *scrcpy.Server*) n=$((n+1));; esac
done
echo "procs=$n"
cat /proc/net/tcp /proc/net/tcp6 2>/dev/null | grep ' 0A ' | while read line; do
  set -- $line
  echo $((16#\${2##*:}))
done | sort -un | tr '\\n' ' '
echo
`;

const MAX_BITRATE = 12582912;
const MAX_FPS = 30;
const MAX_BOUNDS_SIDE = 1920;
const LOCAL_PORT = 9999;
const DEVICE_PORT = 28887; // 全新端口，避开一切残留

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const udid = process.argv[2];
if (!udid) { console.error('用法: node verify_encode_direct.js <udid>'); process.exit(1); }
log('设备', udid);

const adb = (args, opts) => execSync(`adb -s ${udid} ${args}`, { encoding: 'utf8', timeout: 20000, ...opts }).toString();
const sh = (cmd) => adb(`shell "${cmd}"`);

// ---- 设备物理分辨率 ----
function physicalSize() {
    const out = sh('wm size');
    const m = out.match(/Physical size:\s*(\d+)x(\d+)/);
    return m ? [+m[1], +m[2]] : null;
}
const physical = physicalSize();
log('adb 物理分辨率', physical ? physical.join('x') : '未知');

// ---- 确保设备端辅助脚本在位（自包含生成后推送）----
function ensureHelperScripts() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsverify-'));
    const cleanPath = path.join(dir, 'dev_clean.sh');
    const probePath = path.join(dir, 'dev_probe.sh');
    fs.writeFileSync(cleanPath, DEV_CLEAN_SH);
    fs.writeFileSync(probePath, DEV_PROBE_SH);
    adb(`push ${cleanPath} /data/local/tmp/dev_clean.sh`);
    adb(`push ${probePath} /data/local/tmp/dev_probe.sh`);
}
function killAllServers() {
    try { sh('sh /data/local/tmp/dev_clean.sh'); } catch (e) { log('清理异常(忽略):', e.message.slice(0, 80)); }
}
function probe() {
    const out = sh('sh /data/local/tmp/dev_probe.sh');
    const procs = parseInt((out.match(/procs=(\d+)/) || [])[1] || '0', 10);
    const ports = (out.split('\n')[1] || '').trim().split(/\s+/).filter(Boolean).map(Number);
    return { procs, ports };
}

// ---- 清理旧 forward ----
try { adb(`forward --remove tcp:${LOCAL_PORT}`); } catch (e) { /* ignore */ }

let adbShellProc = null;
function ensureServer() {
    ensureHelperScripts();
    // 设备可能清理 /data/local/tmp，jar 会丢；先确保在位
    try {
        const jarStat = sh('ls -la /data/local/tmp/scrcpy-server.jar');
        if (!jarStat.includes('scrcpy-server.jar')) { throw new Error('missing'); }
    } catch (e) {
        log('设备端 jar 缺失，重新推送...');
        adb('push /data/ws-scrcpy-new/vendor/Genymobile/scrcpy/scrcpy-server.jar /data/local/tmp/scrcpy-server.jar');
    }
    killAllServers();
    const before = probe();
    log('清理后: server 进程', before.procs, '| 端口', JSON.stringify(before.ports));
    if (before.ports.includes(DEVICE_PORT)) {
        console.error(`FAIL: 端口 ${DEVICE_PORT} 清理后仍被占用`);
        process.exit(1);
    }
    log('启动 scrcpy server（adb shell 长连接保活）...');
    adbShellProc = spawn('adb', ['-s', udid, 'shell',
        `CLASSPATH=/data/local/tmp/scrcpy-server.jar nohup app_process / com.genymobile.scrcpy.Server 1.19-ws8 web ERROR ${DEVICE_PORT} true 2>&1 > /dev/null`],
        { stdio: ['ignore', 'pipe', 'pipe'] });
    adbShellProc.stdout.on('data', (d) => process.stdout.write('[server-out] ' + d.toString()));
    adbShellProc.stderr.on('data', (d) => process.stdout.write('[server-err] ' + d.toString()));
    adbShellProc.on('exit', (code) => log('[adb-shell 退出]', code));
    // 轮询等待端口监听（最多 15s）
    const deadline = Date.now() + 15000;
    const poll = () => {
        const p = probe();
        if (p.ports.includes(DEVICE_PORT)) {
            log(`server 已监听 ${DEVICE_PORT}（进程数 ${p.procs}）`);
            return Promise.resolve();
        }
        if (Date.now() > deadline) {
            console.error('FAIL: server 15s 内未监听目标端口');
            process.exit(1);
        }
        return sleep(500).then(poll);
    };
    return poll();
}

ensureServer().then(() => {
    adb(`forward tcp:${LOCAL_PORT} tcp:${DEVICE_PORT}`);
    log('forward 就绪: tcp:' + LOCAL_PORT + ' -> tcp:' + DEVICE_PORT);
    return connect();
}).catch((e) => { console.error('ensureServer 失败:', e.message); process.exit(1); });

function connect() {
// ---- initial-info 解析 ----
function parseInitial(buf) {
    let off = 14 + 64;
    const displaysCount = buf.readInt32BE(off); off += 4;
    const displays = [];
    for (let i = 0; i < displaysCount; i++) {
        const displayId = buf.readInt32BE(off);
        const w = buf.readInt32BE(off + 4);
        const h = buf.readInt32BE(off + 8);
        off += 24;
        off += 4; // connectionCount
        const siLen = buf.readInt32BE(off); off += 4;
        let screenInfo = null;
        if (siLen) { const si = buf.slice(off, off + siLen); off += siLen; screenInfo = { videoSize: [si.readInt32BE(16), si.readInt32BE(20)] }; }
        const vsLen = buf.readInt32BE(off); off += 4;
        let videoSettings = null;
        if (vsLen) {
            const vs = buf.slice(off, off + vsLen); off += vsLen;
            videoSettings = {
                bitrate: vs.readInt32BE(0),
                maxFps: vs.readInt32BE(4),
                bounds: (vs.readInt16BE(9) && vs.readInt16BE(11)) ? [vs.readInt16BE(9), vs.readInt16BE(11)] : null,
            };
        }
        displays.push({ displayId, displaySize: [w, h], screenInfo, videoSettings });
    }
    return displays;
}

// ---- SetVideoSettings（与 CommandControlMessage.createSetVideoSettingsCommand 布局一致）----
function buildSetVideoSettings({ bitrate, maxFps, iFrameInterval, w, h, displayId }) {
    const vs = Buffer.alloc(35);
    let o = 0;
    vs.writeInt32BE(bitrate, o); o += 4;
    vs.writeInt32BE(maxFps, o); o += 4;
    vs.writeInt8(iFrameInterval, o); o += 1;
    vs.writeInt16BE(w, o); o += 2;
    vs.writeInt16BE(h, o); o += 2;
    o += 8; // crop 全 0
    vs.writeInt8(0, o); o += 1; // sendFrameMeta
    vs.writeInt8(-1, o); o += 1; // lockedVideoOrientation
    vs.writeInt32BE(displayId, o); o += 4;
    vs.writeInt32BE(0, o); o += 4; // codecOptions 长度 0
    vs.writeInt32BE(0, o); o += 4; // encoderName 长度 0
    const cmd = Buffer.alloc(1 + vs.length);
    cmd.writeUInt8(101, 0);
    vs.copy(cmd, 1);
    return cmd;
}

function spsResolution(nal) {
    try {
        const r = H264Parser.parseSPS(nal);
        const width = Math.ceil(
            ((r.pic_width_in_mbs_minus1 + 1) * 16 - r.frame_crop_left_offset * 2 - r.frame_crop_right_offset * 2) * (r.sar[0] / r.sar[1]),
        );
        const height =
            (2 - r.frame_mbs_only_flag) * (r.pic_height_in_map_units_minus1 + 1) * 16 -
            (r.frame_mbs_only_flag ? 2 : 4) * (r.frame_crop_top_offset + r.frame_crop_bottom_offset);
        return [width, height];
    } catch (e) { return null; }
}

// ---- 连接设备端 server ----
const ws = new WebSocket(`ws://127.0.0.1:${LOCAL_PORT}`, { perMessageDeflate: false });
ws.binaryType = 'arraybuffer';
let pushed = false;
let pushedAt = 0;
const spsBefore = [];
const spsAfter = [];
let nalCount = 0;
let idrAfterPush = 0;
let firstDataAt = 0;
const t0 = Date.now();

const finish = (code) => {
    try { ws.close(); } catch (e) { /**/ }
    try { adbShellProc && adbShellProc.kill(); } catch (e) { /**/ }
    // 可靠清理：杀设备端所有 scrcpy server + 移除 forward（异步分离执行，不阻塞退出）
    try {
        const cleanup = spawn('adb', ['-s', udid, 'shell', 'sh /data/local/tmp/dev_clean.sh'], { stdio: 'ignore', detached: true });
        cleanup.unref();
        spawn('adb', ['-s', udid, 'forward', '--remove', `tcp:${LOCAL_PORT}`], { stdio: 'ignore', detached: true }).unref();
    } catch (e) { /**/ }
    setTimeout(() => process.exit(code), 500);
};

ws.on('open', () => log('ws 已连接（直连设备端），等待 initial-info...'));
ws.on('error', (e) => { log('ws 错误:', e.message); finish(1); });
ws.on('unexpected-response', (req, res) => { log('unexpected-response', res.statusCode); finish(1); });
ws.on('close', (code, reason) => { log('ws 关闭', code, reason.toString()); });

// 防回路：只在第一条 initial-info 时推送；后续 initial-info 是服务器回显，只记录不推
let everPushed = false;
let frameLogCount = 0;

ws.on('message', (data, isBinary) => {
    if (!firstDataAt) { firstDataAt = Date.now(); log(`收到首个数据（握手后 ${firstDataAt - t0}ms，binary=${isBinary}）`); }
    if (typeof data === 'string') { log('文本消息:', data.slice(0, 200)); return; }
    const buf = Buffer.from(data);
    if (frameLogCount < 12) {
        frameLogCount++;
        log(`帧#${frameLogCount} len=${buf.length} head=${buf.slice(0, 16).toString('hex')} ascii=${JSON.stringify(buf.slice(0, 16).toString('latin1'))}`);
    }
    if (buf.length > 14 && buf.slice(0, 14).toString() === 'scrcpy_initial') {
        const displays = parseInitial(buf);
        log('initial-info:');
        displays.forEach((d) => {
            log(`  display ${d.displayId} 设备尺寸=${d.displaySize} screenInfo.videoSize=${d.screenInfo ? d.screenInfo.videoSize : '无'}`);
            log(`  服务端当前 videoSettings: ${JSON.stringify(d.videoSettings)}`);
        });
        if (everPushed) {
            log('（服务器回显，不重复推送）');
            return;
        }
        everPushed = true;
        const d = displays[0];
        const maxSide = Math.max(d.displaySize[0], d.displaySize[1]);
        const side = Math.min(maxSide, MAX_BOUNDS_SIDE) & ~15;
        log(`推送画质策略: bounds=${side}x${side} bitrate=${MAX_BITRATE} maxFps=${MAX_FPS}`);
        ws.send(buildSetVideoSettings({ bitrate: MAX_BITRATE, maxFps: MAX_FPS, iFrameInterval: 5, w: side, h: side, displayId: d.displayId }));
        pushed = true;
        pushedAt = Date.now();
        return;
    }
    if (buf.length > 14 && buf.slice(0, 14).toString() === 'scrcpy_message') return;
    // 视频 NAL：每帧带 4 字节 Annex-B 起始码，NAL 头在第 5 字节（与 WebCodecsPlayer 一致）
    if (buf.length < 6) return;
    nalCount++;
    const nalType = buf[4] & 0x1f;
    if (nalType === 5 && pushed) idrAfterPush++;
    if (nalType === 7) {
        const res = spsResolution(buf.slice(4));
        if (res) {
            log(`SPS → ${res[0]}x${res[1]}${pushed ? '（推送后）' : '（推送前）'}`);
            (pushed ? spsAfter : spsBefore).push(res);
        }
    }
});

// 结果判定独立定时器：推送后再等（屏幕静止时没有新帧，不能依赖消息触发）
const resultTimer = setInterval(() => {
    if (!pushed) { return; }
    const elapsed = Date.now() - pushedAt;
    // 拿到推送后的 SPS 再稳 3s 即可出结果；最多等 20s
    if (!((spsAfter.length > 0 && elapsed > 3000) || elapsed > 20000)) { return; }
    clearInterval(resultTimer);
    log('\n===== 结果 =====');
    log(`NAL ${nalCount} 个，推送后 IDR ${idrAfterPush} 个`);
    if (spsAfter.length) {
        const last = spsAfter[spsAfter.length - 1];
        log(`推送后实际编码分辨率: ${last[0]}x${last[1]}`);
        if (physical) {
            const maxNative = Math.max(physical[0], physical[1]);
            const maxEnc = Math.max(last[0], last[1]);
            const expect = Math.min(maxNative, MAX_BOUNDS_SIDE);
            const ok = maxEnc >= expect * 0.95;
            log(`期望长边 ≈ ${expect}（原生 ${maxNative}${maxNative > MAX_BOUNDS_SIDE ? '，1920 封顶' : ''}）`);
            log(ok ? 'PASS: 编码尺寸吃满原生' : `FAIL: 编码长边 ${maxEnc} < 期望 ${expect}`);
            finish(ok ? 0 : 1);
            return;
        }
    } else {
        log('FAIL: 推送后未收到 SPS');
    }
    finish(spsAfter.length ? 0 : 1);
}, 500);

setTimeout(() => { log('超时（60s）'); finish(1); }, 60000);
} // end connect()
