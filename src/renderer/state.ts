/** Estado compartido de la interfaz: sesiones, búferes, ajustes y ventana activa. */
import type { BufferType, DccInfo, Line, NetworkConfig, NickEntry, SessionInfo, Settings } from '../core/types';
import { key } from './dom';

export const STATUS = '*';
export const LOCAL = 'local';
export const MAX_LINES = 2000;

export interface BufferState {
  name: string;
  type: BufferType;
  lines: Line[];
  nicks: NickEntry[];
  topic: string;
  unread: number;
  highlight: boolean;
  typing: Map<string, number>;
  reactions: Map<string, string[]>;
  /** Personas vistas a través de un puente (Telegram, WhatsApp, Signal…): nombre → red. */
  relayed: Map<string, string>;
}

export interface SessionState {
  info: SessionInfo;
  buffers: Map<string, BufferState>;
}

export const sessions = new Map<string, SessionState>();
export const dccs = new Map<string, DccInfo>();

/** Valores que cambian durante la ejecución (los módulos los leen siempre a través de este objeto). */
export const st = {
  active: { sid: LOCAL, buffer: STATUS },
  settings: null as unknown as Settings,
  networks: [] as NetworkConfig[],
};

export function newBuffer(name: string, type: BufferType): BufferState {
  return { name, type, lines: [], nicks: [], topic: '', unread: 0, highlight: false, typing: new Map(), reactions: new Map(), relayed: new Map() };
}

export function ensureSession(info: SessionInfo): SessionState {
  let s = sessions.get(info.sid);
  if (!s) {
    s = { info, buffers: new Map() };
    sessions.set(info.sid, s);
  } else s.info = info;
  return s;
}

export function getBuffer(sid: string, name: string, create?: BufferType): BufferState | undefined {
  const s = sessions.get(sid);
  if (!s) return undefined;
  let b = s.buffers.get(key(name));
  if (!b && create) {
    b = newBuffer(name, create);
    s.buffers.set(key(name), b);
  }
  return b;
}

export const activeBuffer = () => getBuffer(st.active.sid, st.active.buffer);
export const isActive = (sid: string, buffer: string) => st.active.sid === sid && key(st.active.buffer) === key(buffer);

/** Envía lo escrito (texto o comando) a la ventana activa. */
export function send(text: string): void {
  void window.onda.invoke('input', st.active.sid, st.active.buffer, text);
}
