/**
 * Prueba de humo contra un servidor IRC real, usando el mismo núcleo que la aplicación.
 *
 *   npm run smoke                              → irc.rogertp.es:6697 con TLS
 *   npm run smoke -- servidor [puerto] [--plain] [--nick N] [--channel #c]
 *   ONDA_SMOKE_PASSWORD=… npm run smoke -- --account cuenta      (SASL; la contraseña solo por variable de entorno)
 *
 * Entra en un canal de pruebas (por defecto #onda-prueba, no en #general), envía un mensaje y sale.
 */
import { IrcClient, MessageEvent } from '../src/core/irc/client';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const plain = args.includes('--plain');
if (plain) args.splice(args.indexOf('--plain'), 1);
const nick = flag('--nick') ?? 'onda' + Math.floor(Math.random() * 9000 + 1000);
const channel = flag('--channel') ?? '#onda-prueba';
const account = flag('--account');
const host = args[0] ?? 'irc.rogertp.es';
const port = Number(args[1]) || (plain ? 6667 : 6697);
const password = process.env.ONDA_SMOKE_PASSWORD;

let failed = 0;
const ok = (what: string, detail = '') => console.log(`  ✓ ${what}${detail ? ` — ${detail}` : ''}`);
const bad = (what: string, detail = '') => {
  failed++;
  console.log(`  ✗ ${what}${detail ? ` — ${detail}` : ''}`);
};
const info = (what: string) => console.log(`  · ${what}`);

function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const start = Date.now();
    const t = setInterval(() => {
      if (cond() || Date.now() - start > ms) {
        clearInterval(t);
        resolve(cond());
      }
    }, 50);
  });
}

async function main(): Promise<void> {
  console.log(`Prueba de humo: ${host}:${port} ${plain ? '(sin cifrar)' : '(TLS)'} como ${nick}`);
  if (account && !password) {
    console.log('Falta la variable de entorno ONDA_SMOKE_PASSWORD para --account.');
    process.exit(2);
  }
  const c = new IrcClient({
    host, port, tls: !plain, nick, username: 'onda', realname: 'Prueba de humo de Onda IRC',
    sasl: account && password ? { account, password } : undefined,
  });
  let error = '';
  let sasl: boolean | null = null;
  const messages: MessageEvent[] = [];
  const numerics: string[] = [];
  c.on('error', (e: Error) => (error = e.message));
  c.on('servererror', (t: string) => (error = t));
  c.on('sasl', (okSasl: boolean) => (sasl = okSasl));
  c.on('message', (m: MessageEvent) => messages.push(m));
  c.on('numeric', (m: { command: string; params: string[] }) => numerics.push(`${m.command} ${m.params.slice(1).join(' ')}`));

  c.connect();
  if (!(await waitFor(() => c.connected || !!error, 15000)) || !c.connected) {
    bad('Conexión', error || 'sin respuesta en 15 s');
    process.exit(1);
  }
  ok('Conexión establecida', plain ? 'sin cifrar' : 'TLS con certificado verificado');

  if (!(await waitFor(() => c.registered || !!error, 30000)) || !c.registered) {
    bad('Registro en el servidor', error || numerics.slice(-3).join(' | ') || 'sin respuesta en 30 s');
    c.disconnect();
    process.exit(1);
  }
  ok('Registro en el servidor', `nick ${c.nick}`);
  await waitFor(() => !!c.isupport.CHANTYPES, 5000);
  info(`Red: ${c.network} · servidor: ${c.serverName}`);
  info(`Capacidades activas: ${[...c.caps].sort().join(' ') || '(ninguna)'}`);
  info(`ISUPPORT: NICKLEN=${c.isupport.NICKLEN ?? '?'} CHANTYPES=${c.isupport.CHANTYPES ?? '?'} PREFIX=${c.isupport.PREFIX ?? '?'} MONITOR=${c.isupport.MONITOR ?? 'no'}`);
  for (const cap of ['server-time', 'message-tags', 'echo-message', 'batch']) {
    if (c.caps.has(cap)) ok(`Capacidad ${cap}`);
    else info(`El servidor no ofrece ${cap}`);
  }
  if (account) {
    if (sasl) ok('Autenticación SASL', account);
    else bad('Autenticación SASL', 'rechazada o no ofrecida por el servidor');
  }

  c.join(channel);
  if (await waitFor(() => !!c.channel(channel), 10000)) {
    await waitFor(() => (c.channel(channel)?.users.size ?? 0) > 0, 5000);
    ok(`Entrada en ${channel}`, `${c.channel(channel)!.users.size} usuario(s)`);
  } else {
    bad(`Entrada en ${channel}`, numerics.slice(-2).join(' | '));
  }

  if (c.channel(channel)) {
    const text = `prueba de humo ${Date.now()} áéíñ 🚀`;
    c.say(channel, text);
    if (await waitFor(() => messages.some((m) => m.self && m.text === text), 10000)) {
      const echo = messages.find((m) => m.self && m.text === text)!;
      ok('Envío de mensaje', c.caps.has('echo-message') ? `eco del servidor recibido${echo.tags.msgid ? ' con msgid' : ''}` : 'eco local');
    } else bad('Envío de mensaje', 'no llegó el eco');

    if (c.caps.has('draft/chathistory') || c.caps.has('chathistory')) {
      const before = messages.length;
      c.requestHistory(channel, 10);
      if (await waitFor(() => messages.slice(before).some((m) => m.history), 8000)) ok('Historial del servidor (chathistory)');
      else info('chathistory no devolvió mensajes (normal en un canal sin registrar)');
    }
    c.part(channel, 'fin de la prueba');
    if (await waitFor(() => !c.channel(channel), 8000)) ok(`Salida de ${channel}`);
    else bad(`Salida de ${channel}`);
  }

  c.disconnect('prueba de humo terminada');
  await waitFor(() => !c.connected, 5000);
  console.log(failed ? `\nResultado: ${failed} comprobación(es) fallida(s).` : '\nResultado: todo correcto.');
  process.exit(failed ? 1 : 0);
}

void main();
