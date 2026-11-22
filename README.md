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
npm run dist     # genera el instalador del sistema en el que se ejecuta (carpeta release/)
```

Los instaladores de Windows (`.exe`), macOS (`.dmg`) y Linux (`.AppImage`) los genera el flujo «Instaladores» de GitHub Actions:
al publicar una etiqueta `v*` se adjuntan a la versión, y también se puede lanzar a mano. No están firmados, así que
Windows y macOS mostrarán un aviso la primera vez que se abran.

Dentro de la aplicación: «Conectar», o `/server RogerNet` (la red propia, `irc.rogertp.es:6697` con TLS, ya viene guardada y entra en `#general`). `/help` lista los comandos.
Como en mIRC, `/comando` no evalúa identificadores y `//comando` sí (`//echo -a $me`).

## RogerNet (irc.rogertp.es)

- Servidor Ergo; único puerto público: 6697 con TLS.
- Cuentas: `/msg NickServ REGISTER contraseña` registra tu nick. Después rellena «Cuenta (SASL)» y «Contraseña (SASL)» en
  «Conectar» para identificarte al entrar; un nick registrado exige autenticarse.
- Los mensajes que llegan por el puente de Telegram usan nicks `Nombre/tg`; el cliente los muestra como «Nombre» con la etiqueta «Telegram».
- El servidor oculta tu IP, pero un DCC es una conexión directa y la revela a la otra persona.

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
prefijos `^`, `!` y `me`, popups `menu` (nicklist, channel, query, status), `var/set/unset/inc/dec`, `timer`, `hadd/hget…`, `write/$read`, `$regex`, `$calc`, `$gettok` y afines.

Todavía no admitido: `dialog`, `goto`, corchetes de evaluación `[ ]`, niveles de usuario, sockets (`sockopen`),
ventanas personalizadas (`/window`) y COM/DLL. Al cargar un script se avisa de lo que se ha ignorado.

Diferencias deliberadas, por seguridad: el texto recibido de la red nunca se reevalúa, los temporizadores no
reevalúan su comando al dispararse y `/write`, `$read` y similares solo acceden a la carpeta de datos de scripts.

## Pendiente

- Firma de los instaladores e icono propio de la aplicación.
- DCC pasivo/inverso (necesario detrás de algunos routers) y reanudación de transferencias.
- Pasarelas a otras redes de mensajería (Telegram).
- Las contraseñas de las redes guardadas se almacenan sin cifrar.

## Estructura

- `src/core/irc` — protocolo, cliente y formato.
- `src/core/msl` — intérprete de scripts mIRC.
- `src/core/app.ts` — sesiones, comandos, DCC y registros (sin dependencias de Electron).
- `src/main`, `src/renderer` — ventana e interfaz.
