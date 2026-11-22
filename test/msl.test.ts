import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { MslContext, MslEngine, MslHost, calc, newContext, wildMatch } from '../src/core/msl/engine';

let out: string[];
let cmds: string[];
let raws: string[];
let engine: MslEngine;
let dataDir: string;

function makeHost(): MslHost {
  return {
    dataDir,
    command(name, args) {
      if (['msg', 'notice', 'join', 'part', 'me', 'describe', 'kick', 'mode'].includes(name)) {
        cmds.push(`${name} ${args}`.trim());
        return true;
      }
      return false;
    },
    echo(text, target) {
      out.push(target ? `${target}: ${text}` : text);
    },
    raw(line) {
      raws.push(line);
    },
    info: () => ({ me: 'Yo', server: 'irc.test', network: 'TestNet', active: '#sala', channels: ['#sala', '#otra'] }),
    nicks: (_ctx, chan) =>
      chan.toLowerCase() === '#sala'
        ? [{ nick: 'Jefa', prefix: '@' }, { nick: 'Voz', prefix: '+' }, { nick: 'Yo', prefix: '' }]
        : [],
  };
}

beforeEach(() => {
  out = [];
  cmds = [];
  raws = [];
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onda-msl-'));
  engine = new MslEngine(makeHost());
});

const run = (line: string, ctx: Partial<MslContext> = {}) => engine.execLine(line, newContext({ cid: 's1', ...ctx }));

describe('evaluación', () => {
  it('sustituye identificadores, parámetros y $+', () => {
    run('echo -a $me en $network $+ ! $1 / $2- / $0', { params: ['uno', 'dos', 'tres'] });
    expect(out).toEqual(['Yo en TestNet! uno / dos tres / 3']);
  });

  it('funciones de texto y tokens', () => {
    run('echo -a $upper(hola) $len(mundo) $left(abcdef,3) $right(abcdef,2) $mid(abcdef,2,3) $replace(a-b-c,-,+)');
    run('echo -a $gettok(a.b.c,2,46) $numtok(a b c,32) $gettok(a.b.c,-1,46) $gettok(a.b.c,2-,46) $addtok(a.b,c,46) $istok(a b,b,32)');
    run('echo -a $+(a,b,c) $calc(2 + 3 * 4) $calc((1+2)^2) $iif(3 > 2,si,no) $str(ab,3) $chr(65) $asc(A)');
    expect(out).toEqual(['HOLA 5 abc ef bcd a+b+c', 'b 3 c b.c a.b.c $true', 'abc 14 9 si ababab A 65']);
  });

  it('no reevalúa texto procedente de la red (sin inyección)', () => {
    run('echo -a dijo: $1-', { params: ['$me', '%secreto', '$calc(1+1)', '|', 'quit'] });
    expect(out).toEqual(['dijo: $me %secreto $calc(1+1) | quit']);
    expect(raws).toEqual([]);
  });

  it('deja intactos los $ que no son identificadores', () => {
    run('echo -a cuesta $5.00 y 100% seguro');
    expect(out).toEqual(['cuesta $5.00 y 100% seguro']);
  });

  it('calc y comodines', () => {
    expect(calc('10 / 4')).toBe('2.5');
    expect(calc('7 % 3')).toBe('1');
    expect(calc('1 / 0')).toBe('0');
    expect(wildMatch('!hola*', '!HOLA mundo')).toBe(true);
    expect(wildMatch('a?c', 'abc')).toBe(true);
    expect(wildMatch('a?c', 'abbc')).toBe(false);
  });
});

