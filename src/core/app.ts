/**
 * Núcleo de la aplicación, independiente de Electron: sesiones IRC, comandos, scripts,
 * DCC y registros. Se comunica con la interfaz emitiendo eventos `ui`.
 */
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DccChat, DccOffer, DccReceive, DccSend, parseDccOffer, parseDccResume } from './dcc';
import { IrcClient, MessageEvent } from './irc/client';
import { stripFormatting } from './irc/formatting';
import { IrcMessage, ircLower } from './irc/message';
import { Logger } from './logs';
import { DialogView, MenuEntry, MslContext, MslEngine, MslHost, newContext, wildMatch } from './msl/engine';
import {
  BufferType, ChannelListEntry, DccInfo, LOCAL, Line, LineKind, NetworkConfig, NickEntry, STATUS, ScriptInfo, SessionInfo, Settings,
  Snapshot, UiEvent,
} from './types';

interface Buffer {
  name: string;
  type: BufferType;
}

interface Session {
  sid: string;
  cfg: NetworkConfig;
  client: IrcClient;
  buffers: Map<string, Buffer>;
  state: SessionInfo['state'];
  reconnects: number;
  reconnectTimer: NodeJS.Timeout | null;
  pendingRegistration?: { password: string; at: number };
  chanlist?: ChannelListEntry[];
  /** Estado de ausencia: mensaje, lo recibido mientras tanto y a quién se ha respondido ya. */
  away?: { message: string; since: number; log: string[]; replied: Map<string, number>; prevNick?: string };
  /** Protección contra inundaciones: marcas de tiempo recientes por nick e ignorados temporales. */
  flood: Map<string, number[]>;
  tempIgnore: Map<string, number>;
}

interface DccEntry {
  info: DccInfo;
  offer?: DccOffer;
  recv?: DccReceive;
  send?: DccSend;
  chat?: DccChat;
  token?: string;
  resumeTimer?: NodeJS.Timeout;
}

const DEFAULT_SETTINGS: Settings = {
  nick: 'onda' + Math.floor(Math.random() * 9000 + 1000),
  username: 'onda',
  realname: 'Usuario de Onda IRC',
  quitMessage: 'Onda IRC',
  theme: 'dark',
  layout: 'modern',
  fontSize: 14,
  showTimestamps: true,
  logging: true,
  notifications: true,
  sendTyping: true,
  ignore: [],
  notify: [],
  awayMessage: 'Ahora no estoy',
  awayAutoReply: true,
  awayNickSuffix: '',
  floodProtect: true,
  nickSuffix: ': ',
  fkeys: {},
};

/** Abreviaturas de comandos: `/q nick` equivale a `/query nick`, `/ns texto` a `/msg NickServ texto`, etc. */
export const COMMAND_SHORTCUTS: Record<string, string> = {
  q: 'query', p: 'part', w: 'whois', wi: 'whois', k: 'kick', n: 'names', c: 'clear', s: 'server', m: 'msg', t: 'topic',
  a: 'away', i: 'ignore', dop: 'deop', v: 'voice', dv: 'devoice', b: 'ban', l: 'list', id: 'msg NickServ identify',
  ns: 'msg NickServ', cs: 'msg ChanServ', send: 'dcc send', chat: 'dcc chat', exit: 'quit', bye: 'quit',
};

/** Cifrado de contraseñas guardadas (en la aplicación lo aporta el almacén de claves del sistema). */
export interface SecretCodec {
  encrypt(plain: string): string;
  decrypt(cipher: string): string;
}

const SECRET_PREFIX = 'enc:v1:';
const SECRET_FIELDS = ['password', 'saslPassword'] as const;

/** Red preconfigurada en la primera ejecución. */
export const DEFAULT_NETWORK: NetworkConfig = {
  name: 'RogerNet', host: 'irc.rogertp.es', port: 6697, tls: true, nick: '', autojoin: ['#general'],
};

export class AppCore extends EventEmitter implements MslHost {
  sessions = new Map<string, Session>();
  engine: MslEngine;
  logger: Logger;
  settings: Settings = { ...DEFAULT_SETTINGS };
  networks: NetworkConfig[] = [];
  active = { sid: LOCAL, buffer: STATUS };
  dataDir: string;
  version: string;

  private rootDir: string;
  private scriptsDir: string;
  private downloadsDir: string;
  private dccs = new Map<string, DccEntry>();
  private nextSid = 1;
  private nextDcc = 1;
  private varsTimer: NodeJS.Timeout | null = null;
  private secrets: SecretCodec | null;
  private windows = new Map<string, string>();

  constructor(opts: { dataDir: string; downloadsDir?: string; version?: string; secrets?: SecretCodec }) {
    super();
    this.secrets = opts.secrets ?? null;
    this.rootDir = opts.dataDir;
    this.dataDir = path.join(opts.dataDir, 'data');
    this.scriptsDir = path.join(opts.dataDir, 'scripts');
    this.downloadsDir = opts.downloadsDir ?? path.join(opts.dataDir, 'descargas');
    this.version = opts.version ?? 'Onda IRC 0.1';
    for (const d of [this.dataDir, this.scriptsDir]) fs.mkdirSync(d, { recursive: true });
    this.logger = new Logger(path.join(opts.dataDir, 'logs'));
    this.engine = new MslEngine(this);
    this.loadConfig();
    this.logger.enabled = this.settings.logging;
    this.engine.onVarsChanged = () => {
      if (this.varsTimer) return;
      this.varsTimer = setTimeout(() => {
        this.varsTimer = null;
        this.saveVars();
      }, 500);
      this.varsTimer.unref();
    };
    this.engine.onUsersChanged = () =>
      fs.writeFileSync(path.join(this.rootDir, 'users.json'), JSON.stringify(this.engine.users, null, 2));
    for (const file of fs.readdirSync(this.scriptsDir).sort()) {
      if (file.endsWith('.mrc')) this.engine.load(file, fs.readFileSync(path.join(this.scriptsDir, file), 'utf8'));
    }
  }

  // ------------------------------------------------------- persistencia

