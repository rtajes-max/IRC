/** Diálogos de la aplicación: conexión, ajustes, scripts, transferencias, panel de control, canales y registros. */
import { stripFormatting } from '../core/irc/formatting';
import type { ChannelListEntry, DccInfo, NetworkConfig, ScriptInfo, Settings } from '../core/types';
import { $, el } from './dom';
import { fmtSize } from './format';
import { LOCAL, STATUS, dccs, send, sessions, st } from './state';

export function dialog(id: string): HTMLDialogElement {
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
  set('nick', n.nick || st.settings.nick);
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
  for (const n of st.networks) {
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
      st.networks = st.networks.filter((k) => k.name !== n.name);
      renderSaved();
    });
    chip.append(pick, x);
    box.append(chip);
  }
}

$('btn-connect').addEventListener('click', () => {
  fillConnect(st.networks[0] ?? { name: 'RogerNet', host: 'irc.rogertp.es', autojoin: ['#general'] });
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
  if (f.has('save')) st.networks = [...st.networks.filter((n) => n.name !== cfg.name), cfg];
  await window.onda.invoke('connect', cfg, f.has('save'));
});

// Ajustes
$('btn-settings').addEventListener('click', () => {
  const f = $<HTMLFormElement>('settings-form');
  for (const [k, v] of Object.entries(st.settings)) {
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
    nick: String(f.get('nick')).trim() || st.settings.nick,
    realname: String(f.get('realname')),
    quitMessage: String(f.get('quitMessage')),
    theme: String(f.get('theme')) as Settings['theme'],
    layout: String(f.get('layout')) === 'modern' ? 'modern' : 'classic',
    fontSize: Math.min(24, Math.max(10, Number(f.get('fontSize')) || 14)),
    showTimestamps: f.has('showTimestamps'),
    logging: f.has('logging'),
    notifications: wantsNotif,
    sendTyping: f.has('sendTyping'),
    floodProtect: f.has('floodProtect'),
    nickSuffix: String(f.get('nickSuffix') ?? '').trim().slice(0, 4) || ':',
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

export async function loadScripts(reset = true): Promise<void> {
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

export function renderDcc(): void {
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

// ----------------------------------------------------- panel de control
const PANEL: [string, string, () => void][] = [
  ['Ajustes generales', '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>', () => $('btn-settings').click()],
  ['Redes y conexión', '<path d="M9 7V3M15 7V3M7 7h10v5a5 5 0 0 1-10 0zM12 17v4"/>', () => $('btn-connect').click()],
  ['Sistema de ausencia', '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>', () => openAway()],
  ['Teclas de función', '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10"/>', () => openFkeys()],
  ['Ignorados', '<circle cx="12" cy="12" r="8"/><path d="M6.5 6.5l11 11"/>', () => openIgnore()],
  ['Scripts', '<path d="M8 6l-5 6 5 6M16 6l5 6-5 6M13 4l-2 16"/>', () => $('btn-scripts').click()],
  ['Lista de canales', '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>', () => $('btn-list').click()],
  ['Transferencias DCC', '<path d="M7 4v14M3 14l4 4 4-4M17 20V6M13 10l4-4 4 4"/>', () => $('btn-dcc').click()],
  ['Registros', '<path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3zM5 17a3 3 0 0 1 3-3h11"/>', () => $('btn-logs').click()],
];
function svgIcon(paths: string): SVGSVGElement {
  // Los trazos son constantes definidas arriba, nunca texto del usuario.
  const doc = new DOMParser().parseFromString(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`, 'image/svg+xml');
  return document.importNode(doc.documentElement, true) as unknown as SVGSVGElement;
}
$('btn-panel').addEventListener('click', () => {
  const grid = $('panel-grid');
  grid.replaceChildren();
  for (const [label, icon, open] of PANEL) {
    const b = el('button');
    b.type = 'button';
    b.append(svgIcon(icon), el('span', '', label));
    b.addEventListener('click', () => {
      dialog('dlg-panel').close();
      open();
    });
    grid.append(b);
  }
  dialog('dlg-panel').showModal();
});

function openAway(): void {
  const f = $<HTMLFormElement>('away-form');
  (f.elements.namedItem('awayMessage') as HTMLInputElement).value = st.settings.awayMessage;
  (f.elements.namedItem('awayAutoReply') as HTMLInputElement).checked = st.settings.awayAutoReply;
  (f.elements.namedItem('awayNickSuffix') as HTMLInputElement).value = st.settings.awayNickSuffix;
  dialog('dlg-away').showModal();
}
$('away-form').addEventListener('submit', () => {
  const f = new FormData($<HTMLFormElement>('away-form'));
  void window.onda.invoke('settings:update', {
    awayMessage: String(f.get('awayMessage') ?? '').trim() || 'Ausente',
    awayAutoReply: f.has('awayAutoReply'),
    awayNickSuffix: String(f.get('awayNickSuffix') ?? '').replace(/\s/g, '').slice(0, 12),
  } satisfies Partial<Settings>);
});

function openFkeys(): void {
  const grid = $('fkeys-grid');
  grid.replaceChildren();
  for (let n = 1; n <= 12; n++) {
    const label = el('label', '', `F${n}`);
    const box = el('input');
    box.name = `F${n}`;
    box.value = st.settings.fkeys?.[`F${n}`] ?? '';
    box.placeholder = n === 1 ? '/help' : '';
    label.append(box);
    grid.append(label);
  }
  dialog('dlg-fkeys').showModal();
}
$('fkeys-form').addEventListener('submit', () => {
  const f = new FormData($<HTMLFormElement>('fkeys-form'));
  const fkeys: Record<string, string> = {};
  for (let n = 1; n <= 12; n++) {
    const v = String(f.get(`F${n}`) ?? '').trim();
    if (v) fkeys[`F${n}`] = v;
  }
  void window.onda.invoke('settings:update', { fkeys } satisfies Partial<Settings>);
});

function renderIgnore(): void {
  const list = $('ignore-list');
  list.replaceChildren();
  if (!st.settings.ignore.length) list.append(el('div', 'empty', 'No ignoras a nadie.'));
  for (const m of st.settings.ignore) {
    const row = el('div', 'ign');
    const rm = el('button', '', 'Quitar');
    rm.type = 'button';
    rm.addEventListener('click', async () => {
      await window.onda.invoke('settings:update', { ignore: st.settings.ignore.filter((x) => x !== m) } satisfies Partial<Settings>);
      renderIgnore();
    });
    row.append(el('span', '', m), rm);
    list.append(row);
  }
}
function openIgnore(): void {
  renderIgnore();
  dialog('dlg-ignore').showModal();
}
$('ignore-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const box = $<HTMLInputElement>('ignore-input');
  const mask = box.value.trim().split(/\s+/)[0];
  if (!mask) return;
  if (!st.settings.ignore.includes(mask)) await window.onda.invoke('settings:update', { ignore: [...st.settings.ignore, mask] } satisfies Partial<Settings>);
  box.value = '';
  renderIgnore();
});

// Lista de canales de la red
export const chanLists = new Map<string, ChannelListEntry[]>();
export let listSid = '';

export function renderChanList(): void {
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
  const s = sessions.get(st.active.sid);
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
