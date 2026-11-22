/** Códigos de formato de mIRC: negrita, color, cursiva, subrayado, inverso, etc. */

export interface Segment {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  mono?: boolean;
  reverse?: boolean;
  fg?: number;
  bg?: number;
}

/** Paleta clásica de 16 colores de mIRC. */
export const MIRC_COLORS = [
  '#ffffff', '#000000', '#00007f', '#009300', '#ff0000', '#7f0000', '#9c009c', '#fc7f00',
  '#ffff00', '#00fc00', '#009393', '#00ffff', '#0000fc', '#ff00ff', '#7f7f7f', '#d2d2d2',
];

const B = '\x02', C = '\x03', I = '\x1d', U = '\x1f', S = '\x1e', M = '\x11', R = '\x16', O = '\x0f';

export function parseFormatting(input: string): Segment[] {
  const out: Segment[] = [];
  let st: Omit<Segment, 'text'> = {};
  let buf = '';
  const flush = () => {
    if (buf) out.push({ text: buf, ...st });
    buf = '';
  };
  const toggle = (k: 'bold' | 'italic' | 'underline' | 'strike' | 'mono' | 'reverse') => {
    st = { ...st };
    if (st[k]) delete st[k];
    else st[k] = true;
  };
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    switch (ch) {
      case B: flush(); toggle('bold'); break;
      case I: flush(); toggle('italic'); break;
      case U: flush(); toggle('underline'); break;
      case S: flush(); toggle('strike'); break;
      case M: flush(); toggle('mono'); break;
      case R: flush(); toggle('reverse'); break;
      case O: flush(); st = {}; break;
      case C: {
        flush();
        const m = /^(\d{1,2})(?:,(\d{1,2}))?/.exec(input.slice(i + 1, i + 6));
        if (m) {
          st = { ...st, fg: Number(m[1]) };
          if (m[2] !== undefined) st.bg = Number(m[2]);
          i += m[0].length;
        } else {
          st = { ...st };
          delete st.fg;
          delete st.bg;
        }
        break;
      }
      default:
        buf += ch;
    }
  }
  flush();
  return out;
}

export function stripFormatting(input: string): string {
  return input.replace(/\x03(\d{1,2}(,\d{1,2})?)?/g, '').replace(/[\x02\x0f\x11\x16\x1d\x1e\x1f]/g, '');
}
