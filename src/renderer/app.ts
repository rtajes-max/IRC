import { stripFormatting } from '../core/irc/formatting';
import type {
  BufferType, ChannelListEntry, DccInfo, Line, NetworkConfig, NickEntry, ScriptInfo, SessionInfo, Settings, Snapshot, UiEvent,
} from '../core/types';
import { $, el, key } from './dom';
import { appendFormatted, fmtSize, nickColor, splitRelay } from './format';
import { MenuItem, showMenu } from './menu';
import { syncDialog } from './script-dialogs';
import { chanLists, dialog, listSid, loadScripts, renderChanList, renderDcc } from './dialogs';
import {
  BufferState, LOCAL, MAX_LINES, STATUS, activeBuffer, dccs, ensureSession, getBuffer, isActive, newBuffer, send, sessions, st,
} from './state';

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


function activate(sid: string, buffer: string, focus = true): void {
  const b = getBuffer(sid, buffer);
  if (!b) return;
  const w = ensureWin(sid, b);
  const changed = !isActive(sid, b.name);
  st.active = { sid, buffer: b.name };
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
  renderStatus();
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
  $('btn-max').classList.toggle('on', on);
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
  const cur = winOf(st.active.sid, st.active.buffer);
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
    const t = e.target as HTMLElement;
    if (t.closest('.nick') && !window.getSelection()?.toString()) return; // el nick tiene su propio menú
    e.preventDefault();
    const { clientX, clientY } = e;
    const selection = window.getSelection()?.toString() ?? '';
    const link = t.closest('a') as HTMLAnchorElement | null;
    const row = t.closest('.row') as HTMLElement | null;
    const copyText = (text: string) => () => window.onda.invoke('clipboard:write', text);
    const items: MenuItem[] = [];
    if (selection) items.push(['Copiar', () => window.onda.invoke('edit', 'copy')]);
    if (link) items.push(['Copiar enlace', copyText(link.href)], ['Abrir enlace', () => window.open(link.href, '_blank', 'noopener')]);
    if (row?.dataset.plain) items.push(['Copiar esta línea', copyText(row.dataset.plain)]);
    items.push(
      ['Copiar toda la conversación', copyText([...wlog.querySelectorAll<HTMLElement>('.row')].map((r) => r.dataset.plain ?? '').filter(Boolean).join('\n'))],
      ['Seleccionar todo', () => {
        const range = document.createRange();
        range.selectNodeContents(wlog);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }],
      null,
      ['Buscar…', () => $('btn-find').click()],
      ['Limpiar la ventana', () => send('/clear')],
    );
    // Popups de los scripts para canal, privado o estado
    const extra = await scriptItems();
    if (extra.length) items.push(null, ...extra);
    showMenu(clientX, clientY, items);
  });
  topic.addEventListener('contextmenu', (e) => {
    const text = stripFormatting(getBuffer(sid, b.name)?.topic ?? '');
    if (!text) return;
    e.preventDefault();
    showMenu(e.clientX, e.clientY, [['Copiar el tema', () => window.onda.invoke('clipboard:write', text)]]);
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

function renderHeader(w: Win | undefined = winOf(st.active.sid, st.active.buffer)): void {
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
  w.mynick.textContent = s.info.sid === LOCAL ? st.settings.nick : s.info.nick;
}

function renderNicks(w: Win | undefined = winOf(st.active.sid, st.active.buffer)): void {
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
  if (b.relayed.size) {
    pane.append(el('div', 'count bridge', 'Por puentes'));
    for (const [name, network] of [...b.relayed].sort((x, y) => x[0].localeCompare(y[0]))) {
      const row = el('button', 'nick-row relayed');
      row.type = 'button';
      const tag = el('span', 'net-tag', network);
      tag.dataset.net = network.toLowerCase();
      row.append(el('span', 'pfx', ''), document.createTextNode(name), tag);
      row.title = `${name}, desde ${network}. Pulsa para mencionarle.`;
      row.addEventListener('click', () => insertText(`${name}${(st.settings.nickSuffix || ':').trimEnd()} `));
      pane.append(row);
    }
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
  const { sid, buffer } = st.active;
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
  const sid = st.active.sid;
  const extra = await scriptItems(nick);
  const inChan = activeBuffer()?.type === 'channel';
  showMenu(x, y, [
    ['Conversación privada', () => send(`/query ${nick}`)],
    ['Información (whois)', () => send(`/whois ${nick}`)],
    ['Mencionar', () => insertText(nick + ': ')],
    ['Copiar el nick', () => window.onda.invoke('clipboard:write', nick)],
    [st.settings.ignore.some((m) => m.toLowerCase() === nick.toLowerCase()) ? 'Dejar de ignorar' : 'Ignorar', () =>
      send(`/${st.settings.ignore.some((m) => m.toLowerCase() === nick.toLowerCase()) ? 'unignore' : 'ignore'} ${nick}`)],
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
      const tag = el('span', 'net-tag', relay.network);
      tag.dataset.net = relay.network.toLowerCase();
      nick.append(tag);
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
  // Texto de la línea tal como se copia al portapapeles: [hora] <nick> mensaje
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const plain = stripFormatting(line.text);
  row.dataset.plain =
    line.kind === 'msg' ? `[${hhmm}] <${line.nick ?? ''}> ${plain}`
    : line.kind === 'notice' ? `[${hhmm}] -${line.nick ?? ''}- ${plain}`
    : line.kind === 'action' ? `[${hhmm}] * ${line.nick ?? ''} ${plain}`
    : `[${hhmm}] ${line.kind === 'echo' ? '' : '* '}${plain}`;
  return row;
}

function renderLog(w: Win | undefined = winOf(st.active.sid, st.active.buffer)): void {
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

function renderTyping(w: Win | undefined = winOf(st.active.sid, st.active.buffer)): void {
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
  document.documentElement.dataset.theme = st.settings.theme;
  document.documentElement.dataset.layout = st.settings.layout;
  document.documentElement.style.setProperty('--size', st.settings.fontSize + 'px');
  desktop.classList.toggle('no-times', !st.settings.showTimestamps);
}

// ----------------------------------------------------------------- eventos

function onUi(ev: UiEvent): void {
  switch (ev.type) {
    case 'session': {
      const before = sessions.get(ev.sid)?.info;
      ensureSession({ sid: ev.sid, name: ev.name, state: ev.state, nick: ev.nick, lag: ev.lag, away: ev.away });
      renderStatus();
      // Un cambio que solo afecta al lag no necesita redibujar nada más.
      if (before && before.state === ev.state && before.nick === ev.nick && before.name === ev.name) break;
      renderTree();
      for (const w of wins.values()) if (w.sid === ev.sid) renderHeader(w);
      break;
    }
    case 'session:remove':
      for (const w of [...wins.values()]) if (w.sid === ev.sid) removeWin(w.sid, w.name);
      sessions.delete(ev.sid);
      if (st.active.sid === ev.sid) activate(LOCAL, STATUS);
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
      // Quien escribe a través de un puente no figura en la lista del canal: se le añade aparte.
      if (ev.line.nick && b.type === 'channel') {
        const relay = splitRelay(ev.line.nick);
        if (relay.network && b.relayed.get(relay.name) !== relay.network) {
          b.relayed.set(relay.name, relay.network);
          renderNicks(winOf(sid, b.name));
        }
      }
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
          if (ev.line.highlight) {
            b.highlight = true;
            lastNote = { sid, buffer: b.name, text: `${ev.line.nick ?? ''} en ${b.type === 'query' ? 'privado' : b.name}: ${stripFormatting(ev.line.text).slice(0, 80)}` };
            renderStatus();
          }
          renderTree();
        }
        if (ev.line.highlight && st.settings.notifications && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
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
      st.settings = ev.settings;
      applySettings();
      renderStatus();
      for (const w of wins.values()) {
        renderHeader(w);
        renderLog(w);
        renderNicks(w);
      }
      break;
  }
}

// ----------------------------------------------------------------- entrada

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
  if (!b || b.type === 'status' || b.type === 'dcc' || !st.settings.sendTyping) return;
  if (state === 'active') {
    if (Date.now() - typingSent < 3000) return;
    typingSent = Date.now();
  } else {
    if (!typingSent) return;
    typingSent = 0;
  }
  void window.onda.invoke('typing', st.active.sid, st.active.buffer, state);
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
    const s = sessions.get(st.active.sid);
    const pool = word.startsWith('#')
      ? [...(s?.buffers.values() ?? [])].filter((x) => x.type === 'channel').map((x) => x.name)
      : word.startsWith('/')
        ? ['/join', '/part', '/msg', '/query', '/me', '/nick', '/topic', '/kick', '/op', '/deop', '/voice', '/whois', '/away', '/server', '/quit', '/dcc', '/load', '/help', '/clear', '/notice', '/mode', '/ctcp']
        : [...(b?.nicks ?? []).map((n) => n.nick), ...(b?.relayed.keys() ?? [])];
    const matches = pool.filter((x) => x.toLowerCase().startsWith(word));
    if (!matches.length) return;
    completion = { start: pos - m[1].length, matches, index: 0, base: input.value.slice(pos) };
  } else completion.index = (completion.index + 1) % completion.matches.length;
  const pick = completion.matches[completion.index];
  const suffix = completion.start === 0 && !/^[#/]/.test(pick) ? (st.settings.nickSuffix || ':').trimEnd() + ' ' : ' ';
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

// Clic derecho en cualquier caja de texto: cortar, copiar, pegar y seleccionar todo.
document.addEventListener('contextmenu', (e) => {
  const box = (e.target as HTMLElement).closest('textarea, input') as HTMLInputElement | HTMLTextAreaElement | null;
  if (!box || (box instanceof HTMLInputElement && ['checkbox', 'radio', 'number', 'button', 'submit'].includes(box.type))) return;
  e.preventDefault();
  const has = box.selectionStart !== box.selectionEnd;
  const act = (action: string) => () => {
    box.focus();
    return window.onda.invoke('edit', action);
  };
  const editable = !box.readOnly && !box.disabled;
  showMenu(e.clientX, e.clientY, [
    ...(has && editable ? ([['Cortar', act('cut')]] as MenuItem[]) : []),
    ...(has ? ([['Copiar', act('copy')]] as MenuItem[]) : []),
    ...(editable ? ([['Pegar', act('paste')]] as MenuItem[]) : []),
    ['Seleccionar todo', act('selectAll')],
  ]);
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

// Barra de menús y opciones de «Ver» (se recuerdan en este equipo)
type Edge = 'top' | 'bottom' | 'left' | 'right';
const view: { tree: boolean; nicks: boolean; switchbar: boolean; toolbar: boolean; statusbar: boolean; switchPos: Edge; statusPos: 'top' | 'bottom' } = {
  tree: false, nicks: true, switchbar: true, toolbar: true, statusbar: true, switchPos: 'bottom', statusPos: 'bottom',
};
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
  // Barra de ventanas: arriba o abajo va en la columna principal; a izquierda o derecha, junto al escritorio.
  if (!['top', 'bottom', 'left', 'right'].includes(view.switchPos)) view.switchPos = 'bottom';
  const bar = $('switchbar');
  const vertical = view.switchPos === 'left' || view.switchPos === 'right';
  bar.classList.toggle('vertical', vertical);
  bar.setAttribute('aria-orientation', vertical ? 'vertical' : 'horizontal');
  if (view.switchPos === 'left') $('chat').before(bar);
  else if (view.switchPos === 'right') $('chat').after(bar);
  else $('layout').before(bar);
  document.body.classList.toggle('switch-bottom', view.switchPos === 'bottom');
  document.body.classList.toggle('status-top', view.statusPos === 'top');
  $('statusbar').hidden = !view.statusbar;
  try {
    localStorage.setItem('onda.ver', JSON.stringify(view));
  } catch {
    /* almacenamiento no disponible */
  }
}
applyView();

function menuItems(name: string): MenuItem[] {
  const tick = (on: boolean, label: string) => (on ? '✓ ' : '\u2003 ') + label;
  const toggle = (k: 'tree' | 'nicks' | 'switchbar' | 'toolbar' | 'statusbar', label: string): MenuItem => [tick(view[k], label), () => {
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
        ['Cerrar ventana', () => st.active.sid !== LOCAL || st.active.buffer.startsWith('@') ? window.onda.invoke('closeBuffer', st.active.sid, st.active.buffer) : undefined],
        ['Salir', () => window.close()],
      ];
    case 'ver':
      return [
        toggle('toolbar', 'Barra de botones'),
        toggle('switchbar', 'Barra de ventanas'),
        toggle('statusbar', 'Barra de estado'),
        toggle('tree', 'Árbol de redes'),
        toggle('nicks', 'Lista de nicks'),
        null,
        ['Barra de ventanas en…', null],
        ...(['top', 'bottom', 'left', 'right'] as const).map((pos): MenuItem => [
          tick(view.switchPos === pos, '\u2003' + { top: 'Arriba', bottom: 'Abajo', left: 'Izquierda', right: 'Derecha' }[pos]),
          () => {
            view.switchPos = pos;
            view.switchbar = true;
            applyView();
          },
        ]),
        ['Barra de estado en…', null],
        ...(['top', 'bottom'] as const).map((pos): MenuItem => [
          tick(view.statusPos === pos, '\u2003' + { top: 'Arriba', bottom: 'Abajo' }[pos]),
          () => {
            view.statusPos = pos;
            view.statusbar = true;
            applyView();
          },
        ]),
        null,
        [tick(st.settings.showTimestamps, 'Mostrar la hora'), () => window.onda.invoke('settings:update', { showTimestamps: !st.settings.showTimestamps })],
        null,
        ...(['classic', 'dark', 'light'] as const).map((t): MenuItem => [
          tick(st.settings.theme === t, { classic: 'Tema clásico', dark: 'Tema oscuro', light: 'Tema claro' }[t]),
          () => window.onda.invoke('settings:update', { theme: t }),
        ]),
        null,
        [tick(st.settings.layout === 'classic', 'Texto compacto (estilo IRC)'), () => window.onda.invoke('settings:update', { layout: st.settings.layout === 'classic' ? 'modern' : 'classic' })],
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
        ['Panel de control…', click('btn-panel')],
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

$('switchbar').addEventListener('contextmenu', (e) => {
  if ((e.target as HTMLElement).closest('.sw')) return;
  e.preventDefault();
  showMenu(e.clientX, e.clientY, [
    ['Colocar la barra de ventanas', null],
    ...(['top', 'bottom', 'left', 'right'] as const).map((pos): MenuItem => [
      (view.switchPos === pos ? '✓ ' : '\u2003 ') + { top: 'Arriba', bottom: 'Abajo', left: 'Izquierda', right: 'Derecha' }[pos],
      () => {
        view.switchPos = pos;
        applyView();
      },
    ]),
  ]);
});
$('statusbar').addEventListener('contextmenu', (e) => {
  e.preventDefault();
  showMenu(e.clientX, e.clientY, [
    ['Colocar la barra de estado', null],
    ...(['top', 'bottom'] as const).map((pos): MenuItem => [
      (view.statusPos === pos ? '✓ ' : '\u2003 ') + { top: 'Arriba', bottom: 'Abajo' }[pos],
      () => {
        view.statusPos = pos;
        applyView();
      },
    ]),
    ['Ocultar', () => {
      view.statusbar = false;
      applyView();
    }],
  ]);
});

// ----------------------------------------------------- barra de estado y título
let lastNote: { sid: string; buffer: string; text: string } | null = null;

function renderStatus(): void {
  const s = sessions.get(st.active.sid);
  const b = activeBuffer();
  const d = new Date();
  $('sb-clock').textContent = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const real = s && s.info.sid !== LOCAL ? s : [...sessions.values()].find((x) => x.info.sid !== LOCAL);
  const net = $('sb-net');
  net.className = real ? real.info.state : '';
  net.textContent = real ? `${real.info.name} (${stateLabel(real.info.state)})` : 'Sin conexión';
  $('sb-nick').textContent = real ? real.info.nick : st.settings.nick;
  const lag = real && real.info.state === 'connected' && (real.info.lag ?? -1) >= 0 ? real.info.lag! : -1;
  $('sb-lag').textContent = lag >= 0 ? `Lag: ${lag.toFixed(lag < 10 ? 2 : 0)} s` : '';
  $('sb-away').hidden = !real?.info.away;
  $('btn-away').classList.toggle('on', !!real?.info.away);
  $('sb-log').textContent = st.settings.logging ? 'Registro activado' : 'Registro desactivado';
  const note = $('sb-note');
  if (lastNote && isActive(lastNote.sid, lastNote.buffer)) lastNote = null;
  note.hidden = !lastNote;
  note.textContent = lastNote ? `● ${lastNote.text}` : '';
  const name = b ? (b.type === 'status' ? s?.info.name ?? 'Onda' : b.name) : 'Onda';
  const parts = [name];
  if (real) parts.push(real.info.state === 'connected' ? `${real.info.name}${lag >= 0 ? ` · lag ${lag.toFixed(1)} s` : ''}` : stateLabel(real.info.state));
  if (real?.info.away) parts.push('ausente');
  document.title = `${parts.join(' · ')} — Onda IRC`;
}
$('sb-note').addEventListener('click', () => {
  if (lastNote) activate(lastNote.sid, lastNote.buffer);
});
window.setInterval(renderStatus, 20000);

// ----------------------------------------------------- botones nuevos y teclas de función
$('btn-disconnect').addEventListener('click', () => send('/disconnect'));
$('btn-join').addEventListener('click', () => insertText('/join #'));
$('btn-query').addEventListener('click', () => insertText('/query '));
$('btn-away').addEventListener('click', () => send('/away'));
document.addEventListener('keydown', (e) => {
  if (!/^F([1-9]|1[0-2])$/.test(e.key) || e.ctrlKey || e.altKey || e.metaKey) return;
  const cmd = st.settings.fkeys?.[e.shiftKey ? 'S' + e.key : e.key];
  if (!cmd) return;
  e.preventDefault();
  send(cmd);
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

// ------------------------------------------------------------------ inicio

async function start(): Promise<void> {
  const snap = await window.onda.invoke<Snapshot>('snapshot');
  st.settings = snap.settings;
  st.networks = snap.networks;
  applySettings();
  const local = ensureSession({ sid: LOCAL, name: 'Onda', state: 'local', nick: st.settings.nick });
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
  $('btn-max').classList.toggle('on', desktop.classList.contains('maxed'));
  activate(LOCAL, STATUS);
  renderDcc();
  renderStatus();
}

void start();
