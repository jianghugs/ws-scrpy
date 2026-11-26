/* 端到端验证「群控台画质策略」：
 * 1. 以模拟客户端连上 8000 的 proxy-adb websocket（带 key）
 * 2. 读 initial-info：服务端当前各 display 的 videoSettings / screenInfo
 * 3. 按新画质策略推送 SetVideoSettings（12 Mbps / 30 fps / 原生盒子）
 * 4. 收集视频 NAL，解析推送后的 SPS → 真实编码分辨率
 * 5. 与 adb 上报的设备物理分辨率对比
 */
const WebSocket = require('/data/ws-scrcpy-new/node_modules/ws');
const H264Parser = require('/data/ws-scrcpy-new/node_modules/h264-converter/dist/h264-parser');
const { execSync } = require('child_process');

const KEY = process.env.WS_SCRCPY_API_KEY || "<your-api-key>";
const HOST = '127.0.0.1';
const PORT = 8000;
const MAX_BITRATE = 12582912;
const MAX_FPS = 30;
const MAX_BOUNDS_SIDE = 1920;

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---- 选设备：默认取列表最后一个；也可用 argv[2] 指定 ----
const devices = execSync('adb devices | grep -w device | awk \'{print $1}\'')
    .toString().trim().split('\n').filter(Boolean);
const udid = process.argv[2] || devices[devices.length - 1];
log('设备', udid, `（共 ${devices.length} 台）`);

// ---- 设备物理分辨率 ----
function physicalSize(u) {
    try {
        const out = execSync(`adb -s ${u} shell wm size`).toString();
        const m = out.match(/Physical size:\s*(\d+)x(\d+)/);
        const o = out.match(/Override size:\s*(\d+)x(\d+)/);
        return { physical: m ? [+m[1], +m[2]] : null, override: o ? [+o[1], +o[2]] : null };
    } catch (e) {
        return { physical: null, override: null };
    }
}
const sizes = physicalSize(udid);
log('adb 物理分辨率', JSON.stringify(sizes));

// ---- 解析 initial-info ----
function parseInitial(buf) {
    let off = 14; // 'scrdpy_initial' 魔术长度（含结尾 \0 则为 15，见下方修正）
    // Util.stringToUtf8ByteArray('scrdpy_initial') 长度 14
    off += 64; // device name 字段
    const displaysCount = buf.readInt32BE(off); off += 4;
    const displays = [];
    for (let i = 0; i < displaysCount; i++) {
        const displayId = buf.readInt32BE(off);
        const w = buf.readInt32BE(off + 4);
        const h = buf.readInt32BE(off + 8);
        const rotation = buf.readInt32BE(off + 12);
        off += 24;
        const connectionCount = buf.readInt32BE(off); off += 4;
        const siLen = buf.readInt32BE(off); off += 4;
        let screenInfo = null;
        if (siLen) {
            const si = buf.slice(off, off + siLen); off += siLen;
            screenInfo = { videoSize: [si.readInt32BE(16), si.readInt32BE(20)], rotation: si.readUInt8(24) };
        }
        const vsLen = buf.readInt32BE(off); off += 4;
        let videoSettings = null;
        if (vsLen) {
            const vs = buf.slice(off, off + vsLen); off += vsLen;
            videoSettings = parseVideoSettings(vs);
        }
        displays.push({ displayId, displaySize: [w, h], rotation, connectionCount, screenInfo, videoSettings });
    }
    return displays;
}

function parseVideoSettings(b) {
    let off = 0;
    const bitrate = b.readInt32BE(off); off += 4;
    const maxFps = b.readInt32BE(off); off += 4;
    const iFrameInterval = b.readInt8(off); off += 1;
    const width = b.readInt16BE(off); off += 2;
    const height = b.readInt16BE(off); off += 2;
    off += 8; // crop
    const sendFrameMeta = b.readInt8(off); off += 1;
    const lockedVideoOrientation = b.readInt8(off); off += 1;
    const displayId = b.readInt32BE(off); off += 4;
    return { bitrate, maxFps, iFrameInterval, bounds: width && height ? [width, height] : null, sendFrameMeta, lockedVideoOrientation, displayId };
}

// ---- 构造 SetVideoSettings 命令 ----
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
    cmd.writeUInt8(101, 0); // TYPE_CHANGE_STREAM_PARAMETERS
    vs.copy(cmd, 1);
    return cmd;
}

