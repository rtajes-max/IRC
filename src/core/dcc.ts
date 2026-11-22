/** DCC: transferencia directa de archivos (SEND) y chat directo (CHAT) entre clientes. */
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';

export interface DccOffer {
  type: 'SEND' | 'CHAT';
  filename: string;
  ip: string;
  port: number;
  size: number;
}

export function ipToInt(ip: string): number {
  return ip.split('.').reduce((acc, o) => acc * 256 + (Number(o) & 255), 0);
}

export function intToIp(n: number): string {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

/** Interpreta los argumentos de un CTCP DCC, p. ej. `SEND "mi foto.png" 3232235777 5000 1234`. */
export function parseDccOffer(args: string): DccOffer | null {
  const m = /^(SEND|CHAT)\s+(?:"([^"]*)"|(\S+))\s+(\S+)\s+(\d+)(?:\s+(\d+))?/i.exec(args.trim());
  if (!m) return null;
  const port = Number(m[5]);
  if (port < 1 || port > 65535) return null; // DCC pasivo (puerto 0) no admitido
  const addr = m[4];
  const ip = /^\d+$/.test(addr) ? intToIp(Number(addr)) : addr;
  if (!net.isIP(ip)) return null;
  return { type: m[1].toUpperCase() as DccOffer['type'], filename: safeFilename(m[2] ?? m[3] ?? ''), ip, port, size: Number(m[6] ?? 0) };
}

/** Elimina rutas y caracteres peligrosos del nombre de archivo ofrecido por el remitente. */
export function safeFilename(name: string): string {
  const base = name.replace(/\\/g, '/').split('/').pop() ?? '';
  const clean = base.replace(/[\x00-\x1f<>:"|?*]/g, '_').replace(/^\.+/, '_').trim();
  return clean || 'archivo';
}

function uniquePath(dir: string, name: string): string {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = path.join(dir, name);
  for (let n = 1; fs.existsSync(candidate); n++) candidate = path.join(dir, `${stem} (${n})${ext}`);
  return candidate;
}

export class DccReceive extends EventEmitter {
  received = 0;
  path = '';
  private socket: net.Socket | null = null;
  private finished = false;

  constructor(public offer: DccOffer, private destDir: string) {
    super();
  }

  start(): void {
    fs.mkdirSync(this.destDir, { recursive: true });
    this.path = uniquePath(this.destDir, this.offer.filename);
    const out = fs.createWriteStream(this.path);
    const sock = net.connect({ host: this.offer.ip, port: this.offer.port });
    this.socket = sock;
    sock.setTimeout(60000, () => sock.destroy(new Error('tiempo de espera agotado')));
    const finish = (err?: Error) => {
      if (this.finished) return;
      this.finished = true;
      out.end(() => {
        const complete = !err && (this.offer.size === 0 || this.received >= this.offer.size);
        if (complete) this.emit('done', this.path);
        else this.emit('error', err ?? new Error('transferencia incompleta'));
      });
      sock.destroy();
    };
    sock.on('data', (chunk: Buffer) => {
      out.write(chunk);
      this.received += chunk.length;
      const ack = Buffer.alloc(4);
      ack.writeUInt32BE(this.received >>> 0);
      sock.write(ack);
      this.emit('progress', this.received, this.offer.size);
      if (this.offer.size > 0 && this.received >= this.offer.size) finish();
    });
    sock.on('error', (e) => finish(e));
    sock.on('close', () => finish());
  }

  cancel(): void {
    this.socket?.destroy(new Error('cancelado'));
  }
}

export class DccSend extends EventEmitter {
  sent = 0;
  size = 0;
  private server: net.Server | null = null;
  private finished = false;

  constructor(public filePath: string) {
    super();
  }

  /** Abre un puerto de escucha y devuelve los argumentos del CTCP DCC que hay que enviar. */
  listen(localIp: string, port = 0): Promise<string> {
    this.size = fs.statSync(this.filePath).size;
    return new Promise((resolve, reject) => {
      const server = net.createServer((sock) => {
        server.close();
        clearTimeout(timeout);
        const stream = fs.createReadStream(this.filePath);
        const finish = (err?: Error) => {
          if (this.finished) return;
          this.finished = true;
          stream.destroy();
          sock.destroy();
          if (err || this.sent < this.size) this.emit('error', err ?? new Error('transferencia interrumpida'));
          else this.emit('done');
        };
        stream.on('data', (chunk) => {
          this.sent += chunk.length;
          this.emit('progress', this.sent, this.size);
        });
        stream.on('error', (e) => finish(e));
        sock.on('data', () => undefined); // acuses de recibo
        sock.on('error', (e) => finish(e));
        sock.on('close', () => finish());
        stream.on('end', () => sock.end());
        stream.pipe(sock, { end: false });
      });
      this.server = server;
      const timeout = setTimeout(() => {
        server.close();
        if (!this.finished) {
          this.finished = true;
          this.emit('error', new Error('el destinatario no aceptó la transferencia'));
        }
      }, 120000);
      timeout.unref();
      server.on('error', reject);
      server.listen(port, () => {
        const addr = server.address() as net.AddressInfo;
        const name = path.basename(this.filePath);
        const quoted = name.includes(' ') ? `"${name}"` : name;
        resolve(`SEND ${quoted} ${ipToInt(localIp)} ${addr.port} ${this.size}`);
      });
    });
  }

  cancel(): void {
    this.server?.close();
  }
}

/** Chat DCC: conexión TCP directa, una línea por mensaje. */
export class DccChat extends EventEmitter {
  private socket: net.Socket | null = null;
  private server: net.Server | null = null;
  private buf = '';

  connect(ip: string, port: number): void {
    this.attach(net.connect({ host: ip, port }));
  }

  listen(localIp: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((sock) => {
        server.close();
        this.attach(sock);
        this.emit('open');
      });
      this.server = server;
      server.on('error', reject);
      server.listen(0, () => resolve(`CHAT chat ${ipToInt(localIp)} ${(server.address() as net.AddressInfo).port}`));
    });
  }

  private attach(sock: net.Socket): void {
    this.socket = sock;
    sock.setEncoding('utf8');
    sock.on('connect', () => this.emit('open'));
    sock.on('data', (d: string) => {
      this.buf += d;
      let i: number;
      while ((i = this.buf.indexOf('\n')) !== -1) {
        const line = this.buf.slice(0, i).replace(/\r$/, '');
        this.buf = this.buf.slice(i + 1);
        if (line) this.emit('line', line);
      }
    });
    sock.on('error', (e) => this.emit('error', e));
    sock.on('close', () => this.emit('close'));
  }

  write(line: string): boolean {
    if (!this.socket || this.socket.destroyed) return false;
    this.socket.write(line.split(/[\r\n]/)[0] + '\n');
    return true;
  }

  close(): void {
    this.server?.close();
    this.socket?.destroy();
  }
}
