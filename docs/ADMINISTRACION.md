# Administración de clubes, equipos y códigos

> **Estado:** implementado y probado en local. **Sin desplegar.**
>
> - Todas las escrituras son operaciones críticas y siguen **desactivadas** (`ADMIN_CRITICAL_OPS = "disabled"`).
> - No hay clubes ni equipos en D1.
> - La migración `0003` no está aplicada en remoto.
> - La PWA no se ha modificado.

## Arquitectura

El panel lo sirve el propio Worker en `<api>/admin`, en el **mismo origen** que la API:

```
Navegador ── Cloudflare Access (/admin, /api/admin/*) ──► Worker ──► archivos del panel (ASSETS)
                                                                 └► API /api/admin/* ──► D1
PWA (develop.galipau-stats.pages.dev) ── Bearer token de dispositivo, CORS sin cookies ──► /api/teams/*
```

- **Mismo origen:** la protección CSRF de las escrituras sigue igual. El panel hace `fetch` al propio origen con JSON, así que el navegador envía `Sec-Fetch-Site: same-origin` y `Origin`.
- **Sin CORS en la administración:** ni el panel ni `/api/admin/*` responden con cabeceras CORS.
- **El Worker se ejecuta siempre primero** (`run_worker_first: true`): antes de servir cualquier archivo del panel verifica el JWT de Access y que la identidad tenga un rol administrativo. Así el panel no depende solo de la configuración de Access.
- **Cabeceras del panel:** CSP estricta (solo recursos propios, sin incrustarse en otras webs), `X-Frame-Options: DENY`, `no-referrer` y `no-store`.
- **Código separado de la PWA:** el panel está en `admin/` (React, el mismo sistema de diseño) y se compila con `npm run build:admin` a `server/admin-dist/`, que no se sube a Git. Wrangler lo compila solo antes de `dev` y `deploy`. La compilación de la PWA y su despliegue en Pages no cambian.
- **Punto de entrada del Worker:** `server/src/index.ts` solo exporta el manejador; la lógica está en `app.ts`. Con archivos estáticos, el runtime trata cada exportación con nombre de ese módulo como un punto de entrada y rechaza las que no lo son. Una prueba lo vigila.

## Pantallas del panel

| Pantalla | Contenido |
| -------- | --------- |
| Clubes | Lista con estado (activo o suspendido) y alta de club (solo superadministrador) |
| Club | Equipos agrupados por temporada (más reciente primero), alta de equipo, datos del club y estado (solo superadministrador) |
| Equipo | Identificador y temporada; los dos códigos (mostrar, copiar, regenerar, revocar); datos del equipo |

- Si las escrituras no están habilitadas (`/api/admin/me` devuelve `criticalOpsEnabled: false`), los formularios aparecen desactivados con un aviso.
- **Verificación reforzada:** si una operación crítica necesita biometría, el panel lleva al usuario a `/api/admin/critical/reauth?return=/admin/#/…`.
  - Access pide la biometría de la aplicación crítica y el Worker devuelve al panel.
  - La vuelta solo admite rutas internas del panel; cualquier otra lleva a `/admin/`.

## Clubes

| Operación | Superadmin | Admin de club (su club) |
| --------- | :--------: | :---------------------: |
| Ver clubes y su ficha | Todos, también suspendidos | Solo el suyo y activo |
| Crear y eliminar clubes | ✔ | — |
| Editar nombre y nombre corto | ✔ | ✔ |
| Suspender y reactivar | ✔ | — |
| Crear y editar equipos | ✔ | ✔ |

- **Suspensión** (`status = 'suspended'`, migración `0003`):
  - corta el acceso operativo a todos sus equipos: lecturas, escrituras, sincronización, consulta de códigos y canje de invitaciones;
  - su administrador de club deja de verlo;
  - es reversible y no borra nada;
  - solo el superadministrador conserva el acceso para revisarlo y reactivarlo.
