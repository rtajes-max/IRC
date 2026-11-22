import { MIRC_COLORS, parseFormatting, stripFormatting } from '../core/irc/formatting';
import type {
  BufferType, DccInfo, Line, NetworkConfig, NickEntry, ScriptInfo, SessionInfo, Settings, Snapshot, UiEvent,
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

const log = $('log');
const input = $<HTMLTextAreaElement>('input');

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

function activate(sid: string, buffer: string): void {
  if (!getBuffer(sid, buffer)) return;
  active = { sid, buffer: getBuffer(sid, buffer)!.name };
  const b = activeBuffer()!;
  b.unread = 0;
  b.highlight = false;
  void window.onda.invoke('setActive', sid, b.name);
  renderTree();
  renderLog();
  renderHeader();
  renderNicks();
  renderTyping();
  input.focus();
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
    const order: BufferType[] = ['status', 'channel', 'query', 'dcc'];
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
        if (s.info.sid === LOCAL) return;
        showMenu(e.clientX, e.clientY, [
          [b.type === 'status' ? 'Desconectar y cerrar' : b.type === 'channel' ? 'Salir del canal' : 'Cerrar', () => window.onda.invoke('closeBuffer', s.info.sid, b.name)],
        ]);
      });
      net.append(row);
    }
    tree.append(net);
  }
}

function stateLabel(st: SessionInfo['state']): string {
  return { connecting: 'conectando', connected: 'conectado', disconnected: 'desconectado', local: 'local' }[st];
}

function renderHeader(): void {
  const b = activeBuffer();
  const s = sessions.get(active.sid);
  const topic = $('topic');
  topic.replaceChildren();
  if (!b || !s) return;
  topic.append(el('span', 'name', b.type === 'status' ? s.info.name : b.name));
  const text = el('span', 'text');
  if (b.type === 'status') text.textContent = s.info.sid === LOCAL ? 'Consola' : stateLabel(s.info.state);
  else appendFormatted(text, b.topic);
  topic.append(text);
  topic.title = stripFormatting(b.topic);
  $('my-nick').textContent = s.info.sid === LOCAL ? settings.nick : s.info.nick;
  document.title = `${b.type === 'status' ? s.info.name : b.name} · Onda IRC`;
}

