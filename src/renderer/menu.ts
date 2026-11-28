/** Menú contextual común: lo usan los menús de la barra, los de clic derecho y los popups de scripts. */
import { $, el } from './dom';

/** Elemento de menú: [texto, acción]; acción nula = título no pulsable; `null` = separador. */
export type MenuItem = [string, (() => unknown) | null] | null;

export function showMenu(x: number, y: number, items: MenuItem[]): void {
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
  // Dentro de un diálogo abierto el menú debe ir en él, o quedaría tapado.
  (document.querySelector('dialog[open]') ?? document.body).append(menu);
  menu.hidden = false;
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.max(4, Math.min(x, window.innerWidth - r.width - 4)) + 'px';
  menu.style.top = Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) + 'px';
  (menu.querySelector('button') as HTMLElement | null)?.focus();
}