// ---- SPS → 分辨率 ----
function spsResolution(nal) {
    try {
        const r = H264Parser.parseSPS(nal);
        const width = Math.ceil(
            ((r.pic_width_in_mbs_minus1 + 1) * 16 - r.frame_crop_left_offset * 2 - r.frame_crop_right_offset * 2) *
            (r.sar[0] / r.sar[1]),
        );
        const height =
            (2 - r.frame_mbs_only_flag) * (r.pic_height_in_map_units_minus1 + 1) * 16 -
            (r.frame_mbs_only_flag ? 2 : 4) * (r.frame_crop_top_offset + r.frame_crop_bottom_offset);
        return [width, height];
    } catch (e) {
        return null;
    }
}

// ---- 主流程 ----
const wsUrl = `ws://${HOST}:${PORT}/?action=proxy-adb&remote=tcp:8886&udid=${udid}&key=${KEY}`;
log('连接', wsUrl.replace(KEY, '***'));
const ws = new WebSocket(wsUrl);
ws.binaryType = 'arraybuffer';

let pushed = false;
let displays = [];
const spsAfterPush = [];
let idrCount = 0;
let idrAfterPush = 0;
let nalCount = 0;
const startTime = Date.now();

const finish = (code) => {
    try { ws.close(); } catch (e) { /* ignore */ }
    setTimeout(() => process.exit(code), 300);
};

ws.on('open', () => log('ws 已连接'));
ws.on('error', (e) => { log('ws 错误', e.message); finish(1); });

ws.on('message', (data) => {
    if (typeof data === 'string') {
        log('文本消息:', data.slice(0, 120));
        return;
    }
    const buf = Buffer.from(data);
    if (buf.length > 14 && buf.slice(0, 14).toString() === 'scrdpy_initial') {
        displays = parseInitial(buf);
        log('initial-info:');
        displays.forEach((d) => {
            log(`  display ${d.displayId} 设备尺寸=${d.displaySize} 连接数=${d.connectionCount}`);
            log(`    screenInfo.videoSize=${d.screenInfo ? d.screenInfo.videoSize : '无'} 服务端videoSettings=${JSON.stringify(d.videoSettings)}`);
        });
        // 推送画质策略
        const d = displays[0];
        const maxSide = Math.max(d.displaySize[0], d.displaySize[1]);
        const side = Math.min(maxSide, MAX_BOUNDS_SIDE) & ~15;
        log(`推送画质策略: bounds=${side}x${side} bitrate=${MAX_BITRATE} maxFps=${MAX_FPS} displayId=${d.displayId}`);
        ws.send(buildSetVideoSettings({ bitrate: MAX_BITRATE, maxFps: MAX_FPS, iFrameInterval: 5, w: side, h: side, displayId: d.displayId }));
        pushed = true;
        return;
    }
    if (buf.length > 14 && buf.slice(0, 14).toString() === 'scrdpy_message') {
        return; // 设备消息
    }
    // 视频 NAL
    nalCount++;
    const nalType = buf[0] & 0x1f;
    if (nalType === 5) { idrCount++; if (pushed) idrAfterPush++; }
    if (nalType === 7) {
        const res = spsResolution(buf);
        if (res) {
            log(`SPS → 编码分辨率 ${res[0]}x${res[1]}${pushed ? '（推送后）' : '（推送前）'}`);
            if (pushed) spsAfterPush.push(res);
        }
    }
    // 12 秒后收尾
    if (Date.now() - startTime > 12000) {
        log(`\n===== 结果 =====`);
        log(`NAL 总数 ${nalCount}，IDR ${idrCount}（推送后 ${idrAfterPush}）`);
        if (spsAfterPush.length) {
            const last = spsAfterPush[spsAfterPush.length - 1];
            log(`推送后实际编码分辨率: ${last[0]}x${last[1]}`);
            log(`设备物理分辨率: ${sizes.physical ? sizes.physical.join('x') : '未知'}`);
            const native = sizes.physical;
            if (native) {
                const maxNative = Math.max(native[0], native[1]);
                const maxEnc = Math.max(last[0], last[1]);
                const ok = maxEnc >= Math.min(maxNative, MAX_BOUNDS_SIDE) * 0.95;
                log(ok ? 'PASS: 编码尺寸已吃满原生（或 1920 封顶值）' : `FAIL: 编码长边 ${maxEnc} 远小于原生长边 ${maxNative}`);
                finish(ok ? 0 : 1);
                return;
            }
        } else {
            log('FAIL: 推送后未收到 SPS');
        }
        finish(spsAfterPush.length ? 0 : 1);
    }
});

setTimeout(() => { log('超时'); finish(1); }, 60000);
