/**
 * AppuBot Connect's relay, cut down for tests: a room is claimed by the computer that signs
 * the relay's challenge with the room's key, and whoever joins it is multiplexed over that computer's socket (OPEN,
 * DATA, CLOSE). It copies bytes it can't read, as the real one does.
 */
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { RelayFrame, challengeMessage, decodeRelayFrame, encodeRelayFrame, roomIdForPublicKey } from '@appubot/protocol';

const toU8 = (d: RawData): Uint8Array => new Uint8Array(Buffer.isBuffer(d) ? d : Array.isArray(d) ? Buffer.concat(d) : Buffer.from(d));

export class FakeRelay {
  private wss: WebSocketServer;
  readonly hosts = new Map<string, WebSocket>();
  private joined = new Map<number, { ws: WebSocket; room: string }>();
  private next = 1;
  /** how many streams were opened to a room, ever */
  joins = 0;
  readonly listening: Promise<void>;

  constructor() {
    this.wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    this.listening = new Promise((r) => this.wss.once('listening', () => r()));
    this.wss.on('connection', (ws, req) => {
      const path = req.url ?? '';
      if (path === '/host') return this.host(ws, String(req.headers['x-connect-pubkey'] ?? ''));
      const m = /^\/join\/([a-z2-7]{26})$/.exec(path);
      if (m) return this.join(ws, m[1]!);
      ws.close();
    });
  }

  get url(): string { return `ws://127.0.0.1:${(this.wss.address() as AddressInfo).port}`; }

  private host(ws: WebSocket, pubB64: string): void {
    const pub = new Uint8Array(Buffer.from(pubB64, 'base64'));
    const nonce = crypto.getRandomValues(new Uint8Array(32));
    let room = '';
    ws.send(JSON.stringify({ t: 'challenge', nonce: Buffer.from(nonce).toString('base64') }));
    ws.on('message', async (data, isBinary) => {
      if (!isBinary) {
        const msg = JSON.parse(data.toString()) as { sig: string };
        const key = await crypto.subtle.importKey('raw', pub, { name: 'Ed25519' }, false, ['verify']);
        if (!(await crypto.subtle.verify('Ed25519', key, Buffer.from(msg.sig, 'base64'), challengeMessage(nonce)))) { ws.close(); return; }
        room = roomIdForPublicKey(pub);
        this.hosts.set(room, ws);
        ws.send(JSON.stringify({ t: 'ready', room }));
        return;
      }
      const bytes = toU8(data);
      const f = decodeRelayFrame(bytes);
      if (!f) return;
      if (f.type === RelayFrame.PING) { ws.send(bytes); return; }
      const peer = this.joined.get(f.streamId);
      if (!peer) return;
      if (f.type === RelayFrame.DATA) peer.ws.send(f.payload);
      if (f.type === RelayFrame.CLOSE) { this.joined.delete(f.streamId); peer.ws.close(); }
    });
    ws.on('close', () => {
      if (this.hosts.get(room) === ws) this.hosts.delete(room);
      for (const [id, p] of this.joined) if (p.room === room) { this.joined.delete(id); p.ws.close(); }
    });
  }

  private join(ws: WebSocket, room: string): void {
    const host = this.hosts.get(room);
    if (!host) { ws.send(JSON.stringify({ t: 'no_host' })); ws.close(); return; }
    const id = this.next++;
    this.joins += 1;
    this.joined.set(id, { ws, room });
    host.send(encodeRelayFrame(RelayFrame.OPEN, id, new TextEncoder().encode('203.0.113.7')));
    ws.send(JSON.stringify({ t: 'ready' }));
    ws.on('message', (data, isBinary) => { if (isBinary) host.send(encodeRelayFrame(RelayFrame.DATA, id, toU8(data))); });
    ws.on('close', () => { if (this.joined.delete(id)) host.send(encodeRelayFrame(RelayFrame.CLOSE, id)); });
  }

  close(): Promise<void> {
    for (const c of this.wss.clients) c.terminate();
    return new Promise((r) => this.wss.close(() => r()));
  }
}
