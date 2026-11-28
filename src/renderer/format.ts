/** Presentación de texto IRC: colores y formato de mIRC, enlaces, colores de nick y nombres de puentes. */
import { MIRC_COLORS, parseFormatting } from '../core/irc/formatting';
import { el } from './dom';

export function nickColor(nick: string): string {
  let h = 0;
  for (const ch of nick.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const light = document.documentElement.dataset.theme !== 'dark';
  return `hsl(${h % 360} ${light ? '70% 32%' : '65% 68%'})`;
}

export function appendFormatted(parent: HTMLElement, text: string): void {
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

/** Etiquetas de los puentes de mensajería: lo que va tras la barra en «Nombre/etiqueta». */
export const RELAY_NETWORKS: Record<string, string> = {
  tg: 'Telegram', telegram: 'Telegram', wa: 'WhatsApp', whatsapp: 'WhatsApp', sg: 'Signal', signal: 'Signal',
  rcs: 'RCS', sms: 'SMS', im: 'iMessage', imsg: 'iMessage', imessage: 'iMessage',
  mx: 'Matrix', matrix: 'Matrix', dc: 'Discord', discord: 'Discord',
};

/** Los puentes (relaymsg) usan nicks «Nombre/red», p. ej. «Ana/tg» para Telegram. */
export function splitRelay(nick: string): { name: string; network: string } {
  const i = nick.lastIndexOf('/');
  if (i <= 0 || i === nick.length - 1) return { name: nick, network: '' };
  const label = nick.slice(i + 1);
  return { name: nick.slice(0, i), network: RELAY_NETWORKS[label.toLowerCase()] ?? label };
}

export function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