describe('variables y control de flujo', () => {
  it('var, set, inc, dec y aritmética simple', () => {
    engine.load('t.mrc', `alias prueba {
  var %a = 5, %b = 2
  %a = %a + %b
  inc %a
  dec %b 2
  set %global hola mundo
  echo -a %a %b %global
}`);
    run('prueba');
    expect(out).toEqual(['8 0 hola mundo']);
    expect(engine.vars.get('global')).toBe('hola mundo');
    expect(engine.vars.has('a')).toBe(false);
  });

  it('if / elseif / else con operadores', () => {
    engine.load('t.mrc', `alias clasifica {
  if ($1 isnum) && ($1 > 10) { return grande }
  elseif ($1 isnum) { return pequeño }
  elseif (ho isin $1) return saludo
  else { return otro }
}
alias test { echo -a $clasifica(50) $clasifica(3) $clasifica(hola) $clasifica(xyz) }`);
    run('test');
    expect(out).toEqual(['grande pequeño saludo otro']);
  });

  it('while con break y continue', () => {
    engine.load('t.mrc', `alias cuenta {
  var %i = 0, %r
  while (%i < 10) {
    inc %i
    if (%i == 2) continue
    if (%i > 5) break
    %r = %r $+ %i
  }
  echo -a %r
}`);
    run('cuenta');
    expect(out).toEqual(['1345']);
  });

  it('detecta bucles infinitos y recursión sin colgarse', () => {
    engine.load('t.mrc', 'alias bucle { while (1) { noop } }\nalias rec { rec2 }\nalias rec2 { rec }');
    expect(run('bucle').error).toMatch(/bucle/);
    expect(run('rec').error).toMatch(/recursi/);
  });

  it('isop, ison, ischan y negaciones', () => {
    run('if (Jefa isop #sala) && (Voz !isop #sala) && (Nadie !ison #sala) && (#otra ischan) { echo -a ok }');
    run('if (!$1) echo -a vacío');
    expect(out).toEqual(['ok', 'vacío']);
  });

  it('una sola línea con | y comando sin llaves tras if', () => {
    run('if (1 == 2) echo -a no | echo -a siempre');
    expect(out).toEqual(['siempre']);
  });

  it('tablas hash', () => {
    run('hadd -m puntos ana 5 | hinc puntos ana 2 | hadd puntos luis 1 | echo -a $hget(puntos,ana) $hget(puntos,0).item $hget(puntos,2).item');
    expect(out).toEqual(['7 2 luis']);
  });

  it('$regex y $regml', () => {
    run('if ($regex(pedido 4521 listo,/pedido (\\d+)/i)) echo -a n= $+ $regml(1)');
    expect(out).toEqual(['n=4521']);
  });
});

describe('alias y comandos', () => {
  it('los alias reciben parámetros y delegan en comandos del cliente', () => {
    engine.load('t.mrc', 'alias saluda { msg $1 Hola $2- , soy $me }\nalias j join #$1');
    run('saluda #sala querida gente');
    run('j ayuda');
    expect(cmds).toEqual(['msg #sala Hola querida gente , soy Yo', 'join #ayuda']);
  });

  it('un alias que redefine un comando puede llamar al original', () => {
    engine.load('t.mrc', 'alias msg { echo -a enviando | msg $1- }');
    run('msg #sala hola');
    expect(out).toEqual(['enviando']);
    expect(cmds).toEqual(['msg #sala hola']);
  });

  it('los comandos desconocidos se envían al servidor', () => {
    run('whowas alguien');
    expect(raws).toEqual(['WHOWAS alguien']);
  });

  it('lo escrito con una sola barra no se evalúa', () => {
    engine.execLine('/echo -a $me', newContext({ cid: 's1' }), false);
    expect(out).toEqual(['$me']);
  });
});

