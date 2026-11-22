import { MIRC_COLORS, parseFormatting, stripFormatting } from '../core/irc/formatting';
import type {
  BufferType, ChannelListEntry, DccInfo, DialogControlView, DialogView, Line, NetworkConfig, NickEntry, ScriptInfo, SessionInfo, Settings, Snapshot, UiEvent,
} from '../core/types';

const STATUS = '*';
const LOCAL = 'local';
const MAX_LINES = 2000;

declare global {
  interface Window {
    onda: { invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>; onUi(cb: (ev: UiEvent) => void): void };
  }
}

interface BufferState {
  name: string;
  type: BufferType;
  lines: Line[];
  nicks: NickEntry[];
  topic: string;
  unread: number;
  highlight: boolean;
  typing: Map<string, number>;
  reactions: Map<string, string[]>;
}

interface SessionState {
  info: SessionInfo;
  buffers: Map<string, BufferState>;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};
const key = (s: string) => s.toLowerCase();

const sessions = new Map<string, SessionState>();
let active = { sid: LOCAL, buffer: STATUS };
let settings: Settings;
let networks: NetworkConfig[] = [];
const dccs = new Map<string, DccInfo>();
const history: string[] = [];
let historyPos = -1;

/** Ventana flotante de un búfer (canal, privado, estado…), como las de mIRC. */
interface Win {
  sid: string;
  name: string;
  root: HTMLElement;
  title: HTMLElement;
  topic: HTMLElement;
  log: HTMLElement;
  nicks: HTMLElement;
  typing: HTMLElement;
  mynick: HTMLElement;
  input: HTMLTextAreaElement;
}
const wins = new Map<string, Win>();
const winId = (sid: string, buffer: string) => `${sid}\u0000${key(buffer)}`;
const winOf = (sid: string, buffer: string) => wins.get(winId(sid, buffer));
const desktop = $('desktop');
// Elementos de la ventana activa: los usan el completado, la inserción de texto y la búsqueda.
let log: HTMLElement = el('div');
let input: HTMLTextAreaElement = el('textarea');
let zTop = 10;

// ------------------------------------------------------------------ estado

function newBuffer(name: string, type: BufferType): BufferState {
  return { name, type, lines: [], nicks: [], topic: '', unread: 0, highlight: false, typing: new Map(), reactions: new Map() };
}

function ensureSession(info: SessionInfo): SessionState {
  let s = sessions.get(info.sid);
  if (!s) {
    s = { info, buffers: new Map() };
    sessions.set(info.sid, s);
  } else s.info = info;
  return s;
}

function getBuffer(sid: string, name: string, create?: BufferType): BufferState | undefined {
  const s = sessions.get(sid);
  if (!s) return undefined;
  let b = s.buffers.get(key(name));
  if (!b && create) {
    b = newBuffer(name, create);
    s.buffers.set(key(name), b);
  }
  return b;
}

const activeBuffer = () => getBuffer(active.sid, active.buffer);
const isActive = (sid: string, buffer: string) => active.sid === sid && key(active.buffer) === key(buffer);

function activate(sid: string, buffer: string, focus = true): void {
  const b = getBuffer(sid, buffer);
  if (!b) return;
  const w = ensureWin(sid, b);
  const changed = !isActive(sid, b.name);
  active = { sid, buffer: b.name };
  b.unread = 0;
  b.highlight = false;
  w.root.classList.remove('min');
  w.root.style.zIndex = String(++zTop);
  for (const o of wins.values()) o.root.classList.toggle('active', o === w);
  log = w.log;
  input = w.input;
  if (changed) void window.onda.invoke('setActive', sid, b.name);
  if (findQuery) $('find-count').textContent = `${b.lines.filter(matchesFind).length} coincidencias`;
  renderTree();
  const s = sessions.get(sid);
  document.title = `${b.type === 'status' ? s?.info.name ?? 'Onda' : b.name} · Onda IRC`;
  if (desktop.classList.contains('maxed')) w.log.scrollTop = w.log.scrollHeight;
  if (focus && $('find').hidden) input.focus();
}

// --------------------------------------------------------------- ventanas

interface Geo { x: number; y: number; w: number; h: number }
let savedGeo: Record<string, Geo> = {};
try {
  savedGeo = JSON.parse(localStorage.getItem('onda.ventanas') ?? '{}');
  if (localStorage.getItem('onda.max') === '1') desktop.classList.add('maxed');
} catch {
  /* sin posiciones guardadas */
}
let geoTimer = 0;
function saveGeo(): void {
  window.clearTimeout(geoTimer);
  geoTimer = window.setTimeout(() => {
    try {
      localStorage.setItem('onda.ventanas', JSON.stringify(savedGeo));
      localStorage.setItem('onda.max', desktop.classList.contains('maxed') ? '1' : '0');
    } catch {
      /* almacenamiento no disponible */
    }
  }, 300);
}

function placeWin(w: Win, g: Geo): void {
  const dw = Math.max(320, desktop.clientWidth);
  const dh = Math.max(200, desktop.clientHeight);
  const width = Math.min(Math.max(260, g.w), dw);
  const height = Math.min(Math.max(150, g.h), dh);
  w.root.style.left = Math.max(0, Math.min(g.x, dw - 80)) + 'px';
  w.root.style.top = Math.max(0, Math.min(g.y, dh - 30)) + 'px';
  w.root.style.width = width + 'px';
  w.root.style.height = height + 'px';
}

function rememberWin(w: Win): void {
  if (desktop.classList.contains('maxed') || w.root.classList.contains('min')) return;
  savedGeo[key(w.name === STATUS ? `*${w.sid === LOCAL ? 'onda' : 'estado'}` : w.name)] = {
    x: w.root.offsetLeft, y: w.root.offsetTop, w: w.root.offsetWidth, h: w.root.offsetHeight,
  };
  saveGeo();
}

function setMaxed(on: boolean): void {
  desktop.classList.toggle('maxed', on);
  $('btn-max').textContent = on ? 'Restaurar' : 'Maximizar';
  saveGeo();
  for (const w of wins.values()) w.log.scrollTop = w.log.scrollHeight;
}

/** Coloca las ventanas visibles en cascada, en mosaico (cuadrícula), en columnas o en filas. */
function arrange(mode: 'cascade' | 'grid' | 'columns' | 'rows'): void {
  setMaxed(false);
  const list = [...wins.values()].filter((w) => !w.root.classList.contains('min'));
  if (!list.length) return;
  const dw = desktop.clientWidth;
  const dh = desktop.clientHeight;
  if (mode === 'cascade') {
    list.forEach((w, n) => {
      const off = (n % 8) * 30;
      placeWin(w, { x: off, y: off, w: Math.round(dw * 0.66), h: Math.round(dh * 0.7) });
      w.root.style.zIndex = String(++zTop);
    });
  } else {
    const cols = mode === 'columns' ? list.length : mode === 'rows' ? 1 : Math.ceil(Math.sqrt(list.length));
    const rows = Math.ceil(list.length / cols);
    list.forEach((w, n) => {
      const r = Math.floor(n / cols);
      const inRow = r === rows - 1 ? list.length - cols * (rows - 1) : cols;
      const cw = dw / inRow;
      placeWin(w, { x: Math.round((n % cols) * cw), y: Math.round(r * (dh / rows)), w: Math.floor(cw), h: Math.floor(dh / rows) });
    });
  }
  for (const w of list) {
    rememberWin(w);
    w.log.scrollTop = w.log.scrollHeight;
  }
  const cur = winOf(active.sid, active.buffer);
  if (cur) cur.root.style.zIndex = String(++zTop);
}

function closeWinAction(w: Win): void {
  const b = getBuffer(w.sid, w.name);
  // La consola y las ventanas de estado no se cierran con la X (sería desconectar): se minimizan.
  if (!b || b.type === 'status') minimizeWin(w);
  else void window.onda.invoke('closeBuffer', w.sid, w.name);
}

