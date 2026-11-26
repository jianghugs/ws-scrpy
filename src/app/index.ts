import '../style/app.css';
import { StreamClientScrcpy } from './googDevice/client/StreamClientScrcpy';
import { HostTracker } from './client/HostTracker';
import { Tool } from './client/Tool';
import KeyEvent from './googDevice/android/KeyEvent';
import { KeyCodeControlMessage } from './controlMessage/KeyCodeControlMessage';

window.onload = async function (): Promise<void> {
    const hash = location.hash.replace(/^#!/, '');
    const parsedQuery = new URLSearchParams(hash);
    // 参数既支持写在 #! 之后（原生方式），也支持写在 ?query 里（便于外部拼接 URL）
    // 同名参数以 #! 中的为准
    new URLSearchParams(location.search).forEach((value: string, name: string) => {
        if (!parsedQuery.has(name)) {
            parsedQuery.set(name, value);
        }
    });
    const action = parsedQuery.get('action');

    /// #if USE_BROADWAY
    const { BroadwayPlayer } = await import('./player/BroadwayPlayer');
    StreamClientScrcpy.registerPlayer(BroadwayPlayer);
    /// #endif

    /// #if USE_H264_CONVERTER
    const { MsePlayer } = await import('./player/MsePlayer');
    StreamClientScrcpy.registerPlayer(MsePlayer);
    /// #endif

    /// #if USE_TINY_H264
    const { TinyH264Player } = await import('./player/TinyH264Player');
    StreamClientScrcpy.registerPlayer(TinyH264Player);
    /// #endif

    /// #if USE_WEBCODECS
    const { WebCodecsPlayer } = await import('./player/WebCodecsPlayer');
    StreamClientScrcpy.registerPlayer(WebCodecsPlayer);
    /// #endif

    if (action === StreamClientScrcpy.ACTION && typeof parsedQuery.get('udid') === 'string') {
        const streamClient = StreamClientScrcpy.start(parsedQuery);
        // --- iframe embed: report actual video aspect ratio to parent window ---
        // .video div is layout-sized (width/height 100%), so its contentRect does NOT
        // follow the stream. The media element's intrinsic size (videoWidth/videoHeight
        // for <video>, width/height attributes for <canvas>) is the real stream ratio.
        setTimeout(() => {
            let lastRatio = 0;
            const report = (): void => {
                const media = document.querySelector('.video video, .video canvas') as
                    | (HTMLVideoElement | HTMLCanvasElement)
                    | null;
                if (!media) {
                    return;
                }
                let w = 0;
                let h = 0;
                const v = media as HTMLVideoElement;
                const c = media as HTMLCanvasElement;
                if (v.videoWidth && v.videoHeight) {
                    w = v.videoWidth;
                    h = v.videoHeight;
                } else if (c.width && c.height) {
                    w = c.width;
                    h = c.height;
                }
                if (w > 0 && h > 0) {
                    const ratio = w / h;
                    if (Math.abs(ratio - lastRatio) > 0.01) {
                        lastRatio = ratio;
                        window.parent.postMessage(`iframe_message_resize_${ratio}`, '*');
                    }
                }
            };
            setTimeout(report, 500);
            setInterval(report, 800);
        }, 600);

        // --- iframe embed: 右侧工具栏隐藏开关 ---
        // 1) URL 参数: ?hideToolbar=1
        // 2) 父页面 postMessage: 'hide' / 'hide_toolbar' 隐藏，'show' / 'show_toolbar' 显示
        let hideToolbar = (() => {
            const v = (parsedQuery.get('hideToolbar') || '').toLowerCase();
            return v === '1' || v === 'true' || v === 'yes';
        })();
        const applyToolbar = (): void => {
            const list = document.querySelector('.control-buttons-list') as HTMLElement | null;
            if (list) {
                list.style.display = hideToolbar ? 'none' : '';
            }
        };
        setInterval(applyToolbar, 500);
        window.addEventListener('message', (event) => {
            if (event.data === 'hide' || event.data === 'hide_toolbar') {
                hideToolbar = true;
                applyToolbar();
            } else if (event.data === 'show' || event.data === 'show_toolbar') {
                hideToolbar = false;
                applyToolbar();
            }
        });
        // --- end 工具栏开关 ---

        // --- iframe embed: 右键 = 返回键（与 PC 版 scrcpy 行为一致）---
        // 1) 画面内右键：屏蔽浏览器右键菜单，改为下发 KEYCODE_BACK（DOWN+UP）
        // 2) 拦截 button===2 的鼠标事件进入触控链路，避免设备上形成二次触摸
        // 3) 多设备同步：主控右键上报 touch_report_back，从机收到 touch_inject_back 后同样返回
        const sendAndroidBack = (): void => {
            try {
                streamClient.sendMessage(
                    new KeyCodeControlMessage(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_BACK, 0, 0),
                );
                streamClient.sendMessage(
                    new KeyCodeControlMessage(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_BACK, 0, 0),
                );
            } catch (error) {
                console.warn('[RightClickBack] 发送返回键失败', error);
            }
        };
        const isInsideVideo = (target: EventTarget | null): boolean => {
            const video = document.querySelector('.video');
            return !!video && !!target && video.contains(target as Node);
        };
        document.addEventListener('contextmenu', (event: MouseEvent) => {
            if (!isInsideVideo(event.target)) {
                return; // 工具栏等区域的右键保持浏览器默认行为
            }
            event.preventDefault();
            sendAndroidBack();
            if (window.parent !== window) {
                window.parent.postMessage('touch_report_back', '*');
            }
        });
        ['mousedown', 'mouseup', 'mousemove'].forEach((type) => {
            document.addEventListener(
                type,
                (event: Event) => {
                    const mouseEvent = event as MouseEvent;
                    const isRight =
                        type === 'mousemove' ? mouseEvent.buttons === 2 : mouseEvent.button === 2;
                    if (isRight && isInsideVideo(mouseEvent.target)) {
                        mouseEvent.stopPropagation(); // 阻止到达 document.body 上的触控监听
                    }
                },
                true,
            );
        });
        // --- end 右键返回 ---

        // --- iframe embed: 多设备同步操控（主控 → 从机）---
        // 上报：把本页鼠标事件按 0-1 比例坐标 postMessage 给父窗口
        // 注入：收到父窗口下发的 touch_inject_<type>_<x>_<y>，在本页模拟派发鼠标事件
        // 用比例而非像素坐标，因为各台手机的分辨率和容器大小都不同
        // 注意：注入必须派发在 .touch-layer 上——它是 player.getTouchableElement() 返回的
        // canvas（z-index 1 盖在画面上，用户真实点的也是它）。FeaturedInteractionHandler
        // 会校验 event.target === touch-layer，派发在 .video 容器上会被直接丢弃。
        const syncVideo = (): HTMLElement | null => {
            return document.querySelector('.video') as HTMLElement | null;
        };
        const syncTouchLayer = (): HTMLElement | null => {
            return document.querySelector('.video .touch-layer') as HTMLElement | null;
        };
        const syncReport = (event: MouseEvent): void => {
            if (window.parent === window) {
                return; // 不在 iframe 中，无需上报
            }
            if (event.buttons & 2 || event.button === 2) {
                return; // 右键不参与触摸同步（右键走返回键逻辑）
            }
            const el = syncVideo();
            if (!el) {
                return;
            }
            const rect = el.getBoundingClientRect();
            if (!rect.width || !rect.height) {
                return;
            }
            const x = (event.clientX - rect.left) / rect.width;
            const y = (event.clientY - rect.top) / rect.height;
            if (x < 0 || x > 1 || y < 0 || y > 1) {
                return; // 点在画面之外（例如点在工具栏上）
            }
            window.parent.postMessage(`touch_report_${event.type}_${x.toFixed(4)}_${y.toFixed(4)}`, '*');
        };
        document.addEventListener('mousedown', syncReport, true);
        document.addEventListener('mouseup', syncReport, true);
        document.addEventListener(
            'mousemove',
            (event: MouseEvent) => {
                if (event.buttons) {
                    syncReport(event); // 只在按住拖动时上报，避免无意义流量
                }
            },
            true,
        );
        window.addEventListener('message', (event) => {
            if (typeof event.data !== 'string' || event.data.indexOf('touch_inject_') !== 0) {
                return;
            }
            if (event.data === 'touch_inject_back') {
                sendAndroidBack(); // 主控右键返回 → 从机同步返回
                return;
            }
            const parts = event.data.split('_'); // ['touch','inject',type,x,y]
            const type = parts[2];
            const x = parseFloat(parts[3]);
            const y = parseFloat(parts[4]);
            if (!type || !isFinite(x) || !isFinite(y)) {
                return;
            }
            const el = syncTouchLayer();
            if (!el) {
                return;
            }
            const rect = el.getBoundingClientRect();
            el.dispatchEvent(
                new MouseEvent(type, {
                    bubbles: true, // 必须冒泡：触控监听绑在 document.body 上
                    cancelable: true,
                    view: window,
                    clientX: rect.left + x * rect.width,
                    clientY: rect.top + y * rect.height,
                    buttons: type === 'mouseup' ? 0 : 1, // mouseup 时按键已松开
                }),
            );
        });
        // --- end 同步操控 ---
        return;
    }

    /// #if INCLUDE_APPL
    {
        const { DeviceTracker } = await import('./applDevice/client/DeviceTracker');

        /// #if USE_QVH_SERVER
        const { StreamClientQVHack } = await import('./applDevice/client/StreamClientQVHack');

        DeviceTracker.registerTool(StreamClientQVHack);

        /// #if USE_WEBCODECS
        const { WebCodecsPlayer } = await import('./player/WebCodecsPlayer');
        StreamClientQVHack.registerPlayer(WebCodecsPlayer);
        /// #endif

        /// #if USE_H264_CONVERTER
        const { MsePlayerForQVHack } = await import('./player/MsePlayerForQVHack');
        StreamClientQVHack.registerPlayer(MsePlayerForQVHack);
        /// #endif

        if (action === StreamClientQVHack.ACTION && typeof parsedQuery.get('udid') === 'string') {
            StreamClientQVHack.start(StreamClientQVHack.parseParameters(parsedQuery));
            return;
        }
        /// #endif

        /// #if USE_WDA_MJPEG_SERVER
        const { StreamClientMJPEG } = await import('./applDevice/client/StreamClientMJPEG');
        DeviceTracker.registerTool(StreamClientMJPEG);

        const { MjpegPlayer } = await import('./player/MjpegPlayer');
        StreamClientMJPEG.registerPlayer(MjpegPlayer);

        if (action === StreamClientMJPEG.ACTION && typeof parsedQuery.get('udid') === 'string') {
            StreamClientMJPEG.start(StreamClientMJPEG.parseParameters(parsedQuery));
            return;
        }
        /// #endif
    }
    /// #endif

    const tools: Tool[] = [];

    /// #if INCLUDE_ADB_SHELL
    const { ShellClient } = await import('./googDevice/client/ShellClient');
    if (action === ShellClient.ACTION && typeof parsedQuery.get('udid') === 'string') {
        ShellClient.start(ShellClient.parseParameters(parsedQuery));
        return;
    }
    tools.push(ShellClient);
    /// #endif

    /// #if INCLUDE_DEV_TOOLS
    const { DevtoolsClient } = await import('./googDevice/client/DevtoolsClient');
    if (action === DevtoolsClient.ACTION) {
        DevtoolsClient.start(DevtoolsClient.parseParameters(parsedQuery));
        return;
    }
    tools.push(DevtoolsClient);
    /// #endif

    /// #if INCLUDE_FILE_LISTING
    const { FileListingClient } = await import('./googDevice/client/FileListingClient');
    if (action === FileListingClient.ACTION) {
        FileListingClient.start(FileListingClient.parseParameters(parsedQuery));
        return;
    }
    tools.push(FileListingClient);
    /// #endif

    if (tools.length) {
        const { DeviceTracker } = await import('./googDevice/client/DeviceTracker');
        tools.forEach((tool) => {
            DeviceTracker.registerTool(tool);
        });
    }
    HostTracker.start();
};
