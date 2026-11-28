/** Utilidades de DOM y acceso al puente con el proceso principal. */
import type { UiEvent } from '../core/types';

declare global {
  interface Window {
    onda: { invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>; onUi(cb: (ev: UiEvent) => void): void };
  }
}

/** Elemento por su id. */
export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** Crea un elemento con clase y texto opcionales. El texto siempre se inserta como texto, nunca como HTML. */
export const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};

/** Clave de comparación de nombres de ventana (sin distinguir mayúsculas). */
export const key = (s: string) => s.toLowerCase();
