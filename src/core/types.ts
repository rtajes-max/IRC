/** Tipos compartidos entre el núcleo, el proceso principal y la interfaz. */

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
}

export interface Settings {
  nick: string;
  username: string;
  realname: string;
  quitMessage: string;
  theme: 'dark' | 'light' | 'classic';
  fontSize: number;
  showTimestamps: boolean;
  logging: boolean;
  notifications: boolean;
  sendTyping: boolean;
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
  | { type: 'scripts' }
  | { type: 'settings'; settings: Settings };

export interface Snapshot {
  sessions: (SessionInfo & { buffers: { name: string; type: BufferType; topic: string; nicks: NickEntry[] }[] })[];
  settings: Settings;
  networks: NetworkConfig[];
  dccs: DccInfo[];
  /** Ventanas personalizadas creadas por scripts (/window @nombre). */
  windows: string[];
}

export interface ScriptInfo {
  name: string;
  source: string;
  warnings: string[];
}
