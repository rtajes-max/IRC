import { ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppCore } from '../src/core/app';
import { DccChat, DccReceive, DccSend, intToIp, ipToInt, parseDccOffer, parseDccResume, safeFilename } from '../src/core/dcc';
import { DccInfo, Line, STATUS, UiEvent } from '../src/core/types';
import { hasNgircd, startServer, waitFor } from './helpers';

const PORT = 16672;

describe('DCC', () => {
  it('convierte direcciones y analiza ofertas', () => {
    expect(ipToInt('192.168.1.1')).toBe(3232235777);
    expect(intToIp(3232235777)).toBe('192.168.1.1');
    expect(parseDccOffer('SEND "mi foto.png" 3232235777 5000 1234')).toEqual({ type: 'SEND', filename: 'mi foto.png', ip: '192.168.1.1', port: 5000, size: 1234 });
    expect(parseDccOffer('CHAT chat 2130706433 4000')).toMatchObject({ type: 'CHAT', ip: '127.0.0.1', port: 4000 });
    expect(parseDccOffer('SEND x 2130706433 0 10 99')).toMatchObject({ port: 0, token: '99', size: 10 });
    expect(parseDccOffer('SEND x 2130706433 0 10')).toBeNull();
    expect(parseDccOffer('CHAT chat 2130706433 0 7')).toBeNull();
    expect(parseDccOffer('SEND x no-es-ip 80 10')).toBeNull();
  });

  it('neutraliza nombres de archivo peligrosos', () => {
    expect(safeFilename('../../etc/passwd')).toBe('passwd');
    expect(safeFilename('C:\\Windows\\system.ini')).toBe('system.ini');
    expect(safeFilename('.bashrc')).toBe('_bashrc');
    expect(safeFilename('')).toBe('archivo');
  });

  it('transfiere un archivo íntegro y no sobrescribe uno existente', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onda-dcc-'));
    const src = path.join(dir, 'origen.bin');
    const data = Buffer.alloc(300_000);
    for (let i = 0; i < data.length; i++) data[i] = (i * 31) & 255;
    fs.writeFileSync(src, data);
    const dest = path.join(dir, 'dest');
    fs.mkdirSync(dest);
    fs.writeFileSync(path.join(dest, 'origen.bin'), 'ya existía');

    const send = new DccSend(src);
    const offer = parseDccOffer(await send.listen('127.0.0.1'))!;
    const recv = new DccReceive(offer, dest);
    const done = new Promise<string>((resolve, reject) => {
      recv.on('done', resolve);
      recv.on('error', reject);
    });
    const sent = new Promise<void>((resolve, reject) => {
      send.on('done', resolve);
      send.on('error', reject);
    });
    recv.start();
    const file = await done;
    await sent;
    expect(path.basename(file)).toBe('origen (1).bin');
    expect(fs.readFileSync(file).equals(data)).toBe(true);
    expect(fs.readFileSync(path.join(dest, 'origen.bin'), 'utf8')).toBe('ya existía');
  });

  it('DCC pasivo: el receptor escucha y el remitente se conecta', async () => {
    const net = await import('node:net');
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'onda-pasivo-'));
    const data = Buffer.from('datos por dcc pasivo '.repeat(2000));
    const recv = new DccReceive(parseDccOffer(`SEND "mi archivo.txt" 2130706433 0 ${data.length} 77`)!, dest);
    const done = new Promise<string>((resolve, reject) => {
      recv.on('done', resolve);
      recv.on('error', reject);
    });
    const reply = await recv.listenPassive('127.0.0.1');
    const m = /^SEND "mi archivo.txt" 2130706433 (\d+) (\d+) 77$/.exec(reply)!;
    expect(Number(m[2])).toBe(data.length);
    const sock = net.connect(Number(m[1]), '127.0.0.1', () => sock.write(data));
    sock.on('data', () => undefined);
    const file = await done;
    expect(fs.readFileSync(file).equals(data)).toBe(true);
    sock.destroy();
  });

  it('envío pasivo de extremo a extremo: oferta con puerto 0, respuesta y conexión del remitente', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onda-pasivo2-'));
    const src = path.join(dir, 'foto grande.bin');
    const data = Buffer.alloc(150_000, 9);
    fs.writeFileSync(src, data);
    const send = new DccSend(src);
    const offer = parseDccOffer(send.passiveOffer('4242'))!;
    expect(offer).toMatchObject({ port: 0, token: '4242', size: data.length, filename: 'foto grande.bin' });
    const recv = new DccReceive(offer, path.join(dir, 'dest'));
    const done = new Promise<string>((resolve, reject) => {
      recv.on('done', resolve);
      recv.on('error', reject);
    });
    const sent = new Promise<void>((resolve, reject) => {
      send.on('done', resolve);
      send.on('error', reject);
    });
    const reply = parseDccOffer(await recv.listenPassive('127.0.0.1'))!;
    expect(reply.token).toBe('4242');
    send.connectTo(reply.ip, reply.port);
    expect(fs.readFileSync(await done).equals(data)).toBe(true);
    await sent;
  });

  it('reanuda una descarga interrumpida desde donde se quedó', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onda-resume-'));
    const src = path.join(dir, 'video.bin');
    const data = Buffer.alloc(400_000);
    for (let i = 0; i < data.length; i++) data[i] = (i * 7 + 3) & 255;
    fs.writeFileSync(src, data);
    const dest = path.join(dir, 'dest');
    fs.mkdirSync(dest);
    // Queda un «.part» con los primeros 150 000 bytes de un intento anterior.
    fs.writeFileSync(path.join(dest, 'video.bin.part'), data.subarray(0, 150_000));

    const send = new DccSend(src);
    const offer = parseDccOffer(await send.listen('127.0.0.1'))!;
    const recv = new DccReceive(offer, dest);
    expect(recv.resumePosition()).toBe(150_000);
    expect(parseDccResume(`RESUME video.bin ${offer.port} 150000`)).toEqual({ kind: 'RESUME', port: offer.port, position: 150_000 });
    expect(send.resumeFrom(150_000)).toBe(true);
    expect(send.resumeFrom(data.length)).toBe(false);
    let firstProgress = 0;
    send.on('progress', (n: number) => (firstProgress ||= n));
    const done = new Promise<string>((resolve, reject) => {
      recv.on('done', resolve);
      recv.on('error', reject);
    });
    recv.start(150_000);
    const file = await done;
    expect(path.basename(file)).toBe('video.bin');
    expect(fs.readFileSync(file).equals(data)).toBe(true);
    expect(firstProgress).toBeGreaterThan(150_000); // solo se envió lo que faltaba
    expect(fs.existsSync(path.join(dest, 'video.bin.part'))).toBe(false);
  });

  it('una descarga cortada deja el «.part» y no un archivo final incompleto', async () => {
    const net = await import('node:net');
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'onda-corte-'));
    const srv = net.createServer((sock) => {
      sock.on('error', () => undefined);
      sock.write(Buffer.alloc(1000, 1), () => sock.destroy());
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as import('node:net').AddressInfo).port;
    const recv = new DccReceive(parseDccOffer(`SEND doc.bin 2130706433 ${port} 5000`)!, dest);
    const err = await new Promise<Error>((resolve) => {
      recv.on('error', resolve);
      recv.on('done', () => resolve(new Error('no debía completarse')));
      recv.start();
    });
    expect(err.message).toMatch(/incompleta/);
    expect(fs.readdirSync(dest)).toEqual(['doc.bin.part']);
    expect(recv.resumePosition()).toBe(1000);
    srv.close();
  });

  it('chat DCC en ambos sentidos', async () => {
    const a = new DccChat();
    const b = new DccChat();
    const got: string[] = [];
    a.on('line', (l: string) => got.push('a:' + l));
    b.on('line', (l: string) => got.push('b:' + l));
    const offer = parseDccOffer(await a.listen('127.0.0.1'))!;
    const open = new Promise<void>((r) => a.on('open', r));
    b.connect(offer.ip, offer.port);
    await open;
    b.write('hola');
    a.write('qué tal\ninyectado');
    await waitFor(() => got.length === 2, 'líneas');
    expect(got.sort()).toEqual(['a:hola', 'b:qué tal']);
    a.close();
    b.close();
  });
});