function minimizeWin(w: Win): void {
  rememberWin(w);
  w.root.classList.add('min');
  if (isActive(w.sid, w.name)) {
    const next = [...wins.values()].filter((o) => !o.root.classList.contains('min')).sort((a, b) => Number(b.root.style.zIndex) - Number(a.root.style.zIndex))[0];
    if (next) activate(next.sid, next.name);
    else renderTree();
  }
}

function ensureWin(sid: string, b: BufferState): Win {
  const id = winId(sid, b.name);
  const had = wins.get(id);
  if (had) return had;
  const root = el('section', 'win');
  root.dataset.type = b.type;
  const bar = el('header', 'win-bar');
  const title = el('span', 'win-title');
  const topic = el('span', 'win-topic');
  const mk = (cls: string, glyph: string, label: string, fn: () => void) => {
    const btn = el('button', 'win-btn ' + cls, glyph);
    btn.type = 'button';
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      fn();
    });
    return btn;
  };
  const body = el('div', 'win-body');
  const wlog = el('div', 'log');
  wlog.setAttribute('role', 'log');
  const nicks = el('aside', 'nicks');
  nicks.setAttribute('aria-label', 'Usuarios del canal');
  body.append(wlog, nicks);
  const typing = el('div', 'typing');
  const form = el('form', 'input-form');
  const mynick = el('span', 'my-nick');
  const winput = el('textarea', 'input');
  winput.rows = 1;
  winput.placeholder = 'Mensaje o /comando';
  winput.autocomplete = 'off';
  winput.spellcheck = true;
  form.append(mynick, winput);
  form.addEventListener('submit', (e) => e.preventDefault());
  const w: Win = { sid, name: b.name, root, title, topic, log: wlog, nicks, typing, mynick, input: winput };
  bar.append(
    title, topic,
    mk('min', '–', 'Minimizar', () => minimizeWin(w)),
    mk('max', '□', 'Maximizar o restaurar', () => {
      activate(sid, b.name);
      setMaxed(!desktop.classList.contains('maxed'));
    }),
    mk('close', '×', b.type === 'status' ? 'Minimizar' : b.type === 'channel' ? 'Salir del canal' : 'Cerrar', () => closeWinAction(w)),
  );
  root.append(bar, body, typing, form);
  wins.set(id, w);

  // Posición: la guardada para ese nombre o, si no, en cascada.
  const n = wins.size - 1;
  const saved = savedGeo[key(b.name === STATUS ? `*${sid === LOCAL ? 'onda' : 'estado'}` : b.name)];
  desktop.append(root);
  placeWin(w, saved ?? {
    x: 16 + (n % 8) * 28, y: 12 + (n % 8) * 28,
    w: Math.round(Math.max(420, desktop.clientWidth * 0.62)), h: Math.round(Math.max(260, desktop.clientHeight * 0.68)),
  });
  root.style.zIndex = String(++zTop);

  // Activar al pulsar en cualquier parte; arrastrar por la barra de título.
  root.addEventListener('pointerdown', () => {
    if (!isActive(sid, b.name)) activate(sid, b.name, false);
  });
  root.addEventListener('mouseup', (e) => {
    const t = e.target as HTMLElement;
    if (window.getSelection()?.isCollapsed && !t.closest('button, a, textarea, input, select')) winput.focus();
    rememberWin(w); // también recoge los cambios de tamaño hechos con el tirador
  });
  bar.addEventListener('dblclick', (e) => {
    if (!(e.target as HTMLElement).closest('button')) setMaxed(!desktop.classList.contains('maxed'));
  });
  bar.addEventListener('pointerdown', (e) => {
    if ((e.target as HTMLElement).closest('button') || desktop.classList.contains('maxed')) return;
    const dx = e.clientX - root.offsetLeft;
    const dy = e.clientY - root.offsetTop;
    const move = (m: PointerEvent) => {
      root.style.left = Math.max(0, Math.min(desktop.clientWidth - 80, m.clientX - dx)) + 'px';
      root.style.top = Math.max(0, Math.min(desktop.clientHeight - 30, m.clientY - dy)) + 'px';
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      rememberWin(w);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
  // Clic derecho en la conversación: popups de los scripts para canal, privado o estado.
  wlog.addEventListener('contextmenu', async (e) => {
    if ((e.target as HTMLElement).closest('a, .nick')) return;
    e.preventDefault();
    const { clientX, clientY } = e;
    const items = await scriptItems();
    if (items.length) showMenu(clientX, clientY, items);
  });
  attachInput(w);
  renderHeader(w);
  renderLog(w);
  renderNicks(w);
  return w;
}

function removeWin(sid: string, buffer: string): void {
  const w = winOf(sid, buffer);
  if (!w) return;
  w.root.remove();
  wins.delete(winId(sid, buffer));
}

// --------------------------------------------------------------- dibujado

function nickColor(nick: string): string {
  let h = 0;
  for (const ch of nick.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const light = document.documentElement.dataset.theme !== 'dark';
  return `hsl(${h % 360} ${light ? '70% 32%' : '65% 68%'})`;
}

function renderTree(): void {
  const tree = $('tree');
  tree.replaceChildren();
  for (const s of sessions.values()) {
    const net = el('div', 'net');
    const order: BufferType[] = ['status', 'channel', 'query', 'dcc', 'custom'];
    const list = [...s.buffers.values()].sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type) || a.name.localeCompare(b.name));
    for (const b of list) {
      const row = el('button', 'item' + (b.type === 'status' ? ' net-row' : ''));
      row.type = 'button';
      if (isActive(s.info.sid, b.name)) row.classList.add('active');
      if (b.unread) row.classList.add('unread');
      if (b.type === 'status') row.append(el('span', 'dot ' + s.info.state));
      row.append(el('span', 'label', b.type === 'status' ? s.info.name : b.name));
      if (b.unread) row.append(el('span', 'badge' + (b.highlight ? ' hl' : ''), String(Math.min(b.unread, 999))));
      row.title = b.type === 'status' ? `${s.info.name} (${stateLabel(s.info.state)})` : b.name;
      row.addEventListener('click', () => activate(s.info.sid, b.name));
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (s.info.sid === LOCAL && b.type !== 'custom') return;
        showMenu(e.clientX, e.clientY, [
          [b.type === 'status' ? 'Desconectar y cerrar' : b.type === 'channel' ? 'Salir del canal' : 'Cerrar', () => window.onda.invoke('closeBuffer', s.info.sid, b.name)],
        ]);
      });
      net.append(row);
    }
    tree.append(net);
  }
  renderSwitchbar();
}

/** Barra de ventanas: un botón por ventana abierta, como en los clientes IRC clásicos. */
function renderSwitchbar(): void {
  const bar = $('switchbar');
  bar.replaceChildren();
  const order: BufferType[] = ['status', 'channel', 'query', 'dcc', 'custom'];
  for (const s of sessions.values()) {
    const list = [...s.buffers.values()].sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type) || a.name.localeCompare(b.name));
    for (const b of list) {
      const btn = el('button', 'sw', b.type === 'status' ? s.info.name : b.name);
      btn.type = 'button';
      btn.setAttribute('role', 'tab');
      const on = isActive(s.info.sid, b.name);
      btn.setAttribute('aria-selected', String(on));
      if (on) btn.classList.add('active');
      if (b.highlight) btn.classList.add('hl');
      else if (b.unread) btn.classList.add('unread');
      if (b.type === 'status') btn.classList.add('status');
      btn.title = b.unread ? `${b.name === STATUS ? s.info.name : b.name} (${b.unread} sin leer)` : b.type === 'status' ? s.info.name : b.name;
      if (winOf(s.info.sid, b.name)?.root.classList.contains('min')) btn.classList.add('minimized');
      btn.addEventListener('click', () => activate(s.info.sid, b.name));
      btn.addEventListener('auxclick', (e) => {
        if (e.button === 1 && !(s.info.sid === LOCAL && b.type !== 'custom')) void window.onda.invoke('closeBuffer', s.info.sid, b.name);
      });
      btn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (s.info.sid === LOCAL && b.type !== 'custom') return;
        showMenu(e.clientX, e.clientY, [
          [b.type === 'status' ? 'Desconectar y cerrar' : b.type === 'channel' ? 'Salir del canal' : 'Cerrar', () => window.onda.invoke('closeBuffer', s.info.sid, b.name)],
        ]);
      });
      bar.append(btn);
    }
  }
}

