/** Tipos compartidos entre el núcleo, el proceso principal y la interfaz. */
import type { DialogView } from './msl/engine';

export type { DialogControlView, DialogView } from './msl/engine';

export const STATUS = '*';
export const LOCAL = 'local';

export interface NetworkConfig {
  name: string;
  host: string;
  port: number;
  tls: boolean;
  nick: string;
  username?: string;
  realname?: string;
  password?: string;
  saslAccount?: string;
  saslPassword?: string;
  autojoin?: string[];
  allowInvalidCert?: boolean;
  autoconnect?: boolean;
  /** Comandos que se ejecutan al conectar (uno por línea), como el «Perform» de mIRC. */
  perform?: string[];
}

export interface Settings {
  nick: string;
  username: string;
  realname: string;
  quitMessage: string;
  theme: 'dark' | 'light' | 'classic';
  /** Distribución de la ventana: clásica (compacta, estilo cliente IRC tradicional) o moderna. */
  layout: 'classic' | 'modern';
  fontSize: number;
  showTimestamps: boolean;
  logging: boolean;
  notifications: boolean;
  sendTyping: boolean;
  /** Nicks o máscaras (nick!usuario@host, con comodines) cuyos mensajes no se muestran. */
  ignore: string[];
  /** Nicks de los que se avisa cuando entran o salen de la red. */
  notify: string[];
  /** Sistema de ausencia: mensaje por defecto, respuesta automática y sufijo opcional para el nick. */
  awayMessage: string;
  awayAutoReply: boolean;
  awayNickSuffix: string;
  /** Protección personal: ignora un rato a quien inunda con privados o peticiones CTCP. */
  floodProtect: boolean;
  /** Lo que se añade al completar un nick al principio de la línea. */
  nickSuffix: string;
  /** Comandos asignados a las teclas de función (F1…F12). */
  fkeys: Record<string, string>;
}

export type LineKind =
  | 'msg' | 'action' | 'notice' | 'info' | 'error' | 'join' | 'part' | 'quit' | 'kick' | 'nick' | 'topic' | 'mode'
  | 'echo' | 'ctcp' | 'server';

export interface Line {
  time: number;
  kind: LineKind;
  text: string;
  nick?: string;
  prefix?: string;
  self?: boolean;
  highlight?: boolean;
  history?: boolean;
  msgid?: string;
}

export type BufferType = 'status' | 'channel' | 'query' | 'dcc' | 'custom';

export interface NickEntry {
  nick: string;
  prefix: string;
}

export interface SessionInfo {
  sid: string;
  name: string;
  state: 'connecting' | 'connected' | 'disconnected' | 'local';
  nick: string;
  /** Retardo con el servidor en segundos (-1 si no se conoce). */
  lag?: number;
  away?: boolean;
}

export interface DccInfo {
  id: string;
  sid: string;
  nick: string;
  direction: 'in' | 'out';
  type: 'SEND' | 'CHAT';
  filename: string;
  size: number;
  transferred: number;
  status: 'offered' | 'waiting' | 'active' | 'done' | 'failed' | 'rejected';
  error?: string;
  path?: string;
}

export interface ChannelListEntry {
  name: string;
  users: number;
  topic: string;
}

export type UiEvent =
  | ({ type: 'session' } & SessionInfo)
  | { type: 'session:remove'; sid: string }
  | { type: 'buffer:add'; sid: string; buffer: string; bufferType: BufferType }
  | { type: 'buffer:remove'; sid: string; buffer: string }
  | { type: 'buffer:clear'; sid: string; buffer: string }
  | { type: 'activate'; sid: string; buffer: string }
  | { type: 'line'; sid: string; buffer: string; line: Line }
  | { type: 'nicks'; sid: string; buffer: string; nicks: NickEntry[] }
  | { type: 'topic'; sid: string; buffer: string; topic: string }
  | { type: 'typing'; sid: string; buffer: string; nick: string; state: string }
  | { type: 'react'; sid: string; buffer: string; nick: string; emoji: string; msgid: string }
  | { type: 'dcc'; dcc: DccInfo }
  | { type: 'dialog'; name: string; view: DialogView | null }
  | { type: 'chanlist'; sid: string; channels: ChannelListEntry[] }
  | { type: 'scripts' }
  | { type: 'settings'; settings: Settings };

export interface Snapshot {
  sessions: (SessionInfo & { buffers: { name: string; type: BufferType; topic: string; nicks: NickEntry[] }[] })[];
  settings: Settings;
  networks: NetworkConfig[];
  dccs: DccInfo[];
  /** Ventanas personalizadas creadas por scripts (/window @nombre). */
  windows: string[];
  /** Diálogos de scripts abiertos. */
  dialogs: DialogView[];
}

export interface ScriptInfo {
  name: string;
  source: string;
  warnings: string[];
}