  private loadConfig(): void {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(this.rootDir, 'config.json'), 'utf8'));
      this.settings = { ...DEFAULT_SETTINGS, ...(cfg.settings ?? {}) };
      this.networks = (Array.isArray(cfg.networks) ? cfg.networks : []).map((n: NetworkConfig) => this.openSecrets(n));
    } catch {
      // Primera ejecución: la red propia queda preconfigurada.
      this.networks = [{ ...DEFAULT_NETWORK, nick: this.settings.nick }];
    }
    try {
      const vars = JSON.parse(fs.readFileSync(path.join(this.rootDir, 'vars.json'), 'utf8'));
      for (const [k, v] of Object.entries(vars)) this.engine.vars.set(k, String(v));
    } catch {
      /* sin variables guardadas */
    }
    try {
      const users = JSON.parse(fs.readFileSync(path.join(this.rootDir, 'users.json'), 'utf8'));
      if (Array.isArray(users)) {
        this.engine.users = users
          .filter((u) => u && typeof u.mask === 'string' && Array.isArray(u.levels))
          .map((u) => ({ mask: u.mask, levels: u.levels.map(String) }));
      }
    } catch {
      /* sin lista de usuarios */
    }
  }

  private saveConfig(): void {
    const networks = this.networks.map((n) => this.sealSecrets(n));
    fs.writeFileSync(path.join(this.rootDir, 'config.json'), JSON.stringify({ settings: this.settings, networks }, null, 2));
  }

  /** Cifra las contraseñas de una red antes de escribirla en disco (si hay almacén de claves). */
  private sealSecrets(n: NetworkConfig): NetworkConfig {
    const out = { ...n };
    if (!this.secrets) return out;
    for (const f of SECRET_FIELDS) {
      const v = out[f];
      if (v) out[f] = SECRET_PREFIX + this.secrets.encrypt(v);
    }
    return out;
  }

  private openSecrets(n: NetworkConfig): NetworkConfig {
    const out = { ...n };
    for (const f of SECRET_FIELDS) {
      const v = out[f];
      if (!v || !v.startsWith(SECRET_PREFIX)) continue;
      try {
        if (!this.secrets) throw new Error('sin almacén de claves');
        out[f] = this.secrets.decrypt(v.slice(SECRET_PREFIX.length));
      } catch {
        delete out[f]; // no se puede descifrar: habrá que volver a escribirla
      }
    }
    return out;
  }

  private saveVars(): void {
    fs.writeFileSync(path.join(this.rootDir, 'vars.json'), JSON.stringify(Object.fromEntries(this.engine.vars), null, 2));
  }

  updateSettings(patch: Partial<Settings>): void {
    this.settings = { ...this.settings, ...patch };
    this.logger.enabled = this.settings.logging;
    this.saveConfig();
    this.ui({ type: 'settings', settings: this.settings });
  }

  saveNetwork(cfg: NetworkConfig): void {
    const i = this.networks.findIndex((n) => n.name === cfg.name);
    if (i === -1) this.networks.push(cfg);
    else this.networks[i] = cfg;
    this.saveConfig();
  }

  removeNetwork(name: string): void {
    this.networks = this.networks.filter((n) => n.name !== name);
    this.saveConfig();
  }

  // ---------------------------------------------------------- interfaz

  private ui(ev: UiEvent): void {
    this.emit('ui', ev);
  }

  snapshot(): Snapshot {
    return {
      sessions: [...this.sessions.values()].map((s) => ({
        ...this.sessionInfo(s),
        buffers: [...s.buffers.values()].map((b) => ({
          name: b.name,
          type: b.type,
          topic: s.client.channel(b.name)?.topic ?? '',
          nicks: b.type === 'channel' ? this.nickList(s, b.name) : [],
        })),
      })),
      settings: this.settings,
      networks: this.networks,
      dccs: [...this.dccs.values()].map((d) => d.info),
      windows: [...this.windows.values()],
      dialogs: [...this.engine.dialogs.values()],
    };
  }

  private sessionInfo(s: Session): SessionInfo {
    return { sid: s.sid, name: s.cfg.name || s.cfg.host, state: s.state, nick: s.client.nick, lag: s.client.lag, away: !!s.away };
  }

  setActive(sid: string, buffer: string): void {
    this.active = { sid, buffer };
  }

  private line(sid: string, buffer: string, kind: LineKind, text: string, extra: Partial<Line> = {}): void {
    const line: Line = { time: Date.now(), kind, text, ...extra };
    this.ui({ type: 'line', sid, buffer, line });
    const s = this.sessions.get(sid);
    if (!s || buffer === STATUS || line.history) return;
    const plain = stripFormatting(text);
    let out: string;
    switch (kind) {
      case 'msg': out = `<${line.prefix ?? ''}${line.nick}> ${plain}`; break;
      case 'action': out = `* ${line.nick} ${plain}`; break;
      case 'notice': out = `-${line.nick}- ${plain}`; break;
      default: out = `* ${plain}`;
    }
    this.logger.append(s.cfg.name || s.cfg.host, buffer, out, new Date(line.time));
  }

  private note(sid: string, buffer: string, text: string): void {
    this.line(sid, buffer, 'info', text);
  }

  private error(sid: string, buffer: string, text: string): void {
    this.line(sid, buffer, 'error', text);
  }

  private ensureBuffer(s: Session, name: string, type: BufferType): Buffer {
    const key = ircLower(name);
    let b = s.buffers.get(key);
    if (!b) {
      b = { name, type };
      s.buffers.set(key, b);
      this.ui({ type: 'buffer:add', sid: s.sid, buffer: name, bufferType: type });
    }
    return b;
  }

  private removeBuffer(s: Session, name: string): void {
    const b = s.buffers.get(ircLower(name));
    if (!b || b.type === 'status') return;
    s.buffers.delete(ircLower(name));
    this.ui({ type: 'buffer:remove', sid: s.sid, buffer: b.name });
    if (this.active.sid === s.sid && ircLower(this.active.buffer) === ircLower(name)) this.active = { sid: s.sid, buffer: STATUS };
  }

  private nickList(s: Session, chan: string): NickEntry[] {
    const ch = s.client.channel(chan);
    if (!ch) return [];
    const order = '~&@%+';
    const rank = (p: string) => (p ? (order.indexOf(p[0]) === -1 ? 9 : order.indexOf(p[0])) : 10);
    return [...ch.users.values()]
      .map((u) => ({ nick: u.nick, prefix: u.prefix }))
      .sort((a, b) => rank(a.prefix) - rank(b.prefix) || a.nick.toLowerCase().localeCompare(b.nick.toLowerCase()));
  }

  private emitNicks(s: Session, chan: string): void {
    this.ui({ type: 'nicks', sid: s.sid, buffer: chan, nicks: this.nickList(s, chan) });
  }

  /** ¿Está ignorado este remitente? Se compara el nick y la máscara completa nick!usuario@host. */
  private ignored(nick: string, hostmask: string): boolean {
    const full = `${nick}!${hostmask || '*@*'}`;
    return this.settings.ignore.some((m) => (/[!@]/.test(m) ? wildMatch(m, full) : wildMatch(m, nick)));
  }

  /**
   * Protección personal: cuenta lo que envía un nick y, si supera el límite en la ventana de tiempo,
   * lo ignora durante dos minutos. Devuelve true si el mensaje debe descartarse.
   */
  private flooding(s: Session, nick: string, kind: 'ctcp' | 'msg'): boolean {
    const k = ircLower(nick);
    const now = Date.now();
    if ((s.tempIgnore.get(k) ?? 0) > now) return true;
    if (!this.settings.floodProtect) return false;
    const [limit, windowMs] = kind === 'ctcp' ? [4, 10000] : [8, 6000];
    const key = `${kind}:${k}`;
    const times = (s.flood.get(key) ?? []).filter((t) => now - t < windowMs);
    times.push(now);
    s.flood.set(key, times);
    if (s.flood.size > 500) s.flood.clear();
    if (times.length < limit) return false;
    s.tempIgnore.set(k, now + 120000);
    s.flood.delete(key);
    this.line(s.sid, STATUS, 'error', `Protección: ${nick} está inundando con ${kind === 'ctcp' ? 'peticiones CTCP' : 'mensajes privados'}; se le ignora durante 2 minutos.`);
    return true;
  }

  private setAway(s: Session, message: string): void {
    const c = s.client;
    const prevNick = this.settings.awayNickSuffix && !c.nick.endsWith(this.settings.awayNickSuffix) ? c.nick : undefined;
    s.away = { message, since: Date.now(), log: [], replied: new Map(), prevNick };
    c.send(`AWAY :${message}`);
    if (prevNick) c.setNick(prevNick + this.settings.awayNickSuffix);
    this.note(s.sid, this.active.sid === s.sid ? this.active.buffer : STATUS, `Ahora estás ausente: ${message}`);
    this.ui({ type: 'session', ...this.sessionInfo(s) });
  }

  private setBack(s: Session): void {
    const away = s.away;
    s.away = undefined;
    s.client.send('AWAY');
    if (away?.prevNick) s.client.setNick(away.prevNick);
    const where = this.active.sid === s.sid ? this.active.buffer : STATUS;
    if (away) {
      const mins = Math.max(1, Math.round((Date.now() - away.since) / 60000));
      this.note(s.sid, where, `Has vuelto tras ${mins} min. ${away.log.length ? `Mientras tanto te escribieron ${away.log.length === 1 ? 'una vez' : `${away.log.length} veces`}:` : 'Nadie te escribió mientras tanto.'}`);
      for (const l of away.log) this.line(s.sid, where, 'info', l);
    }
    this.ui({ type: 'session', ...this.sessionInfo(s) });
  }

  // --------------------------------------------------------- conexiones

  connect(cfg: NetworkConfig): string {
    const sid = 's' + this.nextSid++;
    const s: Session = {
      sid, cfg, client: this.makeClient(cfg), buffers: new Map(), state: 'connecting', reconnects: 0, reconnectTimer: null,
      flood: new Map(), tempIgnore: new Map(),
    };
    this.sessions.set(sid, s);
    this.ui({ type: 'session', ...this.sessionInfo(s) });
    this.ensureBuffer(s, STATUS, 'status');
    this.ui({ type: 'activate', sid, buffer: STATUS });
    this.active = { sid, buffer: STATUS };
    this.wire(s);
    this.note(sid, STATUS, `Conectando a ${cfg.host}:${cfg.port}${cfg.tls ? ' (TLS)' : ''}…`);
    s.client.connect();
    return sid;
  }

  private makeClient(cfg: NetworkConfig): IrcClient {
    return new IrcClient({
      host: cfg.host,
      port: cfg.port,
      tls: cfg.tls,
      rejectUnauthorized: !cfg.allowInvalidCert,
      nick: cfg.nick || this.settings.nick,
      username: cfg.username || this.settings.username,
      realname: cfg.realname || this.settings.realname,
      password: cfg.password || undefined,
      sasl: cfg.saslAccount && cfg.saslPassword ? { account: cfg.saslAccount, password: cfg.saslPassword } : undefined,
      autojoin: cfg.autojoin,
      version: this.version,
    });
  }

  private reconnect(s: Session): void {
    if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
    s.reconnectTimer = null;
    s.client.removeAllListeners();
    // Al reconectar se vuelve a entrar en los canales que estaban abiertos.
    const open = [...s.buffers.values()].filter((b) => b.type === 'channel').map((b) => b.name);
    const autojoin = [...new Set([...(s.cfg.autojoin ?? []), ...open].map((c) => c.trim()).filter(Boolean))];
    s.client = this.makeClient({ ...s.cfg, autojoin });
    s.state = 'connecting';
    this.ui({ type: 'session', ...this.sessionInfo(s) });
    this.wire(s);
    this.note(s.sid, STATUS, `Conectando a ${s.cfg.host}:${s.cfg.port}…`);
    s.client.connect();
  }

  closeSession(sid: string): void {
    const s = this.sessions.get(sid);
    if (!s) return;
    if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
    s.client.disconnect(this.settings.quitMessage);
    s.client.removeAllListeners();
    s.client.on('error', () => undefined);
    this.sessions.delete(sid);
    this.ui({ type: 'session:remove', sid });
    if (this.active.sid === sid) this.active = { sid: LOCAL, buffer: STATUS };
  }

  shutdown(): void {
    for (const s of this.sessions.values()) {
      if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
      s.client.disconnect(this.settings.quitMessage);
    }
    this.engine.dispose();
    if (this.varsTimer) {
      clearTimeout(this.varsTimer);
      this.saveVars();
    }
  }

  private wire(s: Session): void {
    const c = s.client;
    const sid = s.sid;
    const base = (extra: Partial<MslContext> & { text?: string; isMe?: boolean }) => ({ cid: sid, ...extra });

    c.on('error', (err: Error) => this.error(sid, STATUS, `Error de conexión: ${err.message}`));
    c.on('servererror', (text: string) => this.error(sid, STATUS, `El servidor cerró la conexión: ${text}`));
    c.on('sasl', (ok: boolean, text: string) =>
      ok ? this.note(sid, STATUS, 'Autenticación SASL correcta') : this.error(sid, STATUS, `Falló la autenticación SASL: ${text}`),
    );
    c.on('loggedin', (account: string) => {
      this.note(sid, STATUS, `Sesión iniciada como ${account}`);
      // Tras /register, la cuenta se guarda en la red para identificarse sola (SASL) en adelante.
      const pending = s.pendingRegistration;
      s.pendingRegistration = undefined;
      if (!pending || Date.now() - pending.at > 120000) return;
      s.cfg = { ...s.cfg, saslAccount: account || c.nick, saslPassword: pending.password };
      if (this.networks.some((n) => n.name === s.cfg.name)) {
        this.saveNetwork(s.cfg);
        this.note(sid, STATUS, 'Cuenta registrada. Se ha guardado en esta red para identificarte automáticamente.');
      } else this.note(sid, STATUS, 'Cuenta registrada. Guarda esta red desde «Conectar» para identificarte automáticamente.');
    });
    c.on('lag', () => this.ui({ type: 'session', ...this.sessionInfo(s) }));
    c.on('registered', () => {
      s.state = 'connected';
      s.reconnects = 0;
      this.ui({ type: 'session', ...this.sessionInfo(s) });
      this.engine.fire('CONNECT', base({ nick: c.nick, isMe: true }));
      for (const line of s.cfg.perform ?? []) {
        const cmd = line.trim();
        if (cmd) this.engine.execLine(cmd.startsWith('/') ? cmd : '/' + cmd, this.ctxFor(sid, STATUS), cmd.startsWith('//'));
      }
    });
    c.on('close', ({ wasConnected, byUser }: { wasConnected: boolean; byUser: boolean }) => {
      if (!this.sessions.has(sid)) return;
      s.state = 'disconnected';
      this.ui({ type: 'session', ...this.sessionInfo(s) });
      for (const b of s.buffers.values()) {
        this.note(sid, b.name, 'Desconectado');
        if (b.type === 'channel') this.ui({ type: 'nicks', sid, buffer: b.name, nicks: [] });
      }
      if (wasConnected) this.engine.fire('DISCONNECT', base({ nick: c.nick, isMe: true }));
      if (!byUser && s.reconnects < 8) {
        const delay = Math.min(120, 5 * 2 ** s.reconnects);
        s.reconnects++;
        this.note(sid, STATUS, `Reintentando en ${delay} s…`);
        s.reconnectTimer = setTimeout(() => this.reconnect(s), delay * 1000);
        s.reconnectTimer.unref();
      }
    });

    c.on('numeric', (msg: IrcMessage) => {
      const text = msg.params.slice(1).join(' ');
      // Lista de canales (/list): se reúne y se entrega entera a la interfaz.
      if (msg.command === '321') {
        s.chanlist = [];
        return;
      }
      if (msg.command === '322' && s.chanlist) {
        if (s.chanlist.length < 20000) s.chanlist.push({ name: msg.params[1] ?? '', users: Number(msg.params[2]) || 0, topic: msg.params[3] ?? '' });
        return;
      }
      if (msg.command === '323' && s.chanlist) {
        this.ui({ type: 'chanlist', sid, channels: s.chanlist.sort((a, b) => b.users - a.users) });
        this.note(sid, STATUS, `Lista de canales recibida: ${s.chanlist.length}`);
        s.chanlist = undefined;
        return;
      }
      // Avisos de amigos (MONITOR): 730 en línea, 731 desconectado.
      if (msg.command === '730' || msg.command === '731') {
        const where = this.active.sid === sid ? this.active.buffer : STATUS;
        for (const entry of (msg.params[1] ?? '').split(',')) {
          const nick = entry.split('!')[0];
          if (nick) this.line(sid, s.buffers.has(ircLower(where)) ? where : STATUS, 'info', msg.command === '730' ? `${nick} está en línea` : `${nick} se ha desconectado`, { highlight: msg.command === '730' });
        }
        return;
      }
      if ((msg.command === '376' || msg.command === '422') && this.settings.notify.length && c.isupport.MONITOR !== undefined) {
        c.send(`MONITOR + ${this.settings.notify.join(',')}`);
      }
      const r = this.engine.fire('RAW', base({ numeric: msg.command, rawmsg: msg.raw, text: msg.params.join(' ') }), true);
      if (!r.haltdef && !['353', '366'].includes(msg.command)) {
        const isError = /^[45]\d\d$/.test(msg.command);
        const target = isError && this.active.sid === sid ? this.active.buffer : STATUS;
        this.line(sid, s.buffers.has(ircLower(target)) ? target : STATUS, isError ? 'error' : 'server', text);
      }
      this.engine.fire('RAW', base({ numeric: msg.command, rawmsg: msg.raw, text: msg.params.join(' ') }));
    });

    c.on('message', (m: MessageEvent) => {
      const isChan = !!m.target && c.isChannel(m.target);
      const event = m.kind === 'action' ? 'ACTION' : m.kind === 'notice' ? 'NOTICE' : 'TEXT';
      const init = base({
        nick: m.from, chan: isChan ? m.target : undefined, target: isChan ? m.target : c.nick, address: m.hostmask,
        text: m.text, isMe: m.self,
      });
      if (!m.self && this.ignored(m.from, m.hostmask)) return;
      if (!m.self && !m.history && !isChan && m.kind !== 'notice' && this.flooding(s, m.from, 'msg')) return;
      if (!m.self && (s.tempIgnore.get(ircLower(m.from)) ?? 0) > Date.now()) return;
      const scripted = !m.self && !m.history;
      if (scripted && this.engine.fire(event, init, true).haltdef) return;

      let buffer = STATUS;
      if (isChan) buffer = this.ensureBuffer(s, m.target, 'channel').name;
      else if (m.target && (m.kind !== 'notice' || s.buffers.has(ircLower(m.target)))) buffer = this.ensureBuffer(s, m.target, 'query').name;

      const kind: LineKind = m.kind === 'privmsg' ? 'msg' : m.kind;
      const mention = new RegExp(`(^|[^A-Za-z0-9_])${c.nick.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^A-Za-z0-9_])`, 'i');
      const highlight = !m.self && !m.history && m.kind !== 'notice' && (!isChan || mention.test(stripFormatting(m.text)));
      const prefix = isChan ? c.channel(m.target)?.users.get(ircLower(m.from))?.prefix[0] ?? '' : '';
      this.line(sid, buffer, kind, m.text, {
        nick: m.from, prefix, self: m.self, highlight, history: m.history, time: m.time.getTime(), msgid: m.tags.msgid,
      });
      this.ui({ type: 'typing', sid, buffer, nick: m.from, state: 'done' });
      // Sistema de ausencia: se anota quién escribió y, si procede, se le avisa una vez cada diez minutos.
      if (s.away && highlight) {
        const t = new Date(m.time);
        const hhmm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
        if (s.away.log.length < 200) s.away.log.push(`[${hhmm}] <${m.from}${isChan ? ` en ${m.target}` : ''}> ${stripFormatting(m.text)}`);
        const last = s.away.replied.get(ircLower(m.from)) ?? 0;
        if (this.settings.awayAutoReply && Date.now() - last > 600000) {
          s.away.replied.set(ircLower(m.from), Date.now());
          c.send(`NOTICE ${m.from} :Estoy ausente: ${s.away.message}`);
        }
      }
      if (scripted) this.engine.fire(event, init);
    });

    c.on('join', (e: { nick: string; channel: string; hostmask: string; self: boolean }) => {
      const init = base({ nick: e.nick, chan: e.channel, target: e.channel, address: e.hostmask, isMe: e.self });
      const b = this.ensureBuffer(s, e.channel, 'channel');
      if (e.self) {
        this.ui({ type: 'activate', sid, buffer: b.name });
        this.active = { sid, buffer: b.name };
        c.requestHistory(e.channel);
      }
      if (!this.engine.fire('JOIN', init, true).haltdef) {
        this.line(sid, b.name, 'join', e.self ? `Has entrado en ${e.channel}` : `${e.nick} (${e.hostmask}) ha entrado en ${e.channel}`, { nick: e.nick });
      }
      this.emitNicks(s, e.channel);
      this.engine.fire('JOIN', init);
    });

    c.on('part', (e: { nick: string; channel: string; reason: string; hostmask: string; self: boolean }) => {
      const init = base({ nick: e.nick, chan: e.channel, target: e.channel, address: e.hostmask, text: e.reason, isMe: e.self });
      if (e.self) this.removeBuffer(s, e.channel);
      else if (!this.engine.fire('PART', init, true).haltdef) {
        this.line(sid, e.channel, 'part', `${e.nick} ha salido de ${e.channel}${e.reason ? ` (${e.reason})` : ''}`, { nick: e.nick });
        this.emitNicks(s, e.channel);
      }
      this.engine.fire('PART', init);
    });

    c.on('kick', (e: { nick: string; channel: string; victim: string; reason: string; self: boolean }) => {
      const init = base({ nick: e.nick, chan: e.channel, target: e.channel, knick: e.victim, text: e.reason, isMe: e.self });
      this.line(sid, e.channel, 'kick', `${e.victim} ha sido expulsado de ${e.channel} por ${e.nick}${e.reason ? ` (${e.reason})` : ''}`, { nick: e.nick, highlight: e.self });
      this.emitNicks(s, e.channel);
      this.engine.fire('KICK', init);
    });

    c.on('quit', (e: { nick: string; reason: string; channels: string[]; hostmask: string }) => {
      const init = base({ nick: e.nick, address: e.hostmask, text: e.reason });
      const hide = this.engine.fire('QUIT', init, true).haltdef;
      for (const ch of e.channels) {
        if (!hide) this.line(sid, ch, 'quit', `${e.nick} ha abandonado el IRC${e.reason ? ` (${e.reason})` : ''}`, { nick: e.nick });
        this.emitNicks(s, ch);
      }
      if (!hide && s.buffers.has(ircLower(e.nick))) this.line(sid, e.nick, 'quit', `${e.nick} ha abandonado el IRC`);
      this.engine.fire('QUIT', init);
    });

    c.on('nick', (e: { oldNick: string; newNick: string; channels: string[]; self: boolean }) => {
      const text = e.self ? `Ahora eres ${e.newNick}` : `${e.oldNick} ahora es ${e.newNick}`;
      for (const ch of e.channels) {
        this.line(sid, ch, 'nick', text, { nick: e.newNick });
        this.emitNicks(s, ch);
      }
      if (e.self) {
        this.note(sid, STATUS, text);
        this.ui({ type: 'session', ...this.sessionInfo(s) });
      }
      const q = s.buffers.get(ircLower(e.oldNick));
      if (q && q.type === 'query' && !s.buffers.has(ircLower(e.newNick))) {
        this.removeBuffer(s, e.oldNick);
        this.ensureBuffer(s, e.newNick, 'query');
      }
      this.engine.fire('NICK', base({ nick: e.oldNick, newnick: e.newNick, isMe: e.self }));
    });

    c.on('topic', (e: { channel: string; topic: string; nick: string; initial: boolean }) => {
      if (!s.buffers.has(ircLower(e.channel))) return;
      this.ui({ type: 'topic', sid, buffer: e.channel, topic: e.topic });
      if (e.initial) {
        if (e.topic) this.line(sid, e.channel, 'topic', `Tema: ${e.topic}`);
      } else {
        this.line(sid, e.channel, 'topic', `${e.nick} ha cambiado el tema a: ${e.topic}`, { nick: e.nick });
        this.engine.fire('TOPIC', base({ nick: e.nick, chan: e.channel, target: e.channel, text: e.topic }));
      }
    });

    c.on('mode', (e: { nick: string; target: string; modes: string; args: string[] }) => {
      const text = `${e.nick} establece modo ${e.modes} ${e.args.join(' ')}`.trim();
      if (c.isChannel(e.target) && s.buffers.has(ircLower(e.target))) {
        this.line(sid, e.target, 'mode', text, { nick: e.nick });
        this.emitNicks(s, e.target);
        this.engine.fire('MODE', base({ nick: e.nick, chan: e.target, target: e.target, text: `${e.modes} ${e.args.join(' ')}`.trim() }));
      } else this.line(sid, STATUS, 'mode', text);
    });

    c.on('names', (e: { channel: string }) => this.emitNicks(s, e.channel));
    c.on('typing', (e: { nick: string; target: string; state: string }) => this.ui({ type: 'typing', sid, buffer: e.target, nick: e.nick, state: e.state }));
    c.on('react', (e: { nick: string; target: string; emoji: string; msgid: string }) => this.ui({ type: 'react', sid, buffer: e.target, ...e }));
    c.on('invite', (e: { nick: string; channel: string }) => {
      if (!this.ignored(e.nick, '')) this.note(sid, STATUS, `${e.nick} te invita a ${e.channel}`);
    });
    c.on('ctcpreply', (e: { from: string; command: string; args: string }) => {
      let text = e.args;
      if (e.command === 'PING' && /^\d+$/.test(e.args)) text = `${((Date.now() - Number(e.args)) / 1000).toFixed(2)} s`;
      this.line(sid, this.active.sid === sid ? this.active.buffer : STATUS, 'ctcp', `[${e.from} respuesta ${e.command}] ${text}`);
    });
    c.on('ctcp', (e: { from: string; target: string; command: string; args: string; hostmask: string }) => {
      if (this.ignored(e.from, e.hostmask) || this.flooding(s, e.from, 'ctcp')) return;
      if (e.command === 'DCC') {
        this.onDccOffer(s, e.from, e.args);
        return;
      }
      const r = this.engine.fire('CTCP', base({ nick: e.from, address: e.hostmask, target: e.target, text: `${e.command} ${e.args}`.trim() }));
      if (!r.haltdef) this.line(sid, STATUS, 'ctcp', `[${e.from} CTCP ${e.command}] ${e.args}`.trim());
    });
  }

  // ------------------------------------------------------------ entrada

  private ctxFor(sid: string, buffer: string): MslContext {
    const s = this.sessions.get(sid);
    const isChan = !!s && s.buffers.get(ircLower(buffer))?.type === 'channel';
    return newContext({
      cid: s ? sid : null, chan: isChan ? buffer : undefined, target: buffer === STATUS ? undefined : buffer,
      nick: s?.client.nick ?? this.settings.nick,
    });
  }

  /** Procesa lo que el usuario escribe en un búfer. */
  input(sid: string, buffer: string, text: string): void {
    this.active = { sid, buffer };
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const ctx = this.ctxFor(sid, buffer);
      if (line.startsWith('/')) {
        this.engine.execLine(line, ctx, line.startsWith('//'));
        continue;
      }
      const init = { cid: ctx.cid, chan: ctx.chan, target: ctx.target, nick: ctx.nick, text: line, isMe: true };
      if (this.engine.fire('INPUT', init).haltdef) continue;
      if (buffer.startsWith('@')) continue; // ventana personalizada: solo la atienden los scripts (on INPUT)
      this.sayTo(sid, buffer, line);
    }
  }

  private sayTo(sid: string, buffer: string, text: string): void {
    const s = this.sessions.get(sid);
    if (!s || buffer === STATUS) {
      this.error(sid, STATUS, 'Esta ventana no es un canal ni una conversación. Usa /join #canal o /msg nick texto.');
      return;
    }
    if (buffer.startsWith('=')) {
      const d = [...this.dccs.values()].find((x) => x.chat && x.info.sid === sid && ircLower('=' + x.info.nick) === ircLower(buffer));
      if (d?.chat?.write(text)) this.line(sid, buffer, 'msg', text, { nick: s.client.nick, self: true });
      else this.error(sid, buffer, 'El chat DCC no está conectado');
      return;
    }
    if (!s.client.registered) {
      this.error(sid, buffer, 'No estás conectado');
      return;
    }
    s.client.say(buffer, text);
  }

  typing(sid: string, buffer: string, state: 'active' | 'paused' | 'done'): void {
    const s = this.sessions.get(sid);
    if (s && this.settings.sendTyping && buffer !== STATUS && !buffer.startsWith('=') && s.client.registered) s.client.typing(buffer, state);
  }

  private closeWindow(name: string): boolean {
    const real = this.windows.get(name.toLowerCase());
    if (!real) return false;
    this.windows.delete(name.toLowerCase());
    this.ui({ type: 'buffer:remove', sid: LOCAL, buffer: real });
    if (this.active.sid === LOCAL && this.active.buffer.toLowerCase() === name.toLowerCase()) this.active = { sid: LOCAL, buffer: STATUS };
    return true;
  }

  closeBuffer(sid: string, buffer: string): void {
    if (buffer.startsWith('@') && this.closeWindow(buffer)) return;
    const s = this.sessions.get(sid);
    if (!s) return;
    const b = s.buffers.get(ircLower(buffer));
    if (!b) return;
    if (b.type === 'status') this.closeSession(sid);
    else if (b.type === 'channel' && s.client.channel(buffer)) s.client.part(buffer);
    else this.removeBuffer(s, buffer);
  }

  // ---------------------------------------------------- interfaz MslHost

  private sessionOf(ctx: MslContext): Session | undefined {
    return this.sessions.get(ctx.cid ?? '') ?? this.sessions.get(this.active.sid);
  }

  info(ctx: MslContext) {
    const s = this.sessionOf(ctx);
    return {
      me: s?.client.nick ?? this.settings.nick,
      server: s?.client.serverName || s?.cfg.host || '',
      network: s?.client.network ?? '',
      active: this.active.buffer === STATUS ? 'Status Window' : this.active.buffer,
      channels: s ? [...s.client.channels.values()].map((c) => c.name) : [],
    };
  }

  nicks(ctx: MslContext, chan: string): NickEntry[] {
    const s = this.sessionOf(ctx);
    return s ? this.nickList(s, chan) : [];
  }

  echo(text: string, target: string | null, ctx: MslContext, flags: string): void {
    const s = this.sessionOf(ctx);
    const sid = s?.sid ?? LOCAL;
    if (target?.startsWith('@')) {
      const name = this.windows.get(target.toLowerCase());
      if (name) this.ui({ type: 'line', sid: LOCAL, buffer: name, line: { time: Date.now(), kind: 'echo', text } });
      return;
    }
    let buffer = STATUS;
    if (target && s?.buffers.has(ircLower(target))) buffer = s.buffers.get(ircLower(target))!.name;
    else if (flags.includes('a') && this.active.sid === sid) buffer = this.active.buffer;
    this.ui({ type: 'line', sid, buffer, line: { time: Date.now(), kind: 'echo', text } });
  }

  dialogChanged(name: string, view: DialogView | null): void {
    this.ui({ type: 'dialog', name, view });
  }

  /** Acción del usuario sobre un diálogo de script (clic, texto, selección o cierre). */
  dialogEvent(name: string, event: string, id: number, value?: { text?: string; checked?: boolean; sel?: number }): void {
    this.engine.dialogEvent(String(name), String(event), Number(id) || 0, value && typeof value === 'object' ? value : {});
  }

  raw(line: string, ctx: MslContext): void {
    const s = this.sessionOf(ctx);
    if (s?.client.connected) s.client.send(line);
    else this.error(s?.sid ?? LOCAL, STATUS, `Comando desconocido o sin conexión: ${line.split(' ')[0]}`);
  }

  command(nameIn: string, argsIn: string, ctx: MslContext): boolean {
    // Abreviaturas de los comandos más usados (los alias de los scripts tienen prioridad sobre ellas).
    const short = COMMAND_SHORTCUTS[nameIn];
    const name = short ? short.split(' ')[0] : nameIn;
    const args = short && short.includes(' ') ? `${short.slice(short.indexOf(' ') + 1)} ${argsIn}`.trim() : argsIn;
    const s = this.sessionOf(ctx);
    const sid = s?.sid ?? LOCAL;
    const here = ctx.target ?? (this.active.sid === sid ? this.active.buffer : STATUS);
    const chan = ctx.chan ?? (s && s.buffers.get(ircLower(here))?.type === 'channel' ? here : '');
    const toks = args.split(' ').filter(Boolean);
    const tail = (n: number) => args.split(' ').filter(Boolean).slice(n).join(' ');
    const fail = (msg: string) => {
      this.error(sid, this.active.sid === sid ? this.active.buffer : STATUS, msg);
      return true;
    };
    const online = (): Session | null => (s && s.client.registered ? s : null);
    const needChan = (first: string | undefined) => (first && s?.client.isChannel(first) ? { c: first, rest: 1 } : { c: chan, rest: 0 });

    switch (name) {
      case 'server':
      case 'connect': {
        if (!toks.length) return fail('Uso: /server [-e] servidor[:puerto] [puerto] [contraseña]');
        let tls = false;
        while (toks[0]?.startsWith('-')) {
          if (/e|ssl|tls/i.test(toks[0])) tls = true;
          toks.shift();
        }
        const saved = this.networks.find((n) => n.name.toLowerCase() === (toks[0] ?? '').toLowerCase());
        if (saved) {
          this.connect(saved);
          return true;
        }
        let [host, portStr] = (toks.shift() ?? '').split(':');
        if (!portStr && /^\+?\d+$/.test(toks[0] ?? '')) portStr = toks.shift()!;
        if (portStr?.startsWith('+')) {
          tls = true;
          portStr = portStr.slice(1);
        }
        if (!host) return fail('Falta el servidor');
        const port = Number(portStr) || (tls ? 6697 : 6667);
        if (port === 6697) tls = true;
        this.connect({ name: host, host, port, tls, nick: this.settings.nick, password: toks[0] });
        return true;
      }
      case 'disconnect':
        s?.client.disconnect(args || this.settings.quitMessage);
        return true;
      case 'quit':
        if (s) this.closeSession(s.sid);
        return true;
      case 'reconnect':
        if (s) {
          s.client.disconnect('Reconectando');
          setTimeout(() => this.sessions.has(s.sid) && this.reconnect(s), 800);
        }
        return true;
      case 'join':
      case 'j': {
        if (!online()) return fail('No estás conectado');
        if (!toks[0]) return fail('Uso: /join #canal [clave]');
        for (const ch of toks[0].split(',')) s!.client.join(s!.client.isChannel(ch) ? ch : '#' + ch, toks[1]);
        return true;
      }
      case 'part':
      case 'leave': {
        if (!online()) return fail('No estás conectado');
        const { c, rest } = needChan(toks[0]);
        if (!c) return fail('Uso: /part [#canal] [motivo]');
        s!.client.part(c, tail(rest));
        return true;
      }
      case 'msg':
      case 'say':
      case 'notice':
      case 'me':
      case 'describe':
      case 'action': {
        if (!online()) return fail('No estás conectado');
        const explicit = name === 'msg' || name === 'notice' || name === 'describe';
        const target = explicit ? toks[0] : here;
        const text = explicit ? tail(1) : args;
        if (!target || target === STATUS || !text) return fail(`Uso: /${name} ${explicit ? 'destino ' : ''}texto`);
        if (name === 'notice') s!.client.notice(target, text);
        else if (name === 'msg' || name === 'say') s!.client.say(target, text);
        else s!.client.action(target, text);
        return true;
      }
      case 'amsg':
      case 'ame':
        if (!online()) return fail('No estás conectado');
        for (const ch of s!.client.channels.values()) name === 'amsg' ? s!.client.say(ch.name, args) : s!.client.action(ch.name, args);
        return true;
      case 'query': {
        if (!s || !toks[0]) return fail('Uso: /query nick [texto]');
        const b = this.ensureBuffer(s, toks[0], 'query');
        this.ui({ type: 'activate', sid, buffer: b.name });
        this.active = { sid, buffer: b.name };
        if (tail(1) && online()) s.client.say(toks[0], tail(1));
        return true;
      }
      case 'nick':
        if (!toks[0]) return fail('Uso: /nick nuevo_nick');
        if (s?.client.connected) s.client.setNick(toks[0]);
        else this.updateSettings({ nick: toks[0] });
        return true;
      case 'topic': {
        if (!online()) return fail('No estás conectado');
        const { c, rest } = needChan(toks[0]);
        if (!c) return fail('Uso: /topic [#canal] [tema]');
        s!.client.send(tail(rest) ? `TOPIC ${c} :${tail(rest)}` : `TOPIC ${c}`);
        return true;
      }
      case 'kick': {
        if (!online()) return fail('No estás conectado');
        const { c, rest } = needChan(toks[0]);
        if (!c || !toks[rest]) return fail('Uso: /kick [#canal] nick [motivo]');
        s!.client.send(`KICK ${c} ${toks[rest]} :${tail(rest + 1) || toks[rest]}`);
        return true;
      }
      case 'op': case 'deop': case 'voice': case 'devoice': case 'ban': case 'unban': {
        if (!online()) return fail('No estás conectado');
        const { c, rest } = needChan(toks[0]);
        const who = toks.slice(rest);
        if (!c || !who.length) return fail(`Uso: /${name} [#canal] nick`);
        const mode = { op: '+o', deop: '-o', voice: '+v', devoice: '-v', ban: '+b', unban: '-b' }[name]!;
        for (const w of who) s!.client.send(`MODE ${c} ${mode} ${name.endsWith('ban') && !/[!@*]/.test(w) ? w + '!*@*' : w}`);
        return true;
      }
      case 'mode':
        if (!online()) return fail('No estás conectado');
        s!.client.send(`MODE ${toks.length && !/^[+-]/.test(toks[0]) ? args : `${chan || s!.client.nick} ${args}`}`);
        return true;
      case 'register': {
        if (!online()) return fail('No estás conectado');
        if (!toks[0]) return fail('Uso: /register contraseña  (registra tu nick actual como cuenta en la red)');
        s!.pendingRegistration = { password: args, at: Date.now() };
        s!.client.send(`PRIVMSG NickServ :REGISTER ${args}`);
        this.note(sid, STATUS, `Solicitando el registro de la cuenta ${s!.client.nick}…`);
        return true;
      }
      case 'notify': {
        const where = this.active.sid === sid ? this.active.buffer : STATUS;
        const remove = toks.includes('-r');
        const nick = toks.filter((t) => !t.startsWith('-'))[0];
        if (!nick) {
          this.note(sid, where, this.settings.notify.length ? `Lista de avisos: ${this.settings.notify.join(', ')}` : 'Lista de avisos vacía. Uso: /notify nick  ·  /notify -r nick');
          return true;
        }
        const has = this.settings.notify.some((n) => ircLower(n) === ircLower(nick));
        if (remove) this.updateSettings({ notify: this.settings.notify.filter((n) => ircLower(n) !== ircLower(nick)) });
        else if (!has) this.updateSettings({ notify: [...this.settings.notify, nick] });
        this.note(sid, where, remove ? `${nick} eliminado de la lista de avisos` : `Se te avisará cuando ${nick} entre o salga de la red`);
        if (online()) {
          if (s!.client.isupport.MONITOR !== undefined) s!.client.send(`MONITOR ${remove ? '-' : '+'} ${nick}`);
          else if (!remove) this.note(sid, where, 'Este servidor no admite avisos de presencia (MONITOR).');
        }
        return true;
      }
      case 'list':
        if (!online()) return fail('No estás conectado');
        s!.client.send(args ? `LIST ${args}` : 'LIST');
        this.note(sid, STATUS, 'Pidiendo la lista de canales…');
        return true;
      case 'ignore':
      case 'unignore': {
        const where = this.active.sid === sid ? this.active.buffer : STATUS;
        const mask = toks.filter((t) => !t.startsWith('-'))[0];
        if (!mask) {
          this.note(sid, where, this.settings.ignore.length ? `Ignorados: ${this.settings.ignore.join(', ')}` : 'No ignoras a nadie. Uso: /ignore nick  ·  /unignore nick');
          return true;
        }
        const has = this.settings.ignore.some((m) => m.toLowerCase() === mask.toLowerCase());
        if (name === 'ignore' && !toks.includes('-r')) {
          if (!has) this.updateSettings({ ignore: [...this.settings.ignore, mask] });
          this.note(sid, where, `Ignorando a ${mask}`);
        } else {
          this.updateSettings({ ignore: this.settings.ignore.filter((m) => m.toLowerCase() !== mask.toLowerCase()) });
          this.note(sid, where, has ? `Ya no ignoras a ${mask}` : `${mask} no estaba ignorado`);
        }
        return true;
      }
      case 'whois':
        if (!online()) return fail('No estás conectado');
        s!.client.send(`WHOIS ${toks[0] ?? s!.client.nick}`);
        return true;
      case 'names':
        if (!online()) return fail('No estás conectado');
        s!.client.send(`NAMES ${toks[0] ?? chan}`.trim());
        return true;
      case 'away':
        if (!online()) return fail('No estás conectado');
        // /away sin texto alterna: te marca ausente con el mensaje por defecto, o te trae de vuelta.
        if (!args && s!.away) this.setBack(s!);
        else this.setAway(s!, args || this.settings.awayMessage || 'Ausente');
        return true;
      case 'back':
        if (online()) this.setBack(s!);
        return true;
      case 'ctcp':
        if (!online()) return fail('No estás conectado');
        if (toks.length < 2) return fail('Uso: /ctcp nick comando');
        s!.client.ctcp(toks[0], toks[1], toks[1].toUpperCase() === 'PING' ? String(Date.now()) : tail(2));
        return true;
      case 'ping':
        if (online() && toks[0]) s!.client.ctcp(toks[0], 'PING', String(Date.now()));
        return true;
      case 'raw':
      case 'quote':
        if (!s?.client.connected) return fail('No estás conectado');
        s.client.send(args);
        return true;
      case 'window': {
        const flags = toks[0]?.startsWith('-') ? toks.shift()! : '';
        const name = toks[0] ?? '';
        if (!name.startsWith('@') || name.length < 2) return fail('Uso: /window [-c] @nombre');
        if (flags.includes('c')) {
          this.closeWindow(name);
          return true;
        }
        if (!this.windows.has(name.toLowerCase())) {
          this.windows.set(name.toLowerCase(), name);
          this.ui({ type: 'buffer:add', sid: LOCAL, buffer: name, bufferType: 'custom' });
        }
        if (!flags.includes('h') && !flags.includes('n')) {
          this.ui({ type: 'activate', sid: LOCAL, buffer: this.windows.get(name.toLowerCase())! });
          this.active = { sid: LOCAL, buffer: this.windows.get(name.toLowerCase())! };
        }
        return true;
      }
      case 'aline': {
        while (toks[0]?.startsWith('-')) toks.shift();
        let color = '';
        if (toks.length > 2 && /^\d{1,2}$/.test(toks[0])) color = toks.shift()!;
        const name = this.windows.get((toks[0] ?? '').toLowerCase());
        if (!name) return fail('Uso: /aline [color] @ventana texto (la ventana debe existir: /window @nombre)');
        const text = toks.slice(1).join(' ');
        this.ui({ type: 'line', sid: LOCAL, buffer: name, line: { time: Date.now(), kind: 'echo', text: color ? `\x03${color.padStart(2, '0')}${text}` : text } });
        return true;
      }
      case 'clear':
        if (toks[0]?.startsWith('@') && this.windows.has(toks[0].toLowerCase())) {
          this.ui({ type: 'buffer:clear', sid: LOCAL, buffer: this.windows.get(toks[0].toLowerCase())! });
          return true;
        }
        this.ui({ type: 'buffer:clear', sid: this.active.buffer.startsWith('@') ? LOCAL : sid, buffer: this.active.buffer.startsWith('@') ? this.active.buffer : here });
        return true;
      case 'close':
        this.closeBuffer(sid, toks[0] ?? here);
        return true;
      case 'history':
        online()?.client.requestHistory(toks[0] ?? here, Number(toks[1]) || 100);
        return true;
      case 'load':
      case 'reload': {
        const file = (toks[toks.length - 1] ?? '').replace(/^-\w+$/, '');
        const full = path.join(this.scriptsDir, path.basename(file));
        if (!file || !fs.existsSync(full)) return fail(`No existe el script ${file || '(sin nombre)'} en ${this.scriptsDir}`);
        this.loadScriptFile(path.basename(file));
        this.note(sid, STATUS, `Script cargado: ${path.basename(file)}`);
        return true;
      }
      case 'unload': {
        const file = path.basename((toks[toks.length - 1] ?? '').replace(/^-\w+$/, ''));
        this.note(sid, STATUS, this.engine.unload(file) ? `Script descargado: ${file}` : `El script ${file} no estaba cargado`);
        this.ui({ type: 'scripts' });
        return true;
      }
      case 'dcc': {
        const sub = (toks[0] ?? '').toLowerCase();
        if (!online()) return fail('No estás conectado');
        const passive = toks[1] === '-p';
        if (passive) toks.splice(1, 1);
        if (sub === 'send' && toks[1] && toks[2]) void this.dccSend(sid, toks[1], toks.slice(2).join(' ').replace(/^"(.*)"$/, '$1'), passive);
        else if (sub === 'chat' && toks[1]) void this.dccChat(sid, toks[1]);
        else return fail('Uso: /dcc send [-p] nick archivo  ·  /dcc chat nick  (-p: envío pasivo, si no puedes recibir conexiones)');
        return true;
      }
      case 'help':
        for (const l of [
          'Comandos principales: /server [-e] host[:puerto] · /join #canal · /part · /msg nick texto · /query nick · /me acción',
          'Abreviaturas: /j join · /p part · /q query · /m msg · /w whois · /k kick · /t topic · /n names · /c clear · /s server · /a away · /l list · /ns y /cs (NickServ, ChanServ) · /id contraseña',
          '/nick · /register contraseña · /ignore nick · /notify nick · /list · /topic · /kick · /op /deop /voice /devoice /ban · /mode · /whois · /away · /ctcp · /dcc send|chat · /quit',
          'Scripts mIRC: /load archivo.mrc · /unload archivo.mrc · // evalúa identificadores (p. ej. //echo -a $me)',
        ]) this.line(sid, this.active.sid === sid ? this.active.buffer : STATUS, 'info', l);
        return true;
    }
    return false;
  }

  // ------------------------------------------------------------ scripts

  private menuContext(sid: string, buffer: string, nick?: string): MslContext {
    const ctx = this.ctxFor(sid, buffer);
    if (nick) ctx.params = [nick];
    else if (!ctx.chan && ctx.target) ctx.params = [ctx.target];
    return ctx;
  }

  /** Popups de los scripts para la ventana indicada: nicklist si se pasa un nick; si no, según el tipo de búfer. */
  scriptMenu(sid: string, buffer: string, nick?: string): MenuEntry[] {
    const type = this.sessions.get(sid)?.buffers.get(ircLower(buffer))?.type;
    const kind = nick ? 'nicklist' : type === 'channel' ? 'channel' : type === 'query' || type === 'dcc' ? 'query' : 'status';
    return this.engine.menu(kind, this.menuContext(sid, buffer, nick));
  }

  runScriptMenu(id: string, sid: string, buffer: string, nick?: string): void {
    this.engine.runMenu(String(id), this.menuContext(sid, buffer, nick));
  }

  private loadScriptFile(file: string): ScriptInfo {
    const source = fs.readFileSync(path.join(this.scriptsDir, file), 'utf8');
    const script = this.engine.load(file, source);
    this.engine.fire('LOAD', { cid: null });
    this.ui({ type: 'scripts' });
    return { name: file, source, warnings: script.warnings };
  }

  listScripts(): ScriptInfo[] {
    return fs
      .readdirSync(this.scriptsDir)
      .filter((f) => f.endsWith('.mrc'))
      .sort()
      .map((f) => ({
        name: f,
        source: fs.readFileSync(path.join(this.scriptsDir, f), 'utf8'),
        warnings: this.engine.scripts.get(f)?.warnings ?? [],
      }));
  }

  saveScript(nameIn: string, source: string): ScriptInfo {
    let name = path.basename(nameIn).replace(/[^A-Za-z0-9_.\-]/g, '_');
    if (!name.endsWith('.mrc')) name += '.mrc';
    fs.writeFileSync(path.join(this.scriptsDir, name), source);
    return this.loadScriptFile(name);
  }

  deleteScript(name: string): void {
    const file = path.basename(name);
    this.engine.unload(file);
    fs.rmSync(path.join(this.scriptsDir, file), { force: true });
    this.ui({ type: 'scripts' });
  }

  searchLogs(query: string) {
    return this.logger.search(query);
  }

  // ---------------------------------------------------------------- DCC

  private dccUpdate(d: DccEntry, patch: Partial<DccInfo> = {}): void {
    Object.assign(d.info, patch);
    this.ui({ type: 'dcc', dcc: { ...d.info } });
  }

  private newDcc(info: Omit<DccInfo, 'id'>): DccEntry {
    const d: DccEntry = { info: { id: 'd' + this.nextDcc++, ...info } };
    this.dccs.set(d.info.id, d);
    return d;
  }

  private onDccOffer(s: Session, from: string, args: string): void {
    const res = parseDccResume(args);
    if (res) {
      const same = (x: DccEntry) => x.info.sid === s.sid && ircLower(x.info.nick) === ircLower(from);
      if (res.kind === 'RESUME') {
        // El destinatario ya tiene parte del archivo: se envía solo lo que falta.
        const mine = [...this.dccs.values()].find((x) => x.send && same(x) && x.info.status === 'waiting' && x.send.port === res.port);
        if (mine?.send?.resumeFrom(res.position)) {
          const name = mine.info.filename.includes(' ') ? `"${mine.info.filename}"` : mine.info.filename;
          s.client.ctcp(from, 'DCC', `ACCEPT ${name} ${res.port} ${res.position}`);
        }
      } else {
        const theirs = [...this.dccs.values()].find((x) => x.recv && x.resumeTimer && same(x) && x.offer?.port === res.port);
        if (theirs && res.position === theirs.recv!.resumePosition()) {
          clearTimeout(theirs.resumeTimer);
          theirs.resumeTimer = undefined;
          theirs.recv!.start(res.position);
        }
      }
      return;
    }
    const offer = parseDccOffer(args);
    if (!offer) {
      this.note(s.sid, STATUS, `${from} envió una oferta DCC que no se admite (${args.split(' ')[0]})`);
      return;
    }
    // Respuesta a un envío pasivo nuestro: el destinatario indica dónde conectarse.
    if (offer.type === 'SEND' && offer.token && offer.port > 0) {
      const mine = [...this.dccs.values()].find(
        (x) => x.send && x.token === offer.token && x.info.sid === s.sid && ircLower(x.info.nick) === ircLower(from) && x.info.status === 'waiting',
      );
      if (mine) {
        mine.send!.connectTo(offer.ip, offer.port);
        return;
      }
    }
    if (offer.port === 0 && !offer.token) return;
    const d = this.newDcc({
      sid: s.sid, nick: from, direction: 'in', type: offer.type, filename: offer.type === 'SEND' ? offer.filename : '',
      size: offer.size, transferred: 0, status: 'offered',
    });
    d.offer = offer;
    this.dccUpdate(d);
    this.line(s.sid, STATUS, 'info', offer.type === 'SEND'
      ? `${from} quiere enviarte el archivo "${offer.filename}" (${offer.size} bytes). Acéptalo o recházalo en el panel de transferencias.`
      : `${from} solicita un chat DCC. Acéptalo o recházalo en el panel de transferencias.`, { highlight: true });
  }

  /** Las ofertas entrantes nunca se aceptan solas: siempre lo decide el usuario. */
  dccAccept(id: string): void {
    const d = this.dccs.get(id);
    const s = d && this.sessions.get(d.info.sid);
    if (!d || !s || !d.offer || d.info.status !== 'offered') return;
    if (d.offer.type === 'SEND') {
      const recv = new DccReceive(d.offer, this.downloadsDir);
      d.recv = recv;
      recv.on('progress', (n: number) => this.dccUpdate(d, { transferred: n, status: 'active' }));
      recv.on('done', (p: string) => {
        this.dccUpdate(d, { status: 'done', path: p });
        this.note(s.sid, STATUS, `Archivo recibido de ${d.info.nick}: ${p}`);
      });
      recv.on('error', (e: Error) => this.dccUpdate(d, { status: 'failed', error: e.message }));
      this.dccUpdate(d, { status: 'active' });
      if (d.offer.token) {
        recv
          .listenPassive(s.client.localAddress)
          .then((ctcp) => s.client.ctcp(d.info.nick, 'DCC', ctcp))
          .catch((e: Error) => this.dccUpdate(d, { status: 'failed', error: e.message }));
      } else {
        const pos = recv.resumePosition();
        if (pos > 0) {
          // Hay una descarga parcial: se pide continuar; si el remitente no contesta, se empieza de cero.
          const name = d.offer.filename.includes(' ') ? `"${d.offer.filename}"` : d.offer.filename;
          s.client.ctcp(d.info.nick, 'DCC', `RESUME ${name} ${d.offer.port} ${pos}`);
          d.resumeTimer = setTimeout(() => {
            d.resumeTimer = undefined;
            if (d.info.status === 'active') recv.start();
          }, 8000);
          d.resumeTimer.unref();
        } else recv.start();
      }
    } else {
      const chat = new DccChat();
      this.attachChat(s, d, chat);
      chat.connect(d.offer.ip, d.offer.port);
    }
  }

  dccReject(id: string): void {
    const d = this.dccs.get(id);
    if (!d) return;
    if (d.resumeTimer) clearTimeout(d.resumeTimer);
    d.resumeTimer = undefined;
    d.recv?.cancel();
    d.send?.cancel();
    d.chat?.close();
    this.dccUpdate(d, { status: d.info.status === 'done' ? 'done' : 'rejected' });
  }

  private attachChat(s: Session, d: DccEntry, chat: DccChat): void {
    d.chat = chat;
    const buffer = '=' + d.info.nick;
    chat.on('open', () => {
      this.ensureBuffer(s, buffer, 'dcc');
      this.dccUpdate(d, { status: 'active' });
      this.note(s.sid, buffer, `Chat DCC con ${d.info.nick} establecido`);
      this.ui({ type: 'activate', sid: s.sid, buffer });
    });
    chat.on('line', (text: string) => {
      this.ensureBuffer(s, buffer, 'dcc');
      this.line(s.sid, buffer, 'msg', text, { nick: d.info.nick, highlight: true });
    });
    chat.on('error', (e: Error) => this.dccUpdate(d, { status: 'failed', error: e.message }));
    chat.on('close', () => {
      if (d.info.status === 'active') this.dccUpdate(d, { status: 'done' });
      if (s.buffers.has(ircLower(buffer))) this.note(s.sid, buffer, 'Chat DCC cerrado');
    });
  }

  async dccSend(sid: string, nick: string, filePath: string, passive = false): Promise<void> {
    const s = this.sessions.get(sid);
    if (!s) return;
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      this.error(sid, STATUS, `No se encuentra el archivo: ${filePath}`);
      return;
    }
    const send = new DccSend(filePath);
    const d = this.newDcc({
      sid, nick, direction: 'out', type: 'SEND', filename: path.basename(filePath), size: fs.statSync(filePath).size,
      transferred: 0, status: 'waiting',
    });
    d.send = send;
    send.on('progress', (n: number) => this.dccUpdate(d, { transferred: n, status: 'active' }));
    send.on('done', () => {
      this.dccUpdate(d, { status: 'done' });
      this.note(sid, STATUS, `Archivo enviado a ${nick}: ${d.info.filename}`);
    });
    send.on('error', (e: Error) => this.dccUpdate(d, { status: 'failed', error: e.message }));
    try {
      if (passive) d.token = String(Math.floor(Math.random() * 9e8) + 1e8);
      const ctcp = passive ? send.passiveOffer(d.token!) : await send.listen(s.client.localAddress);
      s.client.ctcp(nick, 'DCC', ctcp);
      this.dccUpdate(d);
      this.note(sid, STATUS, `Ofreciendo "${d.info.filename}" a ${nick} por DCC…`);
    } catch (e) {
      this.dccUpdate(d, { status: 'failed', error: (e as Error).message });
    }
  }

  async dccChat(sid: string, nick: string): Promise<void> {
    const s = this.sessions.get(sid);
    if (!s) return;
    const chat = new DccChat();
    const d = this.newDcc({ sid, nick, direction: 'out', type: 'CHAT', filename: '', size: 0, transferred: 0, status: 'waiting' });
    this.attachChat(s, d, chat);
    try {
      s.client.ctcp(nick, 'DCC', await chat.listen(s.client.localAddress));
      this.dccUpdate(d);
      this.note(sid, STATUS, `Solicitando chat DCC a ${nick}…`);
    } catch (e) {
      this.dccUpdate(d, { status: 'failed', error: (e as Error).message });
    }
  }
}