function stateLabel(st: SessionInfo['state']): string {
  return { connecting: 'conectando', connected: 'conectado', disconnected: 'desconectado', local: 'local' }[st];
}

function renderHeader(w: Win | undefined = winOf(active.sid, active.buffer)): void {
  if (!w) return;
  const b = getBuffer(w.sid, w.name);
  const s = sessions.get(w.sid);
  w.title.replaceChildren();
  w.topic.replaceChildren();
  if (!b || !s) return;
  w.title.append(b.type === 'status' ? s.info.name : b.name);
  if (b.type === 'channel') w.title.append(el('span', 'count', `[${b.nicks.length}]`));
  if (b.type === 'status') w.topic.textContent = s.info.sid === LOCAL ? 'Consola' : stateLabel(s.info.state);
  else appendFormatted(w.topic, b.topic);
  w.topic.title = stripFormatting(b.topic);
  w.mynick.textContent = s.info.sid === LOCAL ? settings.nick : s.info.nick;
}

function renderNicks(w: Win | undefined = winOf(active.sid, active.buffer)): void {
  if (!w) return;
  const b = getBuffer(w.sid, w.name);
  const pane = w.nicks;
  pane.hidden = !b || b.type !== 'channel';
  pane.replaceChildren();
  if (!b || b.type !== 'channel') return;
  pane.append(el('div', 'count', `${b.nicks.length} ${b.nicks.length === 1 ? 'usuario' : 'usuarios'}`));
  for (const n of b.nicks) {
    const row = el('button', 'nick-row');
    row.type = 'button';
    row.append(el('span', 'pfx', n.prefix[0] ?? ''), document.createTextNode(n.nick));
    row.style.color = nickColor(n.nick);
    row.addEventListener('dblclick', () => send(`/query ${n.nick}`));
    const menu = (e: MouseEvent) => {
      e.preventDefault();
      void nickMenu(e.clientX, e.clientY, n.nick);
    };
    row.addEventListener('contextmenu', menu);
    row.addEventListener('click', menu);
    pane.append(row);
  }
}

interface ScriptMenuEntry {
  label: string;
  id?: string;
  separator?: boolean;
  children?: ScriptMenuEntry[];
}

/** Convierte los popups de los scripts en elementos de menú; los submenús se muestran sangrados bajo su título. */
async function scriptItems(nick?: string): Promise<MenuItem[]> {
  const { sid, buffer } = active;
  let entries: ScriptMenuEntry[] = [];
  try {
    entries = await window.onda.invoke<ScriptMenuEntry[]>('menu:get', sid, buffer, nick);
  } catch {
    return [];
  }
  const out: MenuItem[] = [];
  const walk = (list: ScriptMenuEntry[], depth: number) => {
    for (const e of list) {
      const pad = '\u2003'.repeat(depth);
      if (e.separator) out.push(null);
      else if (e.children) {
        out.push([pad + e.label, null]);
        walk(e.children, depth + 1);
      } else if (e.id) out.push([pad + e.label, () => window.onda.invoke('menu:run', e.id, sid, buffer, nick)]);
    }
  };
  walk(entries, 0);
  return out;
}

async function nickMenu(x: number, y: number, nick: string): Promise<void> {
  const sid = active.sid;
  const extra = await scriptItems(nick);
  const inChan = activeBuffer()?.type === 'channel';
  showMenu(x, y, [
    ['Conversación privada', () => send(`/query ${nick}`)],
    ['Información (whois)', () => send(`/whois ${nick}`)],
    ['Mencionar', () => insertText(nick + ': ')],
    [settings.ignore.some((m) => m.toLowerCase() === nick.toLowerCase()) ? 'Dejar de ignorar' : 'Ignorar', () =>
      send(`/${settings.ignore.some((m) => m.toLowerCase() === nick.toLowerCase()) ? 'unignore' : 'ignore'} ${nick}`)],
    null,
    ...(inChan
      ? ([
          ['Dar op', () => send(`/op ${nick}`)],
          ['Quitar op', () => send(`/deop ${nick}`)],
          ['Dar voz', () => send(`/voice ${nick}`)],
          ['Expulsar', () => send(`/kick ${nick}`)],
          null,
        ] as MenuItem[])
      : []),
    ['Enviar archivo…', () => window.onda.invoke('dcc:send', sid, nick)],
    ['Enviar archivo (modo pasivo)…', () => window.onda.invoke('dcc:send', sid, nick, true)],
    ['Chat directo (DCC)', () => window.onda.invoke('dcc:chat', sid, nick)],
    ...(extra.length ? [null, ...extra] : []),
  ]);
}

type MenuItem = [string, (() => unknown) | null] | null;

function showMenu(x: number, y: number, items: MenuItem[]): void {
  const menu = $('context-menu');
  menu.replaceChildren();
  for (const it of items) {
    if (!it) {
      menu.append(el('hr'));
      continue;
    }
    const action = it[1];
    if (!action) {
      menu.append(el('div', 'menu-title', it[0]));
      continue;
    }
    const b = el('button', '', it[0]);
    b.type = 'button';
    b.addEventListener('click', () => {
      menu.hidden = true;
      void action();
    });
    menu.append(b);
  }
  menu.hidden = false;
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.max(4, Math.min(x, window.innerWidth - r.width - 4)) + 'px';
  menu.style.top = Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) + 'px';
  (menu.querySelector('button') as HTMLElement | null)?.focus();
}

function appendFormatted(parent: HTMLElement, text: string): void {
  for (const seg of parseFormatting(text)) {
    const span = el('span');
    if (seg.bold) span.style.fontWeight = '700';
    if (seg.italic) span.style.fontStyle = 'italic';
    const deco = [seg.underline ? 'underline' : '', seg.strike ? 'line-through' : ''].filter(Boolean).join(' ');
    if (deco) span.style.textDecoration = deco;
    if (seg.mono) span.style.fontFamily = 'var(--mono)';
    let fg = seg.fg !== undefined ? MIRC_COLORS[seg.fg % 16] : '';
    let bg = seg.bg !== undefined ? MIRC_COLORS[seg.bg % 16] : '';
    if (seg.reverse) [fg, bg] = [bg || 'var(--bg)', fg || 'var(--text)'];
    if (fg) span.style.color = fg;
    if (bg) span.style.backgroundColor = bg;
    // Enlaces: solo http(s), y siempre se abren fuera de la aplicación.
    const re = /https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(seg.text))) {
      if (m.index > last) span.append(seg.text.slice(last, m.index));
      const a = el('a', '', m[0]);
      a.href = m[0];
      a.target = '_blank';
      a.rel = 'noreferrer noopener';
      span.append(a);
      last = m.index + m[0].length;
    }
    if (last < seg.text.length) span.append(seg.text.slice(last));
    parent.append(span);
  }
}

const RELAY_NETWORKS: Record<string, string> = { tg: 'Telegram', wa: 'WhatsApp' };

/** Los puentes (relaymsg) usan nicks «Nombre/red», p. ej. «Ana/tg» para Telegram. */
function splitRelay(nick: string): { name: string; network: string } {
  const i = nick.lastIndexOf('/');
  if (i <= 0 || i === nick.length - 1) return { name: nick, network: '' };
  const label = nick.slice(i + 1);
  return { name: nick.slice(0, i), network: RELAY_NETWORKS[label.toLowerCase()] ?? label };
}

let findQuery = '';

function matchesFind(line: Line): boolean {
  return !findQuery || `${line.nick ?? ''} ${stripFormatting(line.text)}`.toLowerCase().includes(findQuery);
}

