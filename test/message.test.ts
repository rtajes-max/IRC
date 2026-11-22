import { describe, expect, it } from 'vitest';
import { parseFormatting, stripFormatting } from '../src/core/irc/formatting';
import { formatMessage, ircLower, parseMessage } from '../src/core/irc/message';

describe('parseMessage', () => {
  it('analiza prefijo, comando y parámetros', () => {
    const m = parseMessage(':ana!u@host.example PRIVMSG #canal :hola a todos')!;
    expect(m.nick).toBe('ana');
    expect(m.user).toBe('u');
    expect(m.host).toBe('host.example');
    expect(m.command).toBe('PRIVMSG');
    expect(m.params).toEqual(['#canal', 'hola a todos']);
  });

  it('analiza etiquetas IRCv3 con escapes', () => {
    const m = parseMessage('@time=2026-01-02T03:04:05.000Z;+draft/x=a\\sb\\:c;solo :srv 001 yo :Bienvenido')!;
    expect(m.tags.time).toBe('2026-01-02T03:04:05.000Z');
    expect(m.tags['+draft/x']).toBe('a b;c');
    expect(m.tags.solo).toBe('');
    expect(m.command).toBe('001');
  });

  it('admite parámetro final vacío y comandos sin prefijo', () => {
    expect(parseMessage('PING :abc')!.params).toEqual(['abc']);
    expect(parseMessage(':n!u@h TOPIC #c :')!.params).toEqual(['#c', '']);
    expect(parseMessage('')).toBeNull();
  });

  it('formatMessage añade ":" solo cuando hace falta', () => {
    expect(formatMessage('PRIVMSG', ['#c', 'hola mundo'])).toBe('PRIVMSG #c :hola mundo');
    expect(formatMessage('JOIN', ['#c'])).toBe('JOIN #c');
    expect(formatMessage('TAGMSG', ['#c'], { '+typing': 'active' })).toBe('@+typing=active TAGMSG #c');
  });

  it('ircLower sigue rfc1459', () => {
    expect(ircLower('Nick[A]\\')).toBe('nick{a}|');
  });
});

describe('formato mIRC', () => {
  it('interpreta negrita y colores', () => {
    const segs = parseFormatting('a\x02b\x02 \x0304,01rojo\x03 fin');
    expect(segs[0]).toEqual({ text: 'a' });
    expect(segs[1]).toMatchObject({ text: 'b', bold: true });
    expect(segs[3]).toMatchObject({ text: 'rojo', fg: 4, bg: 1 });
    expect(segs[4]).toEqual({ text: ' fin' });
  });

  it('elimina los códigos', () => {
    expect(stripFormatting('\x02hola\x0f \x0312,4mundo\x03\x1d!')).toBe('hola mundo!');
  });
});
