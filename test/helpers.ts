import { ChildProcess, spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';

export const hasNgircd = spawnSync('sh', ['-c', 'command -v ngircd']).status === 0;

/** Arranca un servidor IRC real (ngircd) en un puerto local para las pruebas de integración. */
export async function startServer(port: number): Promise<ChildProcess> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onda-ircd-'));
  const conf = path.join(dir, 'ngircd.conf');
  fs.writeFileSync(
    conf,
    `[Global]\nName = irc.prueba.test\nInfo = Servidor de pruebas\nListen = 127.0.0.1\nPorts = ${port}\nPidFile = ${dir}/pid\nServerUID = ${process.getuid?.() ?? 0}\nServerGID = ${process.getgid?.() ?? 0}\n[Limits]\nMaxConnectionsIP = 0\nMaxNickLength = 20\n[Options]\nPAM = no\nIdent = no\nDNS = no\n`,
  );
  const proc = spawn('ngircd', ['-n', '-f', conf], { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    const ok = await new Promise<boolean>((resolve) => {
      const s = net.connect(port, '127.0.0.1', () => {
        s.destroy();
        resolve(true);
      });
      s.on('error', () => resolve(false));
    });
    if (ok) return proc;
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill();
  throw new Error('ngircd no arrancó');
}

export async function waitFor(cond: () => boolean, what: string, ms = 8000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`Tiempo agotado esperando: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