function lineRow(b: BufferState, line: Line): HTMLElement {
  const row = el('div', `row ${line.kind}`);
  if (findQuery && matchesFind(line)) row.classList.add('match');
  if (line.highlight) row.classList.add('highlight');
  if (line.self) row.classList.add('self');
  if (line.history) row.classList.add('history');
  const d = new Date(line.time);
  const time = el('span', 'time', `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`);
  time.title = d.toLocaleString();
  row.append(time);
  if (line.nick && (line.kind === 'msg' || line.kind === 'notice')) {
    const relay = splitRelay(line.nick);
    const nick = el('span', 'nick', (line.prefix ?? '') + relay.name);
    nick.style.color = nickColor(line.nick);
    if (relay.network) {
      nick.classList.add('relayed');
      nick.title = `${relay.name}, desde ${relay.network}`;
      nick.append(el('span', 'net-tag', relay.network));
    } else nick.addEventListener('click', (e) => void nickMenu(e.clientX, e.clientY, line.nick!));
    row.append(nick);
  }
  const body = el('span', 'body');
  if (line.kind === 'action') body.append(`* ${splitRelay(line.nick ?? '').name} `);
  else if (line.kind !== 'msg' && line.kind !== 'notice' && line.kind !== 'echo') body.append('· ');
  appendFormatted(body, line.text);
  if (line.msgid) {
    row.dataset.msgid = line.msgid;
    for (const r of b.reactions.get(line.msgid) ?? []) body.append(el('span', 'react', r));
  }
  row.append(body);
  return row;
}

function renderLog(w: Win | undefined = winOf(active.sid, active.buffer)): void {
  if (!w) return;
  const b = getBuffer(w.sid, w.name);
  w.log.replaceChildren();
  if (!b) return;
  if (!b.lines.length) w.log.append(el('div', 'empty', 'Aún no hay mensajes aquí.'));
  const frag = document.createDocumentFragment();
  for (const l of b.lines) frag.append(lineRow(b, l));
  w.log.append(frag);
  w.log.scrollTop = w.log.scrollHeight;
}

function renderTyping(w: Win | undefined = winOf(active.sid, active.buffer)): void {
  if (!w) return;
  const b = getBuffer(w.sid, w.name);
  const names = b ? [...b.typing.keys()] : [];
  w.typing.textContent = !names.length
    ? ''
    : names.length === 1
      ? `${names[0]} está escribiendo…`
      : names.length <= 3
        ? `${names.join(', ')} están escribiendo…`
        : 'Varias personas están escribiendo…';
}

function applySettings(): void {
  document.documentElement.dataset.theme = settings.theme;
  document.documentElement.dataset.layout = settings.layout;
  document.documentElement.style.setProperty('--size', settings.fontSize + 'px');
  desktop.classList.toggle('no-times', !settings.showTimestamps);
}