describe('configuración inicial', () => {
  it('preconfigura la red propia en la primera ejecución y respeta la configuración guardada después', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onda-cfg-'));
    const first = new AppCore({ dataDir: dir });
    expect(first.networks).toMatchObject([{ name: 'RogerNet', host: 'irc.rogertp.es', port: 6697, tls: true, autojoin: ['#general'] }]);
    first.removeNetwork('RogerNet');
    first.shutdown();
    const second = new AppCore({ dataDir: dir });
    expect(second.networks).toEqual([]);
    second.shutdown();
  });

  it('/server con el nombre de una red guardada usa su configuración', () => {
    const app = new AppCore({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'onda-cfg-')) });
    app.on('ui', () => undefined);
    app.input('local', STATUS, '/server rogernet');
    const s = [...app.sessions.values()][0];
    expect(s.cfg).toMatchObject({ host: 'irc.rogertp.es', port: 6697, tls: true, autojoin: ['#general'] });
    s.client.on('error', () => undefined);
    app.closeSession(s.sid);
    app.shutdown();
  });
});

describe('contraseñas guardadas', () => {
  const codec = {
    encrypt: (p: string) => Buffer.from(p.split('').reverse().join('')).toString('base64'),
    decrypt: (c: string) => Buffer.from(c, 'base64').toString().split('').reverse().join(''),
  };
  const net = { name: 'Red', host: 'irc.ejemplo.test', port: 6697, tls: true, nick: 'yo', saslAccount: 'yo', saslPassword: 'sésamo', password: 'puerta' };

  it('se cifran en disco y se recuperan al arrancar', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onda-sec-'));
    const a = new AppCore({ dataDir: dir, secrets: codec });
    a.saveNetwork(net);
    a.shutdown();
    const raw = fs.readFileSync(path.join(dir, 'config.json'), 'utf8');
    expect(raw).not.toContain('sésamo');
    expect(raw).not.toContain('puerta');
    expect(raw).toContain('enc:v1:');
    const b = new AppCore({ dataDir: dir, secrets: codec });
    expect(b.networks.find((n) => n.name === 'Red')).toMatchObject({ saslPassword: 'sésamo', password: 'puerta', saslAccount: 'yo' });
    b.shutdown();
    // Sin almacén de claves no se puede descifrar: la contraseña se descarta en vez de usarse cifrada.
    const c = new AppCore({ dataDir: dir });
    const lost = c.networks.find((n) => n.name === 'Red')!;
    expect(lost.saslPassword).toBeUndefined();
    expect(lost.saslAccount).toBe('yo');
    c.shutdown();
  });

  it('sin almacén de claves se guardan en claro, como antes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onda-sec-'));
    const a = new AppCore({ dataDir: dir });
    a.saveNetwork(net);
    a.shutdown();
    const b = new AppCore({ dataDir: dir });
    expect(b.networks.find((n) => n.name === 'Red')!.saslPassword).toBe('sésamo');
    b.shutdown();
  });
});

