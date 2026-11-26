# Cuentas de club (propietario y administradores)

Base técnica de la autogestión de clubes: cuentas con inicio de sesión por código de
correo, un propietario por club y varios administradores. **Desactivada en todos los
entornos** (`ACCOUNTS_ENABLED` sin definir): no hay interfaz y la migración 0008 no está
aplicada en ninguna D1 remota. Con el interruptor apagado, el Worker no carga el módulo y
funciona sin la migración 0008; `/api/account/*` y `/api/club/*` siguen el camino de
cualquier ruta desconocida (401 sin token de dispositivo, 404 con él), como antes.

Nada de esto cambia a los entrenadores y usuarios de consulta, que siguen entrando con
los códigos de equipo, ni a la superadministración, que sigue en Cloudflare Access.

## Interruptores

| Variable | Valor | Efecto |
| -------- | ----- | ------ |
| `ACCOUNTS_ENABLED` | `true` (exacto) | La función existe en ese entorno. Cualquier otro valor o ninguno: el Worker responde exactamente igual que antes y la biblioteca ni se carga |
| `ACCOUNTS_PUBLIC_SIGNUP` | `true` (exacto) | Registro libre: cualquiera crea su cuenta, verifica su correo y da de alta su club como propietario, sin aprobación. Con otro valor, solo pueden crear cuenta los correos con una invitación pendiente y no se pueden crear clubes |

Son independientes: «función todavía no publicada» (`ACCOUNTS_ENABLED` apagado) y
«registro libre habilitado» (`ACCOUNTS_PUBLIC_SIGNUP=true`) son estados distintos.

Con `ACCOUNTS_ENABLED=true` también hacen falta (si falta algo, las rutas de cuentas
responden 503 `accounts_not_configured` y no se arranca nada):

| Variable | Tipo | Requisito |
| -------- | ---- | --------- |
| `ACCOUNTS_ORIGIN` | variable | Origen exacto donde se sirven las cuentas (`https://…`; `http://localhost` solo en local y pruebas). En cualquier otro host, las rutas no existen |
| `BETTER_AUTH_SECRET` | secret | Clave de firma de las sesiones, al menos 32 caracteres |
| `TOKEN_PEPPER` | secret | La de siempre; aquí, para los contadores de límites |
| `TURNSTILE_SECRET_KEY` | secret | Obligatoria salvo en local y pruebas |
| Proveedor de correo | — | Pendiente (tarea posterior). Hoy solo hay correo simulado en las pruebas y la consola en `wrangler dev` local |

## Biblioteca de autenticación

`better-auth` **1.7.28**, versión exacta (en `server/package.json`, sin `^`). Solo se
usan el núcleo, el plugin de código por correo (`emailOTP`) y el de Turnstile
(`captcha`). La configuración completa está en [`server/src/accounts/auth.ts`](../server/src/accounts/auth.ts)
y una prueba comprueba sus valores, para que nada dependa de valores por defecto.

| Aspecto | Valor |
| ------- | ----- |
| Código | 6 cifras, 5 minutos, guardado con hash (SHA-256), 3 intentos; pedir otro invalida el anterior |
| Sesión | 7 días, renovación diaria, sin caché en cookie (revocación inmediata) |
| Cookie | `__Secure-gs.session_token`, HttpOnly, Secure, SameSite=Strict, `Path=/`, sin `Domain` (solo ese host). La reciben las rutas de cuentas y las administrativas del club del mismo origen; recibirla no concede nada: cada ruta exige sesión válida, cuenta activa y su propio permiso |
| Origen y CSRF | `trustedOrigins` = solo `ACCOUNTS_ORIGIN`; `baseURL` fija; comprobaciones activadas explícitamente; además, las mismas defensas que la administración (origen propio y cuerpo JSON) |
| Límite por IP | En D1 (`auth_rate_limit`): pedir código 3/min, entrar y verificar 5/min, resto 60/min |
| Límite por correo | 5 códigos por hora y dirección, sea cual sea la IP (en `auth_attempts`, con HMAC) |
| Altas de club | 3 por cuenta y día, contadas dentro del mismo batch que crea el club |
| Turnstile | Al pedir código, al entrar y al verificar el correo |
| Desactivado | Contraseñas, cambio de correo, borrado de cuenta por el usuario, vinculación de cuentas, telemetría |