describe('eventos', () => {
  const text = (t: string, extra: Partial<MslContext> = {}) =>
    engine.fire('TEXT', { cid: 's1', nick: 'ana', chan: '#sala', target: '#sala', address: 'u@host', text: t, ...extra });

  it('on TEXT con comodines y destino', () => {
    engine.load('bot.mrc', `on *:TEXT:!hola*:#:{ msg $chan Hola $nick $+ , dijiste: $2- }
on *:TEXT:*:?:{ msg $nick recibido en privado }`);
    text('!hola qué tal');
    text('otra cosa');
    text('hola', { chan: undefined, target: 'Yo' });
    expect(cmds).toEqual(['msg #sala Hola ana, dijiste: qué tal', 'msg ana recibido en privado']);
  });

  it('solo se ejecuta el primer manejador coincidente por script', () => {
    engine.load('a.mrc', 'on *:TEXT:*:#:echo -a primero\non *:TEXT:*:#:echo -a segundo');
    engine.load('b.mrc', 'on *:TEXT:*:#sala:echo -a otro script');
    text('algo');
    expect(out).toEqual(['primero', 'otro script']);
  });

  it('^ con haltdef oculta el mensaje y el prefijo ! excluye al propio usuario', () => {
    engine.load('a.mrc', 'on ^*:TEXT:*spam*:#:{ haltdef }\non !*:JOIN:#:{ msg $chan Bienvenido, $nick }');
    expect(engine.fire('TEXT', { cid: 's1', nick: 'x', chan: '#sala', text: 'esto es spam' }, true).haltdef).toBe(true);
    expect(engine.fire('TEXT', { cid: 's1', nick: 'x', chan: '#sala', text: 'normal' }, true).haltdef).toBe(false);
    engine.fire('JOIN', { cid: 's1', nick: 'Yo', chan: '#sala', isMe: true });
    engine.fire('JOIN', { cid: 's1', nick: 'ana', chan: '#sala', isMe: false });
    expect(cmds).toEqual(['msg #sala Bienvenido, ana']);
  });

  it('raw numérico y eventos sin destino', () => {
    engine.load('a.mrc', 'raw 433:*:echo -a nick en uso: $2\non *:CONNECT:echo -a conectado a $network\non *:NICK:echo -a $nick -> $newnick');
    engine.fire('RAW', { cid: 's1', numeric: '433', text: 'Yo Deseado :Nickname is already in use' });
    engine.fire('CONNECT', { cid: 's1' });
    engine.fire('NICK', { cid: 's1', nick: 'ana', newnick: 'ana2' });
    expect(out).toEqual(['nick en uso: Deseado', 'conectado a TestNet', 'ana -> ana2']);
  });

  it('informa de construcciones no admitidas sin romper el resto', () => {
    const s = engine.load('m.mrc', 'dialog cosa {\n  title "x"\n}\nalias ok { echo -a bien }');
    expect(s.warnings.join(' ')).toMatch(/dialog/);
    run('ok');
    expect(out).toEqual(['bien']);
  });
});

describe('temporizadores y archivos', () => {
  it('los temporizadores evalúan al crearse y no al dispararse', async () => {
    run('timer -m 1 20 echo -a tic $1', { params: ['$me'] });
    await new Promise((r) => setTimeout(r, 80));
    expect(out).toEqual(['tic $me']);
    expect(engine.timers.size).toBe(0);
  });

  it('timer con nombre se puede detener', async () => {
    run('timerlatido -m 0 20 echo -a pum');
    await new Promise((r) => setTimeout(r, 70));
    run('timerlatido off');
    const n = out.length;
    expect(n).toBeGreaterThanOrEqual(2);
    await new Promise((r) => setTimeout(r, 60));
    expect(out.length).toBe(n);
  });

  it('write/$read quedan confinados a la carpeta de datos', () => {
    run('write notas.txt primera | write notas.txt segunda | echo -a $lines(notas.txt) $read(notas.txt,2)');
    expect(out).toEqual(['2 segunda']);
    expect(run('write ../fuera.txt malo').error).toMatch(/ruta/);
    expect(fs.existsSync(path.join(dataDir, '..', 'fuera.txt'))).toBe(false);
    run('echo -a ( $+ $read(/etc/passwd,1) $+ )');
    expect(out[out.length - 1]).toBe('()');
  });
});

describe('popups (menu)', () => {
  const SRC = `menu nicklist {
  Saludar a $1:msg $chan Hola, $1
  -
  Moderación
  .Dar voz:mode $chan +v $1
  .Expulsar:{
    msg $chan Adiós, $snick
    kick $chan $1 fuera
  }
  $iif($1 == Yo,Soy yo):echo -a yo
  -
}
menu channel,status {
  Canal $chan:echo -a en $chan
  Vacío
  .$null:noop
}`;

  it('construye el árbol evaluando etiquetas y ocultando lo vacío', () => {
    const s = engine.load('p.mrc', SRC);
    expect(s.warnings).toEqual([]);
    const m = engine.menu('nicklist', newContext({ cid: 's1', chan: '#sala', params: ['ana'] }));
    expect(m.map((e) => (e.separator ? '-' : e.label))).toEqual(['Saludar a ana', '-', 'Moderación']);
    expect(m[2].children!.map((e) => e.label)).toEqual(['Dar voz', 'Expulsar']);
    const mine = engine.menu('nicklist', newContext({ cid: 's1', chan: '#sala', params: ['Yo'] }));
    expect(mine.map((e) => e.label)).toContain('Soy yo');
    expect(engine.menu('channel', newContext({ cid: 's1', chan: '#sala' })).map((e) => e.label)).toEqual(['Canal #sala']);
    expect(engine.menu('query', newContext({ cid: 's1' }))).toEqual([]);
  });

  it('ejecuta el comando del elemento elegido con el nick seleccionado', () => {
    engine.load('p.mrc', SRC);
    const ctx = () => newContext({ cid: 's1', chan: '#sala', params: ['ana'] });
    const m = engine.menu('nicklist', ctx());
    expect(engine.runMenu(m[0].id!, ctx())).toBe(true);
    expect(engine.runMenu(m[2].children![1].id!, ctx())).toBe(true);
    expect(cmds).toEqual(['msg #sala Hola, ana', 'msg #sala Adiós, ana', 'kick #sala ana fuera']);
    expect(engine.runMenu('p.mrc\u00009\u00009', ctx())).toBe(false);
  });
});