describe('registro de cuenta', () => {
  it('/register pide la cuenta a NickServ y guarda las credenciales SASL cuando el servidor confirma', async () => {
    const net = await import('node:net');
    const got: string[] = [];
    const srv = net.createServer((sock) => {
      sock.setEncoding('utf8');
      sock.on('error', () => undefined);
      let buf = '';
      sock.on('data', (d: string) => {
        buf += d;
        let i: number;
        while ((i = buf.indexOf('\r\n')) !== -1) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 2);
          got.push(line);
          if (line === 'CAP LS 302') sock.write(':srv CAP * LS :sasl=PLAIN\r\n');
          else if (line.startsWith('USER ')) sock.write(':srv 001 nuevo :Hola\r\n');
          else if (line.startsWith('PRIVMSG NickServ :REGISTER ')) sock.write(':srv 900 nuevo nuevo!u@h nuevo :Sesión iniciada\r\n');
        }
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as import('node:net').AddressInfo).port;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onda-reg-'));
    const app = new AppCore({ dataDir: dir });
    const ev: UiEvent[] = [];
    app.on('ui', (e: UiEvent) => ev.push(e));
    const cfg = { name: 'Local', host: '127.0.0.1', port, tls: false, nick: 'nuevo' };
    app.saveNetwork(cfg);
    const sid = app.connect(cfg);
    await waitFor(() => app.sessions.get(sid)!.state === 'connected', 'conexión');
    app.input(sid, '*', '/register cl4ve secreta');
    await waitFor(() => app.networks.find((n) => n.name === 'Local')?.saslAccount === 'nuevo', 'cuenta guardada');
    expect(app.networks.find((n) => n.name === 'Local')).toMatchObject({ saslAccount: 'nuevo', saslPassword: 'cl4ve secreta' });
    expect(got).toContain('PRIVMSG NickServ :REGISTER cl4ve secreta');
    // La contraseña no aparece en ninguna línea mostrada ni en los registros.
    expect(JSON.stringify(ev)).not.toContain('cl4ve');
    expect(fs.existsSync(path.join(dir, 'logs'))).toBe(false);
    app.shutdown();
    srv.close();
  });
});

describe('robustez de la conexión', () => {
  /** Servidor mínimo: registra, acepta JOIN y permite cortar o callar la conexión. */
  async function fakeServer() {
    const net = await import('node:net');
    const joins: string[] = [];
    const socks: import('node:net').Socket[] = [];
    let silent = false;
    const srv = net.createServer((sock) => {
      socks.push(sock);
      sock.setEncoding('utf8');
      sock.on('error', () => undefined);
      let buf = '';
      sock.on('data', (d: string) => {
        buf += d;
        let i: number;
        while ((i = buf.indexOf('\r\n')) !== -1) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (silent) continue;
          if (line.startsWith('USER ')) sock.write(':srv 001 yo :Hola\r\n');
          else if (line.startsWith('JOIN ')) {
            joins.push(line.slice(5));
            sock.write(`:yo!u@h JOIN ${line.slice(5)}\r\n`);
          } else if (line.startsWith('PING ')) sock.write(`:srv PONG srv ${line.slice(5)}\r\n`);
        }
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    return { srv, joins, socks, port: (srv.address() as import('node:net').AddressInfo).port, silence: () => (silent = true) };
  }

  it('al caerse la conexión reconecta y vuelve a los canales abiertos', async () => {
    const f = await fakeServer();
    const app = new AppCore({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'onda-rec-')) });
    const ev: UiEvent[] = [];
    app.on('ui', (e: UiEvent) => ev.push(e));
    const sid = app.connect({ name: 'L', host: '127.0.0.1', port: f.port, tls: false, nick: 'yo', autojoin: ['#fijo'] });
    await waitFor(() => f.joins.includes('#fijo'), 'autojoin');
    app.input(sid, '*', '/join #extra');
    await waitFor(() => f.joins.includes('#extra'), 'join manual');
    f.socks[0].destroy();
    await waitFor(() => app.sessions.get(sid)!.state === 'disconnected', 'desconexión detectada');
    await waitFor(() => f.joins.filter((j) => j === '#extra').length === 2 && f.joins.filter((j) => j === '#fijo').length === 2, 'reentrada tras reconectar', 12000);
    expect(app.sessions.get(sid)!.state).toBe('connected');
    app.shutdown();
    f.srv.close();
  }, 20000);

  it('detecta un servidor que deja de responder', async () => {
    const { IrcClient } = await import('../src/core/irc/client');
    const f = await fakeServer();
    const c = new IrcClient({ host: '127.0.0.1', port: f.port, nick: 'yo' });
    c.deadAfter = 2;
    let closed = '';
    c.on('error', (e: Error) => (closed = e.message));
    c.connect();
    await waitFor(() => c.registered, 'registro');
    await new Promise((r) => setTimeout(r, 1500));
    expect(c.connected).toBe(true); // mientras responde a los PING sigue viva
    f.silence();
    await waitFor(() => !c.connected, 'cierre por silencio', 6000);
    expect(closed).toMatch(/dejado de responder/);
    f.srv.close();
  }, 15000);
});

describe('avisos de amigos (/notify)', () => {
  it('pide MONITOR al conectar y al añadir, y muestra entradas y salidas', async () => {
    const net = await import('node:net');
    const got: string[] = [];
    let sock: import('node:net').Socket | undefined;
    const srv = net.createServer((s) => {
      sock = s;
      s.setEncoding('utf8');
      s.on('error', () => undefined);
      let buf = '';
      s.on('data', (d: string) => {
        buf += d;
        let i: number;
        while ((i = buf.indexOf('\r\n')) !== -1) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 2);
          got.push(line);
          if (line.startsWith('USER ')) s.write(':srv 001 yo :Hola\r\n:srv 005 yo MONITOR=100 :son soportados\r\n:srv 376 yo :Fin del MOTD\r\n');
        }
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as import('node:net').AddressInfo).port;
    const app = new AppCore({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'onda-notify-')) });
    const ev: UiEvent[] = [];
    app.on('ui', (e: UiEvent) => ev.push(e));
    app.updateSettings({ notify: ['ana'] });
    const sid = app.connect({ name: 'L', host: '127.0.0.1', port, tls: false, nick: 'yo' });
    await waitFor(() => got.includes('MONITOR + ana'), 'MONITOR al conectar');
    app.input(sid, '*', '/notify Luis');
    await waitFor(() => got.includes('MONITOR + Luis'), 'MONITOR al añadir');
    sock!.write(':srv 730 yo :ana!u@h,Luis!u@h\r\n:srv 731 yo :ana\r\n');
    const notes = () => ev.flatMap((e) => (e.type === 'line' ? [e.line.text] : []));
    await waitFor(() => notes().includes('ana se ha desconectado'), 'avisos');
    expect(notes()).toEqual(expect.arrayContaining(['ana está en línea', 'Luis está en línea', 'ana se ha desconectado']));
    app.input(sid, '*', '/notify -r ana');
    await waitFor(() => got.includes('MONITOR - ana'), 'MONITOR al quitar');
    expect(app.settings.notify).toEqual(['Luis']);
    app.shutdown();
    srv.close();
  });
});

describe('abreviaturas de comandos', () => {
  it('/q, /ns, /c y compañía equivalen a sus comandos, y un alias de script tiene prioridad', async () => {
    const net = await import('node:net');
    const got: string[] = [];
    const srv = net.createServer((sock) => {
      sock.setEncoding('utf8');
      sock.on('error', () => undefined);
      let buf = '';
      sock.on('data', (d: string) => {
        buf += d;
        let i: number;
        while ((i = buf.indexOf('\r\n')) !== -1) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 2);
          got.push(line);
          if (line.startsWith('USER ')) sock.write(':srv 001 yo :Hola\r\n:yo!u@h JOIN #sala\r\n');
        }
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as import('node:net').AddressInfo).port;
    const app = new AppCore({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'onda-abr-')) });
    const ev: UiEvent[] = [];
    app.on('ui', (e: UiEvent) => ev.push(e));
    const sid = app.connect({ name: 'L', host: '127.0.0.1', port, tls: false, nick: 'yo' });
    await waitFor(() => ev.some((e) => e.type === 'buffer:add' && e.buffer === '#sala'), 'canal');
    app.input(sid, '#sala', '/q ana hola ana');
    app.input(sid, '#sala', '/ns info');
    app.input(sid, '#sala', '/id s3creta');
    app.input(sid, '#sala', '/w luis');
    app.input(sid, '#sala', '/k pesado por pesado');
    app.input(sid, '#sala', '/t Tema nuevo');
    app.input(sid, '#sala', '/n');
    app.input(sid, '#sala', '/c');
    await waitFor(() => got.includes('NAMES #sala'), 'comandos enviados', 12000);
    expect(ev.some((e) => e.type === 'buffer:add' && e.buffer === 'ana' && e.bufferType === 'query')).toBe(true);
    expect(got).toEqual(expect.arrayContaining([
      'PRIVMSG ana :hola ana', 'PRIVMSG NickServ :info', 'PRIVMSG NickServ :identify s3creta', 'WHOIS luis',
      'KICK #sala pesado :por pesado', 'TOPIC #sala :Tema nuevo', 'NAMES #sala',
    ]));
    expect(ev.some((e) => e.type === 'buffer:clear' && e.buffer === '#sala')).toBe(true);
    // Un alias propio llamado «q» sustituye a la abreviatura.
    app.saveScript('mio', 'alias q { echo -a alias propio $1 }');
    app.input(sid, '#sala', '/q prueba');
    expect(ev.some((e) => e.type === 'line' && e.line.text === 'alias propio prueba')).toBe(true);
    app.shutdown();
    srv.close();
  }, 20000);
});

