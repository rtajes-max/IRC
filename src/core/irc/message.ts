/** Análisis y serialización de mensajes IRC (RFC 1459/2812 + etiquetas IRCv3). */

export interface IrcMessage {
  tags: Record<string, string>;
  prefix: string;
  nick: string;
  user: string;
  host: string;
  command: string;
  params: string[];
  raw: string;
}

const TAG_UNESCAPE: Record<string, string> = { ':': ';', s: ' ', '\\': '\\', r: '\r', n: '\n' };

export function unescapeTag(v: string): string {
  let out = '';
  for (let i = 0; i < v.length; i++) {
    if (v[i] === '\\') {
      i++;
      if (i < v.length) out += TAG_UNESCAPE[v[i]] ?? v[i];
    } else out += v[i];
  }
  return out;
}

export function escapeTag(v: string): string {
  return v
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\:')
    .replace(/ /g, '\\s')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
}

export function parseMessage(line: string): IrcMessage | null {
  const raw = line.replace(/[\r\n]+$/, '');
  let rest = raw;
  const msg: IrcMessage = { tags: {}, prefix: '', nick: '', user: '', host: '', command: '', params: [], raw };

  if (rest.startsWith('@')) {
    const sp = rest.indexOf(' ');
    if (sp === -1) return null;
    for (const part of rest.slice(1, sp).split(';')) {
      if (!part) continue;
      const eq = part.indexOf('=');
      if (eq === -1) msg.tags[part] = '';
      else msg.tags[part.slice(0, eq)] = unescapeTag(part.slice(eq + 1));
    }
    rest = rest.slice(sp + 1).replace(/^ +/, '');
  }

  if (rest.startsWith(':')) {
    const sp = rest.indexOf(' ');
    if (sp === -1) return null;
    msg.prefix = rest.slice(1, sp);
    const bang = msg.prefix.indexOf('!');
    const at = msg.prefix.indexOf('@');
    if (bang !== -1 && at > bang) {
      msg.nick = msg.prefix.slice(0, bang);
      msg.user = msg.prefix.slice(bang + 1, at);
      msg.host = msg.prefix.slice(at + 1);
    } else if (at !== -1) {
      msg.nick = msg.prefix.slice(0, at);
      msg.host = msg.prefix.slice(at + 1);
    } else {
      msg.nick = msg.prefix;
    }
    rest = rest.slice(sp + 1).replace(/^ +/, '');
  }

  while (rest.length) {
    if (rest.startsWith(':')) {
      msg.params.push(rest.slice(1));
      break;
    }
    const sp = rest.indexOf(' ');
    if (sp === -1) {
      msg.params.push(rest);
      break;
    }
    msg.params.push(rest.slice(0, sp));
    rest = rest.slice(sp + 1).replace(/^ +/, '');
  }

  const cmd = msg.params.shift();
  if (!cmd) return null;
  msg.command = cmd.toUpperCase();
  return msg;
}

/** Construye una línea IRC. El último parámetro se envía como "trailing" si hace falta. */
export function formatMessage(command: string, params: string[] = [], tags?: Record<string, string>): string {
  let out = '';
  if (tags && Object.keys(tags).length) {
    out +=
      '@' +
      Object.entries(tags)
        .map(([k, v]) => (v === '' ? k : `${k}=${escapeTag(v)}`))
        .join(';') +
      ' ';
  }
  out += command;
  params.forEach((p, i) => {
    const last = i === params.length - 1;
    if (last && (p === '' || p.includes(' ') || p.startsWith(':'))) out += ' :' + p;
    else out += ' ' + p;
  });
  return out;
}

/** Comparación de nicks/canales sin distinguir mayúsculas (rfc1459). */
export function ircLower(s: string): string {
  return s
    .toLowerCase()
    .replace(/\[/g, '{')
    .replace(/\]/g, '}')
    .replace(/\\/g, '|')
    .replace(/~/g, '^');
}
