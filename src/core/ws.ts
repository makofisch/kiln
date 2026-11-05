import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

// A minimal WebSocket server side (RFC 6455) for Kiln's live updates: text frames from the server,
// pings to keep the line alive, and the client's close. Kiln's windows used Server-Sent Events, but
// Chromium keeps at most six HTTP/1.1 connections per host across all windows of the app, and every
// tab held one open for its events: with the tab strip and five tabs the pool was full, so a sixth tab
// could not even load and the other tabs' scene downloads stalled (an empty viewer). WebSockets don't
// count against that pool.

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Anything that receives the event stream: a WebSocket or an SSE response (for other local apps). */
export interface Sink {
  send(data: string): void;
  close(): void;
  onClose(fn: () => void): void;
}

function frame(opcode: number, payload: Buffer): Buffer {
  const n = payload.length;
  const head = n < 126 ? Buffer.alloc(2) : n < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
  head[0] = 0x80 | opcode;
  if (n < 126) head[1] = n;
  else if (n < 65536) {
    head[1] = 126;
    head.writeUInt16BE(n, 2);
  } else {
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(n), 2);
  }
  return Buffer.concat([head, payload]);
}

/** Completes the handshake and returns the connection, or null (the socket is then closed). */
export function acceptWebSocket(req: IncomingMessage, socket: Duplex): Sink | null {
  const key = req.headers['sec-websocket-key'];
  if (typeof key !== 'string' || (req.headers.upgrade ?? '').toLowerCase() !== 'websocket') {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return null;
  }
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const closers: Array<() => void> = [];
  let open = true;
  const finish = () => {
    if (!open) return;
    open = false;
    clearInterval(ping);
    for (const fn of closers) fn();
  };
  const ping = setInterval(() => open && socket.write(frame(0x9, Buffer.alloc(0))), 20_000);
  ping.unref();
  // Client frames: we only act on close (and answer pings); everything else is ignored.
  let buf = Buffer.alloc(0);
  socket.on('data', (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const op = buf[0]! & 0x0f;
      let len = buf[1]! & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      const masked = (buf[1]! & 0x80) !== 0;
      const total = off + (masked ? 4 : 0) + len;
      if (buf.length < total) return;
      const mask = masked ? buf.subarray(off, off + 4) : null;
      const body = Buffer.from(buf.subarray(off + (masked ? 4 : 0), total));
      if (mask) for (let i = 0; i < body.length; i++) body[i]! ^= mask[i % 4]!;
      buf = buf.subarray(total);
      if (op === 0x8) {
        if (open) socket.end(frame(0x8, Buffer.alloc(0)));
        finish();
        return;
      }
      if (op === 0x9) socket.write(frame(0xa, body));
    }
  });
  socket.on('close', finish);
  socket.on('error', finish);
  return {
    send(data) {
      if (open) socket.write(frame(0x1, Buffer.from(data, 'utf8')));
    },
    close() {
      if (!open) return;
      socket.end(frame(0x8, Buffer.alloc(0)));
      finish();
    },
    onClose(fn) {
      closers.push(fn);
    },
  };
}