describe('ventanas personalizadas', () => {
  it('/window, /aline, /echo @ventana, on INPUT y cierre', () => {
    const app = new AppCore({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'onda-win-')) });
    const ev: UiEvent[] = [];
    app.on('ui', (e: UiEvent) => ev.push(e));
    app.saveScript('w', 'alias panel { window @Panel | aline 4 @Panel primera | echo @panel segunda $1 }\non *:INPUT:@Panel:{ aline @Panel eco: $1- | halt }');
    app.input('local', STATUS, '/panel hola');
    expect(ev.some((e) => e.type === 'buffer:add' && e.sid === 'local' && e.buffer === '@Panel' && e.bufferType === 'custom')).toBe(true);
    expect(app.snapshot().windows).toEqual(['@Panel']);
    app.input('local', '@Panel', 'texto del usuario');
    app.input('local', STATUS, '/aline @NoExiste x');
    const lines = ev.flatMap((e) => (e.type === 'line' && e.buffer === '@Panel' ? [e.line.text] : []));
    expect(lines).toEqual(['\x0304primera', 'segunda hola', 'eco: texto del usuario']);
    expect(ev.some((e) => e.type === 'line' && e.line.kind === 'error' && e.line.text.includes('/aline'))).toBe(true);
    app.closeBuffer('local', '@panel');
    expect(ev.some((e) => e.type === 'buffer:remove' && e.buffer === '@Panel')).toBe(true);
    expect(app.snapshot().windows).toEqual([]);
    app.shutdown();
  });
});