- **Eliminación:** es un borrado lógico (`deleted_at`) y corta el acceso a todos.

## Equipos y temporadas

- Cada equipo pertenece a un club y a una temporada (`AAAA/AA`).
- Su identificador (por ejemplo `SMA2627`) es único dentro del club. **Solo identifica: no da acceso.**
- El identificador y la temporada no se editan. La temporada siguiente tiene **equipos nuevos**, con identificador y códigos nuevos (por ejemplo `SMA2728`).
- Nombre, categoría y modalidad sí se editan.

**Datos de referencia del primer club** (no insertados en D1). Las pruebas los crean solo en una base en memoria.

| Club Balonmano Burjassot — 2026/27 | Identificador |
| --- | --- |
| Senior Masculino A | `SMA2627` |
| Senior Masculino B | `SMB2627` |
| Senior Femenino A | `SFA2627` |
| Senior Femenino B | `SFB2627` |

## Dos códigos por equipo

| Código | Concede | Pueden verlo | Pueden regenerarlo o revocarlo |
| ------ | ------- | ------------ | ------------------------------ |
| Entrenador | `coach` | superadmin, admin del club, entrenadores del equipo | superadmin, admin del club |
| Jugador/familia | `viewer` | superadmin, admin del club, entrenadores y consulta del equipo | superadmin, admin del club |

- **Al crear un equipo** se generan los dos códigos en la misma transacción: no puede quedar un equipo sin códigos.
- **Independientes:** como máximo hay uno vigente de cada tipo. Regenerar o revocar uno no toca el otro.
  - **Regenerar** crea un código nuevo y anula el anterior para nuevos canjes. Los dispositivos que ya entraron conservan el acceso.
  - **Revocar** deja ese tipo sin código. Con `revokeAccess` retira además el acceso de los dispositivos que entraron con él (código filtrado).
- **Vigencia:** durante la temporada, hasta el **1 de agosto** del año siguiente al de inicio (julio como margen), salvo regeneración o revocación. Después, la temporada nueva usa sus equipos y códigos nuevos.
- **Dispositivos:**
  - conservan su acceso entre sesiones con su token, que no caduca y es revocable;
  - la caducidad de un código solo impide **nuevos** canjes.
- **El entrenador ve los dos códigos**, así que puede compartir el suyo. Es una decisión aprobada y conviene tenerla presente.

### Almacenamiento cifrado recuperable

- **Dos formas de guardar cada código:**
  - `code_hash`: HMAC-SHA-256 con `TOKEN_PEPPER`, para canjearlo (con el límite de intentos);
  - `code_enc` (migración `0003`): AES-256-GCM con **`INVITE_CODE_KEY`**, un secret del servidor distinto de `TOKEN_PEPPER`, para volver a mostrarlo.
- **Datos asociados:** cada código cifrado incluye la invitación, el equipo y el rol. Un texto cifrado copiado a otra fila, por ejemplo el de entrenador a la de consulta, no se descifra.
- **Versionado:** el formato lleva versión (`v1.`) para poder rotar la clave.
- **Sin la clave**, crear, regenerar o mostrar códigos responde **503** (`codes_unavailable`), sin filtrar nada.
- **Exposición:**
  - los códigos solo aparecen en respuestas a quien tiene permiso, siempre con `Cache-Control: no-store`;
  - nunca aparecen en registros, porque el Worker solo registra errores inesperados, sin datos de la petición;
  - la respuesta para un dispositivo de consulta ni siquiera menciona el código de entrenador.
- **Invitaciones anteriores a `0003`** (sin copia cifrada): se muestran como «no disponible» y hay que regenerarlas. Hoy no existe ninguna.

## API

**Dispositivos** (PWA; `Authorization: Bearer <token>`; CORS solo para los orígenes de la app, sin cookies ni credenciales):

| Ruta | Permiso |
| ---- | ------- |
| `GET /api/teams/:teamId/codes` | Cualquier rol del equipo; el de entrenador solo con `codes.coach.read` |

