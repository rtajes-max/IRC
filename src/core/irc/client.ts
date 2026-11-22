import { EventEmitter } from 'node:events';
import * as net from 'node:net';
import * as tls from 'node:tls';
import { IrcMessage, formatMessage, ircLower, parseMessage } from './message';

export interface IrcOptions {
  host: string;
  port: number;
  tls?: boolean;
  /** false permite certificados autofirmados (por defecto se verifican). */
  rejectUnauthorized?: boolean;
  nick: string;
  username?: string;
  realname?: string;
  password?: string;
  sasl?: { account: string; password: string };
  autojoin?: string[];
  version?: string;
}

export interface ChannelUser {
  nick: string;
  prefix: string;
}

export interface Channel {
  name: string;
  topic: string;
  users: Map<string, ChannelUser>;
  joined: boolean;
}

export interface MessageEvent {
  from: string;
  /** Nombre del búfer donde debe mostrarse (canal o nick del interlocutor). */
  target: string;
  text: string;
  kind: 'privmsg' | 'notice' | 'action';
  self: boolean;
  time: Date;
  history: boolean;
  hostmask: string;
  tags: Record<string, string>;
}

const WANTED_CAPS = [
  'server-time', 'message-tags', 'multi-prefix', 'away-notify', 'account-notify', 'extended-join',
  'chghost', 'batch', 'echo-message', 'cap-notify', 'userhost-in-names', 'account-tag', 'setname',
  'invite-notify', 'draft/chathistory', 'chathistory',
];

/** Cliente IRC con negociación de capacidades IRCv3, SASL PLAIN y seguimiento de estado. */
export class IrcClient extends EventEmitter {
  nick: string;
  registered = false;
  connected = false;
  caps = new Set<string>();
  availableCaps = new Map<string, string>();
  isupport: Record<string, string> = {};
  channels = new Map<string, Channel>();
  serverName = '';

  private socket: net.Socket | null = null;
  private inbuf: Buffer = Buffer.alloc(0);
  private capPending = 0;
  private capLsBuffer: string[] = [];
  private batches = new Map<string, string>();
  private prefixModes = 'ov';
  private prefixChars = '@+';
  private queue: string[] = [];
  private tokens = 4;
  private drainTimer: NodeJS.Timeout | null = null;
  private nickAttempts = 0;
  private closedByUser = false;
  private lastData = 0;
  private keepalive: NodeJS.Timeout | null = null;
  /** Segundos sin recibir nada tras los que la conexión se da por caída (se puede ajustar en pruebas). */
  deadAfter = 240;

  constructor(public opts: IrcOptions) {
    super();
    this.nick = opts.nick;
  }

  get network(): string {
    return this.isupport.NETWORK || this.opts.host;
  }

  get chanTypes(): string {
    return this.isupport.CHANTYPES || '#&';
  }

  /** Dirección local de la conexión (se usa para anunciar DCC). */
  get localAddress(): string {
    return (this.socket?.localAddress ?? '127.0.0.1').replace(/^::ffff:/, '');
  }

  isChannel(name: string): boolean {
    return !!name && this.chanTypes.includes(name[0]);
  }

  isMe(nick: string): boolean {
    return ircLower(nick) === ircLower(this.nick);
  }

  channel(name: string): Channel | undefined {
    return this.channels.get(ircLower(name));
  }