describe('goto y corchetes de evaluación', () => {
  it('goto salta a etiquetas del mismo bloque y de bloques exteriores', () => {
    engine.load('g.mrc', `alias cuenta {
  var %i = 0
  :otra
  inc %i
  if (%i < 4) { goto otra }
  if ($1 == salta) goto fin
  echo -a no saltó %i
  :fin
  echo -a fin %i
}`);
    run('cuenta');
    run('cuenta salta');
    expect(out).toEqual(['no saltó 4', 'fin 4', 'fin 4']);
  });

  it('goto a una etiqueta inexistente o en bucle infinito da error en vez de colgarse', () => {
    engine.load('g.mrc', 'alias a { goto nada }\nalias b { :x | goto x }');
    expect(run('a').error).toMatch(/etiqueta :nada/);
    expect(run('b').error).toMatch(/goto/);
  });

  it('variables dinámicas con [ $+ [ ] ]', () => {
    engine.load('v.mrc', `alias punto {
  inc %puntos. [ $+ [ $1 ] ]
  set %ultimo. [ $+ [ $1 ] ] $2-
  echo -a $1 lleva %puntos. [ $+ [ $1 ] ] ( %ultimo. [ $+ [ $1 ] ] )
}`);
    run('punto ana gol de cabeza');
    run('punto ana penalti');
    run('punto luis falta');
    expect(out).toEqual(['ana lleva 1 ( gol de cabeza )', 'ana lleva 2 ( penalti )', 'luis lleva 1 ( falta )']);
    expect(engine.vars.get('puntos.ana')).toBe('2');
  });

  it('el valor de un corchete no se reevalúa', () => {
    run('echo -a valor: [ $1- ] fin', { params: ['$me', '%x', '$calc(1+1)'] });
    expect(out).toEqual(['valor: $me %x $calc(1+1) fin']);
  });
});

describe('sockets', () => {
  it('abre una conexión, escribe, lee línea a línea y recibe el cierre', async () => {
    const net = await import('node:net');
    const got: string[] = [];
    const srv = net.createServer((sock) => {
      sock.setEncoding('utf8');
      sock.on('data', (d: string) => {
        got.push(d);
        sock.write('HTTP/1.0 200 OK\r\nX-Dato: 42\r\n\r\ncuerpo sin salto final');
        sock.end();
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as import('node:net').AddressInfo).port;
    engine.load('s.mrc', `alias pide { sockopen web 127.0.0.1 $1 }
on *:SOCKOPEN:web:{
  if ($sockerr > 0) { echo -a fallo | return }
  sockwrite -n $sockname GET / HTTP/1.0
}
on *:SOCKREAD:web:{
  var %l
  sockread %l
  if ($sockbr == 0) return
  echo -a < $+ %l $+ >
}
on *:SOCKCLOSE:web:echo -a cerrado $sockname
on *:SOCKOPEN:malo:echo -a error $sockerr`);
    run(`pide ${port}`);
    for (let i = 0; i < 200 && !out.includes('cerrado web'); i++) await new Promise((r) => setTimeout(r, 20));
    expect(got).toEqual(['GET / HTTP/1.0\r\n']);
    expect(out).toEqual(['<HTTP/1.0 200 OK>', '<X-Dato: 42>', '<>', '<cuerpo sin salto final>', 'cerrado web']);
    expect(engine.socks.size).toBe(0);
    srv.close();

    run('sockopen malo 127.0.0.1 1');
    for (let i = 0; i < 200 && !out.includes('error 3'); i++) await new Promise((r) => setTimeout(r, 20));
    expect(out[out.length - 1]).toBe('error 3');
  });
});
