# Onda IRC

Cliente IRC de escritorio (Windows, macOS y Linux) con las funciones clásicas de mIRC
y soporte para el IRC moderno. Hecho con Electron y TypeScript. «Onda IRC» es un nombre provisional.

## Qué incluye

- **Varias redes a la vez**, con canales, conversaciones privadas, lista de nicks, temas y avisos de mensajes sin leer y menciones.
- **Scripts compatibles con mIRC** (`.mrc`): alias, eventos `on`, `raw`, `ctcp`, variables, `if/elseif/else`, `while`,
  temporizadores, tablas hash, tokens y los identificadores más habituales. Editor integrado en «Scripts».
- **IRCv3**: TLS, autenticación SASL, hora del servidor, historial (`chathistory`), aviso de «está escribiendo» y reacciones.
- **DCC**: envío y recepción de archivos y chat directo. Las ofertas entrantes nunca se aceptan solas.
- **Registros** de conversación en texto plano, con buscador.
- **Temas** oscuro, claro y clásico; colores y formato de mIRC; completado de nicks con Tab; historial de entrada.

## Uso

```bash
npm install
npm start        # compila y abre la aplicación
npm test         # pruebas (las de integración usan ngircd si está instalado)
```

Dentro de la aplicación: «Conectar», o `/server irc.libera.chat` y `/join #canal`. `/help` lista los comandos.
Como en mIRC, `/comando` no evalúa identificadores y `//comando` sí (`//echo -a $me`).

## Ejemplo de script

```mirc
on *:TEXT:!dado*:#:{
  var %caras = $iif($2 isnum,$2,6)
  msg $chan $nick saca un $rand(1,%caras) de %caras
}
alias saluda { me saluda a $1 }
```

## Compatibilidad con el scripting de mIRC

Admitido: `alias`, `on TEXT/ACTION/NOTICE/JOIN/PART/QUIT/NICK/KICK/TOPIC/MODE/CONNECT/DISCONNECT/INPUT/LOAD`, `raw`, `ctcp`,
prefijos `^`, `!` y `me`, `var/set/unset/inc/dec`, `timer`, `hadd/hget…`, `write/$read`, `$regex`, `$calc`, `$gettok` y afines.

Todavía no admitido: `menu` (popups), `dialog`, `goto`, corchetes de evaluación `[ ]`, niveles de usuario, sockets (`sockopen`),
ventanas personalizadas (`/window`) y COM/DLL. Al cargar un script se avisa de lo que se ha ignorado.

Diferencias deliberadas, por seguridad: el texto recibido de la red nunca se reevalúa, los temporizadores no
reevalúan su comando al dispararse y `/write`, `$read` y similares solo acceden a la carpeta de datos de scripts.

## Pendiente

- Instaladores para cada sistema (por ahora se ejecuta con `npm start`).
- DCC pasivo/inverso (necesario detrás de algunos routers) y reanudación de transferencias.
- Pasarelas a otras redes de mensajería (Telegram).
- Las contraseñas de las redes guardadas se almacenan sin cifrar.

## Estructura

- `src/core/irc` — protocolo, cliente y formato.
- `src/core/msl` — intérprete de scripts mIRC.
- `src/core/app.ts` — sesiones, comandos, DCC y registros (sin dependencias de Electron).
- `src/main`, `src/renderer` — ventana e interfaz.