  connect(): void {
    const { host, port } = this.opts;
    this.closedByUser = false;
    const onConnect = () => {
      this.connected = true;
      this.emit('connected');
      this.sendNow('CAP LS 302');
      if (this.opts.password) this.sendNow(formatMessage('PASS', [this.opts.password]));
      this.sendNow(formatMessage('NICK', [this.nick]));
      const user = this.opts.username || this.opts.nick;
      this.sendNow(formatMessage('USER', [user, '0', '*', this.opts.realname || user]));
    };
    const sock = this.opts.tls
      ? tls.connect(
          { host, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: this.opts.rejectUnauthorized !== false },
          onConnect,
        )
      : net.connect({ host, port }, onConnect);
    this.socket = sock;
    sock.on('data', (d: Buffer) => this.onData(d));
    // Vigilancia: si el servidor calla, se le pregunta; si sigue callado, la conexión se da por caída.
    this.lastData = Date.now();
    this.keepalive = setInterval(() => {
      const idle = (Date.now() - this.lastData) / 1000;
      if (idle > this.deadAfter) sock.destroy(new Error('el servidor ha dejado de responder'));
      else if (this.registered && idle > this.deadAfter / 3) this.sendNow(`PING :onda${Date.now()}`);
    }, Math.max(250, (this.deadAfter * 1000) / 8));
    this.keepalive.unref();
    sock.on('error', (err: Error) => this.emit('error', err));
    sock.on('close', () => {
      const was = this.connected;
      this.connected = false;
      this.registered = false;
      this.caps.clear();
      this.channels.clear();
      this.queue = [];
      if (this.drainTimer) clearInterval(this.drainTimer);
      this.drainTimer = null;
      if (this.keepalive) clearInterval(this.keepalive);
      this.keepalive = null;
      this.socket = null;
      this.emit('close', { wasConnected: was, byUser: this.closedByUser });
    });
  }

  disconnect(reason = ''): void {
    this.closedByUser = true;
    if (this.socket && this.connected) {
      this.sendNow(formatMessage('QUIT', [reason]));
      const s = this.socket;
      setTimeout(() => s.destroy(), 500).unref();
    } else this.socket?.destroy();
  }

  // ---------------------------------------------------------------- envío

  /** Envía una línea en bruto (con control de inundación). Nunca permite inyectar saltos de línea. */
  send(line: string): void {
    const clean = line.split(/[\r\n]/)[0];
    if (!clean) return;
    if (this.tokens > 0 && this.queue.length === 0) {
      this.tokens--;
      this.sendNow(clean);
    } else this.queue.push(clean);
    if (!this.drainTimer) {
      this.drainTimer = setInterval(() => {
        if (this.queue.length) this.sendNow(this.queue.shift()!);
        else if (this.tokens < 4) this.tokens++;
        else {
          clearInterval(this.drainTimer!);
          this.drainTimer = null;
        }
      }, 600);
      this.drainTimer.unref();
    }
  }

  private sendNow(line: string): void {
    const clean = line.split(/[\r\n]/)[0];
    if (!this.socket || this.socket.destroyed) return;
    this.socket.write(clean + '\r\n');
    this.emit('raw', 'out', clean);
  }