function renderDcc(): void {
  const list = $('dcc-list');
  list.replaceChildren();
  const pending = [...dccs.values()].filter((d) => d.status === 'offered').length;
  const badge = $('dcc-badge');
  badge.hidden = pending === 0;
  badge.textContent = String(pending);
  if (!dccs.size) list.append(el('div', 'empty', 'No hay transferencias. Para enviar un archivo, haz clic en un nick y elige «Enviar archivo…».'));
  const status: Record<DccInfo['status'], string> = {
    offered: 'pendiente de aceptar', waiting: 'esperando al destinatario', active: 'en curso', done: 'completado', failed: 'fallido', rejected: 'cancelado',
  };
  for (const d of [...dccs.values()].reverse()) {
    const row = el('div', 'dcc');
    const what = el('div', 'what');
    const dir = d.direction === 'in' ? `de ${d.nick}` : `para ${d.nick}`;
    what.append(el('div', '', d.type === 'SEND' ? `${d.filename} (${fmtSize(d.size)}) ${dir}` : `Chat directo ${d.direction === 'in' ? 'solicitado por' : 'con'} ${d.nick}`));
    what.append(el('div', 'sub', status[d.status] + (d.error ? `: ${d.error}` : '')));
    if (d.type === 'SEND' && d.status === 'active' && d.size) {
      const p = el('progress');
      p.max = d.size;
      p.value = d.transferred;
      what.append(p);
    }
    row.append(what);
    const btn = (label: string, cls: string, fn: () => unknown) => {
      const b = el('button', cls, label);
      b.type = 'button';
      b.addEventListener('click', () => void fn());
      row.append(b);
    };
    if (d.status === 'offered') {
      btn('Aceptar', 'primary', () => window.onda.invoke('dcc:accept', d.id));
      btn('Rechazar', '', () => window.onda.invoke('dcc:reject', d.id));
    } else if (d.status === 'active' || d.status === 'waiting') btn('Cancelar', '', () => window.onda.invoke('dcc:reject', d.id));
    else if (d.status === 'done' && d.path) btn('Mostrar en carpeta', '', () => window.onda.invoke('dcc:reveal', d.id));
    list.append(row);
  }
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

// ---------------------------------------------------- diálogos de scripts

const openDialogs = new Map<string, { root: HTMLElement; controls: Map<number, HTMLElement> }>();

function dialogSend(name: string, event: string, id: number, value?: { text?: string; checked?: boolean; sel?: number }): void {
  void window.onda.invoke('dialog:event', name, event, id, value);
}

/** Crea o actualiza la ventana de un diálogo de script; con `view` nulo la cierra. */
function syncDialog(name: string, view: DialogView | null): void {
  const k = key(name);
  let entry = openDialogs.get(k);
  if (!view) {
    entry?.root.remove();
    openDialogs.delete(k);
    return;
  }
  // Las tablas en «dbu» usan unidades de diálogo: aproximadamente 2 px por unidad.
  const scale = view.dbu ? 2 : 1;
  if (!entry) {
    const root = el('section', 'msl-dialog');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', view.title);
    const bar = el('header');
    const title = el('span', 'title', view.title);
    const close = el('button', 'x', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Cerrar');
    close.addEventListener('click', () => dialogSend(view.name, 'close', 0));
    bar.append(title, close);
    const body = el('div', 'body');
    body.style.width = view.w * scale + 'px';
    body.style.height = view.h * scale + 'px';
    root.append(bar, body);
    const offset = openDialogs.size * 24;
    root.style.left = `max(8px, calc(50% - ${(view.w * scale) / 2}px + ${offset}px))`;
    root.style.top = `${90 + offset}px`;
    // Arrastrar por la barra de título
    bar.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('button')) return;
      const r = root.getBoundingClientRect();
      const dx = e.clientX - r.left;
      const dy = e.clientY - r.top;
      const move = (m: PointerEvent) => {
        root.style.left = Math.max(0, Math.min(window.innerWidth - 60, m.clientX - dx)) + 'px';
        root.style.top = Math.max(0, Math.min(window.innerHeight - 30, m.clientY - dy)) + 'px';
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
    entry = { root, controls: new Map() };
    openDialogs.set(k, entry);
    let strip: HTMLElement | null = null;
    for (const c of view.controls) {
      const node = makeDialogControl(view.name, c);
      if (c.type === 'tab') {
        // Todas las pestañas comparten una tira situada donde indica la primera.
        if (!strip) {
          strip = el('div', 'ctl tabs');
          strip.setAttribute('role', 'tablist');
          strip.style.left = c.x * scale + 'px';
          strip.style.top = c.y * scale + 'px';
          body.append(strip);
        }
        node.classList.add('tab');
        entry.controls.set(c.id, node);
        strip.append(node);
        continue;
      }
      node.classList.add('ctl', 'ctl-' + c.type);
      node.style.left = c.x * scale + 'px';
      node.style.top = c.y * scale + 'px';
      node.style.width = c.w * scale + 'px';
      if (c.type !== 'combo' && c.type !== 'check' && c.type !== 'radio') node.style.height = c.h * scale + 'px';
      entry.controls.set(c.id, node);
      body.append(node);
    }
    $('script-dialogs').append(root);
  }
  entry.root.querySelector('.title')!.textContent = view.title;
  const activeTab = view.controls.find((c) => c.type === 'tab' && c.checked)?.id;
  for (const c of view.controls) {
    const node = entry.controls.get(c.id);
    if (!node) continue;
    updateDialogControl(node, c);
    // Un control con estilo `tab N` solo se ve cuando la pestaña N está seleccionada.
    const owner = c.styles.indexOf('tab');
    if (c.type !== 'tab' && owner !== -1 && activeTab !== undefined && Number(c.styles[owner + 1]) !== activeTab) node.hidden = true;
  }
}

function makeDialogControl(dname: string, c: DialogControlView): HTMLElement {
  switch (c.type) {
    case 'edit': {
      const multi = c.styles.includes('multi');
      const e = multi ? el('textarea') : el('input');
      if (!multi && c.styles.includes('pass')) (e as HTMLInputElement).type = 'password';
      if (c.styles.includes('read')) e.readOnly = true;
      e.addEventListener('input', () => dialogSend(dname, 'edit', c.id, { text: e.value }));
      return e;
    }
    case 'button': {
      const b = el('button');
      b.type = 'button';
      if (c.styles.includes('default') || c.styles.includes('ok')) b.classList.add('primary');
      b.addEventListener('click', () => dialogSend(dname, 'sclick', c.id));
      return b;
    }
    case 'check':
    case 'radio': {
      const label = el('label');
      const box = el('input');
      box.type = c.type === 'check' ? 'checkbox' : 'radio';
      box.addEventListener('change', () => dialogSend(dname, 'sclick', c.id, { checked: box.checked }));
      label.append(box, el('span'));
      return label;
    }
    case 'list': {
      const sel = el('select');
      sel.size = 4;
      sel.addEventListener('change', () => dialogSend(dname, 'sclick', c.id, { sel: sel.selectedIndex + 1 }));
      sel.addEventListener('dblclick', () => dialogSend(dname, 'dclick', c.id, { sel: sel.selectedIndex + 1 }));
      return sel;
    }
    case 'combo': {
      const sel = el('select');
      sel.addEventListener('change', () => dialogSend(dname, 'sclick', c.id, { sel: sel.selectedIndex + 1 }));
      return sel;
    }
    case 'box':
      return el('fieldset');
    case 'tab': {
      const b = el('button');
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.addEventListener('click', () => dialogSend(dname, 'sclick', c.id));
      return b;
    }
    default:
      return el('div');
  }
}

function updateDialogControl(node: HTMLElement, c: DialogControlView): void {
  node.hidden = !c.visible;
  const setDisabled = (e: Element) => ((e as HTMLInputElement).disabled = !c.enabled);
  if (c.type === 'edit') {
    const e = node as HTMLInputElement;
    if (e.value !== c.text) e.value = c.text;
    setDisabled(e);
  } else if (c.type === 'tab') {
    node.textContent = c.text.replace(/&/g, '');
    node.classList.toggle('selected', c.checked);
    node.setAttribute('aria-selected', String(c.checked));
    setDisabled(node);
  } else if (c.type === 'button') {
    node.textContent = c.text.replace(/&/g, '');
    setDisabled(node);
  } else if (c.type === 'check' || c.type === 'radio') {
    const box = node.querySelector('input')!;
    box.checked = c.checked;
    setDisabled(box);
    node.querySelector('span')!.textContent = c.text.replace(/&/g, '');
  } else if (c.type === 'list' || c.type === 'combo') {
    const sel = node as HTMLSelectElement;
    const current = [...sel.options].map((o) => o.textContent);
    if (current.length !== c.lines.length || current.some((t, i) => t !== c.lines[i])) {
      sel.replaceChildren(...c.lines.map((l) => el('option', '', l)));
    }
    sel.selectedIndex = c.sel - 1;
    setDisabled(sel);
  } else if (c.type === 'box') {
    node.replaceChildren(el('legend', '', c.text));
  } else node.textContent = c.text;
}

// ----------------------------------------------------------------- eventos

function onUi(ev: UiEvent): void {
  switch (ev.type) {
    case 'session': {
      ensureSession({ sid: ev.sid, name: ev.name, state: ev.state, nick: ev.nick });
      renderTree();
      for (const w of wins.values()) if (w.sid === ev.sid) renderHeader(w);
      break;
    }
    case 'session:remove':
      for (const w of [...wins.values()]) if (w.sid === ev.sid) removeWin(w.sid, w.name);
      sessions.delete(ev.sid);
      if (active.sid === ev.sid) activate(LOCAL, STATUS);
      else renderTree();
      break;
    case 'buffer:add':
      ensureWin(ev.sid, getBuffer(ev.sid, ev.buffer, ev.bufferType)!);
      renderTree();
      break;
    case 'buffer:remove':
      removeWin(ev.sid, ev.buffer);
      sessions.get(ev.sid)?.buffers.delete(key(ev.buffer));
      if (isActive(ev.sid, ev.buffer)) activate(ev.sid, STATUS);
      else renderTree();
      break;
    case 'buffer:clear': {
      const b = getBuffer(ev.sid, ev.buffer);
      if (b) b.lines = [];
      renderLog(winOf(ev.sid, ev.buffer));
      break;
    }
    case 'activate':
      activate(ev.sid, ev.buffer);
      break;
    case 'line': {
      const b = getBuffer(ev.sid, ev.buffer) ?? getBuffer(ev.sid, STATUS) ?? getBuffer(LOCAL, STATUS)!;
      const sid = getBuffer(ev.sid, ev.buffer) || getBuffer(ev.sid, STATUS) ? ev.sid : LOCAL;
      b.lines.push(ev.line);
      if (b.lines.length > MAX_LINES) b.lines.splice(0, b.lines.length - MAX_LINES);
      const lw = winOf(sid, b.name);
      if (lw) {
        const wl = lw.log;
        const atBottom = wl.scrollHeight - wl.scrollTop - wl.clientHeight < 60;
        wl.querySelector('.empty')?.remove();
        wl.append(lineRow(b, ev.line));
        while (wl.childElementCount > MAX_LINES) wl.firstElementChild!.remove();
        if (findQuery && isActive(sid, b.name)) $('find-count').textContent = `${b.lines.filter(matchesFind).length} coincidencias`;
        if (atBottom || ev.line.self) wl.scrollTop = wl.scrollHeight;
      }
      const counts = ['msg', 'action', 'notice'].includes(ev.line.kind) && !ev.line.self && !ev.line.history;
      if (counts && (!isActive(sid, b.name) || !document.hasFocus())) {
        if (!isActive(sid, b.name)) {
          b.unread++;
          if (ev.line.highlight) b.highlight = true;
          renderTree();
        }
        if (ev.line.highlight && settings.notifications && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
          const n = new Notification(`${ev.line.nick ?? ''} en ${b.name}`, { body: stripFormatting(ev.line.text).slice(0, 200), silent: false });
          n.onclick = () => {
            window.focus();
            activate(sid, b.name);
          };
        }
      }
      break;
    }
    case 'nicks': {
      const b = getBuffer(ev.sid, ev.buffer);
      if (b) b.nicks = ev.nicks;
      renderNicks(winOf(ev.sid, ev.buffer));
      renderHeader(winOf(ev.sid, ev.buffer));
      break;
    }
    case 'topic': {
      const b = getBuffer(ev.sid, ev.buffer);
      if (b) b.topic = ev.topic;
      renderHeader(winOf(ev.sid, ev.buffer));
      break;
    }
    case 'typing': {
      const b = getBuffer(ev.sid, ev.buffer);
      if (!b) break;
      window.clearTimeout(b.typing.get(ev.nick));
      b.typing.delete(ev.nick);
      if (ev.state === 'active' || ev.state === 'paused') {
        b.typing.set(ev.nick, window.setTimeout(() => {
          b.typing.delete(ev.nick);
          renderTyping(winOf(ev.sid, ev.buffer));
        }, ev.state === 'active' ? 6000 : 30000));
      }
      renderTyping(winOf(ev.sid, ev.buffer));
      break;
    }
    case 'react': {
      const b = getBuffer(ev.sid, ev.buffer);
      if (!b || !ev.msgid) break;
      const list = b.reactions.get(ev.msgid) ?? [];
      list.push(ev.emoji);
      b.reactions.set(ev.msgid, list);
      const rw = winOf(ev.sid, ev.buffer);
      if (rw) {
        const row = [...rw.log.querySelectorAll<HTMLElement>('.row')].find((r) => r.dataset.msgid === ev.msgid);
        row?.querySelector('.body')?.append(el('span', 'react', ev.emoji));
      }
      break;
    }
    case 'dialog':
      syncDialog(ev.name, ev.view);
      break;
    case 'chanlist':
      chanLists.set(ev.sid, ev.channels);
      if (listSid === ev.sid) renderChanList();
      break;
    case 'dcc':
      dccs.set(ev.dcc.id, ev.dcc);
      renderDcc();
      break;
    case 'scripts':
      if ($<HTMLDialogElement>('dlg-scripts').open) void loadScripts(false);
      break;
    case 'settings':
      settings = ev.settings;
      applySettings();
      for (const w of wins.values()) {
        renderHeader(w);
        renderLog(w);
        renderNicks(w);
      }
      break;
  }
}

// ----------------------------------------------------------------- entrada

function send(text: string): void {
  void window.onda.invoke('input', active.sid, active.buffer, text);
}

function insertText(text: string): void {
  input.setRangeText(text, input.selectionStart, input.selectionEnd, 'end');
  input.focus();
  autosize();
}

function autosize(): void {
  input.style.height = 'auto';
  input.style.height = Math.min(140, input.scrollHeight + 2) + 'px';
  input.style.overflowY = input.scrollHeight > 140 ? 'auto' : 'hidden';
}

let typingSent = 0;
function notifyTyping(state: 'active' | 'done'): void {
  const b = activeBuffer();
  if (!b || b.type === 'status' || b.type === 'dcc' || !settings.sendTyping) return;
  if (state === 'active') {
    if (Date.now() - typingSent < 3000) return;
    typingSent = Date.now();
  } else {
    if (!typingSent) return;
    typingSent = 0;
  }
  void window.onda.invoke('typing', active.sid, active.buffer, state);
}

let completion: { start: number; matches: string[]; index: number; base: string } | null = null;

function tabComplete(): void {
  const pos = input.selectionStart;
  if (!completion) {
    const before = input.value.slice(0, pos);
    const m = /(\S+)$/.exec(before);
    if (!m) return;
    const word = m[1].toLowerCase();
    const b = activeBuffer();
    const s = sessions.get(active.sid);
    const pool = word.startsWith('#')
      ? [...(s?.buffers.values() ?? [])].filter((x) => x.type === 'channel').map((x) => x.name)
      : word.startsWith('/')
        ? ['/join', '/part', '/msg', '/query', '/me', '/nick', '/topic', '/kick', '/op', '/deop', '/voice', '/whois', '/away', '/server', '/quit', '/dcc', '/load', '/help', '/clear', '/notice', '/mode', '/ctcp']
        : (b?.nicks ?? []).map((n) => n.nick);
    const matches = pool.filter((x) => x.toLowerCase().startsWith(word));
    if (!matches.length) return;
    completion = { start: pos - m[1].length, matches, index: 0, base: input.value.slice(pos) };
  } else completion.index = (completion.index + 1) % completion.matches.length;
  const pick = completion.matches[completion.index];
  const suffix = completion.start === 0 && !/^[#/]/.test(pick) ? ': ' : ' ';
  input.value = input.value.slice(0, completion.start) + pick + suffix + completion.base;
  const caret = completion.start + pick.length + suffix.length;
  input.setSelectionRange(caret, caret);
}

/** Teclado de la línea de escritura de una ventana: enviar, historial, completado y aviso de escritura. */
function attachInput(w: Win): void {
  const box = w.input;
  box.addEventListener('focus', () => {
    if (!isActive(w.sid, w.name)) activate(w.sid, w.name, false);
  });
  box.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') completion = null;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const text = box.value;
      if (!text.trim()) return;
      history.unshift(text);
      if (history.length > 200) history.pop();
      historyPos = -1;
      box.value = '';
      autosize();
      notifyTyping('done');
      send(text);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      tabComplete();
    } else if (e.key === 'ArrowUp' && !box.value.includes('\n') && historyPos < history.length - 1) {
      e.preventDefault();
      box.value = history[++historyPos];
      autosize();
    } else if (e.key === 'ArrowDown' && historyPos >= 0 && !box.value.includes('\n')) {
      e.preventDefault();
      historyPos--;
      box.value = historyPos >= 0 ? history[historyPos] : '';
      autosize();
    }
  });
  box.addEventListener('input', () => {
    autosize();
    if (box.value && !box.value.startsWith('/')) notifyTyping('active');
    else notifyTyping('done');
  });
}

