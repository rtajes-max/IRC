/**
 * Intérprete del lenguaje de scripting de mIRC (mSL).
 *
 * Admite alias, eventos `on`, `raw`, `ctcp`, variables locales y globales, `if/elseif/else`,
 * `while`, temporizadores, tablas hash, tokens y los identificadores más habituales.
 * El texto que llega de la red nunca se vuelve a evaluar (evita la inyección clásica de mIRC).
 */
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as tls from 'node:tls';
import * as path from 'node:path';
import { stripFormatting } from '../irc/formatting';
import { ircLower } from '../irc/message';

export interface MslContext {
  cid: string | null;
  event?: string;
  nick?: string;
  chan?: string;
  target?: string;
  address?: string;
  rawmsg?: string;
  numeric?: string;
  knick?: string;
  newnick?: string;
  sockname?: string;
  sockbr?: number;
  sockerr?: number;
  params: string[];
  locals: Map<string, string>;
  aliasStack: string[];
  isid: boolean;
  regml: string[];
  v1: string;
  v2: string;
  result: string;
}

export interface MslHost {
  /** Ejecuta un comando del cliente (/join, /msg…). Devuelve false si no lo reconoce. */
  command(name: string, args: string, ctx: MslContext): boolean;
  echo(text: string, target: string | null, ctx: MslContext, flags: string): void;
  raw(line: string, ctx: MslContext): void;
  info(ctx: MslContext): { me: string; server: string; network: string; active: string; channels: string[] };
  nicks(ctx: MslContext, chan: string): { nick: string; prefix: string }[];
  /** Carpeta a la que se limitan /write, $read, etc. */
  dataDir: string;
}

type Stmt =
  | { t: 'cmd'; text: string }
  | { t: 'if'; branches: { cond: string; body: Stmt[] }[]; otherwise?: Stmt[] }
  | { t: 'while'; cond: string; body: Stmt[] };

interface AliasDef {
  name: string;
  local: boolean;
  body: Stmt[];
}

interface EventDef {
  event: string;
  level: string;
  pre: boolean;
  onlyMe: boolean;
  notMe: boolean;
  match: string;
  target: string;
  body: Stmt[];
}

export interface Script {
  name: string;
  source: string;
  aliases: Map<string, AliasDef>;
  events: EventDef[];
  menus: MenuDef[];
  warnings: string[];
}

interface MenuItemDef {
  depth: number;
  label: string;
  separator: boolean;
  body: Stmt[] | null;
}

interface MenuDef {
  types: string[];
  items: MenuItemDef[];
}

/** Elemento de un popup ya evaluado, listo para mostrarse. */
export interface MenuEntry {
  label: string;
  id?: string;
  separator?: boolean;
  children?: MenuEntry[];
}

class ReturnSignal {
  constructor(public value: string) {}
}
class HaltSignal {
  constructor(public haltdef = false) {}
}
class GotoSignal {
  constructor(public label: string) {}
}
class BreakSignal {}
class ContinueSignal {}
export class MslError extends Error {}

function errText(e: unknown): string {
  if (e instanceof GotoSignal) return `no existe la etiqueta :${e.label}`;
  return e instanceof Error ? e.message : String(e);
}

const PH_OPEN = '\uE000';
const PH_CLOSE = '\uE001';

interface ScriptSocket {
  name: string;
  socket: net.Socket;
  buf: Buffer;
  cid: string | null;
  open: boolean;
}

const JOIN = Symbol('join');
type Tok = string | typeof JOIN;

const TWO_FIELD_EVENTS = new Set(['TEXT', 'ACTION', 'NOTICE', 'CTCP', 'CHAT']);
const ONE_FIELD_EVENTS = new Set([
  'JOIN', 'PART', 'KICK', 'TOPIC', 'MODE', 'RAWMODE', 'OP', 'DEOP', 'VOICE', 'DEVOICE', 'BAN', 'UNBAN',
  'INPUT', 'OPEN', 'CLOSE', 'INVITE', 'RAW', 'SOCKOPEN', 'SOCKREAD', 'SOCKCLOSE',
]);

const MAX_LOOP = 200000;
const MAX_DEPTH = 100;

// ------------------------------------------------------------------ utilidades