  private splitText(target: string, text: string): string[] {
    const max = Math.max(100, 400 - Buffer.byteLength(target));
    const out: string[] = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      let cur = '';
      let bytes = 0;
      for (const word of line.split(/( +)/)) {
        const wb = Buffer.byteLength(word);
        if (bytes + wb > max && cur.trim()) {
          out.push(cur);
          cur = '';
          bytes = 0;
        }
        if (wb > max) {
          for (const ch of word) {
            const cb = Buffer.byteLength(ch);
            if (bytes + cb > max) {
              out.push(cur);
              cur = '';
              bytes = 0;
            }
            cur += ch;
            bytes += cb;
          }
        } else {
          cur += word;
          bytes += wb;
        }
      }
      if (cur.trim()) out.push(cur);
    }
    return out;
  }

  private sendText(command: 'PRIVMSG' | 'NOTICE', target: string, text: string, kind: MessageEvent['kind']): void {
    for (const part of this.splitText(target, text)) {
      const body = kind === 'action' ? `\x01ACTION ${part}\x01` : part;
      this.send(`${command} ${target} :${body}`);
      if (!this.caps.has('echo-message')) {
        this.emit('message', {
          from: this.nick, target, text: part, kind, self: true, time: new Date(), history: false, hostmask: '', tags: {},
        } satisfies MessageEvent);
      }
    }
  }

  say(target: string, text: string): void {
    this.sendText('PRIVMSG', target, text, 'privmsg');
  }
  notice(target: string, text: string): void {
    this.sendText('NOTICE', target, text, 'notice');
  }
  action(target: string, text: string): void {
    this.sendText('PRIVMSG', target, text, 'action');
  }
  ctcp(target: string, command: string, args = ''): void {
    this.send(`PRIVMSG ${target} :\x01${command.toUpperCase()}${args ? ' ' + args : ''}\x01`);
  }
  ctcpReply(target: string, command: string, args = ''): void {
    this.send(`NOTICE ${target} :\x01${command.toUpperCase()}${args ? ' ' + args : ''}\x01`);
  }
  join(channel: string, key = ''): void {
    this.send(`JOIN ${channel}${key ? ' ' + key : ''}`);
  }
  part(channel: string, reason = ''): void {
    this.send(reason ? `PART ${channel} :${reason}` : `PART ${channel}`);
  }
  setNick(nick: string): void {
    this.send(`NICK ${nick}`);
  }
  /** Indicador de escritura IRCv3 (+typing). No hace nada si el servidor no admite etiquetas. */
  typing(target: string, state: 'active' | 'paused' | 'done'): void {
    if (this.caps.has('message-tags')) this.send(`@+typing=${state} TAGMSG ${target}`);
  }
  /** Reacción IRCv3 (+draft/react) a un mensaje identificado por msgid. */
  react(target: string, msgid: string, emoji: string): void {
    if (this.caps.has('message-tags')) this.send(`@+draft/react=${emoji};+draft/reply=${msgid} TAGMSG ${target}`);
  }
  /** Solicita historial reciente si el servidor ofrece chathistory. */
  requestHistory(target: string, limit = 50): void {
    if (this.caps.has('draft/chathistory') || this.caps.has('chathistory')) this.send(`CHATHISTORY LATEST ${target} * ${limit}`);
  }

  // ------------------------------------------------------------- recepción

  private onData(d: Buffer): void {
    this.lastData = Date.now();
    this.inbuf = this.inbuf.length ? Buffer.concat([this.inbuf, d]) : d;
    let idx: number;
    while ((idx = this.inbuf.indexOf(0x0a)) !== -1) {
      const lineBuf = this.inbuf.subarray(0, idx);
      this.inbuf = this.inbuf.subarray(idx + 1);
      let line: string;
      try {
        line = new TextDecoder('utf-8', { fatal: true }).decode(lineBuf);
      } catch {
        line = lineBuf.toString('latin1');
      }
      line = line.replace(/\r$/, '');
      if (!line) continue;
      this.emit('raw', 'in', line);
      const msg = parseMessage(line);
      if (msg) {
        try {
          this.handle(msg);
        } catch (err) {
          this.emit('error', err);
        }
      }
    }
    if (this.inbuf.length > 65536) this.inbuf = Buffer.alloc(0);
  }

  private msgTime(msg: IrcMessage): Date {
    if (msg.tags.time) {
      const d = new Date(msg.tags.time);
      if (!isNaN(d.getTime())) return d;
    }
    return new Date();
  }

  private splitPrefix(entry: string): ChannelUser {
    let i = 0;
    while (i < entry.length && this.prefixChars.includes(entry[i])) i++;
    let nick = entry.slice(i);
    const bang = nick.indexOf('!');
    if (bang !== -1) nick = nick.slice(0, bang);
    return { nick, prefix: entry.slice(0, i) };
  }

  private sortPrefix(p: string): string {
    return [...new Set(p)].sort((a, b) => this.prefixChars.indexOf(a) - this.prefixChars.indexOf(b)).join('');
  }

  private handle(msg: IrcMessage): void {
    const p = msg.params;
    switch (msg.command) {
      case 'PING':
        this.sendNow(formatMessage('PONG', [p[p.length - 1] ?? '']));
        return;
      case 'PONG':
        this.emit('pong', p[p.length - 1] ?? '');
        return;
      case 'CAP':
        this.handleCap(msg);
        return;
      case 'AUTHENTICATE':
        if (p[0] === '+' && this.opts.sasl) {
          const { account, password } = this.opts.sasl;
          const b64 = Buffer.from(`${account}\0${account}\0${password}`).toString('base64');
          for (let i = 0; i < b64.length; i += 400) this.sendNow('AUTHENTICATE ' + b64.slice(i, i + 400));
          if (b64.length % 400 === 0) this.sendNow('AUTHENTICATE +');
        }
        return;
      case '900':
        this.emit('loggedin', p[2] ?? '');
        return;
      case '903':
        this.emit('sasl', true, p[p.length - 1]);
        if (!this.registered) this.sendNow('CAP END');
        return;
      case '902': case '904': case '905': case '906': case '908':
        if (msg.command !== '908') {
          this.emit('sasl', false, p[p.length - 1]);
          if (!this.registered) this.sendNow('CAP END');
        }
        return;
      case '001':
        this.registered = true;
        this.nick = p[0] || this.nick;
        this.serverName = msg.prefix;
        this.emit('numeric', msg);
        this.emit('registered');
        for (const ch of this.opts.autojoin ?? []) if (ch.trim()) this.join(ch.trim());
        return;
      case '005':
        for (const tok of p.slice(1, -1)) {
          const eq = tok.indexOf('=');
          if (eq === -1) this.isupport[tok] = '';
          else this.isupport[tok.slice(0, eq)] = tok.slice(eq + 1);
        }
        {
          const m = /^\(([^)]*)\)(.*)$/.exec(this.isupport.PREFIX ?? '');
          if (m) {
            this.prefixModes = m[1];
            this.prefixChars = m[2];
          }
        }
        this.emit('numeric', msg);
        return;
      case '432': case '433': case '436': case '437':
        if (!this.registered) {
          this.nickAttempts++;
          if (this.nickAttempts > 5) {
            this.emit('numeric', msg);
            return;
          }
          // 432 = nick no válido: en servidores con nicks cortos (9 caracteres) se prueba recortado.
          const base = msg.command === '432' ? this.opts.nick.slice(0, 9 - this.nickAttempts + 1) : this.opts.nick;
          this.nick = msg.command === '432' ? base : base + '_'.repeat(this.nickAttempts);
          this.sendNow(formatMessage('NICK', [this.nick]));
        }
        this.emit('numeric', msg);
        return;
      case 'JOIN': {
        const name = p[0];
        if (this.isMe(msg.nick)) {
          this.channels.set(ircLower(name), { name, topic: '', users: new Map(), joined: true });
        }
        const ch = this.channel(name);
        ch?.users.set(ircLower(msg.nick), { nick: msg.nick, prefix: '' });
        this.emit('join', { nick: msg.nick, channel: name, hostmask: `${msg.user}@${msg.host}`, account: p[1] ?? '', time: this.msgTime(msg), self: this.isMe(msg.nick) });
        return;
      }
      case 'PART': {
        const name = p[0];
        const self = this.isMe(msg.nick);
        this.channel(name)?.users.delete(ircLower(msg.nick));
        if (self) this.channels.delete(ircLower(name));
        this.emit('part', { nick: msg.nick, channel: name, reason: p[1] ?? '', hostmask: `${msg.user}@${msg.host}`, time: this.msgTime(msg), self });
        return;
      }
      case 'KICK': {
        const [name, victim, reason = ''] = p;
        const self = this.isMe(victim);
        this.channel(name)?.users.delete(ircLower(victim));
        if (self) this.channels.delete(ircLower(name));
        this.emit('kick', { nick: msg.nick, channel: name, victim, reason, time: this.msgTime(msg), self });
        return;
      }
      case 'QUIT': {
        const affected: string[] = [];
        for (const ch of this.channels.values()) if (ch.users.delete(ircLower(msg.nick))) affected.push(ch.name);
        this.emit('quit', { nick: msg.nick, reason: p[0] ?? '', channels: affected, hostmask: `${msg.user}@${msg.host}`, time: this.msgTime(msg) });
        return;
      }
      case 'NICK': {
        const newNick = p[0];
        const affected: string[] = [];
        for (const ch of this.channels.values()) {
          const u = ch.users.get(ircLower(msg.nick));
          if (u) {
            ch.users.delete(ircLower(msg.nick));
            ch.users.set(ircLower(newNick), { nick: newNick, prefix: u.prefix });
            affected.push(ch.name);
          }
        }
        const self = this.isMe(msg.nick);
        if (self) this.nick = newNick;
        this.emit('nick', { oldNick: msg.nick, newNick, channels: affected, self, time: this.msgTime(msg) });
        return;
      }
      case '353': {
        const ch = this.channel(p[2]);
        if (ch) {
          for (const entry of (p[3] ?? '').split(' ')) {
            if (!entry) continue;
            const u = this.splitPrefix(entry);
            ch.users.set(ircLower(u.nick), u);
          }
        }
        return;
      }
      case '366':
        this.emit('names', { channel: p[1] });
        return;
      case '331':
      case '332': {
        const ch = this.channel(p[1]);
        const topic = msg.command === '332' ? p[2] ?? '' : '';
        if (ch) ch.topic = topic;
        this.emit('topic', { channel: p[1], topic, nick: '', initial: true, time: this.msgTime(msg) });
        return;
      }
      case 'TOPIC': {
        const ch = this.channel(p[0]);
        if (ch) ch.topic = p[1] ?? '';
        this.emit('topic', { channel: p[0], topic: p[1] ?? '', nick: msg.nick, initial: false, time: this.msgTime(msg) });
        return;
      }
      case 'MODE':
        this.handleMode(msg);
        return;
      case 'PRIVMSG':
      case 'NOTICE':
        this.handleText(msg);
        return;
      case 'TAGMSG': {
        const target = this.isChannel(p[0]) ? p[0] : msg.nick;
        if (this.isMe(msg.nick)) return;
        if (msg.tags['+typing']) this.emit('typing', { nick: msg.nick, target, state: msg.tags['+typing'] });
        if (msg.tags['+draft/react']) this.emit('react', { nick: msg.nick, target, emoji: msg.tags['+draft/react'], msgid: msg.tags['+draft/reply'] ?? '' });
        return;
      }
      case 'BATCH': {
        const ref = p[0] ?? '';
        if (ref.startsWith('+')) this.batches.set(ref.slice(1), p[1] ?? '');
        else if (ref.startsWith('-')) this.batches.delete(ref.slice(1));
        return;
      }
      case 'AWAY':
        this.emit('away', { nick: msg.nick, message: p[0] ?? '' });
        return;
      case 'ACCOUNT':
        this.emit('account', { nick: msg.nick, account: p[0] === '*' ? '' : p[0] });
        return;
      case 'CHGHOST':
      case 'SETNAME':
        return;
      case 'INVITE':
        this.emit('invite', { nick: msg.nick, target: p[0], channel: p[1] ?? '' });
        return;
      case 'ERROR':
        this.emit('servererror', p[0] ?? '');
        return;
      default:
        if (/^\d{3}$/.test(msg.command)) this.emit('numeric', msg);
        else this.emit('unhandled', msg);
    }
  }

  private handleCap(msg: IrcMessage): void {
    const sub = (msg.params[1] ?? '').toUpperCase();
    const more = msg.params[2] === '*';
    const list = (msg.params[more ? 3 : 2] ?? '').split(' ').filter(Boolean);
    if (sub === 'LS' || sub === 'NEW') {
      this.capLsBuffer.push(...list);
      if (more) return;
      const fresh: string[] = [];
      for (const c of this.capLsBuffer) {
        const eq = c.indexOf('=');
        const name = eq === -1 ? c : c.slice(0, eq);
        this.availableCaps.set(name, eq === -1 ? '' : c.slice(eq + 1));
        fresh.push(name);
      }
      this.capLsBuffer = [];
      const want = fresh.filter((c) => !this.caps.has(c) && (WANTED_CAPS.includes(c) || (c === 'sasl' && !!this.opts.sasl && !this.registered)));
      if (want.length) {
        this.capPending++;
        this.sendNow('CAP REQ :' + want.join(' '));
      } else if (!this.registered && sub === 'LS') this.sendNow('CAP END');
    } else if (sub === 'ACK') {
      for (const c of list) {
        if (c.startsWith('-')) this.caps.delete(c.slice(1));
        else this.caps.add(c);
      }
      this.capPending = Math.max(0, this.capPending - 1);
      this.afterCapReply();
    } else if (sub === 'NAK') {
      this.capPending = Math.max(0, this.capPending - 1);
      // Si el servidor rechaza el lote, se piden una a una.
      if (list.length > 1) {
        for (const c of list) {
          this.capPending++;
          this.sendNow('CAP REQ :' + c);
        }
      }
      this.afterCapReply();
    } else if (sub === 'DEL') {
      for (const c of list) {
        this.caps.delete(c);
        this.availableCaps.delete(c);
      }
    }
  }

  private afterCapReply(): void {
    if (this.registered || this.capPending > 0) return;
    this.emit('caps', [...this.caps]);
    if (this.caps.has('sasl') && this.opts.sasl) this.sendNow('AUTHENTICATE PLAIN');
    else this.sendNow('CAP END');
  }

  private handleMode(msg: IrcMessage): void {
    const [target, modes = '', ...args] = msg.params;
    if (this.isChannel(target)) {
      const ch = this.channel(target);
      const [A = '', Bm = '', Cm = ''] = (this.isupport.CHANMODES ?? 'beI,k,l,imnpst').split(',');
      let adding = true;
      let ai = 0;
      for (const m of modes) {
        if (m === '+') adding = true;
        else if (m === '-') adding = false;
        else if (this.prefixModes.includes(m)) {
          const nick = args[ai++];
          const u = nick ? ch?.users.get(ircLower(nick)) : undefined;
          if (u) {
            const sym = this.prefixChars[this.prefixModes.indexOf(m)];
            u.prefix = adding ? this.sortPrefix(u.prefix + sym) : u.prefix.replace(sym, '');
          }
        } else if (A.includes(m) || Bm.includes(m) || (Cm.includes(m) && adding)) ai++;
      }
    }
    this.emit('mode', { nick: msg.nick || msg.prefix, target, modes, args, time: this.msgTime(msg) });
  }

  private handleText(msg: IrcMessage): void {
    const [rawTarget, text = ''] = msg.params;
    const isNotice = msg.command === 'NOTICE';
    const self = this.isMe(msg.nick);
    const fromServer = !msg.user && msg.nick.includes('.');
    const target = this.isChannel(rawTarget.replace(/^[@+%~&]+(?=[#&])/, ''))
      ? rawTarget.replace(/^[@+%~&]+(?=[#&])/, '')
      : self
        ? rawTarget
        : msg.nick;
    const batchType = msg.tags.batch ? this.batches.get(msg.tags.batch) ?? '' : '';
    const base = {
      from: msg.nick || msg.prefix,
      target,
      self,
      time: this.msgTime(msg),
      history: /chathistory|playback/.test(batchType),
      hostmask: msg.user ? `${msg.user}@${msg.host}` : '',
      tags: msg.tags,
    };

    if (text.startsWith('\x01')) {
      const body = text.slice(1).replace(/\x01$/, '');
      const sp = body.indexOf(' ');
      const cmd = (sp === -1 ? body : body.slice(0, sp)).toUpperCase();
      const args = sp === -1 ? '' : body.slice(sp + 1);
      if (cmd === 'ACTION' && !isNotice) {
        this.emit('message', { ...base, text: args, kind: 'action' } satisfies MessageEvent);
        return;
      }
      if (isNotice) {
        this.emit('ctcpreply', { from: msg.nick, command: cmd, args });
        return;
      }
      if (self) return;
      if (cmd === 'VERSION') this.ctcpReply(msg.nick, 'VERSION', this.opts.version || 'Onda IRC');
      else if (cmd === 'PING') this.ctcpReply(msg.nick, 'PING', args);
      else if (cmd === 'TIME') this.ctcpReply(msg.nick, 'TIME', new Date().toString());
      this.emit('ctcp', { from: msg.nick, target, command: cmd, args, hostmask: base.hostmask });
      return;
    }

    this.emit('message', {
      ...base,
      target: isNotice && (fromServer || !msg.nick || !this.registered) ? '' : target,
      text,
      kind: isNotice ? 'notice' : 'privmsg',
    } satisfies MessageEvent);
  }
}
