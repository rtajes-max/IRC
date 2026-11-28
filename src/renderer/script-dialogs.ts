/** Ventanas de los diálogos definidos por scripts (tablas `dialog` de mIRC). */
import type { DialogControlView, DialogView } from '../core/types';
import { $, el, key } from './dom';

const openDialogs = new Map<string, { root: HTMLElement; controls: Map<number, HTMLElement> }>();

function dialogSend(name: string, event: string, id: number, value?: { text?: string; checked?: boolean; sel?: number }): void {
  void window.onda.invoke('dialog:event', name, event, id, value);
}

/** Crea o actualiza la ventana de un diálogo de script; con `view` nulo la cierra. */
export function syncDialog(name: string, view: DialogView | null): void {
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