document.addEventListener('click', (e) => {
  const menu = $('context-menu');
  if (!menu.hidden && !menu.contains(e.target as Node) && !(e.target as HTMLElement).closest('.nick-row, .row .nick')) menu.hidden = true;
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') $('context-menu').hidden = true;
  // Alt+flechas: cambiar de ventana
  if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault();
    const all: { sid: string; buffer: string }[] = [];
    for (const s of sessions.values()) for (const b of s.buffers.values()) all.push({ sid: s.info.sid, buffer: b.name });
    const i = all.findIndex((x) => isActive(x.sid, x.buffer));
    const next = all[(i + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length];
    if (next) activate(next.sid, next.buffer);
  }
});

// ---------------------------------------------------------------- diálogos

function dialog(id: string): HTMLDialogElement {
  return $<HTMLDialogElement>(id);
}
document.querySelectorAll<HTMLButtonElement>('dialog .close').forEach((b) =>
  b.addEventListener('click', (e) => {
    e.preventDefault();
    b.closest('dialog')!.close();
  }),
);

// Conectar
function fillConnect(n: Partial<NetworkConfig>): void {
  const f = $<HTMLFormElement>('connect-form');
  const set = (name: string, v: string | boolean) => {
    const i = f.elements.namedItem(name) as HTMLInputElement;
    if (i.type === 'checkbox') i.checked = !!v;
    else i.value = String(v ?? '');
  };
  set('name', n.name ?? '');
  set('host', n.host ?? '');
  set('port', String(n.port ?? 6697));
  set('tls', n.tls ?? true);
  set('nick', n.nick || settings.nick);
  set('autojoin', (n.autojoin ?? []).join(', '));
  set('saslAccount', n.saslAccount ?? '');
  set('saslPassword', n.saslPassword ?? '');
  set('password', n.password ?? '');
  set('allowInvalidCert', n.allowInvalidCert ?? false);
  set('autoconnect', n.autoconnect ?? false);
  (f.elements.namedItem('perform') as HTMLTextAreaElement).value = (n.perform ?? []).join('\n');
}

function renderSaved(): void {
  const box = $('saved-networks');
  box.replaceChildren();
  for (const n of networks) {
    const chip = el('span', 'chip');
    const pick = el('button', '', n.name);
    pick.type = 'button';
    pick.title = `${n.host}:${n.port}`;
    pick.addEventListener('click', () => fillConnect(n));
    const x = el('button', 'x', '×');
    x.type = 'button';
    x.setAttribute('aria-label', `Olvidar ${n.name}`);
    x.addEventListener('click', async () => {
      await window.onda.invoke('network:remove', n.name);
      networks = networks.filter((k) => k.name !== n.name);
      renderSaved();
    });
    chip.append(pick, x);
    box.append(chip);
  }
}

