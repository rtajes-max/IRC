import { ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppCore } from '../src/core/app';
import { DccChat, DccReceive, DccSend, intToIp, ipToInt, parseDccOffer, safeFilename } from '../src/core/dcc';
import { DccInfo, Line, STATUS, UiEvent } from '../src/core/types';
import { hasNgircd, startServer, waitFor } from './helpers';

const PORT = 16672;

describe('DCC', () => {
  it('convierte direcciones y analiza ofertas', () => {
    expect(ipToInt('192.168.1.1')).toBe(3232235777);
    expect(intToIp(3232235777)).toBe('192.168.1.1');
    expect(parseDccOffer('SEND "mi foto.png" 3232235777 5000 1234')).toEqual({ type: 'SEND', filename: 'mi foto.png', ip: '192.168.1.1', port: 5000, size: 1234 });
    expect(parseDccOffer('CHAT chat 2130706433 4000')).toMatchObject({ type: 'CHAT', ip: '127.0.0.1', port: 4000 });
    expect(parseDccOffer('SEND x 2130706433 0 10 99')).toBeNull();
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
    expect(first.networks).toMatchObject([{ host: 'irc.rogertp.es', port: 6697, tls: true }]);
    first.removeNetwork('irc.rogertp.es');
    first.shutdown();
    const second = new AppCore({ dataDir: dir });
    expect(second.networks).toEqual([]);
    second.shutdown();
  });

  it('/server con el nombre de una red guardada usa su configuración', () => {
    const app = new AppCore({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'onda-cfg-')) });
    app.on('ui', () => undefined);
    app.input('local', STATUS, '/server irc.rogertp.es');
    const s = [...app.sessions.values()][0];
    expect(s.cfg).toMatchObject({ host: 'irc.rogertp.es', port: 6697, tls: true });
    s.client.on('error', () => undefined);
    app.closeSession(s.sid);
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
