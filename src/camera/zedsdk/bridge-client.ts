/**
 * WebSocket client for tools/zed-bridge/server.py. Decodes each binary frame
 * (JPEG -> ImageBitmap, zlib depth/confidence -> typed arrays) off the frame
 * loop and hands the newest decoded frame to listeners. When a decode is in
 * flight, newer messages replace the pending one (never a queue), so a slow
 * tab sees the latest frame, not a growing backlog.
 */
import { parseBridgeMessage, type BridgeHeader } from './protocol';

export interface DecodedBridgeFrame {
  header: BridgeHeader;
  image: ImageBitmap;
  /** uint16 millimetres, depthWidth x depthHeight, row-major, top row first. */
  depthMm: Uint16Array;
  /** 0..255, 255 best, same grid. */
  confidence: Uint8Array;
  /** performance.now() when the decode finished. */
  receivedAt: number;
  /** Bridge send -> browser receive (ms, wall clock, same machine). */
  transportMs: number;
  /** Receive -> decoded (ms). */
  decodeMs: number;
}

export interface BridgeStats {
  connected: boolean;
  /** Decoded frames per second over the last window. */
  fps: number;
  /** Frames received but skipped because a decode was in flight. */
  dropped: number;
  frames: number;
  /** Average bridge send -> browser receive (ms) over the last window. */
  transportMs: number;
  /** Average decode time (ms) over the last window. */
  decodeMs: number;
  bytesPerSecond: number;
  /** Text from the bridge's hello message. */
  source: string;
  error: string | null;
}

export interface ZedBridgeClientOptions {
  url: string;
  /** Reconnect delay (ms) after a drop; 0 disables reconnects. Default 1000. */
  reconnectMs?: number;
}

type Listener = (frame: DecodedBridgeFrame) => void;

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') throw new Error('zed-bridge: DecompressionStream unavailable');
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

export class ZedBridgeClient {
  readonly stats: BridgeStats = { connected: false, fps: 0, dropped: 0, frames: 0, transportMs: 0, decodeMs: 0, bytesPerSecond: 0, source: '', error: null };
  private ws: WebSocket | null = null;
  private readonly listeners = new Set<Listener>();
  private pending: ArrayBuffer | null = null;
  private decoding = false;
  private closed = false;
  private readonly reconnectMs: number;
  private windowStart = 0;
  private windowFrames = 0;
  private windowTransport = 0;
  private windowDecode = 0;
  private windowBytes = 0;

  constructor(private readonly options: ZedBridgeClientOptions) {
    this.reconnectMs = options.reconnectMs ?? 1000;
  }

  get url(): string {
    return this.options.url;
  }

  onFrame(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Resolves once the socket is open (or rejects when the first connection fails). */
  connect(): Promise<void> {
    this.closed = false;
    return new Promise((resolve, reject) => {
      let settled = false;
      const open = (): void => {
        const ws = new WebSocket(this.options.url);
        ws.binaryType = 'arraybuffer';
        this.ws = ws;
        ws.onopen = () => {
          this.stats.connected = true;
          this.stats.error = null;
          if (!settled) {
            settled = true;
            resolve();
          }
        };
        ws.onmessage = (ev: MessageEvent) => {
          if (typeof ev.data === 'string') {
            try {
              const msg = JSON.parse(ev.data) as { type?: string; source?: string };
              if (msg.type === 'hello' && msg.source) this.stats.source = msg.source;
            } catch {
              // ignore malformed text frames
            }
            return;
          }
          this.enqueue(ev.data as ArrayBuffer);
        };
        ws.onerror = () => {
          this.stats.error = `cannot reach ${this.options.url}`;
        };
        ws.onclose = () => {
          this.stats.connected = false;
          if (!settled) {
            settled = true;
            reject(new Error(this.stats.error ?? `zed-bridge: connection to ${this.options.url} closed`));
            return;
          }
          if (!this.closed && this.reconnectMs > 0) setTimeout(open, this.reconnectMs);
        };
      };
      open();
    });
  }

  /** Ask the bridge to reset positional tracking (origin back to the current camera pose). */
  resetTracking(): void {
    this.send({ cmd: 'reset' });
  }

  /** Switch the passthrough / depth sizes on the bridge. */
  configure(opts: { jpegWidth?: number; depthWidth?: number }): void {
    this.send({ cmd: 'config', ...opts });
  }

  private send(cmd: object): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(cmd));
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
    this.ws = null;
    this.stats.connected = false;
  }

  private enqueue(buffer: ArrayBuffer): void {
    this.windowBytes += buffer.byteLength;
    if (this.decoding) {
      if (this.pending) this.stats.dropped += 1;
      this.pending = buffer;
      return;
    }
    void this.decode(buffer);
  }

  private async decode(buffer: ArrayBuffer): Promise<void> {
    this.decoding = true;
    const receivedAt = performance.now();
    const receivedWall = Date.now();
    try {
      const msg = parseBridgeMessage(buffer);
      const [image, depthBytes, confBytes] = await Promise.all([
        createImageBitmap(new Blob([msg.jpeg as BlobPart], { type: 'image/jpeg' })),
        inflate(msg.depthZlib),
        inflate(msg.confZlib),
      ]);
      const n = msg.header.depthWidth * msg.header.depthHeight;
      const depthMm = new Uint16Array(depthBytes.buffer, depthBytes.byteOffset, Math.min(n, depthBytes.byteLength >> 1));
      const confidence = new Uint8Array(confBytes.buffer, confBytes.byteOffset, Math.min(n, confBytes.byteLength));
      const now = performance.now();
      const frame: DecodedBridgeFrame = {
        header: msg.header,
        image,
        depthMm,
        confidence,
        receivedAt: now,
        transportMs: receivedWall - msg.header.sentAt,
        decodeMs: now - receivedAt,
      };
      this.account(frame, now);
      for (const listener of this.listeners) listener(frame);
    } catch (err) {
      this.stats.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.decoding = false;
      const next = this.pending;
      this.pending = null;
      if (next && !this.closed) void this.decode(next);
    }
  }

  private account(frame: DecodedBridgeFrame, now: number): void {
    this.stats.frames += 1;
    this.windowFrames += 1;
    this.windowTransport += frame.transportMs;
    this.windowDecode += frame.decodeMs;
    if (this.windowStart === 0) this.windowStart = now;
    const dt = now - this.windowStart;
    if (dt >= 1000) {
      this.stats.fps = (this.windowFrames * 1000) / dt;
      this.stats.transportMs = this.windowTransport / this.windowFrames;
      this.stats.decodeMs = this.windowDecode / this.windowFrames;
      this.stats.bytesPerSecond = (this.windowBytes * 1000) / dt;
      this.windowStart = now;
      this.windowFrames = 0;
      this.windowTransport = 0;
      this.windowDecode = 0;
      this.windowBytes = 0;
    }
  }
}