$('btn-connect').addEventListener('click', () => {
  fillConnect(networks[0] ?? { name: 'RogerNet', host: 'irc.rogertp.es', autojoin: ['#general'] });
  renderSaved();
  dialog('dlg-connect').showModal();
});
($<HTMLFormElement>('connect-form').elements.namedItem('tls') as HTMLInputElement).addEventListener('change', (e) => {
  const port = $<HTMLFormElement>('connect-form').elements.namedItem('port') as HTMLInputElement;
  const on = (e.target as HTMLInputElement).checked;
  if (on && port.value === '6667') port.value = '6697';
  if (!on && port.value === '6697') port.value = '6667';
});
$('connect-form').addEventListener('submit', async () => {
  const f = new FormData($<HTMLFormElement>('connect-form'));
  const str = (k: string) => String(f.get(k) ?? '').trim();
  const cfg: NetworkConfig = {
    name: str('name') || str('host'),
    host: str('host'),
    port: Number(str('port')) || 6697,
    tls: f.has('tls'),
    nick: str('nick'),
    autojoin: str('autojoin').split(/[\s,]+/).filter(Boolean).map((c) => (/^[#&]/.test(c) ? c : '#' + c)),
    saslAccount: str('saslAccount') || undefined,
    saslPassword: String(f.get('saslPassword') ?? '') || undefined,
    password: String(f.get('password') ?? '') || undefined,
    allowInvalidCert: f.has('allowInvalidCert'),
    autoconnect: f.has('autoconnect'),
    perform: String(f.get('perform') ?? '').split('\n').map((l) => l.trim()).filter(Boolean),
  };
  if (f.has('save')) networks = [...networks.filter((n) => n.name !== cfg.name), cfg];
  await window.onda.invoke('connect', cfg, f.has('save'));
});

// Ajustes
$('btn-settings').addEventListener('click', () => {
  const f = $<HTMLFormElement>('settings-form');
  for (const [k, v] of Object.entries(settings)) {
    const i = f.elements.namedItem(k) as HTMLInputElement | null;
    if (!i) continue;
    if (i.type === 'checkbox') i.checked = !!v;
    else i.value = String(v);
  }
  dialog('dlg-settings').showModal();
});
$('settings-form').addEventListener('submit', async () => {
  const f = new FormData($<HTMLFormElement>('settings-form'));
  const wantsNotif = f.has('notifications');
  if (wantsNotif && typeof Notification !== 'undefined' && Notification.permission === 'default') await Notification.requestPermission();
  await window.onda.invoke('settings:update', {
    nick: String(f.get('nick')).trim() || settings.nick,
    realname: String(f.get('realname')),
    quitMessage: String(f.get('quitMessage')),
    theme: String(f.get('theme')) as Settings['theme'],
    layout: String(f.get('layout')) === 'modern' ? 'modern' : 'classic',
    fontSize: Math.min(24, Math.max(10, Number(f.get('fontSize')) || 14)),
    showTimestamps: f.has('showTimestamps'),
    logging: f.has('logging'),
    notifications: wantsNotif,
    sendTyping: f.has('sendTyping'),
  } satisfies Partial<Settings>);
});

// Scripts
let scripts: ScriptInfo[] = [];
let currentScript = '';
const EXAMPLE = `; Ejemplo: responde a "!hola" en cualquier canal
on *:TEXT:!hola*:#:{
  msg $chan ¡Hola, $nick $+ !
}

; Alias: escribe /saluda nick
alias saluda {
  me saluda a $1
}
`;

function showScript(s: { name: string; source: string; warnings: string[] } | null): void {
  currentScript = s?.name ?? '';
  $<HTMLInputElement>('script-name').value = s?.name ?? 'nuevo.mrc';
  $<HTMLTextAreaElement>('script-source').value = s?.source ?? EXAMPLE;
  scriptStatus(s?.warnings ?? []);
  $('script-list').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.textContent === currentScript));
}

function scriptStatus(warnings: string[], ok = ''): void {
  const st = $('script-status');
  st.className = warnings.length ? 'warn' : '';
  st.textContent = warnings.length ? 'Avisos:\n' + warnings.map((w) => '· ' + w).join('\n') : ok;
}

async function loadScripts(reset = true): Promise<void> {
  scripts = await window.onda.invoke<ScriptInfo[]>('scripts:list');
  const list = $('script-list');
  list.replaceChildren();
  for (const s of scripts) {
    const b = el('button', s.name === currentScript ? 'active' : '', s.name);
    b.type = 'button';
    b.addEventListener('click', () => showScript(s));
    list.append(b);
  }
  if (reset) showScript(scripts.find((s) => s.name === currentScript) ?? scripts[0] ?? null);
}

$('btn-scripts').addEventListener('click', async () => {
  await loadScripts();
  dialog('dlg-scripts').showModal();
});
$('script-new').addEventListener('click', () => showScript(null));
$('script-save').addEventListener('click', async () => {
  const name = $<HTMLInputElement>('script-name').value.trim();
  if (!name) return;
  const saved = await window.onda.invoke<ScriptInfo>('scripts:save', name, $<HTMLTextAreaElement>('script-source').value);
  currentScript = saved.name;
  await loadScripts(false);
  $<HTMLInputElement>('script-name').value = saved.name;
  scriptStatus(saved.warnings, `Guardado y cargado: ${saved.name}`);
});
$('script-delete').addEventListener('click', async () => {
  if (!currentScript) return;
  await window.onda.invoke('scripts:delete', currentScript);
  currentScript = '';
  await loadScripts();
});
$<HTMLTextAreaElement>('script-source').addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    e.preventDefault();
    const t = e.target as HTMLTextAreaElement;
    t.setRangeText('  ', t.selectionStart, t.selectionEnd, 'end');
  }
});

// Barra de menús y opciones de «Ver» (se recuerdan en este equipo)
const view = { tree: true, nicks: true, switchbar: true, toolbar: true };
try {
  Object.assign(view, JSON.parse(localStorage.getItem('onda.ver') ?? '{}'));
} catch {
  /* sin preferencias guardadas */
}
function applyView(): void {
  document.body.classList.toggle('hide-tree', !view.tree);
  document.body.classList.toggle('hide-nicks', !view.nicks);
  document.body.classList.toggle('hide-switchbar', !view.switchbar);
  document.body.classList.toggle('hide-toolbar', !view.toolbar);
  try {
    localStorage.setItem('onda.ver', JSON.stringify(view));
  } catch {
    /* almacenamiento no disponible */
  }
}
applyView();