### Cómo se crean las cuentas

Siempre por el flujo público de la biblioteca: pedir código y entrar con él. No hay
escrituras directas en sus tablas. Quién puede crear cuenta lo decide el hook
documentado `databaseHooks.user.create.before`:

- con registro libre, cualquiera;
- sin él, solo un correo con una invitación pendiente y vigente.

Antes, un filtro previo evita enviar códigos que no llevan a nada: a un correo sin
cuenta y sin permiso para crearla, o a una cuenta desactivada, se le responde lo mismo
que a cualquiera (`{"success": true}`) sin enviar nada. El hook es la garantía; el
filtro solo ahorra correos.

## Registro libre (cuando se habilite)

1. La persona pide un código para su correo y entra con él: se crea su cuenta, ya
   verificada (el código prueba que el correo es suyo).
2. Crea su club (`POST /api/account/clubs` con un identificador UUID propuesto por el
   cliente y el nombre). En un solo batch se crean el club, su propietario y la
   auditoría. Si la petición se repite, devuelve el mismo club.
3. Es propietaria desde ese momento, sin aprobación de la superadministración.
4. Invita a sus administradores por correo.

Mientras `ACCOUNTS_PUBLIC_SIGNUP` no esté a `true`, el paso 2 responde 403
`signup_closed` y solo entran los invitados.

## Modelo de datos (migración 0008)

Exclusivamente aditiva: solo crea tablas, índices y triggers; no cambia ninguna fila
existente. Los clubes actuales (el Burjassot incluido) quedan **sin propietario** y
siguen gestionados desde la administración.

| Tabla | Contenido |
| ----- | --------- |
| `auth_user`, `auth_session`, `auth_account`, `auth_verification`, `auth_rate_limit` | De la biblioteca. Es exactamente el SQL que genera la versión fijada (una prueba lo compara) |
| `account_state` | Estado de la cuenta (activa o desactivada). Sin fila = activa |
| `club_owners` | Propietario vigente; la clave primaria es el club |
| `club_memberships` | Administradores; una membresía activa por club y cuenta |
| `club_invitations` | Invitaciones por correo; una pendiente por club y correo; 7 días |
| `club_owner_transfers` | Transferencias de propiedad; una pendiente por club; 7 días |
| `account_audit` | Auditoría de las cuentas de club (la de Access sigue en `admin_audit`) |

### Invariantes que impone la base

- Un club autogestionado tiene **exactamente un propietario**: la fila no se puede
  borrar (solo desaparece al borrar el club), ni vaciar, ni duplicar, ni mover.
- El propietario es una cuenta existente, activa y con el correo verificado.
- El propietario no es además administrador del mismo club.
- No se puede desactivar una cuenta que posee algún club: antes hay que transferirlo.
- Una cuenta desactivada no recibe membresías ni la propiedad.
- Invitaciones y transferencias se deciden una sola vez y no se reabren.
- Aceptar una invitación crea la membresía y la auditoría en la misma sentencia. Solo
  la acepta la cuenta verificada de ese correo y solo si no ha caducado.
- Aceptar una transferencia cambia el propietario, pasa al anterior a administrador y
  retira la membresía del nuevo, todo en la misma sentencia. Solo la acepta quien la
  recibe, si sigue siendo administrador y el propietario no ha cambiado.
- Revocar a un administrador cancela la transferencia pendiente hacia él.
- Una membresía no cambia de club, cuenta ni rol, y una invitación no se redirige a otro club ni a otro correo.
- Las cuentas no se borran (se desactivan): toda referencia a `auth_user` es `ON DELETE RESTRICT` y la auditoría conserva siempre a su autor.

### Reglas del código

- Toda operación de varios pasos es un único batch de D1 o una sola sentencia con
  triggers: nunca hay escrituras parciales.
- Los resultados se confirman con `RETURNING`. En D1, `meta.changes` incluye las filas
  que modifican los triggers y no sirve para saber si una operación se aplicó.
- Los reintentos son idempotentes (alta de club, invitar, aceptar, revocar, decidir una
  transferencia, desactivar).

## Rutas (`/api/account/*` y `/api/club/*`, solo con el interruptor activado)