**Administración** (Cloudflare Access; mismo origen; sin CORS):

| Ruta | Notas |
| ---- | ----- |
| `GET /admin`, `/admin/*` | Panel |
| `GET /api/admin/me` | Incluye `criticalOpsEnabled` |
| `GET /api/admin/clubs`, `GET /api/admin/clubs/:clubId` | Ficha con equipos y qué códigos están vigentes (sin el código) |
| `GET /api/admin/teams/:teamId/codes` | Los dos códigos |
| `POST /api/admin/critical/clubs` · `PATCH …/clubs/:clubId` · `POST …/clubs/:clubId/status` · `DELETE …/clubs/:clubId` | Escrituras de club |
| `POST /api/admin/critical/clubs/:clubId/teams` · `PATCH /api/admin/critical/teams/:teamId` | Equipos |
| `POST /api/admin/critical/teams/:teamId/codes/:role/regenerate` · `…/revoke` | Códigos (`role` = `coach` o `viewer`) |
| `GET /api/admin/critical/reauth?return=…` | Vuelta al panel tras la biometría |

Todas las rutas `/api/admin/critical/*`:

- responden **503** mientras `ADMIN_CRITICAL_OPS` no sea `"enabled"`;
- exigen, además, el token de la aplicación crítica de Access (401 si no);
- requieren la protección CSRF y los permisos de cada operación.

## Pantallas futuras en la PWA (diseño, sin implementar)

Requieren antes que la PWA guarde su token de dispositivo (Tarea 005E: almacén nuevo en IndexedDB, solo aditivo, sin tocar los datos actuales).

- **Ajustes → Equipo → «Códigos del equipo»**, con los datos de `GET /api/teams/:teamId/codes`:
  - **Entrenador:** dos tarjetas («Código de entrenador» y «Código de jugador/familia»), cada una con el código oculto, *Mostrar*, *Copiar* y su fecha de validez. Un aviso recuerda que el código de entrenador permite registrar partidos. Sin botones para regenerar ni revocar: eso se hace en el panel.
  - **Consulta:** una sola tarjeta con el código de jugador/familia, para compartirlo con la familia.
- **Jugador favorito** (solo dispositivos de consulta): selector en la plantilla, guardado solo en el dispositivo. Se puede cambiar cuando se quiera, no se envía al servidor y no concede ningún permiso.
- **Sin conexión**, la pantalla de códigos muestra «Disponible con conexión», sin códigos guardados en caché.

## Pasos manuales en Cloudflare (pendientes, con autorización)

1. **Access:** añadir `/admin` y `/admin/*` como destinos de la aplicación general «GalipauStats admin» de preview, con la misma política. La aplicación crítica no cambia.
2. **Secret de cifrado:** generar un valor distinto por entorno y guardarlo. No se escribe en ningún archivo.
   ```bash
   node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
   npx wrangler secret put INVITE_CODE_KEY --env preview
   ```
   Si se pierde o se cambia, los códigos guardados dejan de poder mostrarse y hay que regenerarlos; el canje no se ve afectado.
3. **Migración:** aplicar `0003` en preview: `npx wrangler d1 migrations apply DB --env preview --remote`.
4. **Despliegue:** desplegar preview (`npx wrangler deploy --env preview`, que compila el panel). Comprobar que:
   - `/admin/` pide Access y luego muestra el panel con las escrituras desactivadas;
   - `/api/health` responde 200.
5. Las operaciones críticas siguen desactivadas hasta completar las verificaciones pendientes de [AUTENTICACION_ADMIN.md](AUTENTICACION_ADMIN.md#verificación-manual-del-segundo-factor): que la biometría se vuelve a pedir pasado el tiempo configurado y la medición de `iat` y `exp` del token crítico. Las cookies de Access ya están endurecidas en preview (`SameSite=Lax` y *Binding Cookie*).