function menuItems(name: string): MenuItem[] {
  const tick = (on: boolean, label: string) => (on ? '✓ ' : '\u2003 ') + label;
  const toggle = (k: keyof typeof view, label: string): MenuItem => [tick(view[k], label), () => {
    view[k] = !view[k];
    applyView();
  }];
  const click = (id: string) => () => $(id).click();
  switch (name) {
    case 'archivo':
      return [
        ['Conectar…', click('btn-connect')],
        ['Desconectar', () => send('/disconnect')],
        ['Reconectar', () => send('/reconnect')],
        null,
        ['Cerrar ventana', () => active.sid !== LOCAL || active.buffer.startsWith('@') ? window.onda.invoke('closeBuffer', active.sid, active.buffer) : undefined],
        ['Salir', () => window.close()],
      ];
    case 'ver':
      return [
        toggle('toolbar', 'Barra de botones'),
        toggle('switchbar', 'Barra de ventanas'),
        toggle('tree', 'Árbol de redes'),
        toggle('nicks', 'Lista de nicks'),
        null,
        [tick(settings.showTimestamps, 'Mostrar la hora'), () => window.onda.invoke('settings:update', { showTimestamps: !settings.showTimestamps })],
        null,
        ...(['classic', 'dark', 'light'] as const).map((t): MenuItem => [
          tick(settings.theme === t, { classic: 'Tema clásico', dark: 'Tema oscuro', light: 'Tema claro' }[t]),
          () => window.onda.invoke('settings:update', { theme: t }),
        ]),
        null,
        [tick(settings.layout === 'classic', 'Texto compacto (estilo IRC)'), () => window.onda.invoke('settings:update', { layout: settings.layout === 'classic' ? 'modern' : 'classic' })],
      ];
    case 'herramientas':
      return [
        ['Scripts…', click('btn-scripts')],
        ['Lista de canales…', click('btn-list')],
        ['Transferencias DCC…', click('btn-dcc')],
        ['Buscar en los registros…', click('btn-logs')],
        ['Buscar en esta ventana (Ctrl+F)', () => {
          $('find').hidden = false;
          $('find-input').focus();
        }],
        null,
        ['Ajustes…', click('btn-settings')],
      ];
    case 'canal':
      return [
        ['Entrar en un canal…', () => insertText('/join #')],
        ['Lista de canales…', click('btn-list')],
        null,
        ['Salir de este canal', () => send('/part')],
        ['Cambiar el tema…', () => insertText('/topic ')],
        ['Ver quién hay (/names)', () => send('/names')],
        null,
        ['Conversación privada…', () => insertText('/query ')],
        ['Ausente…', () => insertText('/away ')],
        ['Volver (quitar ausencia)', () => send('/back')],
        ['Cambiar de nick…', () => insertText('/nick ')],
        ['Registrar mi nick…', () => insertText('/register ')],
      ];
    case 'ventana': {
      const maxed = desktop.classList.contains('maxed');
      const out: MenuItem[] = [
        ['Cascada', () => arrange('cascade')],
        ['Mosaico', () => arrange('grid')],
        ['Mosaico en columnas', () => arrange('columns')],
        ['Mosaico en filas', () => arrange('rows')],
        [maxed ? 'Restaurar' : 'Maximizar', () => setMaxed(!maxed)],
        ['Minimizar todas', () => {
          for (const w of [...wins.values()]) {
            rememberWin(w);
            w.root.classList.add('min');
          }
          renderTree();
        }],
        null,
      ];
      for (const s of sessions.values()) {
        for (const b of s.buffers.values()) {
          const label = b.type === 'status' ? s.info.name : `\u2003${b.name}`;
          out.push([(isActive(s.info.sid, b.name) ? '✓ ' : '\u2003 ') + label, () => activate(s.info.sid, b.name)]);
        }
      }
      return out;
    }
    default:
      return [
        ['Comandos (/help)', () => send('/help')],
        ['Acerca de Onda IRC', () => send('/echo -a Onda IRC · cliente IRC con scripting compatible con mIRC')],
      ];
  }
}
document.querySelectorAll<HTMLButtonElement>('#menubar button').forEach((btn) => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const r = btn.getBoundingClientRect();
    showMenu(r.left, r.bottom, menuItems(btn.dataset.menu ?? ''));
  });
});

$('btn-cascade').addEventListener('click', () => arrange('cascade'));
$('btn-tile').addEventListener('click', () => arrange('grid'));
$('btn-max').addEventListener('click', () => setMaxed(!desktop.classList.contains('maxed')));
$('btn-find').addEventListener('click', () => {
  $('find').hidden = false;
  $('find-input').focus();
});

// Búsqueda en la conversación (Ctrl+F)
function applyFind(): void {
  findQuery = $<HTMLInputElement>('find-input').value.trim().toLowerCase();
  desktop.classList.toggle('finding', !!findQuery);
  for (const w of wins.values()) renderLog(w);
  const b = activeBuffer();
  $('find-count').textContent = findQuery && b ? `${b.lines.filter(matchesFind).length} coincidencias` : '';
}
function closeFind(): void {
  $('find').hidden = true;
  $<HTMLInputElement>('find-input').value = '';
  applyFind();
  input.focus();
}
$('find-input').addEventListener('input', applyFind);
$('find-input').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeFind();
});
$('find-close').addEventListener('click', closeFind);
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    $('find').hidden = false;
    $('find-input').focus();
  }
});

// Lista de canales de la red
const chanLists = new Map<string, ChannelListEntry[]>();
let listSid = '';

function renderChanList(): void {
  const all = chanLists.get(listSid);
  const out = $('list-results');
  out.replaceChildren();
  if (!all) {
    $('list-status').textContent = 'Pidiendo la lista al servidor…';
    return;
  }
  const q = $<HTMLInputElement>('list-filter').value.trim().toLowerCase();
  const hits = q ? all.filter((c) => c.name.toLowerCase().includes(q) || c.topic.toLowerCase().includes(q)) : all;
  $('list-status').textContent = `${hits.length} de ${all.length} canales${hits.length > 500 ? ' (se muestran los 500 con más usuarios)' : ''}. Pulsa uno para entrar.`;
  for (const c of hits.slice(0, 500)) {
    const row = el('button', 'chan-row');
    row.type = 'button';
    row.append(el('span', 'n', c.name), el('span', 'u', String(c.users)), el('span', 't', stripFormatting(c.topic)));
    row.title = stripFormatting(c.topic);
    row.addEventListener('click', () => {
      void window.onda.invoke('input', listSid, STATUS, `/join ${c.name}`);
      dialog('dlg-list').close();
    });
    out.append(row);
  }
}

function requestChanList(): void {
  chanLists.delete(listSid);
  renderChanList();
  void window.onda.invoke('input', listSid, STATUS, '/list');
}

$('btn-list').addEventListener('click', () => {
  const s = sessions.get(active.sid);
  if (!s || s.info.sid === LOCAL || s.info.state !== 'connected') {
    send('/list'); // muestra el aviso de «No estás conectado» en la ventana activa
    return;
  }
  listSid = s.info.sid;
  dialog('dlg-list').showModal();
  if (chanLists.has(listSid)) renderChanList();
  else requestChanList();
});
$('list-refresh').addEventListener('click', requestChanList);
$('list-filter').addEventListener('input', renderChanList);
$('list-form').addEventListener('submit', (e) => e.preventDefault());

// Transferencias y registros
$('btn-dcc').addEventListener('click', () => {
  renderDcc();
  dialog('dlg-dcc').showModal();
});
$('btn-logs').addEventListener('click', () => {
  dialog('dlg-logs').showModal();
  $('logs-query').focus();
});
$('logs-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $<HTMLInputElement>('logs-query').value.trim();
  const out = $('logs-results');
  out.replaceChildren();
  if (!q) return;
  const hits = await window.onda.invoke<{ network: string; buffer: string; line: string }[]>('logs:search', q);
  if (!hits.length) out.append(el('div', 'empty', 'Sin resultados.'));
  for (const h of hits) {
    const row = el('div', 'hit');
    row.append(el('span', 'where', `${h.network} / ${h.buffer}`), document.createTextNode(h.line));
    out.append(row);
  }
});

// ------------------------------------------------------------------ inicio

async function start(): Promise<void> {
  const snap = await window.onda.invoke<Snapshot>('snapshot');
  settings = snap.settings;
  networks = snap.networks;
  applySettings();
  const local = ensureSession({ sid: LOCAL, name: 'Onda', state: 'local', nick: settings.nick });
  const welcome = newBuffer(STATUS, 'status');
  const now = Date.now();
  for (const text of [
    'Te damos la bienvenida a Onda IRC.',
    'Pulsa «Conectar» o escribe /server RogerNet para empezar. Con /help verás los comandos principales.',
    'Tus scripts de mIRC (.mrc) se gestionan desde «Scripts».',
  ]) welcome.lines.push({ time: now, kind: 'info', text });
  local.buffers.set(STATUS, welcome);
  ensureWin(LOCAL, welcome);
  for (const s of snap.sessions) {
    const st = ensureSession({ sid: s.sid, name: s.name, state: s.state, nick: s.nick });
    for (const b of s.buffers) {
      const buf = getBuffer(st.info.sid, b.name, b.type)!;
      buf.topic = b.topic;
      buf.nicks = b.nicks;
      ensureWin(st.info.sid, buf);
    }
  }
  for (const w of snap.windows) ensureWin(LOCAL, getBuffer(LOCAL, w, 'custom')!);
  for (const d of snap.dialogs) syncDialog(d.name, d);
  for (const d of snap.dccs) dccs.set(d.id, d);
  window.onda.onUi(onUi);
  $('btn-max').textContent = desktop.classList.contains('maxed') ? 'Restaurar' : 'Maximizar';
  activate(LOCAL, STATUS);
  renderDcc();
}

void start();
