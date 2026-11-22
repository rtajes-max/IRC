import { ChildProcess } from 'node:child_process';
import * as net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IrcClient, MessageEvent } from '../src/core/irc/client';
import { hasNgircd, startServer, waitFor } from './helpers';

const PORT = 16671;

describe.skipIf(!hasNgircd)('IrcClient contra un servidor real (ngircd)', () => {
  let server: ChildProcess;
  const clients: IrcClient[] = [];
  const mk = (nick: string) => {
    const c = new IrcClient({ host: '127.0.0.1', port: PORT, nick });
    c.on('error', () => undefined);
    clients.push(c);
    return c;
  };

  beforeAll(async () => {
    server = await startServer(PORT);
  });
  afterAll(() => {
    for (const c of clients) c.disconnect();
    server.kill();
  });

  it('se registra, negocia capacidades y lee ISUPPORT', async () => {
    const c = mk('ana');
    c.connect();
    await waitFor(() => c.registered, 'registro');
    expect(c.nick).toBe('ana');
    await waitFor(() => !!c.isupport.CHANTYPES, 'ISUPPORT');
    expect(c.caps.has('multi-prefix')).toBe(true);
  });

  it('resuelve un nick en uso añadiendo _', async () => {
    const c = mk('ana');
    c.connect();
    await waitFor(() => c.registered, 'registro');
    expect(c.nick).toBe('ana_');
  });

  it('recorta un nick demasiado largo para el servidor', async () => {
    const c = new IrcClient({ host: '127.0.0.1', port: PORT, nick: 'nickdemasiadolargoparaelservidor' });
    c.on('error', () => undefined);
    c.connect();
    await waitFor(() => c.registered, 'registro');
    expect(c.nick).toBe('nickdemas');
    c.disconnect();
  });

  it('canales: entrar, lista de nicks, prefijos, mensajes, acciones, tema, modos, kick', async () => {
    const [ana, luis] = [clients[0], mk('luis')];
    const got: MessageEvent[] = [];
    luis.on('message', (m: MessageEvent) => got.push(m));
    luis.connect();
    await waitFor(() => luis.registered, 'registro luis');

    ana.join('#sala');
    await waitFor(() => !!ana.channel('#sala'), 'ana en #sala');
    luis.join('#SALA');
    await waitFor(() => (ana.channel('#sala')?.users.size ?? 0) === 2 && (luis.channel('#sala')?.users.size ?? 0) === 2, 'dos usuarios');
    expect(luis.channel('#sala')!.users.get('ana')!.prefix).toBe('@');
    expect(luis.channel('#sala')!.users.get('luis')!.prefix).toBe('');

    ana.say('#sala', 'hola \x02mundo\x02 ñandú 🚀');
    ana.action('#sala', 'saluda');
    await waitFor(() => got.length === 2, 'mensajes');
    expect(got[0]).toMatchObject({ from: 'ana', target: '#sala', text: 'hola \x02mundo\x02 ñandú 🚀', kind: 'privmsg', self: false });
    expect(got[1]).toMatchObject({ kind: 'action', text: 'saluda' });

    ana.send('TOPIC #sala :Tema nuevo');
    await waitFor(() => luis.channel('#sala')!.topic === 'Tema nuevo', 'tema');

    ana.send('MODE #sala +v luis');
    await waitFor(() => ana.channel('#sala')!.users.get('luis')!.prefix === '+', 'voz');
    ana.send('MODE #sala +o luis');
    await waitFor(() => luis.channel('#sala')!.users.get('luis')!.prefix === '@+', 'op y voz');
    ana.send('MODE #sala -o luis');
    await waitFor(() => ana.channel('#sala')!.users.get('luis')!.prefix === '+', 'sin op');

    luis.say('ana', 'privado');
    const priv: MessageEvent[] = [];
    ana.on('message', (m: MessageEvent) => priv.push(m));
    await waitFor(() => priv.length === 1, 'privado');
    expect(priv[0]).toMatchObject({ from: 'luis', target: 'luis', text: 'privado' });

    let kicked = false;
    luis.on('kick', (e: { self: boolean }) => (kicked = e.self));
    ana.send('KICK #sala luis :fuera');
    await waitFor(() => kicked, 'kick');
    expect(luis.channel('#sala')).toBeUndefined();
    expect(ana.channel('#sala')!.users.size).toBe(1);
  });

  it('cambios de nick, salida y CTCP', async () => {
    const [ana, luis] = [clients[0], clients[2]];
    luis.join('#sala');
    await waitFor(() => ana.channel('#sala')!.users.size === 2, 'luis vuelve');
    luis.setNick('lucho');
    await waitFor(() => ana.channel('#sala')!.users.has('lucho') && luis.nick === 'lucho', 'nick');

    let reply = '';
    ana.on('ctcpreply', (e: { command: string; args: string }) => (reply = `${e.command} ${e.args}`));
    ana.ctcp('lucho', 'VERSION');
    await waitFor(() => reply !== '', 'respuesta CTCP');
    expect(reply).toBe('VERSION Onda IRC');

    luis.part('#sala', 'adiós');
    await waitFor(() => ana.channel('#sala')!.users.size === 1, 'part');
  });

  it('divide los mensajes largos sin romper caracteres ni pasar el límite', async () => {
    const [ana, luis] = [clients[0], clients[2]];
    const got: string[] = [];
    luis.on('message', (m: MessageEvent) => got.push(m.text));
    const long = Array.from({ length: 120 }, (_, i) => `palabra${i}ñ`).join(' ');
    ana.say('lucho', long);
    await waitFor(() => got.join(' ').length >= long.length, 'mensaje largo', 15000);
    expect(got.length).toBeGreaterThan(1);
    expect(got.join(' ').replace(/ +/g, ' ')).toBe(long);
  });

  it('no permite inyectar comandos con saltos de línea', async () => {
    const ana = clients[0];
    const sent: string[] = [];
    ana.on('raw', (dir: string, line: string) => dir === 'out' && sent.push(line));
    ana.send('PRIVMSG lucho :hola\r\nQUIT :inyectado');
    await new Promise((r) => setTimeout(r, 300));
    expect(sent.some((l) => l.includes('QUIT'))).toBe(false);
    expect(ana.connected).toBe(true);
  });
});