describe.skipIf(!hasNgircd)('AppCore de extremo a extremo', () => {
  let server: ChildProcess;
  const apps: AppCore[] = [];
  const events = new Map<AppCore, UiEvent[]>();

  const mk = (nick: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `onda-app-${nick}-`));
    const app = new AppCore({ dataDir: dir });
    app.updateSettings({ nick });
    const list: UiEvent[] = [];
    events.set(app, list);
    app.on('ui', (e: UiEvent) => list.push(e));
    apps.push(app);
    return { app, dir };
  };
  const lines = (app: AppCore, buffer: string): Line[] =>
    events.get(app)!.flatMap((e) => (e.type === 'line' && e.buffer.toLowerCase() === buffer.toLowerCase() ? [e.line] : []));
  const texts = (app: AppCore, buffer: string) => lines(app, buffer).map((l) => (l.nick ? `<${l.nick}> ` : '') + l.text);

  beforeAll(async () => {
    server = await startServer(PORT);
  });
  afterAll(() => {
    for (const a of apps) a.shutdown();
    server.kill();
  });

  it('conecta con /server, entra en canales y un script mIRC responde a los mensajes', async () => {
    const bot = mk('robot');
    const user = mk('marta');
    bot.app.saveScript('bot', `on *:TEXT:!dado*:#:{
  var %caras = $iif($2 isnum,$2,6)
  inc %tiradas
  msg $chan $nick saca un $rand(1,%caras) de %caras (tirada n.º %tiradas $+ )
}
on *:TEXT:!hora:#:msg $chan Son las $time
on !*:JOIN:#:{ notice $nick Te doy la bienvenida a $chan $+ , $nick }
on ^*:TEXT:*palabrota*:#:haltdef
alias saludo { me saluda a $1 con $2- }`);

    bot.app.input('local', STATUS, `/server 127.0.0.1:${PORT}`);
    user.app.input('local', STATUS, `/server 127.0.0.1 ${PORT}`);
    const sidB = [...bot.app.sessions.keys()][0];
    const sidU = [...user.app.sessions.keys()][0];
    await waitFor(() => bot.app.sessions.get(sidB)!.state === 'connected' && user.app.sessions.get(sidU)!.state === 'connected', 'conexión');

    bot.app.input(sidB, STATUS, '/join #juegos');
    await waitFor(() => events.get(bot.app)!.some((e) => e.type === 'activate' && e.buffer === '#juegos'), 'bot en canal');
    user.app.input(sidU, STATUS, '/j juegos');
    await waitFor(() => texts(user.app, STATUS).some((t) => t.includes('Te doy la bienvenida a #juegos, marta')), 'bienvenida por script');

    user.app.input(sidU, '#juegos', '!dado 20');
    await waitFor(() => texts(user.app, '#juegos').some((t) => /^<robot> marta saca un \d+ de 20 \(tirada n\.º 1\)$/.test(t)), 'respuesta del dado');
    const roll = Number(/saca un (\d+)/.exec(texts(user.app, '#juegos').find((t) => t.includes('saca un'))!)![1]);
    expect(roll).toBeGreaterThanOrEqual(1);
    expect(roll).toBeLessThanOrEqual(20);

    user.app.input(sidU, '#juegos', 'esto lleva una palabrota dentro');
    user.app.input(sidU, '#juegos', 'mensaje normal');
    await waitFor(() => texts(bot.app, '#juegos').includes('<marta> mensaje normal'), 'mensaje normal');
    expect(texts(bot.app, '#juegos').some((t) => t.includes('palabrota'))).toBe(false);

    // El propio mensaje se muestra en el búfer del emisor y la lista de nicks se actualiza.
    expect(texts(user.app, '#juegos')).toContain('<marta> mensaje normal');
    const nicks = events.get(user.app)!.filter((e) => e.type === 'nicks').pop();
    expect(nicks).toMatchObject({ buffer: '#juegos', nicks: [{ nick: 'robot', prefix: '@' }, { nick: 'marta', prefix: '' }] });

    bot.app.input(sidB, '#juegos', '/saludo marta mucho cariño');
    await waitFor(() => lines(user.app, '#juegos').some((l) => l.kind === 'action' && l.text === 'saluda a marta con mucho cariño'), 'alias con /me');

    // Variables globales persistidas y registro en disco.
    await waitFor(() => fs.existsSync(path.join(bot.dir, 'vars.json')), 'vars.json', 3000);
    expect(JSON.parse(fs.readFileSync(path.join(bot.dir, 'vars.json'), 'utf8')).tiradas).toBe('1');
    expect(user.app.searchLogs('saca un').length).toBe(1);
    expect(fs.readFileSync(path.join(user.dir, 'logs', '127.0.0.1', '#juegos.log'), 'utf8')).toMatch(/\] <marta> !dado 20\n/);
  });

  it('menciones, privados, // con identificadores y errores visibles', async () => {
    const [bot, user] = apps;
    const sidB = [...bot.sessions.keys()][0];
    const sidU = [...user.sessions.keys()][0];
    bot.input(sidB, '#juegos', 'oye Marta, ¿estás?');
    await waitFor(() => lines(user, '#juegos').some((l) => l.text.startsWith('oye Marta') && l.highlight === true), 'mención resaltada');

    user.input(sidU, '#juegos', '/msg robot hola en privado');
    await waitFor(() => texts(bot, 'marta').includes('<marta> hola en privado'), 'privado recibido');
    expect(events.get(bot)!.some((e) => e.type === 'buffer:add' && e.buffer === 'marta' && e.bufferType === 'query')).toBe(true);

    user.setActive(sidU, '#juegos');
    user.input(sidU, '#juegos', '//echo -a soy $me en $chan con $nick($chan,0) usuarios');
    expect(texts(user, '#juegos')).toContain('soy marta en #juegos con 2 usuarios');
    user.input(sidU, '#juegos', '/echo -a literal $me');
    expect(texts(user, '#juegos')).toContain('literal $me');

    user.input(sidU, STATUS, 'texto suelto en estado');
    expect(lines(user, STATUS).some((l) => l.kind === 'error' && l.text.includes('no es un canal'))).toBe(true);

    user.input(sidU, '#juegos', '/kick robot fuera');
    await waitFor(() => lines(user, '#juegos').some((l) => l.kind === 'error' && /privileg|operator/i.test(l.text)), 'error del servidor visible en el canal');
  });

  it('envía un archivo por DCC solo tras aceptarlo el receptor', async () => {
    const [bot, user] = apps;
    const sidB = [...bot.sessions.keys()][0];
    const file = path.join(os.tmpdir(), `onda-envio-${Date.now()}.txt`);
    fs.writeFileSync(file, 'contenido de prueba '.repeat(5000));
    bot.input(sidB, STATUS, `/dcc send marta ${file}`);
    const dccOf = (app: AppCore) => events.get(app)!.flatMap((e) => (e.type === 'dcc' ? [e.dcc] : [])).pop() as DccInfo | undefined;
    await waitFor(() => dccOf(user)?.status === 'offered', 'oferta recibida');
    await new Promise((r) => setTimeout(r, 300));
    expect(dccOf(user)!.transferred).toBe(0);
    user.dccAccept(dccOf(user)!.id);
    await waitFor(() => dccOf(user)?.status === 'done' && dccOf(bot)?.status === 'done', 'transferencia completa');
    expect(fs.readFileSync(dccOf(user)!.path!, 'utf8')).toBe(fs.readFileSync(file, 'utf8'));
  });

  it('comandos al conectar (perform), lista de canales y reanudación DCC entre dos clientes', async () => {
    const [bot, user] = apps;
    const sidB = [...bot.sessions.keys()][0];
    // Perform: un tercer cliente entra en un canal y saluda al conectar.
    const third = mk('paco');
    const sid3 = third.app.connect({ name: 'P', host: '127.0.0.1', port: PORT, tls: false, nick: 'paco', perform: ['/join #juegos', '//msg #juegos hola, soy $me'] });
    await waitFor(() => texts(bot, '#juegos').includes('<paco> hola, soy paco'), 'perform ejecutado');

    third.app.input(sid3, '*', '/list');
    await waitFor(() => events.get(third.app)!.some((e) => e.type === 'chanlist'), 'lista de canales');
    const list = events.get(third.app)!.find((e) => e.type === 'chanlist');
    expect(list?.type === 'chanlist' && list.channels[0]).toMatchObject({ name: '#juegos', users: 3 });
    expect(texts(third.app, STATUS).some((t) => t.includes('#juegos 3'))).toBe(false);

    // Reanudación: paco ya tiene la primera parte del archivo que le envía robot.
    const file = path.join(os.tmpdir(), `onda-resume-${Date.now()}.bin`);
    const data = Buffer.alloc(300_000);
    for (let i = 0; i < data.length; i++) data[i] = (i * 13) & 255;
    fs.writeFileSync(file, data);
    fs.mkdirSync(path.join(third.dir, 'descargas'), { recursive: true });
    fs.writeFileSync(path.join(third.dir, 'descargas', path.basename(file) + '.part'), data.subarray(0, 100_000));
    bot.input(sidB, STATUS, `/dcc send paco ${file}`);
    const dccOf = (app: AppCore) => events.get(app)!.flatMap((e) => (e.type === 'dcc' ? [e.dcc] : [])).pop();
    await waitFor(() => dccOf(third.app)?.status === 'offered', 'oferta');
    third.app.dccAccept(dccOf(third.app)!.id);
    await waitFor(() => dccOf(third.app)?.status === 'done' && dccOf(bot)?.status === 'done', 'transferencia reanudada');
    expect(fs.readFileSync(dccOf(third.app)!.path!).equals(data)).toBe(true);
    const sentProgress = events.get(bot)!.flatMap((e) => (e.type === 'dcc' && e.dcc.filename === path.basename(file) && e.dcc.transferred > 0 ? [e.dcc.transferred] : []));
    expect(Math.min(...sentProgress)).toBeGreaterThan(100_000);
    third.app.input(sid3, '*', '/quit');
  });

  it('/ignore oculta los mensajes de un usuario y /unignore los recupera', async () => {
    const [bot, user] = apps;
    const sidB = [...bot.sessions.keys()][0];
    const sidU = [...user.sessions.keys()][0];
    user.input(sidU, '#juegos', '/ignore ROBOT');
    bot.input(sidB, '#juegos', 'esto no lo debe ver marta');
    bot.input(sidB, '#juegos', '/msg marta ni esto en privado');
    await new Promise((r) => setTimeout(r, 700)); // deja llegar (e ignorar) los mensajes anteriores
    user.input(sidU, '#juegos', '/unignore robot');
    bot.input(sidB, '#juegos', 'esto sí');
    await waitFor(() => texts(user, '#juegos').includes('<robot> esto sí'), 'mensaje tras unignore');
    expect(texts(user, '#juegos').some((t) => t.includes('no lo debe ver'))).toBe(false);
    expect(texts(user, 'robot').some((t) => t.includes('ni esto'))).toBe(false);
    expect(user.settings.ignore).toEqual([]);
  });

  it('salir de un canal y cerrar la sesión', async () => {
    const [, user] = apps;
    const sidU = [...user.sessions.keys()][0];
    user.input(sidU, '#juegos', '/part');
    await waitFor(() => events.get(user)!.some((e) => e.type === 'buffer:remove' && e.buffer === '#juegos'), 'búfer cerrado');
    user.input(sidU, STATUS, '/quit');
    expect(user.sessions.size).toBe(0);
    expect(events.get(user)!.some((e) => e.type === 'session:remove')).toBe(true);
  });
});