| Método y ruta | Quién | Uso |
| ------------- | ----- | --- |
| `POST /api/account/auth/email-otp/send-verification-otp` | cualquiera | Pedir código |
| `POST /api/account/auth/sign-in/email-otp` | cualquiera | Entrar (y crear la cuenta si está permitido) |
| `POST /api/account/auth/email-otp/verify-email` | cualquiera | Verificar el correo con un código |
| `GET /api/account/auth/get-session`, `GET …/list-sessions` | sesión | Sesión actual y sesiones de la cuenta |
| `POST /api/account/auth/sign-out`, `…/revoke-session`, `…/revoke-other-sessions`, `…/revoke-sessions` | sesión | Cerrar y revocar sesiones |
| `GET /api/account/me` | sesión | Cuenta, clubes con su rol, invitaciones y transferencias pendientes |
| `POST /api/account/deactivate` | sesión | Desactivar la propia cuenta |
| `POST /api/account/clubs` | sesión, registro libre | Crear club propio |
| `GET /api/account/clubs/:clubId` | propietario o administrador | Ficha del club |
| `POST /api/account/clubs/:clubId/invitations` | propietario | Invitar administrador |
| `POST /api/account/clubs/:clubId/invitations/:id/revoke` | propietario | Retirar invitación |
| `POST /api/account/clubs/:clubId/admins/:userId/revoke` | propietario | Retirar administrador |
| `POST /api/account/clubs/:clubId/leave` | administrador | Dejar de administrar |
| `POST /api/account/clubs/:clubId/transfer` | propietario | Proponer transferencia a un administrador |
| `POST /api/account/invitations/:id/accept` · `…/decline` | cuenta del correo invitado | Responder a una invitación |
| `POST /api/account/transfers/:id/accept` · `…/decline` | quien la recibe | Responder a una transferencia |
| `POST /api/account/transfers/:id/cancel` | quien la propuso | Cancelarla |
| `GET /api/club/:clubId/me` | propietario o administrador de ese club | Rol de la cuenta en el club. Las futuras operaciones administrativas del club cuelgan de `/api/club/:clubId/*` y pasan por el mismo guardián |

Quien no tiene rol en un club recibe 404 (no se revela si existe). Un token de
dispositivo no sirve en estas rutas, y una sesión de cuenta no sirve en la API de
dispositivos ni en la administración.

## Pruebas

- `server/test/accounts-schema.test.ts`: versión fijada, esquema idéntico al de la
  biblioteca y configuración explícita.
- `server/test/accounts-auth.test.ts`: códigos, sesiones, límites, Turnstile, origen,
  cuentas desactivadas y separación de los códigos de equipo.
- `server/test/accounts-clubs.test.ts`: propietario, invitaciones, transferencias,
  revocaciones, desactivación, aislamiento y concurrencia.
- `server/test/accounts-flags.test.ts`: con el interruptor apagado, respuestas idénticas
  a las de antes; activado e incompleto, 503.
- `server/test/accounts-cookie.test.ts`: la cookie (`Path=/`, solo el host) sirve en las rutas de cuentas y del club, no concede nada por sí misma, no se comparte con otro host y deja de valer al revocar o desactivar.
- `server/test/accounts-signup.test.ts`: sin registro libre nadie crea cuentas; con él, una persona crea su cuenta, verifica su correo y es propietaria de su club sin intervención de la superadministración.
- `server/test/migration-0008.test.ts`: sobre una base representativa (`representativeDb.ts`), la migración no cambia ningún dato existente.

## Pendiente (tareas posteriores, con autorización)

- Proveedor de correo (Resend) y plantillas.
- Turnstile real (clave de sitio en el panel y secreto en el Worker).
- Interfaz del panel de cuentas.
- Dominio propio y `ACCOUNTS_ORIGIN` definitivo.
- Aplicar 0008 en la D1 de preview y activar el interruptor allí.
- Asignar propietario a los clubes existentes (operación de superadministración).
- Purga periódica de contadores antiguos de `auth_attempts` (hoy tampoco se purgan los
  del canje de códigos), de códigos caducados en `auth_verification` y de invitaciones
  antiguas. Los contadores de `auth_rate_limit` los limpia la propia biblioteca.