function findClose(s: string, start: number, open: string, close: string): number {
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === open) depth++;
    else if (s[i] === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === sep && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** Comodines de mIRC: * cualquier texto, ? un carácter, & una palabra. */
export function wildMatch(pattern: string, text: string, caseSensitive = false): boolean {
  const re =
    '^' +
    pattern
      .split('')
      .map((c) => (c === '*' ? '.*' : c === '?' ? '.' : c === '&' ? '\\S+' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
      .join('') +
    '$';
  return new RegExp(re, caseSensitive ? 's' : 'is').test(text);
}

function isNum(s: string): boolean {
  return s !== '' && /^-?(\d+\.?\d*|\.\d+)$/.test(s);
}

function fmtNum(n: number): string {
  if (!isFinite(n)) return '0';
  const r = Math.round(n * 1e6) / 1e6;
  return String(r);
}

/** Evaluador aritmético seguro para $calc (sin eval). */
export function calc(expr: string): string {
  let i = 0;
  const s = expr.replace(/\s+/g, '');
  const peek = () => s[i];
  const primary = (): number => {
    if (peek() === '(') {
      i++;
      const v = addsub();
      if (peek() === ')') i++;
      return v;
    }
    if (peek() === '-') {
      i++;
      return -primary();
    }
    if (peek() === '+') {
      i++;
      return primary();
    }
    const m = /^(\d+\.?\d*|\.\d+)/.exec(s.slice(i));
    if (!m) {
      i = s.length;
      return 0;
    }
    i += m[0].length;
    return parseFloat(m[0]);
  };
  const power = (): number => {
    const base = primary();
    if (peek() === '^') {
      i++;
      return Math.pow(base, power());
    }
    return base;
  };
  const muldiv = (): number => {
    let v = power();
    for (;;) {
      const c = peek();
      if (c === '*') {
        i++;
        v *= power();
      } else if (c === '/' && s[i + 1] === '/') {
        i += 2;
        const d = power();
        v = d === 0 ? 0 : Math.floor(v / d);
      } else if (c === '/') {
        i++;
        const d = power();
        v = d === 0 ? 0 : v / d;
      } else if (c === '%') {
        i++;
        const d = power();
        v = d === 0 ? 0 : v % d;
      } else return v;
    }
  };
  const addsub = (): number => {
    let v = muldiv();
    for (;;) {
      const c = peek();
      if (c === '+') {
        i++;
        v += muldiv();
      } else if (c === '-') {
        i++;
        v -= muldiv();
      } else return v;
    }
  };
  return fmtNum(addsub());
}

// ---------------------------------------------------------------- analizador

class BodyParser {
  private i = 0;
  constructor(private s: string) {}

  parseBlock(): Stmt[] {
    const out: Stmt[] = [];
    for (;;) {
      this.skipSeparators();
      if (this.i >= this.s.length) break;
      if (this.s[this.i] === '}') {
        this.i++;
        continue;
      }
      out.push(...this.parseStmt());
    }
    return out;
  }

  private skipSpaces(): void {
    while (this.i < this.s.length && (this.s[this.i] === ' ' || this.s[this.i] === '\t')) this.i++;
  }

  private skipSeparators(): void {
    for (;;) {
      const c = this.s[this.i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') this.i++;
      else if (c === '|' && (this.i + 1 >= this.s.length || /\s/.test(this.s[this.i + 1]))) this.i++;
      else break;
    }
  }

  private peekWord(): string {
    const m = /^[A-Za-z]+/.exec(this.s.slice(this.i, this.i + 12));
    return m ? m[0].toLowerCase() : '';
  }

  private condAfter(wordLen: number): string | null {
    let j = this.i + wordLen;
    while (this.s[j] === ' ') j++;
    if (this.s[j] !== '(') return null;
    const end = findClose(this.s, j, '(', ')');
    if (end === -1) return null;
    let cond = this.s.slice(j + 1, end);
    this.i = end + 1;
    // mIRC admite `if (a) && (b) || (c)`
    for (;;) {
      const m = /^\s*(&&|\|\|)\s*\(/.exec(this.s.slice(this.i, this.i + 12));
      if (!m) break;
      const open = this.i + m[0].length - 1;
      const close = findClose(this.s, open, '(', ')');
      if (close === -1) break;
      cond = `(${cond}) ${m[1]} (${this.s.slice(open + 1, close)})`;
      this.i = close + 1;
    }
    return cond;
  }

  private parseBody(): Stmt[] {
    this.skipSpaces();
    if (this.s[this.i] === '{') {
      const end = findClose(this.s, this.i, '{', '}');
      const inner = this.s.slice(this.i + 1, end === -1 ? this.s.length : end);
      this.i = end === -1 ? this.s.length : end + 1;
      return new BodyParser(inner).parseBlock();
    }
    if (this.i >= this.s.length || this.s[this.i] === '\n') return [];
    return this.parseStmt();
  }

  private parseStmt(): Stmt[] {
    const word = this.peekWord();
    if (this.s[this.i] === '{') return this.parseBody();
    if (word === 'if') {
      const save = this.i;
      const cond = this.condAfter(2);
      if (cond !== null) {
        const stmt: Stmt = { t: 'if', branches: [{ cond, body: this.parseBody() }] };
        for (;;) {
          const mark = this.i;
          this.skipSeparators();
          const w = this.peekWord();
          if (w === 'elseif') {
            const c = this.condAfter(6);
            if (c === null) {
              this.i = mark;
              break;
            }
            stmt.branches.push({ cond: c, body: this.parseBody() });
          } else if (w === 'else' && !/[A-Za-z0-9_]/.test(this.s[this.i + 4] ?? '')) {
            this.i += 4;
            stmt.otherwise = this.parseBody();
            break;
          } else {
            this.i = mark;
            break;
          }
        }
        return [stmt];
      }
      this.i = save;
    }
    if (word === 'while') {
      const save = this.i;
      const cond = this.condAfter(5);
      if (cond !== null) return [{ t: 'while', cond, body: this.parseBody() }];
      this.i = save;
    }
    // Comando simple: hasta fin de línea o " | "
    let j = this.i;
    while (j < this.s.length && this.s[j] !== '\n') {
      if (this.s[j] === '|' && this.s[j - 1] === ' ' && (j + 1 >= this.s.length || /\s/.test(this.s[j + 1]))) break;
      j++;
    }
    let text = this.s.slice(this.i, j).trim();
    this.i = j;
    if (text.endsWith('}') && !text.includes('{')) text = text.slice(0, -1).trim();
    return text ? [{ t: 'cmd', text }] : [];
  }
}

/** Líneas de un popup: `Etiqueta:comando`, `.Subelemento:comando` (los puntos indican nivel) y `-` como separador. */
function parseMenuItems(inner: string): MenuItemDef[] {
  const items: MenuItemDef[] = [];
  const lines = inner.split('\n');
  for (let n = 0; n < lines.length; n++) {
    let line = lines[n].trim();
    if (!line) continue;
    const dots = /^\.*/.exec(line)![0].length;
    line = line.slice(dots).trim();
    if (line === '-') {
      items.push({ depth: dots, label: '', separator: true, body: null });
      continue;
    }
    let depth = 0;
    let colon = -1;
    for (let k = 0; k < line.length; k++) {
      if (line[k] === '(') depth++;
      else if (line[k] === ')') depth--;
      else if (line[k] === ':' && depth <= 0) {
        colon = k;
        break;
      }
    }
    if (colon === -1) {
      items.push({ depth: dots, label: line, separator: false, body: null });
      continue;
    }
    let cmd = line.slice(colon + 1);
    const balance = (t: string) => (t.match(/\{/g)?.length ?? 0) - (t.match(/\}/g)?.length ?? 0);
    while (balance(cmd) > 0 && n + 1 < lines.length) cmd += '\n' + lines[++n];
    const body = new BodyParser(cmd).parseBlock();
    items.push({ depth: dots, label: line.slice(0, colon).trim(), separator: false, body: body.length ? body : null });
  }
  return items;
}

export function parseScript(name: string, source: string): Script {
  const script: Script = { name, source, aliases: new Map(), events: [], menus: [], warnings: [] };
  // Quitar comentarios: bloques /* */ y líneas que empiezan por ;
  const src = source
    .replace(/\r/g, '')
    .replace(/^[ \t]*\/\*[\s\S]*?\*\/[ \t]*$/gm, '')
    .split('\n')
    .filter((l) => !/^\s*;/.test(l))
    .join('\n');

  let i = 0;
  const readBody = (): Stmt[] => {
    while (src[i] === ' ' || src[i] === '\t') i++;
    if (src[i] === '{') {
      const end = findClose(src, i, '{', '}');
      const inner = src.slice(i + 1, end === -1 ? src.length : end);
      i = end === -1 ? src.length : end + 1;
      return new BodyParser(inner).parseBlock();
    }
    let eol = src.indexOf('\n', i);
    if (eol === -1) eol = src.length;
    const line = src.slice(i, eol);
    i = eol;
    return new BodyParser(line).parseBlock();
  };
  const skipBlockOrLine = () => {
    let eol = src.indexOf('\n', i);
    if (eol === -1) eol = src.length;
    const brace = src.indexOf('{', i);
    if (brace !== -1 && brace < eol) {
      const end = findClose(src, brace, '{', '}');
      i = end === -1 ? src.length : end + 1;
    } else i = eol;
  };
  /** Lee un campo hasta ':' sin contar los que están dentro de paréntesis. */
  const readField = (): string | null => {
    let depth = 0;
    for (let j = i; j < src.length && src[j] !== '\n'; j++) {
      if (src[j] === '(') depth++;
      else if (src[j] === ')') depth--;
      else if (src[j] === ':' && depth <= 0) {
        const f = src.slice(i, j);
        i = j + 1;
        return f;
      }
    }
    return null;
  };

  while (i < src.length) {
    while (i < src.length && /\s/.test(src[i])) i++;
    if (i >= src.length) break;
    const m = /^(\S+)[ \t]*/.exec(src.slice(i, i + 200));
    if (!m) break;
    const kw = m[1].toLowerCase();
    if (kw === 'alias') {
      i += m[0].length;
      const h = /^(-l[ \t]+)?(\S+)/.exec(src.slice(i, i + 200));
      if (!h) {
        skipBlockOrLine();
        continue;
      }
      i += h[0].length;
      const aname = h[2].replace(/^\/+/, '').toLowerCase();
      script.aliases.set(aname, { name: aname, local: !!h[1], body: readBody() });
    } else if (kw === 'on' || kw === 'ctcp' || kw === 'raw') {
      i += m[0].length;
      const level = readField();
      if (level === null) {
        script.warnings.push(`Definición "${kw}" mal formada`);
        skipBlockOrLine();
        continue;
      }
      let event: string;
      let match = '*';
      let target = '*';
      let lvl = level.trim();
      if (kw === 'on') {
        const ev = readField();
        if (ev === null) {
          skipBlockOrLine();
          continue;
        }
        event = ev.trim().toUpperCase();
        if (TWO_FIELD_EVENTS.has(event)) {
          match = readField() ?? '*';
          target = readField() ?? '*';
        } else if (ONE_FIELD_EVENTS.has(event)) target = readField() ?? '*';
      } else if (kw === 'ctcp') {
        event = 'CTCP';
        match = readField() ?? '*';
        target = readField() ?? '*';
      } else {
        // raw <numérico>:<texto>:<comandos>
        event = 'RAW';
        target = lvl;
        lvl = '*';
        match = readField() ?? '*';
      }
      const pre = lvl.startsWith('^');
      if (pre) lvl = lvl.slice(1);
      const onlyMe = /^me:?/i.test(lvl);
      const notMe = lvl.startsWith('!');
      script.events.push({ event, level: lvl, pre, onlyMe, notMe, match: match.trim(), target: target.trim(), body: readBody() });
    } else if (kw === 'menu') {
      i += m[0].length;
      const brace = src.indexOf('{', i);
      const eol = src.indexOf('\n', i);
      if (brace === -1 || (eol !== -1 && brace > eol)) {
        script.warnings.push('Definición "menu" mal formada');
        skipBlockOrLine();
        continue;
      }
      const types = src.slice(i, brace).split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
      const end = findClose(src, brace, '{', '}');
      const inner = src.slice(brace + 1, end === -1 ? src.length : end);
      i = end === -1 ? src.length : end + 1;
      script.menus.push({ types, items: parseMenuItems(inner) });
    } else if (kw === 'dialog') {
      script.warnings.push(`"${kw}" todavía no está admitido; se ignora`);
      skipBlockOrLine();
    } else if (kw.startsWith('#')) {
      // #grupo on/off … #grupo end: se tratan como siempre activos
      const eol = src.indexOf('\n', i);
      i = eol === -1 ? src.length : eol;
    } else {
      const eol = src.indexOf('\n', i);
      const line = src.slice(i, eol === -1 ? src.length : eol).trim();
      if (line && line !== '}') script.warnings.push(`Línea no reconocida: ${line.slice(0, 60)}`);
      i = eol === -1 ? src.length : eol;
    }
  }
  return script;
}

// ------------------------------------------------------------------- motor

interface Timer {
  name: string;
  reps: number;
  handle: NodeJS.Timeout;
  command: string;
}

export function newContext(init: Partial<MslContext> = {}): MslContext {
  return {
    cid: null, params: [], locals: new Map(), aliasStack: [], isid: false, regml: [], v1: '', v2: '', result: '',
    ...init,
  };
}

export class MslEngine {
  scripts = new Map<string, Script>();
  vars = new Map<string, string>();
  hashes = new Map<string, Map<string, string>>();
  timers = new Map<string, Timer>();
  socks = new Map<string, ScriptSocket>();
  private placeholders: string[] = [];
  onVarsChanged: (() => void) | null = null;
  private depth = 0;
  private loopBudget = MAX_LOOP;

  constructor(public host: MslHost) {}

  load(name: string, source: string): Script {
    const script = parseScript(name, source);
    this.scripts.set(name, script);
    return script;
  }

  unload(name: string): boolean {
    return this.scripts.delete(name);
  }

  dispose(): void {
    for (const t of this.timers.values()) clearInterval(t.handle);
    this.timers.clear();
    for (const sk of this.socks.values()) sk.socket.destroy();
    this.socks.clear();
  }

  /**
   * Popups definidos por los scripts para un tipo de ventana (channel, nicklist, query, status, menubar).
   * Las etiquetas se evalúan al abrir el menú; una etiqueta vacía oculta el elemento, como en mIRC.
   */
  menu(type: string, ctx: MslContext): MenuEntry[] {
    const root: MenuEntry[] = [];
    for (const script of this.scripts.values()) {
      script.menus.forEach((def, mi) => {
        if (!def.types.includes(type)) return;
        const stack: { depth: number; list: MenuEntry[] }[] = [{ depth: -1, list: root }];
        let hiddenDepth = Infinity;
        def.items.forEach((item, ii) => {
          if (item.depth > hiddenDepth) return;
          hiddenDepth = Infinity;
          while (stack.length > 1 && stack[stack.length - 1].depth >= item.depth) stack.pop();
          const list = stack[stack.length - 1].list;
          if (item.separator) {
            if (list.length && !list[list.length - 1].separator) list.push({ label: '', separator: true });
            return;
          }
          let label = '';
          try {
            label = this.evalText(item.label, newContext({ ...ctx, locals: new Map() }));
          } catch {
            label = '';
          }
          if (!label) {
            hiddenDepth = item.depth;
            return;
          }
          const entry: MenuEntry = { label };
          if (item.body) entry.id = `${script.name}\u0000${mi}\u0000${ii}`;
          else entry.children = [];
          list.push(entry);
          if (entry.children) stack.push({ depth: item.depth, list: entry.children });
        });
      });
    }
    const clean = (list: MenuEntry[]): MenuEntry[] =>
      list
        .map((e) => (e.children ? { ...e, children: clean(e.children) } : e))
        .filter((e) => e.separator || e.id || (e.children && e.children.length))
        .filter((e, k, arr) => !(e.separator && (k === arr.length - 1 || k === 0)));
    return clean(root);
  }

  /** Ejecuta el comando de un elemento de popup devuelto por `menu()`. */
  runMenu(id: string, ctx: MslContext): boolean {
    const [name, mi, ii] = id.split('\u0000');
    const item = this.scripts.get(name)?.menus[Number(mi)]?.items[Number(ii)];
    if (!item?.body) return false;
    this.loopBudget = MAX_LOOP;
    try {
      this.runStmts(item.body, ctx);
    } catch (e) {
      if (!(e instanceof HaltSignal || e instanceof ReturnSignal || e instanceof BreakSignal || e instanceof ContinueSignal)) {
        this.host.echo(`* Error de script (menú): ${errText(e)}`, null, ctx, 's');
      }
    }
    return true;
  }

  findAlias(name: string): AliasDef | undefined {
    const n = name.toLowerCase();
    for (const s of this.scripts.values()) {
      const a = s.aliases.get(n);
      if (a) return a;
    }
    return undefined;
  }

  // ------------------------------------------------------------ entrada

  /**
   * Ejecuta una línea de comando. `evaluate` indica si se evalúan identificadores
   * (true dentro de scripts y con `//`; false para lo que escribe el usuario con `/`).
   */
  execLine(line: string, ctx: MslContext, evaluate = true): { halted: boolean; error?: string } {
    this.loopBudget = MAX_LOOP;
    try {
      if (evaluate) this.runStmts(new BodyParser(line).parseBlock(), ctx);
      else this.execCommand(line, ctx, false);
      return { halted: false };
    } catch (e) {
      if (e instanceof HaltSignal) return { halted: true };
      if (e instanceof ReturnSignal || e instanceof BreakSignal || e instanceof ContinueSignal) return { halted: false };
      const msg = errText(e);
      this.host.echo(`* Error de script: ${msg}`, null, ctx, 's');
      return { halted: true, error: msg };
    }
  }

  /**
   * Dispara un evento. Con `pre` solo se ejecutan los manejadores `^` (previos a la visualización).
   * `haltdef` indica que algún manejador ejecutó /halt o /haltdef.
   */
  fire(event: string, init: Partial<MslContext> & { text?: string; isMe?: boolean }, pre = false): { haltdef: boolean } {
    let haltdef = false;
    const text = init.text ?? '';
    const plain = stripFormatting(text);
    for (const script of this.scripts.values()) {
      for (const def of script.events) {
        if (def.event !== event || def.pre !== pre) continue;
        if (def.onlyMe && !init.isMe) continue;
        if (def.notMe && init.isMe) continue;
        const ctx = newContext({ ...init, event, params: text ? text.split(' ').filter(Boolean) : [] });
        if (!this.matchTarget(def, event, init, ctx)) continue;
        if (TWO_FIELD_EVENTS.has(event) || event === 'RAW') {
          let pat = def.match;
          const dyn = /^\$\((.*)\)$/.exec(pat);
          if (dyn) pat = this.evalText(dyn[1], ctx);
          if (!wildMatch(pat, plain)) continue;
        }
        this.loopBudget = MAX_LOOP;
        try {
          this.runStmts(def.body, ctx);
        } catch (e) {
          if (e instanceof HaltSignal) haltdef = true;
          else if (!(e instanceof ReturnSignal || e instanceof BreakSignal || e instanceof ContinueSignal)) {
            const msg = errText(e);
            this.host.echo(`* Error en ${script.name} (on ${event}): ${msg}`, null, ctx, 's');
          }
        }
        break; // como en mIRC: solo el primer manejador coincidente de cada script
      }
    }
    return { haltdef };
  }

  private matchTarget(def: EventDef, event: string, init: Partial<MslContext>, ctx: MslContext): boolean {
    if (event === 'RAW') return def.target === '*' || def.target === init.numeric || Number(def.target) === Number(init.numeric);
    if (!TWO_FIELD_EVENTS.has(event) && !ONE_FIELD_EVENTS.has(event)) return true;
    const t = def.target;
    if (event.startsWith('SOCK')) return wildMatch(t || '*', init.sockname ?? '');
    if (t === '*' || t === '') return true;
    const chan = init.chan ?? '';
    if (t === '#') return !!chan;
    if (t === '?') return !chan;
    return t.split(',').some((x) => {
      const name = x.startsWith('%') ? this.getVar(x.slice(1), ctx) : x;
      return ircLower(name.trim()) === ircLower(chan || init.target || '');
    });
  }

  runAlias(def: AliasDef, args: string, ctx: MslContext, isid: boolean, params?: string[]): string {
    if (this.depth >= MAX_DEPTH) throw new MslError('demasiada recursión');
    const sub = newContext({
      ...ctx,
      params: params ?? args.split(' ').filter(Boolean),
      locals: new Map(),
      aliasStack: [...ctx.aliasStack, def.name],
      isid,
    });
    this.depth++;
    try {
      this.runStmts(def.body, sub);
      return '';
    } catch (e) {
      if (e instanceof ReturnSignal) return e.value;
      if (e instanceof GotoSignal) throw new MslError(errText(e));
      throw e;
    } finally {
      this.depth--;
    }
  }

  // --------------------------------------------------------- ejecución

  private runStmts(stmts: Stmt[], ctx: MslContext): void {
    for (let idx = 0; idx < stmts.length; idx++) {
      try {
        this.runStmt(stmts[idx], ctx);
      } catch (e) {
        if (!(e instanceof GotoSignal)) throw e;
        // goto: se busca la etiqueta `:nombre` en este bloque; si no está, se propaga al bloque exterior.
        const want = ':' + e.label.toLowerCase();
        const at = stmts.findIndex((st) => st.t === 'cmd' && st.text.trim().toLowerCase() === want);
        if (at === -1) throw e;
        if (--this.loopBudget <= 0) throw new MslError('demasiados saltos con goto (posible bucle infinito)');
        idx = at;
      }
    }
  }

  private runStmt(s: Stmt, ctx: MslContext): void {
    if (s.t === 'cmd') this.execCommand(s.text, ctx, true);
    else if (s.t === 'if') {
      for (const b of s.branches) {
        if (this.evalCond(b.cond, ctx)) {
          this.runStmts(b.body, ctx);
          return;
        }
      }
      if (s.otherwise) this.runStmts(s.otherwise, ctx);
    } else {
      while (this.evalCond(s.cond, ctx)) {
        if (--this.loopBudget <= 0) throw new MslError('bucle while demasiado largo (posible bucle infinito)');
        try {
          this.runStmts(s.body, ctx);
        } catch (e) {
          if (e instanceof BreakSignal) break;
          if (e instanceof ContinueSignal) continue;
          throw e;
        }
      }
    }
  }

  private execCommand(textIn: string, ctx: MslContext, evaluate: boolean): void {
    let text = textIn.trim().replace(/^\/+/, '');
    if (!text || text.startsWith(':')) return; // etiqueta de goto
    if (evaluate && text.includes('[ ')) text = this.resolveBrackets(text, ctx);
    let noAlias = false;
    for (;;) {
      if (text.startsWith('.') && text.length > 1) text = text.slice(1);
      else if (text.startsWith('!') && /^![A-Za-z]/.test(text)) {
        noAlias = true;
        text = text.slice(1);
      } else break;
    }
    const sp = text.indexOf(' ');
    const name = (sp === -1 ? text : text.slice(0, sp)).toLowerCase();
    const rest = sp === -1 ? '' : text.slice(sp + 1).trim();
    const ev = (s: string) => (evaluate ? this.evalText(s, ctx) : s);

    // %var = valor
    if (name.startsWith('%')) {
      const m = /^=\s*(.*)$/s.exec(rest);
      if (m) {
        this.setVar(name.slice(1), this.arith(ev(m[1])), ctx, false);
        return;
      }
    }

    switch (name) {
      case 'var': {
        let body = rest;
        let global = false;
        const f = /^-(\w+)\s+/.exec(body);
        if (f) {
          global = f[1].includes('g');
          body = body.slice(f[0].length);
        }
        for (const part of splitTopLevel(body, ',')) {
          const m = /^\s*%(\S+)\s*(?:=\s*)?(.*)$/s.exec(part);
          if (!m) continue;
          const val = this.arith(ev(m[2]));
          if (global) this.setGlobal(m[1], val);
          else ctx.locals.set(this.expand(m[1]).toLowerCase(), val);
        }
        return;
      }
      case 'set': {
        const m = /^(?:-(\w+)\s+)?(?:(\d+)\s+)?%(\S+)\s*(.*)$/s.exec(rest);
        if (!m) return;
        const { name: vname, value } = this.dynName(m[3], m[4], ctx, evaluate);
        const val = this.arith(ev(value));
        if (m[1]?.includes('l')) ctx.locals.set(this.expand(vname).toLowerCase(), val);
        else this.setGlobal(vname, val);
        const unsetSecs = m[1]?.includes('u') && m[2] ? Number(m[2]) : 0;
        if (unsetSecs > 0) setTimeout(() => this.unsetGlobal(vname), unsetSecs * 1000).unref();
        return;
      }
      case 'unset': {
        for (const t of ev(rest.replace(/^-\w+\s+/, '')).split(' ')) {
          if (!t.startsWith('%')) continue;
          const pat = t.slice(1).toLowerCase();
          if (pat.includes('*') || pat.includes('?')) {
            for (const k of [...this.vars.keys()]) if (wildMatch(pat, k)) this.unsetGlobal(k);
          } else if (!ctx.locals.delete(pat)) this.unsetGlobal(pat);
        }
        return;
      }
      case 'inc':
      case 'dec': {
        const m = /^(?:-\w+\s+)?%(\S+)\s*(.*)$/s.exec(rest);
        if (!m) return;
        const { name: vname, value } = this.dynName(m[1], m[2], ctx, evaluate);
        const by = value.trim() ? Number(ev(value)) || 0 : 1;
        const cur = Number(this.getVar(vname, ctx)) || 0;
        this.setVar(vname, fmtNum(name === 'inc' ? cur + by : cur - by), ctx, false);
        return;
      }
      case 'return':
        throw new ReturnSignal(ev(rest));
      case 'halt':
        throw new HaltSignal();
      case 'haltdef':
        throw new HaltSignal(true);
      case 'break':
        throw new BreakSignal();
      case 'continue':
        throw new ContinueSignal();
      case 'goto':
        throw new GotoSignal(ev(rest).replace(/^:/, ''));
      case 'sockread': {
        const m = /^(?:-(\w+)\s+)?%(\S+)/.exec(rest);
        const sk = this.socks.get((ctx.sockname ?? '').toLowerCase());
        ctx.sockbr = 0;
        if (!m || !sk) return;
        let end = sk.buf.indexOf(0x0a);
        let line: Buffer;
        if (end === -1) {
          if (!m[1]?.includes('f') || !sk.buf.length) return;
          line = sk.buf;
          sk.buf = Buffer.alloc(0);
        } else {
          line = sk.buf.subarray(0, end);
          sk.buf = sk.buf.subarray(end + 1);
        }
        ctx.sockbr = line.length + (end === -1 ? 0 : 1);
        this.setVar(m[2], line.toString('utf8').replace(/\r$/, ''), ctx, false);
        return;
      }
      case 'noop':
        ev(rest);
        return;
      case 'timers':
        if (/^off\b/i.test(rest)) this.stopTimers('*');
        return;
    }

    if (name.startsWith('timer')) {
      this.timerCommand(name.slice(5), rest, ctx, evaluate);
      return;
    }

    if (name === 'echo' && (noAlias || !this.findAlias('echo'))) {
      // Las opciones y el color se leen del texto original, para que un valor numérico no se tome por color.
      const toks = rest.split(' ').filter(Boolean);
      let flags = '';
      let color = '';
      while (toks.length && /^-[A-Za-z]+$/.test(toks[0])) flags += toks.shift()!.slice(1);
      if (toks.length > 1 && /^\d{1,2}$/.test(toks[0])) color = toks.shift()!;
      while (toks.length && /^-[A-Za-z]+$/.test(toks[0])) flags += toks.shift()!.slice(1);
      let body = ev(toks.join(' '));
      let target: string | null = null;
      const first = /^([#&@]\S*) (.+)$/s.exec(body);
      if (!/[as]/.test(flags) && first) {
        target = first[1];
        body = first[2];
      }
      this.host.echo(color ? `\x03${color.padStart(2, '0')}${body}` : body, target, ctx, flags);
      return;
    }

    const args = ev(rest);

    if (!noAlias && ctx.aliasStack[ctx.aliasStack.length - 1] !== name) {
      const alias = this.findAlias(name);
      if (alias) {
        this.runAlias(alias, args, ctx, false);
        return;
      }
    }

    switch (name) {
      case 'sockopen': {
        const m = /^(?:-(\w+)\s+)?(\S+)\s+(\S+)\s+(\d+)/.exec(args);
        if (!m) throw new MslError('uso: /sockopen [-e] nombre servidor puerto');
        this.sockOpen(m[2], m[3], Number(m[4]), !!m[1]?.includes('e'), ctx);
        return;
      }
      case 'sockwrite': {
        const m = /^(?:-(\w+)\s+)?(\S+)\s?(.*)$/s.exec(args);
        const sk = m && this.socks.get(m[2].toLowerCase());
        if (!m || !sk) throw new MslError('socket no encontrado');
        sk.socket.write(m[3] + (m[1]?.includes('n') ? '\r\n' : ''));
        return;
      }
      case 'sockclose':
        for (const [k, sk] of [...this.socks]) {
          if (wildMatch(args.trim() || '*', k)) {
            this.socks.delete(k);
            sk.socket.destroy();
          }
        }
        return;
      case 'hmake':
        this.hashes.set(args.replace(/^-\w+\s+/, '').split(' ')[0].toLowerCase(), new Map());
        return;
      case 'hfree':
        this.hashes.delete(args.replace(/^-\w+\s+/, '').split(' ')[0].toLowerCase());
        return;
      case 'hadd':
      case 'hinc':
      case 'hdec': {
        const m = /^(?:-(\w+)\s+)?(\S+)\s+(\S+)\s*(.*)$/s.exec(args);
        if (!m) return;
        const tname = m[2].toLowerCase();
        let table = this.hashes.get(tname);
        if (!table) {
          if (name === 'hadd' && !m[1]?.includes('m')) throw new MslError(`la tabla hash "${m[2]}" no existe (usa /hmake o /hadd -m)`);
          table = new Map();
          this.hashes.set(tname, table);
        }
        if (name === 'hadd') table.set(m[3], m[4]);
        else {
          const by = m[4].trim() ? Number(m[4]) || 0 : 1;
          const cur = Number(table.get(m[3])) || 0;
          table.set(m[3], fmtNum(name === 'hinc' ? cur + by : cur - by));
        }
        return;
      }
      case 'hdel': {
        const m = /^(?:-\w+\s+)?(\S+)\s+(\S+)/.exec(args);
        if (m) this.hashes.get(m[1].toLowerCase())?.delete(m[2]);
        return;
      }
      case 'write': {
        const m = /^(?:-(\w+)\s+)?("[^"]+"|\S+)\s?(.*)$/s.exec(args);
        if (!m) return;
        const file = this.safePath(m[2]);
        if (!file) throw new MslError('ruta de archivo no permitida');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        if (m[1]?.includes('c')) fs.writeFileSync(file, m[3] ? m[3] + '\n' : '');
        else fs.appendFileSync(file, m[3] + '\n');
        return;
      }
      case 'remove': {
        const file = this.safePath(args);
        if (file && fs.existsSync(file)) fs.rmSync(file);
        return;
      }
    }

    if (this.host.command(name, args, ctx)) return;
    this.host.raw((name.toUpperCase() + ' ' + args).trim(), ctx);
  }

  /** Nombres de variable dinámicos: `set %cuenta. $+ $nick 5`. */
  private dynName(first: string, rest: string, ctx: MslContext, evaluate: boolean): { name: string; value: string } {
    let name = first;
    let value = rest;
    for (;;) {
      const m = /^\$\+\s+(\S+)\s*(.*)$/s.exec(value);
      if (!m) break;
      name += evaluate ? this.evalText(m[1], ctx) : m[1];
      value = m[2];
    }
    return { name, value };
  }

  /** mIRC resuelve `%x = 5 + 2` como aritmética simple. */
  private arith(v: string): string {
    const m = /^(-?\d+\.?\d*) ([+\-*/%^]) (-?\d+\.?\d*)$/.exec(v);
    if (!m) return v;
    return calc(`(${m[1]})${m[2]}(${m[3]})`);
  }

  private timerCommand(suffix: string, rest: string, ctx: MslContext, evaluate: boolean): void {
    const name = (evaluate ? this.evalText(suffix, ctx) : suffix).toLowerCase();
    let body = rest;
    let ms = false;
    const f = /^-(\w+)\s+/.exec(body);
    if (f) {
      ms = f[1].includes('m');
      body = body.slice(f[0].length);
    }
    if (/^off\s*$/i.test(body)) {
      this.stopTimers(name || '*');
      return;
    }
    const m = /^(\S+)\s+(\S+)\s+(.+)$/s.exec(body);
    if (!m) return;
    const ev = (s: string) => (evaluate ? this.evalText(s, ctx) : s);
    const reps = Number(ev(m[1])) || 0;
    const interval = Math.max(ms ? 10 : 100, (Number(ev(m[2])) || 0) * (ms ? 1 : 1000));
    // Como en mIRC, los identificadores se evalúan al crear el temporizador; al dispararse ya no.
    const command = ev(m[3]);
    let tname = name;
    if (!tname) {
      let n = 1;
      while (this.timers.has(String(n))) n++;
      tname = String(n);
    }
    this.stopTimers(tname);
    const snapshot = newContext({ cid: ctx.cid, chan: ctx.chan, nick: ctx.nick, target: ctx.target });
    const timer: Timer = {
      name: tname,
      reps,
      command,
      handle: setInterval(() => {
        const t = this.timers.get(tname);
        if (!t) return;
        if (t.reps > 0 && --t.reps === 0) this.stopTimers(tname);
        this.execLine(command, newContext(snapshot), false);
      }, interval),
    };
    timer.handle.unref();
    this.timers.set(tname, timer);
  }

  private stopTimers(pattern: string): void {
    for (const [k, t] of [...this.timers]) {
      if (wildMatch(pattern, k)) {
        clearInterval(t.handle);
        this.timers.delete(k);
      }
    }
  }

  // --------------------------------------------------------- variables

  getVar(name: string, ctx: MslContext): string {
    const k = this.expand(name).toLowerCase();
    return ctx.locals.get(k) ?? this.vars.get(k) ?? '';
  }

  private setVar(name: string, value: string, ctx: MslContext, forceGlobal: boolean): void {
    const k = this.expand(name).toLowerCase();
    if (!forceGlobal && ctx.locals.has(k)) ctx.locals.set(k, value);
    else this.setGlobal(k, value);
  }

  private setGlobal(name: string, value: string): void {
    this.vars.set(this.expand(name).toLowerCase(), value);
    this.onVarsChanged?.();
  }

  private unsetGlobal(name: string): void {
    if (this.vars.delete(this.expand(name).toLowerCase())) this.onVarsChanged?.();
  }

  private safePath(nameIn: string): string | null {
    const name = nameIn.trim().replace(/^"(.*)"$/, '$1');
    if (!name) return null;
    const base = path.resolve(this.host.dataDir);
    const full = path.resolve(base, name);
    if (full !== base && !full.startsWith(base + path.sep)) return null;
    return full;
  }

  // -------------------------------------------------------- condiciones

  evalCond(text: string, ctx: MslContext): boolean {
    const s = text.trim();
    const ors = this.splitLogic(s, '||');
    if (ors.length > 1) return ors.some((p) => this.evalCond(p, ctx));
    const ands = this.splitLogic(s, '&&');
    if (ands.length > 1) return ands.every((p) => this.evalCond(p, ctx));
    if (s.startsWith('(') && findClose(s, 0, '(', ')') === s.length - 1) return this.evalCond(s.slice(1, -1), ctx);
    if (s.startsWith('!') && s[1] === '(' && findClose(s, 1, '(', ')') === s.length - 1) return !this.evalCond(s.slice(2, -1), ctx);

    const toks = this.splitSpaces(s);
    const OPS = /^!?(==|===|!=|!==|<|>|<=|>=|\/\/|\\\\|&|isin|isincs|iswm|iswmcs|isnum|isletter|ison|isop|ishop|isvoice|isvo|isreg|ischan|isalnum|isalpha|islower|isupper)$/i;
    let opIdx = -1;
    for (let k = 1; k < toks.length; k++) {
      if (OPS.test(toks[k])) {
        opIdx = k;
        break;
      }
    }
    if (opIdx === -1) {
      let negate = false;
      let body = s;
      if (body.startsWith('!') && body.length > 1) {
        negate = true;
        body = body.slice(1);
      }
      const v = this.evalText(body, ctx);
      ctx.v1 = v;
      ctx.v2 = '';
      const truthy = v !== '' && v !== '0' && v !== '$false';
      return negate ? !truthy : truthy;
    }
    let op = toks[opIdx].toLowerCase();
    const v1 = this.evalText(toks.slice(0, opIdx).join(' '), ctx);
    const v2 = this.evalText(toks.slice(opIdx + 1).join(' '), ctx);
    ctx.v1 = v1;
    ctx.v2 = v2;
    let negate = false;
    if (op.startsWith('!') && op !== '!=' && op !== '!==') {
      negate = true;
      op = op.slice(1);
    }
    const r = this.compare(op, v1, v2, ctx);
    return negate ? !r : r;
  }

  private compare(op: string, a: string, b: string, ctx: MslContext): boolean {
    const num = isNum(a) && isNum(b);
    const al = a.toLowerCase();
    const bl = b.toLowerCase();
    const prefixOf = (nick: string, chan: string) =>
      this.host.nicks(ctx, chan).find((u) => ircLower(u.nick) === ircLower(nick))?.prefix;
    switch (op) {
      case '==': return num ? Number(a) === Number(b) : al === bl;
      case '===': return a === b;
      case '!=': return num ? Number(a) !== Number(b) : al !== bl;
      case '!==': return a !== b;
      case '<': return num ? Number(a) < Number(b) : al < bl;
      case '>': return num ? Number(a) > Number(b) : al > bl;
      case '<=': return num ? Number(a) <= Number(b) : al <= bl;
      case '>=': return num ? Number(a) >= Number(b) : al >= bl;
      case '//': return num && Number(b) !== 0 && Number(a) % Number(b) === 0;
      case '\\\\': return num && Number(b) !== 0 && Number(a) % Number(b) !== 0;
      case '&': return (Number(a) & Number(b)) !== 0;
      case 'isin': return a !== '' && bl.includes(al);
      case 'isincs': return a !== '' && b.includes(a);
      case 'iswm': return wildMatch(a, b);
      case 'iswmcs': return wildMatch(a, b, true);
      case 'isnum': {
        if (!isNum(a)) return false;
        const m = /^(-?\d+\.?\d*)-(-?\d+\.?\d*)?$/.exec(b);
        if (!m) return true;
        return Number(a) >= Number(m[1]) && (m[2] === undefined || Number(a) <= Number(m[2]));
      }
      case 'isletter':
      case 'isalpha': return /^[A-Za-zÀ-ÿ]+$/.test(a);
      case 'isalnum': return /^[A-Za-z0-9À-ÿ]+$/.test(a);
      case 'islower': return a === a.toLowerCase() && a !== a.toUpperCase();
      case 'isupper': return a === a.toUpperCase() && a !== a.toLowerCase();
      case 'ison': return prefixOf(a, b) !== undefined;
      case 'isop': return prefixOf(a, b)?.includes('@') ?? false;
      case 'ishop': return prefixOf(a, b)?.includes('%') ?? false;
      case 'isvoice':
      case 'isvo': return prefixOf(a, b)?.includes('+') ?? false;
      case 'isreg': return prefixOf(a, b) === '';
      case 'ischan': return this.host.info(ctx).channels.some((c) => ircLower(c) === ircLower(a));
    }
    return false;
  }

  private splitLogic(s: string, op: '&&' | '||'): string[] {
    const out: string[] = [];
    let depth = 0;
    let last = 0;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '(') depth++;
      else if (s[i] === ')') depth--;
      else if (depth === 0 && s.startsWith(op, i) && s[i - 1] === ' ' && s[i + 2] === ' ') {
        out.push(s.slice(last, i).trim());
        last = i + 2;
        i++;
      }
    }
    out.push(s.slice(last).trim());
    return out;
  }

  private splitSpaces(s: string): string[] {
    const out: string[] = [];
    let depth = 0;
    let cur = '';
    for (const ch of s) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (ch === ' ' && depth <= 0) {
        if (cur) out.push(cur);
        cur = '';
      } else cur += ch;
    }
    if (cur) out.push(cur);
    return out;
  }

  // -------------------------------------------------------- evaluación

  /** Sustituye variables e identificadores en un texto. Los valores sustituidos no se reevalúan. */
  /** Sustituye los marcadores de corchetes ya evaluados por su valor. */
  private expand(s: string): string {
    if (!s.includes(PH_OPEN)) return s;
    return s.replace(/\uE000(\d+)\uE001/g, (_m, id) => this.placeholders[Number(id)] ?? '');
  }

  /**
   * Corchetes de evaluación de mIRC: `[ expr ]` se evalúa antes que el resto y `[ $+ expr ]` se pega
   * a la palabra anterior, lo que permite variables dinámicas como `%puntos. [ $+ [ $nick ] ]`.
   * El valor se inserta como texto literal: no se vuelve a evaluar.
   */
  private resolveBrackets(text: string, ctx: MslContext): string {
    const toks = text.split(' ');
    for (;;) {
      const close = toks.indexOf(']');
      if (close === -1) break;
      const open = toks.lastIndexOf('[', close);
      if (open === -1) break;
      const inner = toks.slice(open + 1, close);
      const glue = inner[0] === '$+';
      const value = this.evalText((glue ? inner.slice(1) : inner).join(' '), ctx);
      if (this.placeholders.length > 20000) this.placeholders = [];
      const ph = `${PH_OPEN}${this.placeholders.push(value) - 1}${PH_CLOSE}`;
      if (glue && open > 0) {
        toks[open - 1] += ph;
        toks.splice(open, close - open + 1);
      } else toks.splice(open, close - open + 1, ph);
    }
    return toks.join(' ');
  }

  // ------------------------------------------------------------ sockets

  private sockOpen(name: string, host: string, port: number, secure: boolean, ctx: MslContext): void {
    const key = name.toLowerCase();
    if (this.socks.has(key)) throw new MslError(`el socket "${name}" ya existe`);
    const socket = secure ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host }) : net.connect({ host, port });
    const sk: ScriptSocket = { name, socket, buf: Buffer.alloc(0), cid: ctx.cid, open: false };
    this.socks.set(key, sk);
    const alive = () => this.socks.get(key) === sk;
    socket.setTimeout(60000, () => socket.destroy(new Error('tiempo de espera agotado')));
    socket.on(secure ? 'secureConnect' : 'connect', () => {
      sk.open = true;
      socket.setTimeout(0);
      if (alive()) this.fire('SOCKOPEN', { cid: sk.cid, sockname: name, sockerr: 0 });
    });
    socket.on('data', (d: Buffer) => {
      if (!alive()) return;
      sk.buf = Buffer.concat([sk.buf, d]);
      if (sk.buf.length > 4 * 1024 * 1024) sk.buf = sk.buf.subarray(sk.buf.length - 1024 * 1024);
      for (let n = 0; n < 100000 && alive() && sk.buf.length; n++) {
        const before = sk.buf.length;
        this.fire('SOCKREAD', { cid: sk.cid, sockname: name, sockerr: 0 });
        if (sk.buf.length === before) break;
      }
    });
    socket.on('error', () => {
      if (alive() && !sk.open) this.fire('SOCKOPEN', { cid: sk.cid, sockname: name, sockerr: 3 });
    });
    socket.on('close', () => {
      if (!alive()) return;
      // Lo que quede sin salto de línea final se entrega antes de cerrar.
      if (sk.buf.length) {
        sk.buf = Buffer.concat([sk.buf, Buffer.from('\n')]);
        for (let n = 0; n < 100000 && sk.buf.length; n++) {
          const before = sk.buf.length;
          this.fire('SOCKREAD', { cid: sk.cid, sockname: name, sockerr: 0 });
          if (sk.buf.length === before) break;
        }
      }
      this.socks.delete(key);
      if (sk.open) this.fire('SOCKCLOSE', { cid: sk.cid, sockname: name, sockerr: 0 });
    });
  }

  evalText(sIn: string, ctx: MslContext): string {
    const s = sIn.includes('[ ') ? this.resolveBrackets(sIn, ctx) : sIn;
    const toks: Tok[] = [];
    const n = s.length;
    let i = 0;
    const nextSpace = (from: number) => {
      const j = s.indexOf(' ', from);
      return j === -1 ? n : j;
    };
    while (i < n) {
      if (s[i] === ' ') {
        i++;
        continue;
      }
      const c = s[i];
      let j: number;
      if (c === '#' && (s[i + 1] === '$' || s[i + 1] === '%') && i + 2 < n && s[i + 2] !== ' ') {
        // `#$1` y `#%canal`, como en el alias clásico `/j /join #$$1`
        toks.push('#', JOIN);
        i++;
        continue;
      }
      if (c === '%' && i + 1 < n && s[i + 1] !== ' ') {
        j = nextSpace(i);
        toks.push(this.getVar(s.slice(i + 1, j), ctx));
      } else if (c === '$' && i + 1 < n && s[i + 1] !== ' ') {
        const r = this.parseIdent(s, i, ctx);
        if (r && (r.end === n || s[r.end] === ' ')) {
          toks.push(r.value);
          j = r.end;
        } else {
          j = nextSpace(i);
          toks.push(s.slice(i, j));
        }
      } else {
        j = nextSpace(i);
        toks.push(s.slice(i, j));
      }
      i = j;
    }
    const merged: string[] = [];
    for (let k = 0; k < toks.length; k++) {
      const t = toks[k];
      if (t === JOIN) {
        const prev = merged.length ? merged.pop()! : '';
        let next = '';
        if (k + 1 < toks.length && toks[k + 1] !== JOIN) next = toks[++k] as string;
        merged.push(prev + next);
      } else merged.push(t);
    }
    return this.expand(merged.filter((t) => t !== '').join(' '));
  }

  private parseIdent(s: string, i: number, ctx: MslContext): { value: Tok; end: number } | null {
    const rest = s.slice(i + 1);
    // $+ como operador de unión
    if (rest[0] === '+' && (rest.length === 1 || rest[1] === ' ')) return { value: JOIN, end: i + 2 };
    // $1, $2-, $3-5, $$1
    const pos = /^(\$?)(\d+)(-(\d+)?)?/.exec(rest);
    if (pos) {
      const from = Number(pos[2]);
      let value: string;
      if (from === 0) value = String(ctx.params.length);
      else if (pos[3]) value = ctx.params.slice(from - 1, pos[4] ? Number(pos[4]) : undefined).join(' ');
      else value = ctx.params[from - 1] ?? '';
      if (pos[1] && value === '') throw new HaltSignal();
      return { value, end: i + 1 + pos[0].length };
    }
    const nm = /^(\+|[A-Za-z_][A-Za-z0-9_]*)/.exec(rest);
    if (!nm) return null;
    const name = nm[1].toLowerCase();
    let end = i + 1 + nm[0].length;
    let rawArgs: string[] | null = null;
    if (s[end] === '(') {
      const close = findClose(s, end, '(', ')');
      if (close === -1) return null;
      rawArgs = splitTopLevel(s.slice(end + 1, close), ',').map((a) => a.trim());
      end = close + 1;
    }
    let prop = '';
    const pm = /^\.([A-Za-z0-9_]+)/.exec(s.slice(end));
    if (pm && rawArgs) {
      prop = pm[1].toLowerCase();
      end += pm[0].length;
    }
    if (name === 'iif' && rawArgs) {
      const ok = this.evalCond(rawArgs[0] ?? '', ctx);
      return { value: this.evalText((ok ? rawArgs[1] : rawArgs[2]) ?? '', ctx), end };
    }
    const args = rawArgs ? rawArgs.map((a) => this.evalText(a, ctx)) : null;
    return { value: this.callIdent(name, args, prop, ctx), end };
  }

  private tokens(text: string, c: string): string[] {
    const sep = String.fromCharCode(Number(c) || 32);
    return text.split(sep).filter((t) => t !== '');
  }

  private callIdent(name: string, args: string[] | null, prop: string, ctx: MslContext): string {
    const a = args ?? [];
    const num = (k: number, d = 0) => (a[k] !== undefined && a[k] !== '' ? Number(a[k]) || 0 : d);
    const info = () => this.host.info(ctx);
    const pad = (v: number, l = 2) => String(v).padStart(l, '0');
    const now = new Date();
    switch (name) {
      case '+': return a.join('');
      case 'null': return '';
      case 'true': return '$true';
      case 'false': return '$false';
      case 'nick':
        if (args) {
          const list = this.host.nicks(ctx, a[0] ?? '');
          const n = num(1);
          return n === 0 ? String(list.length) : list[n - 1]?.nick ?? '';
        }
        return ctx.nick ?? '';
      case 'chan':
        if (args) {
          const chans = info().channels;
          if (isNum(a[0] ?? '')) return num(0) === 0 ? String(chans.length) : chans[num(0) - 1] ?? '';
          return chans.find((c) => ircLower(c) === ircLower(a[0] ?? '')) ?? '';
        }
        return ctx.chan ?? '';
      case 'target': return ctx.target ?? ctx.chan ?? '';
      case 'me': return info().me;
      case 'server': return info().server;
      case 'network': return info().network;
      case 'active': return info().active;
      case 'address': return ctx.address ?? '';
      case 'site': return (ctx.address ?? '').split('@')[1] ?? '';
      case 'fulladdress': return ctx.nick && ctx.address ? `${ctx.nick}!${ctx.address}` : '';
      case 'snick': return ctx.params[0] ?? '';
      case 'knick': return ctx.knick ?? '';
      case 'sockname': return ctx.sockname ?? '';
      case 'sockbr': return String(ctx.sockbr ?? 0);
      case 'sockerr': return String(ctx.sockerr ?? 0);
      case 'sock': return this.socks.get((a[0] ?? '').toLowerCase())?.name ?? '';
      case 'newnick': return ctx.newnick ?? '';
      case 'event': return (ctx.event ?? '').toLowerCase();
      case 'numeric': return ctx.numeric ?? '';
      case 'rawmsg': return ctx.rawmsg ?? '';
      case 'cid': return ctx.cid ?? '';
      case 'isid': return ctx.isid ? '$true' : '$false';
      case 'result': return ctx.result;
      case 'v1':
      case 'ifmatch': return ctx.v1;
      case 'v2': return ctx.v2;
      case 'version': return '7.0';
      case 'cr': return '\r';
      case 'lf': return '\n';
      case 'crlf': return '\r\n';
      case 'time': return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
      case 'date': return `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()}`;
      case 'fulldate': return now.toString();
      case 'day': return now.toLocaleDateString('en-US', { weekday: 'long' });
      case 'timestamp': return `[${pad(now.getHours())}:${pad(now.getMinutes())}]`;
      case 'ctime': return String(Math.floor((a[0] ? new Date(a[0]).getTime() || Date.now() : Date.now()) / 1000));
      case 'ticks': return String(Date.now());
      case 'asctime': {
        const d = a[0] && isNum(a[0]) ? new Date(Number(a[0]) * 1000) : now;
        const fmt = (isNum(a[0] ?? '') ? a[1] : a[0]) || 'ddd mmm dd HH:nn:ss yyyy';
        const map: Record<string, string> = {
          yyyy: String(d.getFullYear()), yy: String(d.getFullYear()).slice(2), mmmm: d.toLocaleDateString('en-US', { month: 'long' }),
          mmm: d.toLocaleDateString('en-US', { month: 'short' }), mm: pad(d.getMonth() + 1), dddd: d.toLocaleDateString('en-US', { weekday: 'long' }),
          ddd: d.toLocaleDateString('en-US', { weekday: 'short' }), dd: pad(d.getDate()), HH: pad(d.getHours()), hh: pad(d.getHours() % 12 || 12),
          nn: pad(d.getMinutes()), ss: pad(d.getSeconds()), tt: d.getHours() < 12 ? 'am' : 'pm',
        };
        return fmt.replace(/yyyy|yy|mmmm|mmm|mm|dddd|ddd|dd|HH|hh|nn|ss|tt/g, (k) => map[k]);
      }
      case 'duration': {
        let secs = Math.floor(num(0));
        const parts: string[] = [];
        for (const [label, size] of [['wk', 604800], ['day', 86400], ['hr', 3600], ['min', 60], ['sec', 1]] as const) {
          const v = Math.floor(secs / size);
          if (v) parts.push(`${v}${label}${v > 1 ? 's' : ''}`);
          secs %= size;
        }
        return parts.join(' ') || '0secs';
      }
      case 'chr': return String.fromCodePoint(num(0));
      case 'asc': return a[0] ? String(a[0].codePointAt(0)) : '';
      case 'len': return String((a[0] ?? '').length);
      case 'upper': return (a[0] ?? '').toUpperCase();
      case 'lower': return (a[0] ?? '').toLowerCase();
      case 'left': return num(1) >= 0 ? (a[0] ?? '').slice(0, num(1)) : (a[0] ?? '').slice(0, num(1));
      case 'right': return num(1) > 0 ? (a[0] ?? '').slice(-num(1)) : (a[0] ?? '').slice(-num(1) || (a[0] ?? '').length);
      case 'mid': {
        const start = num(1) > 0 ? num(1) - 1 : Math.max(0, (a[0] ?? '').length + num(1));
        return a[2] === undefined || a[2] === '' ? (a[0] ?? '').slice(start) : (a[0] ?? '').slice(start, start + num(2));
      }
      case 'replace':
      case 'replacecs': {
        let t = a[0] ?? '';
        for (let k = 1; k + 1 < a.length; k += 2) {
          if (!a[k]) continue;
          t = t.replace(new RegExp(a[k].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), name === 'replace' ? 'gi' : 'g'), () => a[k + 1]);
        }
        return t;
      }
      case 'remove':
      case 'removecs': {
        let t = a[0] ?? '';
        for (let k = 1; k < a.length; k++) {
          if (a[k]) t = t.replace(new RegExp(a[k].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), name === 'remove' ? 'gi' : 'g'), '');
        }
        return t;
      }
      case 'strip': return stripFormatting(a[0] ?? '');
      case 'str': return (a[0] ?? '').repeat(Math.min(10000, Math.max(0, num(1))));
      case 'pos': {
        const hay = (a[0] ?? '').toLowerCase();
        const needle = (a[1] ?? '').toLowerCase();
        if (!needle) return '';
        const want = num(2, 1);
        let idx = -1;
        let count = 0;
        while ((idx = hay.indexOf(needle, idx + 1)) !== -1) {
          count++;
          if (count === want) return String(idx + 1);
        }
        return want === 0 ? String(count) : '';
      }
      case 'count': {
        const hay = (a[0] ?? '').toLowerCase();
        let total = 0;
        for (let k = 1; k < a.length; k++) if (a[k]) total += hay.split(a[k].toLowerCase()).length - 1;
        return String(total);
      }
      case 'qt': return `"${(a[0] ?? '').replace(/^"|"$/g, '')}"`;
      case 'noqt': return (a[0] ?? '').replace(/^"|"$/g, '');
      case 'int': return String(Math.trunc(num(0)));
      case 'round': return fmtNum(Math.round(num(0) * 10 ** num(1)) / 10 ** num(1));
      case 'abs': return fmtNum(Math.abs(num(0)));
      case 'ceil': return String(Math.ceil(num(0)));
      case 'floor': return String(Math.floor(num(0)));
      case 'sqrt': return fmtNum(Math.sqrt(num(0)));
      case 'calc': return calc(a.join(','));
      case 'rand':
      case 'r': {
        if (isNum(a[0] ?? '') && isNum(a[1] ?? '')) {
          const lo = Math.min(num(0), num(1));
          const hi = Math.max(num(0), num(1));
          return String(lo + Math.floor(Math.random() * (hi - lo + 1)));
        }
        const lo = (a[0] ?? 'a').charCodeAt(0);
        const hi = (a[1] ?? 'z').charCodeAt(0);
        return String.fromCharCode(Math.min(lo, hi) + Math.floor(Math.random() * (Math.abs(hi - lo) + 1)));
      }
      case 'gettok': {
        const t = this.tokens(a[0] ?? '', a[2] ?? '32');
        const sep = String.fromCharCode(Number(a[2]) || 32);
        const spec = a[1] ?? '';
        const range = /^(-?\d+)-(\d+)?$/.exec(spec);
        if (range) return t.slice(Number(range[1]) - 1, range[2] ? Number(range[2]) : undefined).join(sep);
        const n = Number(spec) || 0;
        if (n === 0) return String(t.length);
        return (n > 0 ? t[n - 1] : t[t.length + n]) ?? '';
      }
      case 'numtok': return String(this.tokens(a[0] ?? '', a[1] ?? '32').length);
      case 'addtok': {
        const t = this.tokens(a[0] ?? '', a[2] ?? '32');
        if (!t.some((x) => x.toLowerCase() === (a[1] ?? '').toLowerCase())) t.push(a[1] ?? '');
        return t.join(String.fromCharCode(Number(a[2]) || 32));
      }
      case 'deltok': {
        const t = this.tokens(a[0] ?? '', a[2] ?? '32');
        const n = num(1);
        t.splice(n > 0 ? n - 1 : t.length + n, 1);
        return t.join(String.fromCharCode(Number(a[2]) || 32));
      }
      case 'remtok': {
        const t = this.tokens(a[0] ?? '', a[3] ?? '32');
        const idx = t.findIndex((x) => x.toLowerCase() === (a[1] ?? '').toLowerCase());
        if (idx !== -1) t.splice(idx, 1);
        return t.join(String.fromCharCode(Number(a[3]) || 32));
      }
      case 'puttok':
      case 'instok': {
        const t = this.tokens(a[0] ?? '', a[3] ?? '32');
        const n = Math.max(1, num(2));
        if (name === 'puttok') t[n - 1] = a[1] ?? '';
        else t.splice(n - 1, 0, a[1] ?? '');
        return t.join(String.fromCharCode(Number(a[3]) || 32));
      }
      case 'findtok': {
        const t = this.tokens(a[0] ?? '', a[3] ?? a[2] ?? '32');
        const idx = t.findIndex((x) => x.toLowerCase() === (a[1] ?? '').toLowerCase());
        return idx === -1 ? '' : String(idx + 1);
      }
      case 'istok':
        return this.tokens(a[0] ?? '', a[2] ?? '32').some((x) => x.toLowerCase() === (a[1] ?? '').toLowerCase()) ? '$true' : '$false';
      case 'hget': {
        const table = this.hashes.get((a[0] ?? '').toLowerCase());
        if (!table) return '';
        if (a.length < 2) return a[0];
        if (prop === 'item' || prop === 'data') {
          const n = num(1);
          if (n === 0) return String(table.size);
          const entry = [...table.entries()][n - 1];
          return entry ? (prop === 'item' ? entry[0] : entry[1]) : '';
        }
        return table.get(a[1]) ?? '';
      }
      case 'var': return this.getVar((a[0] ?? '').replace(/^%/, ''), ctx);
      case 'exists':
      case 'isfile': {
        const f = this.safePath(a[0] ?? '');
        return f && fs.existsSync(f) ? '$true' : '$false';
      }
      case 'lines': {
        const f = this.safePath(a[0] ?? '');
        if (!f || !fs.existsSync(f)) return '0';
        return String(fs.readFileSync(f, 'utf8').split('\n').filter((l) => l !== '').length);
      }
      case 'read': {
        const f = this.safePath(a[0] ?? '');
        if (!f || !fs.existsSync(f)) return '';
        const lines = fs.readFileSync(f, 'utf8').split('\n').filter((l) => l !== '');
        if (!lines.length) return '';
        const n = a.find((x, k) => k > 0 && isNum(x));
        return (n ? lines[Number(n) - 1] : lines[Math.floor(Math.random() * lines.length)]) ?? '';
      }
      case 'nopath': return path.basename(a[0] ?? '');
      case 'nofile': return path.dirname(a[0] ?? '') + path.sep;
      case 'mircdir':
      case 'scriptdir': return this.host.dataDir + path.sep;
      case 'regex':
      case 'regsubex':
      case 'regsub': {
        const off = a.length > (name === 'regex' ? 2 : 3) ? 1 : 0;
        const text = a[off] ?? '';
        const pm = /^\/(.*)\/([a-zA-Z]*)$/s.exec(a[off + 1] ?? '');
        let re: RegExp;
        try {
          re = pm ? new RegExp(pm[1], pm[2].replace(/[^gimsu]/g, '')) : new RegExp(a[off + 1] ?? '');
        } catch {
          return name === 'regex' ? '0' : text;
        }
        if (name === 'regex') {
          const m = re.exec(text);
          ctx.regml = m ? m.slice(1).map((x) => x ?? '') : [];
          if (!m) return '0';
          return re.global ? String(text.match(re)?.length ?? 0) : '1';
        }
        const sub = a[off + 2] ?? '';
        return text.replace(re, (...g) => sub.replace(/\\(\d|t)/g, (_x, d) => (d === 't' ? g[0] : g[Number(d)] ?? '')));
      }
      case 'regml': {
        const n = num(a.length > 1 ? 1 : 0);
        return n === 0 ? String(ctx.regml.length) : ctx.regml[n - 1] ?? '';
      }
      case 'eval': return a[0] ?? '';
    }
    const alias = this.findAlias(name);
    if (alias) return this.runAlias(alias, a.join(' '), ctx, true, a);
    return '';
  }
}
