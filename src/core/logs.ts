/** Registros de conversación en texto plano, un archivo por red y búfer. */
import * as fs from 'node:fs';
import * as path from 'node:path';

function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9#&_.\-À-￿]/g, '_').replace(/^\.+/, '_').slice(0, 80) || '_';
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export interface LogHit {
  network: string;
  buffer: string;
  line: string;
}

export class Logger {
  enabled = true;
  constructor(public dir: string) {}

  append(network: string, buffer: string, text: string, time = new Date()): void {
    if (!this.enabled) return;
    try {
      const folder = path.join(this.dir, safeName(network));
      fs.mkdirSync(folder, { recursive: true });
      fs.appendFileSync(path.join(folder, safeName(buffer) + '.log'), `[${stamp(time)}] ${text}\n`);
    } catch {
      /* un fallo al registrar nunca debe interrumpir el chat */
    }
  }

  search(query: string, limit = 200): LogHit[] {
    const hits: LogHit[] = [];
    const q = query.toLowerCase();
    if (!q || !fs.existsSync(this.dir)) return hits;
    for (const network of fs.readdirSync(this.dir)) {
      const folder = path.join(this.dir, network);
      if (!fs.statSync(folder).isDirectory()) continue;
      for (const file of fs.readdirSync(folder)) {
        if (!file.endsWith('.log')) continue;
        const lines = fs.readFileSync(path.join(folder, file), 'utf8').split('\n');
        for (let i = lines.length - 1; i >= 0; i--) {
          if (lines[i].toLowerCase().includes(q)) {
            hits.push({ network, buffer: file.slice(0, -4), line: lines[i] });
            if (hits.length >= limit) return hits;
          }
        }
      }
    }
    return hits;
  }
}
