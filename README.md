# Onda IRC

Cliente IRC de escritorio (Windows, macOS y Linux) con las funciones clásicas de mIRC
y soporte para el IRC moderno. Hecho con Electron y TypeScript. «Onda IRC» es un nombre provisional.

## Qué incluye

- **Varias redes a la vez**, con canales, conversaciones privadas, lista de nicks, temas y avisos de mensajes sin leer y menciones.
- **Scripts compatibles con mIRC** (`.mrc`): alias, eventos `on`, `raw`, `ctcp`, variables, `if/elseif/else`, `while`,
  temporizadores, tablas hash, tokens y los identificadores más habituales. Editor integrado en «Scripts».
- **IRCv3**: TLS, autenticación SASL, hora del servidor, historial (`chathistory`), aviso de «está escribiendo» y reacciones.
- **DCC**: envío y recepción de archivos (también en modo pasivo, con `/dcc send -p`, para quien no puede recibir conexiones) y chat directo. Las ofertas entrantes nunca se aceptan solas.
- **Contraseñas** de las redes guardadas cifradas con el almacén de claves del sistema, cuando está disponible.
- **Uso diario**: reconexión automática volviendo a los canales abiertos, detección de conexiones caídas y lista de ignorados (`/ignore`).
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
- Cuentas: `/register contraseña` registra tu nick y guarda la cuenta en la red para identificarte sola al entrar (SASL).
  Un nick registrado exige autenticarse.
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

Admitido:

- `alias`, `on TEXT/ACTION/NOTICE/JOIN/PART/QUIT/NICK/KICK/TOPIC/MODE/CONNECT/DISCONNECT/INPUT/LOAD`, `raw`, `ctcp`, con prefijos `^`, `!` y `me`.
- Popups `menu` (nicklist, channel, query, status) con submenús y separadores.
- `var/set/unset/inc/dec`, variables dinámicas con corchetes (`%puntos. [ $+ [ $nick ] ]`), `if/elseif/else`, `while`, `goto`.
- `timer`, tablas hash (`hadd`, `$hget`…), tokens (`$gettok`…), `$regex`, `$calc`, `write/$read`.
- Sockets: `sockopen [-e]`, `sockwrite`, `sockread`, `sockclose` y los eventos `SOCKOPEN/SOCKREAD/SOCKCLOSE`.
- Ventanas personalizadas: `/window @nombre`, `/aline`, `/echo @nombre` y `on INPUT` sobre ellas.
- Diálogos: tablas `dialog` con `text`, `edit`, `button`, `check`, `radio`, `list`, `combo` y `box`; `/dialog -m/-x/-t`, `/did`,
  `$did`, `$dialog` y `on DIALOG` (`init`, `sclick`, `dclick`, `edit`, `close`).

No admitido: controles de diálogo `tab`, `icon`, `menu` y `scroll`, niveles de usuario, ventanas con imágenes (`/window -p`, `/drawrect`…),
sockets de escucha y UDP, y COM/DLL (propios de Windows). Al cargar un script se avisa de lo que se ha ignorado.

Diferencias deliberadas, por seguridad: el texto recibido de la red nunca se reevalúa (tampoco dentro de `[ ]`), los
temporizadores no reevalúan su comando al dispararse y `/write`, `$read` y similares solo acceden a la carpeta de datos de scripts.

## Pendiente

- Firma de los instaladores (requiere certificados de pago de Windows y Apple).
- Reanudar transferencias DCC interrumpidas.

## Estructura

- `src/core/irc` — protocolo, cliente y formato.
- `src/core/msl` — intérprete de scripts mIRC.
- `src/core/app.ts` — sesiones, comandos, DCC y registros (sin dependencias de Electron).
- `src/main`, `src/renderer` — ventana e interfaz.
