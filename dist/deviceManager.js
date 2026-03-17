import sharp from "sharp";
import { deviceConfigsEqual } from "./config.js";
import { getRoot } from "./cdpRoot.js";
import { FrameProcessor } from "./frameProcessor.js";
import { DeviceBroadcaster } from "./broadcaster.js";
import { hash32 } from "./util.js";
import { SelfTestRunner } from "./selfTest.js";
const PREFERS_REDUCED_MOTION = /^(1|true|yes|on)$/i.test(process.env.PREFERS_REDUCED_MOTION ?? '');
const devices = new Map();
let _cleanupRunning = false;
export const broadcaster = new DeviceBroadcaster();
export async function ensureDeviceAsync(id, cfg) {
    const root = getRoot();
    if (!root)
        throw new Error("CDP not ready");
    let device = devices.get(id);
    if (device) {
        if (deviceConfigsEqual(device.cfg, cfg)) {
            device.lastActive = Date.now();
            device.processor.requestFullFrame();
            return device;
        }
        else {
            console.log(`[device] Reconfiguring device ${id}`);
            await deleteDeviceAsync(device);
        }
    }
    const { targetId } = await root.send('Target.createTarget', {
        url: 'about:blank',
        width: cfg.width,
        height: cfg.height,
    });
    const { sessionId } = await root.send('Target.attachToTarget', {
        targetId,
        flatten: true
    });
    const session = root.session(sessionId);
    await session.send('Page.enable');
    // Hide automation/webdriver flags — comprehensive anti-detection
    await session.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `
      (() => {
        const _def = (obj, prop, val) => {
          try { Object.defineProperty(obj, prop, { get: () => val, configurable: true }); } catch(_) {}
        };

        // webdriver
        _def(navigator, 'webdriver', undefined);

        // 语言 / 硬件
        _def(navigator, 'languages', ['zh-CN', 'zh', 'en-US', 'en']);
        _def(navigator, 'language',  'zh-CN');
        _def(navigator, 'hardwareConcurrency', 4);
        _def(navigator, 'deviceMemory', 4);
        _def(navigator, 'platform', 'Linux armv8l');

        // 触摸点数量（Pixel 7 = 5，默认 headless = 0，是关键检测点）
        _def(navigator, 'maxTouchPoints', 5);

        // devicePixelRatio（Pixel 7 ≈ 2.625；headless 默认 1 是强自动化信号）
        _def(window, 'devicePixelRatio', 2.625);

        // plugins — 符合 PluginArray 类型
        const fakePArr = Object.create(PluginArray.prototype);
        _def(fakePArr, 'length', 3);
        _def(navigator, 'plugins', fakePArr);

        // Chrome API stubs（headless 下这些会缺失）
        if (!window.chrome) window.chrome = {};
        if (!window.chrome.runtime) window.chrome.runtime = {};
        window.chrome.loadTimes = function() {
          const t = Date.now() / 1000;
          return { requestTime: t-1.5, startLoadTime: t-1.2, commitLoadTime: t-0.8,
            finishDocumentLoadTime: t-0.2, finishLoadTime: t-0.1,
            firstPaintTime: t-0.3, firstPaintAfterLoadTime: 0,
            navigationType: 'Other', wasFetchedViaSpdy: true,
            wasNpnNegotiated: true, npnNegotiatedProtocol: 'h2',
            wasAlternateProtocolAvailable: false, connectionInfo: 'h2' };
        };
        window.chrome.csi = function() {
          return { startE: Date.now()-800, onloadT: Date.now()-100, pageT: 700, tran: 15 };
        };
        window.chrome.app = {
          isInstalled: false,
          InstallState: { DISABLED:'disabled', INSTALLED:'installed', NOT_INSTALLED:'not_installed' },
          RunningState: { CANNOT_RUN:'cannot_run', READY_TO_RUN:'ready_to_run', RUNNING:'running' },
        };

        // outerWidth/Height（headless 下默认 0）
        _def(window, 'outerWidth',  window.innerWidth  || screen.width);
        _def(window, 'outerHeight', window.innerHeight || screen.height);

        // permissions
        const _origPermQuery = window.navigator.permissions.query.bind(navigator.permissions);
        window.navigator.permissions.query = (p) =>
          p.name === 'notifications'
            ? Promise.resolve({ state: Notification.permission, onchange: null })
            : _origPermQuery(p);

        // Notification.permission
        try { Object.defineProperty(Notification, 'permission', { get: () => 'default' }); } catch(_) {}

        // Connection API（移动端常见）
        if (!navigator.connection) {
          _def(navigator, 'connection', {
            effectiveType: '4g', downlink: 10, rtt: 50,
            saveData: false, type: 'wifi',
          });
        }
      })();
    `
    });
    await session.send('Emulation.setDeviceMetricsOverride', {
        width: cfg.width,
        height: cfg.height,
        deviceScaleFactor: 1,
        mobile: true,
        screenWidth: cfg.width,
        screenHeight: cfg.height,
    });
    // 启用触摸仿真：maxTouchPoints=0 是最常见的自动化检测点之一
    await session.send('Emulation.setTouchEmulationEnabled', {
        enabled: true,
        maxTouchPoints: 5,
    });
    await session.send('Emulation.setUserAgentOverride', {
        userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
        acceptLanguage: 'zh-CN,zh;q=0.9',
        platform: 'Linux armv8l',
        // Client Hints — 必须与 UA 一致，否则 navigator.userAgentData 会暴露真实的 macOS/x86
        userAgentMetadata: {
            brands: [
                { brand: 'Not_A Brand', version: '8' },
                { brand: 'Chromium', version: '120' },
                { brand: 'Google Chrome', version: '120' },
            ],
            fullVersion: '120.0.6099.109',
            platform: 'Android',
            platformVersion: '13',
            architecture: 'arm',
            model: 'Pixel 7',
            mobile: true,
            bitness: '64',
            wow64: false,
        },
    });
    // pointer:coarse + hover:none 告知页面是真实移动触控设备
    await session.send('Emulation.setEmulatedMedia', {
        media: 'screen',
        features: [
            { name: 'pointer', value: 'coarse' },
            { name: 'hover', value: 'none' },
            { name: 'any-pointer', value: 'coarse' },
            { name: 'any-hover', value: 'none' },
            ...(PREFERS_REDUCED_MOTION ? [{ name: 'prefers-reduced-motion', value: 'reduce' }] : []),
        ],
    });
    await session.send('Page.startScreencast', {
        format: 'jpeg',
        quality: 90,
        maxWidth: cfg.width,
        maxHeight: cfg.height,
        everyNthFrame: cfg.everyNthFrame
    });
    const processor = new FrameProcessor({
        tileSize: cfg.tileSize,
        fullframeTileCount: cfg.fullFrameTileCount,
        fullframeAreaThreshold: cfg.fullFrameAreaThreshold,
        jpegQuality: cfg.jpegQuality,
        fullFrameEvery: cfg.fullFrameEvery,
        maxBytesPerMessage: cfg.maxBytesPerMessage,
    });
    const newDevice = {
        id: targetId,
        deviceId: id,
        cdp: session,
        cfg: cfg,
        url: '',
        lastActive: Date.now(),
        frameId: 0,
        prevFrameHash: 0,
        processor,
        selfTestRunner: new SelfTestRunner(broadcaster),
        pendingB64: undefined,
        throttleTimer: undefined,
        lastProcessedMs: undefined,
    };
    devices.set(id, newDevice);
    newDevice.processor.requestFullFrame();
    const flushPending = async () => {
        const dev = newDevice;
        dev.throttleTimer = undefined;
        const b64 = dev.pendingB64;
        dev.pendingB64 = undefined;
        if (!b64)
            return;
        try {
            const imgBuf = Buffer.from(b64, 'base64');
            const h32 = hash32(imgBuf);
            if (dev.prevFrameHash === h32) {
                dev.lastProcessedMs = Date.now();
                return;
            }
            dev.prevFrameHash = h32;
            let img = sharp(imgBuf);
            if (dev.cfg.rotation)
                img = img.rotate(dev.cfg.rotation);
            const { data, info } = await img
                .ensureAlpha()
                .raw()
                .toBuffer({ resolveWithObject: true });
            const out = await processor.processFrameAsync({ data, width: info.width, height: info.height });
            if (out.rects.length > 0) {
                dev.frameId = (dev.frameId + 1) >>> 0;
                broadcaster.sendFrameChunked(id, out, dev.frameId, cfg.maxBytesPerMessage);
            }
        }
        catch (e) {
            console.warn(`[device] Failed to process frame for ${id}: ${e.message}`);
        }
        finally {
            dev.lastProcessedMs = Date.now();
        }
    };
    session.on('Page.screencastFrame', async (evt) => {
        // ACK immediately to keep producer running
        session.send('Page.screencastFrameAck', { sessionId: evt.sessionId }).catch(() => { });
        if (broadcaster.getClientCount(newDevice.deviceId) === 0)
            return;
        newDevice.lastActive = Date.now();
        newDevice.pendingB64 = evt.data;
        const now = Date.now();
        const since = newDevice.lastProcessedMs ? (now - newDevice.lastProcessedMs) : Infinity;
        if (!newDevice.throttleTimer) {
            const delay = Math.max(0, cfg.minFrameInterval - (Number.isFinite(since) ? since : 0));
            newDevice.throttleTimer = setTimeout(flushPending, delay);
        }
    });
    return newDevice;
}
export async function cleanupIdleAsync(ttlMs = 5 * 60000) {
    if (_cleanupRunning)
        return;
    _cleanupRunning = true;
    try {
        const now = Date.now();
        const staleIds = Array.from(devices.values())
            .filter(d => now - d.lastActive > ttlMs)
            .map(d => d.deviceId);
        for (const id of staleIds) {
            const dev = devices.get(id);
            if (!dev)
                continue;
            console.log(`[device] Cleaning up idle device ${id}`);
            await deleteDeviceAsync(dev).catch(() => { });
        }
    }
    finally {
        _cleanupRunning = false;
    }
}
async function deleteDeviceAsync(device) {
    const root = getRoot();
    if (!devices.delete(device.deviceId))
        return;
    if (device.throttleTimer)
        clearTimeout(device.throttleTimer);
    try {
        await device.cdp.send("Page.stopScreencast").catch(() => { });
    }
    catch { }
    try {
        await root?.send("Target.closeTarget", { targetId: device.id });
    }
    catch { }
}