function renderNicks(): void {
  const b = activeBuffer();
  const pane = $('nicks');
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

function lineRow(b: BufferState, line: Line): HTMLElement {
  const row = el('div', `row ${line.kind}`);
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

function renderLog(): void {
  const b = activeBuffer();
  log.replaceChildren();
  if (!b) return;
  if (!b.lines.length) log.append(el('div', 'empty', 'Aún no hay mensajes aquí.'));
  const frag = document.createDocumentFragment();
  for (const l of b.lines) frag.append(lineRow(b, l));
  log.append(frag);
  log.scrollTop = log.scrollHeight;
}

function renderTyping(): void {
  const b = activeBuffer();
  const names = b ? [...b.typing.keys()] : [];
  $('typing').textContent = !names.length
    ? ''
    : names.length === 1
      ? `${names[0]} está escribiendo…`
      : names.length <= 3
        ? `${names.join(', ')} están escribiendo…`
        : 'Varias personas están escribiendo…';
}

function applySettings(): void {
  document.documentElement.dataset.theme = settings.theme;
  document.documentElement.style.setProperty('--size', settings.fontSize + 'px');
  log.classList.toggle('no-times', !settings.showTimestamps);
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

// ----------------------------------------------------------------- eventos

function onUi(ev: UiEvent): void {
  switch (ev.type) {
    case 'session': {
      ensureSession({ sid: ev.sid, name: ev.name, state: ev.state, nick: ev.nick });
      renderTree();
      if (active.sid === ev.sid) renderHeader();
      break;
    }
    case 'session:remove':
      sessions.delete(ev.sid);
      if (active.sid === ev.sid) activate(LOCAL, STATUS);
      else renderTree();
      break;
    case 'buffer:add':
      getBuffer(ev.sid, ev.buffer, ev.bufferType);
      renderTree();
      break;
    case 'buffer:remove':
      sessions.get(ev.sid)?.buffers.delete(key(ev.buffer));
      if (isActive(ev.sid, ev.buffer)) activate(ev.sid, STATUS);
      else renderTree();
      break;
    case 'buffer:clear': {
      const b = getBuffer(ev.sid, ev.buffer);
      if (b) b.lines = [];
      if (isActive(ev.sid, ev.buffer)) renderLog();
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
      if (isActive(sid, b.name)) {
        const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
        log.querySelector('.empty')?.remove();
        log.append(lineRow(b, ev.line));
        while (log.childElementCount > MAX_LINES) log.firstElementChild!.remove();
        if (atBottom || ev.line.self) log.scrollTop = log.scrollHeight;
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
      if (isActive(ev.sid, ev.buffer)) renderNicks();
      break;
    }
    case 'topic': {
      const b = getBuffer(ev.sid, ev.buffer);
      if (b) b.topic = ev.topic;
      if (isActive(ev.sid, ev.buffer)) renderHeader();
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
          if (isActive(ev.sid, ev.buffer)) renderTyping();
        }, ev.state === 'active' ? 6000 : 30000));
      }
      if (isActive(ev.sid, ev.buffer)) renderTyping();
      break;
    }
    case 'react': {
      const b = getBuffer(ev.sid, ev.buffer);
      if (!b || !ev.msgid) break;
      const list = b.reactions.get(ev.msgid) ?? [];
      list.push(ev.emoji);
      b.reactions.set(ev.msgid, list);
      if (isActive(ev.sid, ev.buffer)) {
        const row = [...log.querySelectorAll<HTMLElement>('.row')].find((r) => r.dataset.msgid === ev.msgid);
        row?.querySelector('.body')?.append(el('span', 'react', ev.emoji));
      }
      break;
    }
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
      renderHeader();
      renderLog();
      renderNicks();
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

input.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab') completion = null;
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    const text = input.value;
    if (!text.trim()) return;
    history.unshift(text);
    if (history.length > 200) history.pop();
    historyPos = -1;
    input.value = '';
    autosize();
    notifyTyping('done');
    send(text);
  } else if (e.key === 'Tab') {
    e.preventDefault();
    tabComplete();
  } else if (e.key === 'ArrowUp' && !input.value.includes('\n') && historyPos < history.length - 1) {
    e.preventDefault();
    input.value = history[++historyPos];
    autosize();
  } else if (e.key === 'ArrowDown' && historyPos >= 0 && !input.value.includes('\n')) {
    e.preventDefault();
    historyPos--;
    input.value = historyPos >= 0 ? history[historyPos] : '';
    autosize();
  }
});
input.addEventListener('input', () => {
  autosize();
  if (input.value && !input.value.startsWith('/')) notifyTyping('active');
  else notifyTyping('done');
});
$('input-form').addEventListener('submit', (e) => e.preventDefault());

// Clic derecho en la conversación: popups de los scripts para canal, privado o estado.
log.addEventListener('contextmenu', async (e) => {
  if ((e.target as HTMLElement).closest('a, .nick')) return;
  e.preventDefault();
  const { clientX, clientY } = e;
  const items = await scriptItems();
  if (items.length) showMenu(clientX, clientY, items);
});

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
  for (const s of snap.sessions) {
    const st = ensureSession({ sid: s.sid, name: s.name, state: s.state, nick: s.nick });
    for (const b of s.buffers) {
      const buf = getBuffer(st.info.sid, b.name, b.type)!;
      buf.topic = b.topic;
      buf.nicks = b.nicks;
    }
  }
  for (const d of snap.dccs) dccs.set(d.id, d);
  window.onda.onUi(onUi);
  activate(LOCAL, STATUS);
  renderDcc();
}

void start();
