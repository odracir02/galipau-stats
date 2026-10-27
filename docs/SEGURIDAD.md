# Permisos, seguridad y privacidad

> **Estado:** implementado y probado en local. **Nada de esto está operativo todavía**: no hay Worker desplegado, ni aplicaciones de Cloudflare Access creadas, y la aplicación no se conecta a ningún servidor. Siguen pendientes:
> - la configuración de Cloudflare Access ([AUTENTICACION_ADMIN.md](AUTENTICACION_ADMIN.md#configuración-pendiente-en-cloudflare));
> - las rutas de canje de códigos, alta de equipos, gestión de códigos y transferencia de partidos;
> - el cliente de sincronización de la aplicación y los paneles de administración.
>
> Las rutas existentes están en [BACKEND.md](BACKEND.md#api-fase-actual) y [AUTENTICACION_ADMIN.md](AUTENTICACION_ADMIN.md#operaciones-implementadas).

## Roles

| Rol | Quién | Alcance | Cómo se obtiene |
| --- | ----- | ------- | --------------- |
| `superadmin` | Propietario de GalipauStats | Toda la plataforma | Procedimiento de configuración del servidor (ver más abajo) |
| `club_admin` | Responsable o presidencia de un club | Todos los equipos de **su** club | Lo nombra un superadministrador |
| `coach` | Entrenador | Los equipos asignados | Código de entrenador |
| `viewer` | Jugador o familia | Los equipos asignados, solo lectura | Código de consulta |

Dos tipos de sujeto, con credenciales distintas:

- **Dispositivo** (navegador o PWA): `coach` y `viewer` sobre equipos concretos (`grants`). Se identifica con un token que obtiene al canjear un código.
- **Identidad administrativa** (una persona, identificada por su correo): `superadmin` y `club_admin` (`admin_roles`). Se autentica con **Cloudflare Access** (proveedor de identidad + segundo factor) y solo en las rutas `/api/admin/*`. Pasar por Access no da ningún rol: los roles salen siempre de la base de datos.

La base de datos impide mezclarlos:

- un permiso de dispositivo solo puede ser `coach` o `viewer` y siempre de un equipo;
- `superadmin` nunca lleva club y `club_admin` siempre lleva uno;
- una invitación solo puede ser `coach` o `viewer`.

### Permisos sobre un equipo

| Operación | superadmin | club_admin (su club) | coach (su equipo) | viewer (su equipo) |
| --------- | :--------: | :------------------: | :---------------: | :----------------: |
| Ver equipo, jugadores, partidos, estadísticas y rankings | ✔ | ✔ | ✔ | ✔ |
| Crear y registrar partidos, corregir acciones | ✔ | ✔ | ✔ | — |
| Editar la plantilla, transferir un partido | ✔ | ✔ | ✔ | — |
| Datos del equipo | ✔ | ✔ | — | — |
| Crear, rotar y revocar códigos de entrenador y de consulta | ✔ | ✔ | — | — |
| Retirar el acceso de dispositivos (p. ej. a un entrenador) | ✔ | ✔ | — | — |

### Permisos sobre clubes y la plataforma

| Operación | superadmin | club_admin |
| --------- | :--------: | :--------: |
| Ver y editar el club, crear y gestionar sus equipos | ✔ todos | ✔ solo el suyo |
| Nombrar y retirar administradores de club | ✔ | — |
| Crear y eliminar clubes | ✔ | — |

Reglas:

- **Todo se comprueba en el servidor**, en cada petición: `authorize` (equipo), `authorizeClub` (club) y `authorizePlatform` (plataforma), en [`auth.ts`](../server/src/auth.ts), con la matriz de [`permissions.ts`](../server/src/permissions.ts). La interfaz solo podrá usarla para ocultar botones.
- Sin ninguna relación con un equipo o club, la respuesta es **404**: no se revela que existan. Con relación pero sin permiso para la operación, **403**.
- Se pueden acumular permisos:
  - un dispositivo puede ser entrenador de un equipo y consulta de otro;
  - una identidad puede administrar varios clubes.
  - En cada equipo vale el mayor de los roles que le correspondan.
- El administrador de un club pierde el acceso a un equipo si ese equipo pasa a otro club.
- **Operaciones críticas** (nombrar administradores, crear o eliminar clubes): solo con un token de la aplicación de Access de operaciones críticas (si no, `401 reauth_required`). Además, están **desactivadas** (`503`) hasta verificar a mano que Cloudflare pide de verdad el segundo factor reciente: el token no lo demuestra por sí solo. Ver [AUTENTICACION_ADMIN.md](AUTENTICACION_ADMIN.md#operaciones-críticas-qué-comprueba-el-worker-y-qué-no).
- **Auditoría:** las operaciones administrativas quedan en `admin_audit` (quién, qué, sobre qué y cuándo).
- El entrenador no tiene jugador destacado. Un dispositivo de consulta podrá elegir uno en el futuro: será una preferencia local, sin verificación y sin permisos adicionales.

## Autenticación administrativa

La decisión, su comparación con otras opciones y la configuración están en [AUTENTICACION_ADMIN.md](AUTENTICACION_ADMIN.md). Resumen:

- **Cloudflare Access autentica:** proveedor de identidad y segundo factor independiente (Face ID, Touch ID, llaves de seguridad o TOTP).
- **El Worker verifica siempre el JWT de Access:** firma RS256 con las claves del equipo, emisor, audiencia y vigencia. Después busca la identidad y sus roles en D1.
- La cuenta de Access queda **vinculada** a la identidad en su primer acceso (`sub`); otra cuenta con el mismo correo se rechaza.
- **Sin configuración de Access, la administración está desactivada** (503) en todos los entornos. No hay modo de desarrollo que la abra.
- Los tokens de dispositivo no sirven para administrar, y una sesión de administración no sirve como dispositivo.

## Primer superadministrador

Ninguna petición HTTP crea ni concede el rol de superadministrador; una prueba lo comprueba recorriendo el código del servidor. El primero se crea por consola, **con la cuenta de Cloudflare del propietario**, que ya está protegida con su inicio de sesión y su segundo factor:

```bash
cd server
node scripts/bootstrap-superadmin.mjs propietario@example.com "Nombre visible" > bootstrap.local.sql
npx wrangler d1 execute DB --env production --remote --file bootstrap.local.sql
rm bootstrap.local.sql
```

- El correo es el de la cuenta con la que el propietario entra en Access.
- El SQL no contiene secretos. `*.local.sql` está excluido de Git.
- **Si ya hay un superadministrador vigente, el SQL no inserta nada.** No sirve para apropiarse de la plataforma.
- Las pruebas verifican también que el nombre no permite inyectar SQL.
- Recuperar el acceso (autenticador perdido) se hace en el panel de Cloudflare: borrar el autenticador del usuario y volver a darlo de alta. Añadir otro superadministrador, por consola. Nunca desde la aplicación.

## Administradores de club

1. El superadministrador, con un token de la aplicación crítica, nombra al administrador de un club por su correo (`appointClubAdmin`). Se crean la identidad (o se reutiliza) y el rol `club_admin` de ese club. Cualquier otro rol que se envíe en la petición se ignora.
2. Se añade ese correo a la política de las aplicaciones de Access de administración.
3. La persona entra con Access y configura su segundo factor; queda vinculada.
4. Retirar el rol (`revokeClubAdmin`) tiene efecto en la siguiente petición: los roles se leen en cada una.

Un administrador de club:

- crea equipos de su club;
- genera los códigos de entrenador y de consulta de esos equipos;
- retira accesos de esos equipos.

No puede:

- nombrar a otros administradores, ni de su club;
- actuar en otro club;
- crear o eliminar clubes.

## Dispositivos y códigos de invitación

**Tokens de dispositivo**
- Token aleatorio de 256 bits, entregado una vez. El servidor solo guarda su HMAC-SHA-256 con la clave `TOKEN_PEPPER`.
- Revocación:
  - por equipo (`revokeTeamAccess`);
  - del token;
  - del dispositivo entero.
- Un dispositivo puede tener varios tokens, lo que permite rotarlos.

**Códigos de invitación**

| | Código de entrenador | Código de jugador/familia |
| - | - | - |
| Concede | `coach` en un equipo | `viewer` en un equipo (solo lectura) |
| Caducidad por defecto | 7 días | 90 días |
| Uso | Personal; admite límite de usos | Compartible |

- 12 símbolos sin caracteres confundibles (≈59 bits), mostrados como `K7QM-4XRP-TB9H`. Se aceptan en minúsculas y sin guiones.
- Son aleatorios y no tienen relación con el código del equipo (`SM2627`), que es un identificador público.
- Se guardan solo como hash. El código en claro se muestra una vez.
- **Nunca conceden roles administrativos:**
  - el servidor rechaza crear invitaciones con otro rol aunque se fuerce la petición (`400 invalid_role`);
  - la base de datos rechaza invitaciones y permisos con roles administrativos.
- **Un código de consulta nunca da escritura.** Concede exactamente `viewer`, que no tiene ninguna operación de escritura. Canjear un código de menor nivel tampoco rebaja un permiso mayor.
- **Rotación y revocación:**
  - *Rotar* = crear uno nuevo. El anterior del mismo tipo queda revocado en la misma operación; quien ya lo canjeó **conserva** el acceso. Sirve para dejar de repartir un código.
  - *Revocar* (`revokeInvite`) deja el código sin validez. Con `revokeAccess` retira además el permiso a **todos los dispositivos que entraron con ese código**, para el caso de un código filtrado. Los accesos obtenidos con otros códigos no se tocan.
  - Hay como máximo un código vigente por equipo y tipo.
- **Un código de consulta no identifica a nadie.** Quien lo tiene puede ver las estadísticas del equipo; no prueba que sea un jugador concreto ni su familia.

### Límite de intentos de canje

- **Clave de cliente** (`clientKeyFromRequest`): solo `CF-Connecting-IP`.
  - Esa cabecera la pone el borde de Cloudflare y **sobrescribe** cualquier valor que envíe el cliente, así que no se puede falsificar en un Worker publicado.
  - `X-Forwarded-For`, `X-Real-IP`, `True-Client-IP` y cualquier otro dato del cliente se **ignoran**. Las pruebas lo comprueban: cambiar esas cabeceras no reinicia el contador.
  - Las IPv6 se agrupan por su **/64**: cambiar de dirección dentro del mismo bloque no da intentos nuevos.
  - Sin la cabecera (petición que no pasa por Cloudflare, como en local) todas comparten un mismo contador: el límite se endurece, no desaparece.
- **Límite:** 10 intentos por clave cada 15 minutos, contados en D1. La IP se guarda solo como hash. El error es el mismo para código inexistente, caducado o revocado.

Limitaciones y controles al desplegar:

- **Muchas IP distintas** (redes de bots, rotación de IPv4): el contador por IP no las frena. Lo que protege es el tamaño del espacio: 30¹² ≈ 5,3·10¹⁷ combinaciones y 960 intentos al día por IP. Con 10 millones de IP distintas, tener un 50 % de probabilidad de acertar alguno entre 200 códigos vigentes llevaría unos 380 años, y los códigos caducan en semanas o meses. Con 10 símbolos habrían bastado unos 5 meses; por eso se usan 12. Al desplegar conviene añadir:
  - una **regla de limitación de Cloudflare (WAF)** sobre la ruta de canje, que actúa antes del Worker;
  - **Turnstile** (verificación anti-bots gratuita de Cloudflare) en el formulario de canje si se detecta abuso;
  - una **alerta** si los fallos de canje superan un umbral global.
- **Usuarios tras la misma IP** (wifi de un pabellón, red móvil con NAT): comparten contador. Con 10 intentos por ventana es poco probable bloquear a alguien legítimo. Si ocurre, se puede subir el límite (`REDEEM_LIMIT`).
- **Limpieza:** la tabla `auth_attempts` crece con las ventanas. Hay que añadir una purga periódica, por ejemplo un *Cron Trigger* que borre ventanas de más de un día.

## Aislamiento entre clubes y equipos

- Toda consulta parte de un equipo o club autorizado. Los permisos de un club no sirven para otro.
- La base de datos lo refuerza con claves foráneas compuestas: una acción, convocatoria, permiso o invitación no puede apuntar a un equipo de otro club. Una persona solo se vincula a jugadores de su club.
- La vinculación de un equipo a un club la hace un administrador, nunca por coincidencia de nombre ni de código.
- CORS: cada entorno solo acepta su propia aplicación. CORS no es la protección; la protección es la credencial.

## Secretos y entornos

- `TOKEN_PEPPER` se configura con `wrangler secret put`, distinto en cada entorno. Nunca va en código, documentación ni commits. En local se usa `server/.dev.vars`, que está excluido de Git; solo se sube la plantilla con un valor de ejemplo.
- Pruebas y producción tienen Workers y bases de datos distintos, y el entorno local tiene un nombre de Worker propio: un `deploy` sin `--env` no puede sustituir al de producción. Una prueba automática lo comprueba en `wrangler.jsonc`.
- Ningún script del proyecto ejecuta comandos remotos.
- Los errores internos devuelven «Error interno» sin detalles.

## Reinicio de los datos de prueba (al terminar la Tarea 005)

Son tres operaciones distintas, en este orden. **Ninguna se ejecuta en la Tarea 005B** y ninguna se automatiza con un «borrar todo».

### 1. Revocar los accesos usados en las pruebas

- Por dispositivo o equipo: `revokeTeamAccess`, o `revoked_at` en dispositivos y tokens.
- Invitaciones de prueba: `revokeInvite` con `revokeAccess`.
- Administradores de prueba: `revokeClubAdmin`, desactivar la identidad (`disabled_at`), quitar su correo de las políticas de Access y revocar su sesión en el panel de Cloudflare.
- **Todo de una vez en un entorno:** cambiar su `TOKEN_PEPPER` (`wrangler secret put`). Invalida a la vez todos los tokens de dispositivo y códigos de ese entorno, porque sus hashes dejan de coincidir. Solo afecta al entorno elegido. Las sesiones de administración se revocan en Cloudflare Access (aplicación → «Revoke existing tokens»).

### 2. Eliminar los registros remotos de prueba

- Las pruebas se hacen **solo en el entorno preview** (`galipau-stats-preview`), nunca en producción.
- Reiniciar preview:
  1. borrar y recrear su base de datos (`wrangler d1 delete` / `wrangler d1 create`);
  2. actualizar su `database_id`;
  3. aplicar las migraciones.
  - Alternativa: borrar sus clubes de prueba; la cascada elimina equipos, partidos, acciones y permisos.
- La base de producción no se toca. Si por error contuviera datos de prueba, se eliminan por club con una consulta revisada antes de ejecutarla.

### 3. Eliminar los datos locales de prueba

- Viven en cada dispositivo (IndexedDB) y no dependen del servidor. Se borran en cada iPhone o navegador de prueba:
  - eliminando la app de la pantalla de inicio;
  - o, en Safari, con Ajustes → Safari → Avanzado → Datos de sitios web → `galipau-stats.pages.dev` o `develop.galipau-stats.pages.dev`.
- La app no tiene un «borrar todo» y no se añadirá sin una confirmación clara. Cuando exista la sincronización, borrar los datos locales no borrará los remotos, y al revés.

## Privacidad (base técnica, sin textos legales)

Las estadísticas se refieren a personas identificables, posiblemente menores. Esta fase prepara la arquitectura; no define textos legales ni presume consentimientos.

- **Minimización:**
  - jugador: nombre y dorsal;
  - persona del club: nombre visible;
  - identidad administrativa: nombre, correo (necesario para vincularla con Access) y el identificador de su cuenta de Access;
  - ni fechas de nacimiento ni fotos;
  - las IP solo como hash.
- **Acceso:** cada dato se ve con un permiso del equipo o del club. El superadministrador lo ve todo; sus operaciones quedan auditadas. Los rankings de club no mostrarán a quienes estén por debajo del décimo puesto, salvo la fila del jugador destacado del propio dispositivo.
- **Revocación:** de códigos, permisos, roles y dispositivos, con efecto inmediato; las sesiones de Access, desde su panel.
- **Supresión:** el borrado físico de un jugador, equipo o club elimina en cascada sus datos. El borrado lógico sirve para sincronizar; habrá que fijar un plazo de purga definitiva.
- **Pendiente de decisión** antes de abrir el servicio a otros clubes:
  - responsable del tratamiento: plataforma, club o ambos;
  - información y consentimiento para menores;
  - plazo de conservación;
  - qué ve exactamente el rol de consulta;
  - acuerdos con cada club.
  - Aceptar un aviso genérico no autoriza mostrar datos de otros jugadores.
