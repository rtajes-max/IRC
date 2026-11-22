# Firma de los instaladores con SignPath Foundation

SignPath Foundation firma gratis programas de código abierto. El repositorio ya está preparado; lo que falta
solo puede hacerlo quien administra el proyecto.

## 1. Requisitos que debe cumplir el proyecto

Según las condiciones de <https://signpath.org/terms> (léelas antes de solicitarlo; pueden cambiar):

- [ ] **Repositorio público.** Ahora mismo es privado.
- [x] Licencia de código abierto aprobada por OSI (MIT), sin componentes propietarios.
- [ ] **Proyecto ya publicado** en la forma que se va a firmar: debe existir una versión descargable (por ejemplo `v0.3.0`).
- [x] Descripción de lo que hace el programa en la página de descarga (README).
- [x] Sección «Code signing policy» en el README, con los roles del equipo y la declaración de privacidad.
- [x] Desinstalador (lo incluye el instalador de Windows).
- [ ] **Verificación en dos pasos** activada en GitHub y en SignPath para todos los miembros del equipo.
- [x] Compilación reproducible desde el código en GitHub Actions, con ejecutores de GitHub.

La aceptación la decide SignPath Foundation y no está garantizada.

## 2. Solicitud

1. Haz público el repositorio y publica una primera versión (etiqueta `v0.3.0`; el flujo «Instaladores» adjunta los archivos).
2. Rellena el formulario de <https://signpath.org/apply>.

## 3. Configuración en SignPath (cuando acepten el proyecto)

1. En la organización de SignPath, añade el sistema de compilación de confianza «GitHub.com» y enlázalo al proyecto.
2. Crea el proyecto y una política de firma (anota sus identificadores, los «slug»).
3. Crea dos configuraciones de artefacto, con estos identificadores exactos:

   `aplicacion`

   ```xml
   <artifact-configuration xmlns="http://signpath.io/artifact-configuration/v1">
     <zip-file>
       <pe-file path="Onda IRC.exe">
         <authenticode-sign/>
       </pe-file>
     </zip-file>
   </artifact-configuration>
   ```

   `instalador`

   ```xml
   <artifact-configuration xmlns="http://signpath.io/artifact-configuration/v1">
     <zip-file>
       <pe-file path="Onda IRC Setup *.exe">
         <authenticode-sign/>
       </pe-file>
     </zip-file>
   </artifact-configuration>
   ```

   SignPath exige además restringir los metadatos de los binarios (nombre y versión del producto); añade esas
   restricciones siguiendo su documentación.
4. Crea un token de API para un usuario con permiso de envío.

## 4. Configuración en GitHub

En el repositorio, en Settings → Secrets and variables → Actions:

| Tipo | Nombre | Valor |
|---|---|---|
| Secreto | `SIGNPATH_API_TOKEN` | El token de API de SignPath |
| Variable | `SIGNPATH_ORGANIZATION_ID` | Identificador de la organización en SignPath |
| Variable | `SIGNPATH_PROJECT_SLUG` | Identificador del proyecto |
| Variable | `SIGNPATH_SIGNING_POLICY_SLUG` | Identificador de la política de firma |

Con la variable `SIGNPATH_ORGANIZATION_ID` definida, el flujo «Instaladores» firma el ejecutable y el instalador de
Windows al publicar una etiqueta `v*` o al lanzarlo a mano. En los pull requests nunca se firma. Cada firma debe
aprobarla a mano un miembro del equipo en SignPath; el flujo espera hasta una hora.

## Estado

Los pasos de firma del flujo están escritos a partir de la documentación de SignPath, pero **no se han podido
probar** porque todavía no existe la cuenta. Es de esperar algún ajuste en la primera ejecución. El desinstalador
que genera el instalador queda sin firmar.
