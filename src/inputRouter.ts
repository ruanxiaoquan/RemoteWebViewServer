import type { DeviceSession } from "./deviceManager.js";
import { TouchKind, KeyAction, parseFrameStatsPacket, parseOpenURLPacket, parseTouchPacket, parseKeyPacket } from "./protocol.js";
import { mapPointForRotation } from "./util.js";

export class InputRouter {
  /**
   * 最后一个 MOVE 的 CDP Promise（per device）。
   * UP 事件等待它完成后再发送，确保 touchEnd 不会在最后一个 touchMove 之前到达 Chrome。
   * MOVE 事件全部并发触发（不排队）：WebSocket 保证 Chrome 按序处理，无积压、无滞后。
   */
  private _lastMovePromise = new Map<string, Promise<void>>();

  public handleTouchPacketAsync(dev: DeviceSession, buf: Buffer): void {
    const pkt = parseTouchPacket(buf);
    if (!pkt) return;

    const id = dev.deviceId;

    if (pkt.kind === TouchKind.Move) {
      // 并发：不等待上一个 move 完成，立即触发，仅记录 promise 用于 UP 等待
      const p = this._dispatchTouchAsync(dev, pkt.kind, pkt.x, pkt.y, pkt.clientTs)
        .catch(() => {});
      this._lastMovePromise.set(id, p);

    } else if (pkt.kind === TouchKind.Up) {
      // UP：等最后一个 MOVE 完成后立即发送（通常只多 ~5ms）
      const last = this._lastMovePromise.get(id) ?? Promise.resolve();
      this._lastMovePromise.delete(id);
      last.then(() =>
        this._dispatchTouchAsync(dev, pkt.kind, pkt.x, pkt.y, pkt.clientTs).catch(() => {})
      );

    } else {
      // DOWN / TAP：立即发送
      this._dispatchTouchAsync(dev, pkt.kind, pkt.x, pkt.y, pkt.clientTs).catch(() => {});
    }
  }

  public async handleFrameStatsPacketAsync(dev: DeviceSession, buf: Buffer): Promise<void> {
    const value = parseFrameStatsPacket(buf);
    dev.selfTestRunner?.setFrameRenderTimeAsync(value ?? 0, dev.cdp);
  }

  public async handleKeyPacketAsync(dev: DeviceSession, buf: Buffer): Promise<void> {
    const pkt = parseKeyPacket(buf);
    if (!pkt) return;

    try {
      const type = pkt.action === KeyAction.Down ? 'keyDown' as const : 'keyUp' as const;

      if (pkt.action === KeyAction.Down && pkt.key.length === 1) {
        await dev.cdp.send('Input.dispatchKeyEvent', { type, key: pkt.key, text: pkt.key });
      } else {
        await dev.cdp.send('Input.dispatchKeyEvent', { type, key: pkt.key });
      }
    } catch (e) {
      console.warn(`Failed to dispatch key event: ${(e as Error).message}`);
    }
  }

  public async handleOpenURLPacketAsync(dev: DeviceSession, buf: Buffer): Promise<void> {
    const pkt = parseOpenURLPacket(buf);
      if (!pkt) return;

      if (pkt.url === "self-test") {
        await dev.selfTestRunner.startAsync(dev.deviceId, dev.cdp);
      } else {
        dev.selfTestRunner.stop();
        
        if (dev.url !== pkt.url)
          await dev.cdp.send('Page.navigate', { url: pkt.url });
      }
  }

  /**
   * 从客户端时间戳低 32 位还原完整 Unix 时间（秒）。
   * 使用服务端当前时间的高位补齐，处理 32-bit 溢出。
   */
  private _restoreTimestamp(clientTs: number | undefined): number {
    if (clientTs === undefined) return Date.now() / 1000;
    const serverMs = Date.now();
    // Date.now() 约 1.7e12，高 32 位 = floor(serverMs / 2^32) * 2^32
    const hi = Math.floor(serverMs / 0x100000000) * 0x100000000;
    let ms = hi + clientTs;
    // 处理溢出：若还原值比服务端时间大超过 5s，则减一个周期
    if (ms > serverMs + 5_000) ms -= 0x100000000;
    // 若还原值比服务端时间小超过 60s（队列积压），则加一个周期
    if (ms < serverMs - 60_000) ms += 0x100000000;
    return ms / 1000;
  }

  private async _dispatchTouchAsync(dev: DeviceSession, kind: TouchKind, x: number, y: number, clientTs?: number): Promise<void> {
    try {
      const rotated = mapPointForRotation(x, y, dev.cfg.width, dev.cfg.height, dev.cfg.rotation);
      // 使用客户端原始时间戳，让 CAPTCHA 的 event.timeStamp 反映真实拖动时序
      const ts = this._restoreTimestamp(clientTs);

      // 仿真真实手指：触点半径约 20px，压力 0.5
      const touchPoint = {
        x: rotated.x,
        y: rotated.y,
        radiusX: 20,
        radiusY: 20,
        rotationAngle: 0,
        force: 0.5,
        id: 1,
      };

      switch (kind) {
        case TouchKind.Down:
          // pointer → touch 顺序，确保 PointerEvent 和 TouchEvent 都能触发
          await dev.cdp.send('Input.dispatchTouchEvent', {
            type: 'touchStart',
            touchPoints: [touchPoint],
            timestamp: ts,
          });
          break;

        case TouchKind.Move:
          await dev.cdp.send('Input.dispatchTouchEvent', {
            type: 'touchMove',
            touchPoints: [touchPoint],
            timestamp: ts,
          });
          break;

        case TouchKind.Up:
          await dev.cdp.send('Input.dispatchTouchEvent', {
            type: 'touchEnd',
            touchPoints: [],
            timestamp: ts,
          });
          break;

        case TouchKind.Tap:
          await dev.cdp.send('Input.dispatchTouchEvent', {
            type: 'touchStart',
            touchPoints: [touchPoint],
            timestamp: ts,
          });
          await new Promise(r => setTimeout(r, 80 + Math.random() * 40));
          await dev.cdp.send('Input.dispatchTouchEvent', {
            type: 'touchEnd',
            touchPoints: [],
            timestamp: Date.now() / 1000,
          });
          break;
      }
    } catch (e) {
      console.warn(`Failed to dispatch touch event: ${(e as Error).message}`);
    }
  }
}