describe('IRCv3 y SASL contra un servidor simulado', () => {
  it('negocia CAP, se autentica con SASL PLAIN y procesa etiquetas, historial y typing', async () => {
    const lines: string[] = [];
    const srv = net.createServer((sock) => {
      sock.setEncoding('utf8');
      let buf = '';
      const w = (l: string) => sock.write(l + '\r\n');
      sock.on('data', (d: string) => {
        buf += d;
        let i: number;
        while ((i = buf.indexOf('\r\n')) !== -1) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 2);
          lines.push(line);
          if (line === 'CAP LS 302') {
            w(':srv CAP * LS * :sasl=PLAIN,EXTERNAL server-time message-tags');
            w(':srv CAP * LS :batch echo-message draft/chathistory cosa-rara');
          } else if (line.startsWith('CAP REQ')) w(`:srv CAP * ACK ${line.slice(8)}`);
          else if (line === 'AUTHENTICATE PLAIN') w('AUTHENTICATE +');
          else if (line.startsWith('AUTHENTICATE ')) {
            w(':srv 900 eva eva!u@h eva :You are now logged in as eva');
            w(':srv 903 eva :SASL authentication successful');
          } else if (line === 'CAP END') {
            w(':srv 001 eva :Bienvenida');
            w(':srv 005 eva NETWORK=Simulada PREFIX=(qov)~@+ CHANTYPES=# :are supported');
            w(':eva!u@h JOIN #x');
            w(':srv BATCH +h1 chathistory #x');
            w('@batch=h1;time=2020-05-06T07:08:09.000Z;msgid=m1 :bob!b@h PRIVMSG #x :mensaje antiguo');
            w(':srv BATCH -h1');
            w('@+typing=active :bob!b@h TAGMSG #x');
            w('@+draft/react=👍;+draft/reply=m1 :bob!b@h TAGMSG #x');
          } else if (line.startsWith('PRIVMSG #x')) w(`@msgid=m2 :eva!u@h ${line}`);
        }
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as net.AddressInfo).port;

    const c = new IrcClient({ host: '127.0.0.1', port, nick: 'eva', sasl: { account: 'eva', password: 's3creta' } });
    const msgs: MessageEvent[] = [];
    const extra: string[] = [];
    let sasl: boolean | null = null;
    c.on('message', (m: MessageEvent) => msgs.push(m));
    c.on('sasl', (ok: boolean) => (sasl = ok));
    c.on('typing', (e: { nick: string; state: string }) => extra.push(`typing ${e.nick} ${e.state}`));
    c.on('react', (e: { nick: string; emoji: string; msgid: string }) => extra.push(`react ${e.nick} ${e.emoji} ${e.msgid}`));
    c.connect();
    await waitFor(() => c.registered && msgs.length === 1 && extra.length === 2, 'registro y eventos');

    expect(sasl).toBe(true);
    expect(lines).toContain('CAP REQ :sasl server-time message-tags batch echo-message draft/chathistory');
    const auth = lines.find((l) => l.startsWith('AUTHENTICATE ') && l !== 'AUTHENTICATE PLAIN')!;
    expect(Buffer.from(auth.slice(13), 'base64').toString()).toBe('eva\0eva\0s3creta');
    expect(c.network).toBe('Simulada');
    expect(msgs[0]).toMatchObject({ from: 'bob', target: '#x', history: true, text: 'mensaje antiguo' });
    expect(msgs[0].time.toISOString()).toBe('2020-05-06T07:08:09.000Z');
    expect(extra).toEqual(['typing bob active', 'react bob 👍 m1']);

    // Con echo-message no se duplica el mensaje propio: solo llega el eco del servidor.
    c.say('#x', 'hola');
    await waitFor(() => msgs.length === 2, 'eco');
    await new Promise((r) => setTimeout(r, 100));
    expect(msgs.length).toBe(2);
    expect(msgs[1]).toMatchObject({ self: true, text: 'hola', target: '#x' });
    expect(msgs[1].tags.msgid).toBe('m2');
    c.typing('#x', 'active');
    await waitFor(() => lines.includes('@+typing=active TAGMSG #x'), 'typing enviado');

    c.disconnect();
    srv.close();
  });
});
