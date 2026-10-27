# Permisos, seguridad y privacidad

> **Estado:** diseño y lógica del servidor, probados en local. **Nada de esto está operativo todavía**: no hay Worker desplegado, la aplicación no se conecta a ningún servidor y siguen pendientes:
> - el inicio de sesión administrativo con llave de acceso, el segundo factor y sus rutas (`/api/admin/*`);
> - las rutas de canje de códigos, alta de clubes y equipos, nombramiento de administradores y transferencia de partidos;
> - el cliente de sincronización de la aplicación.
>
> Las funciones del servidor existen y tienen pruebas. Salvo las cuatro rutas básicas de [BACKEND.md](BACKEND.md#api-fase-actual), ninguna tiene todavía ruta en la API.

## Roles

| Rol | Quién | Alcance | Cómo se obtiene |
| --- | ----- | ------- | --------------- |
| `superadmin` | Propietario de GalipauStats | Toda la plataforma | Procedimiento de configuración del servidor (ver más abajo) |
| `club_admin` | Responsable o presidencia de un club | Todos los equipos de **su** club | Lo nombra un superadministrador |
| `coach` | Entrenador | Los equipos asignados | Código de entrenador |
| `viewer` | Jugador o familia | Los equipos asignados, solo lectura | Código de consulta |

Dos tipos de sujeto, con credenciales distintas:

- **Dispositivo** (navegador o PWA): `coach` y `viewer` sobre equipos concretos (`grants`). Se identifica con un token que obtiene al canjear un código.
- **Identidad administrativa** (una persona): `superadmin` y `club_admin` (`admin_roles`). Solo actúa con una **sesión administrativa**, que se emite tras verificar una credencial fuerte. La sesión va ligada al navegador donde se inicia, que conserva además sus permisos de equipo.

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
- **Operaciones críticas** (nombrar administradores, crear o eliminar clubes): exigen que la credencial fuerte se haya verificado en los últimos 15 minutos, aunque la sesión siga abierta. Si no, la respuesta es `401 reauth_required`.
- **Auditoría:** las operaciones administrativas quedan en `admin_audit` (quién, qué, sobre qué y cuándo).
- El entrenador no tiene jugador destacado. Un dispositivo de consulta podrá elegir uno en el futuro: será una preferencia local, sin verificación y sin permisos adicionales.

## Autenticación administrativa fuerte

- **Credencial principal:** llave de acceso (WebAuthn / *passkey*): Face ID, Touch ID o la llave de seguridad del dispositivo. Une algo que se tiene (el dispositivo con la clave privada) y algo que se es o se sabe (biometría o PIN). Es resistente al *phishing* y el servidor solo guarda la clave pública.
- **Segundo factor adicional, opcional:** TOTP (aplicación de autenticación). El secreto se guarda cifrado con una clave del servidor (`secret_enc`), nunca en claro.
- **Sesiones:**
  - solo existen con la verificación hecha (`mfa_verified_at` es obligatorio en la base de datos);
  - duran poco;
  - se guardan como hash;
  - dejan de valer al revocarse, al desactivar la identidad o al retirarle su último rol.
- **Alta de credenciales:** con un código de **un solo uso, personal y de 30 minutos**, que se entrega en persona o por un canal seguro. Nunca con un código compartido.
- **Capa adicional recomendada al desplegar:** proteger las rutas `/api/admin/*` con Cloudflare Access (inicio de sesión con proveedor de identidad y segundo factor; gratuito hasta 50 usuarios). Es defensa en profundidad: la comprobación propia sigue siendo obligatoria.

La verificación WebAuthn, el inicio de sesión y las rutas `/api/admin/*` se implementarán más adelante. En la Tarea 005B están listos:

- el modelo de datos;
- las reglas de autorización;
- la exigencia de verificación reciente;
- las pruebas.

## Primer superadministrador

No existe ninguna petición HTTP que cree o conceda el rol de superadministrador; una prueba lo comprueba recorriendo el código del servidor. El primero se establece con un procedimiento que exige **controlar la cuenta de Cloudflare**, que ya está protegida con el inicio de sesión y el segundo factor del propietario.

1. Con el `TOKEN_PEPPER` del entorno a mano (no se escribe en ningún archivo):
   ```bash
   cd server
   TOKEN_PEPPER=… npm run bootstrap:superadmin -- "Nombre visible" > bootstrap.local.sql
   ```
   El script ([`bootstrap-superadmin.mjs`](../server/scripts/bootstrap-superadmin.mjs)):
   - genera el SQL de la identidad, el rol `superadmin` y un código de alta (solo su hash);
   - muestra el código una vez por pantalla.
   - `*.local.sql` está excluido de Git.
2. Aplicarlo con la cuenta del propietario:
   ```bash
   npx wrangler d1 execute DB --env production --remote --file bootstrap.local.sql
   ```
3. Borrar `bootstrap.local.sql`.
4. En los 30 minutos siguientes, abrir la página de alta (fase posterior), introducir el código y registrar la llave de acceso. El código queda usado.

Garantías:

- **Si ya hay un superadministrador vigente, el SQL no inserta nada.** No sirve para apropiarse de la plataforma ni para añadir otro superadministrador sin querer.
- El repositorio solo contiene el script, nunca credenciales.
- Las pruebas verifican que el hash del script coincide con el del servidor y que el nombre no permite inyectar SQL.

Añadir otro superadministrador o recuperar el acceso (llave perdida) se hace con el mismo tipo de procedimiento por consola, con la cuenta de Cloudflare: revocar la credencial perdida, emitir un código de alta nuevo y registrar una llave. Nunca desde la aplicación.

## Administradores de club

1. El superadministrador, con verificación reciente, nombra al administrador de un club (`appointClubAdmin`). Se crean:
   - la identidad, o se reutiliza una existente;
   - el rol `club_admin` de ese club;
   - un código de alta de un solo uso (30 minutos).
2. El superadministrador entrega el código en persona o por un canal seguro.
3. La persona registra su llave de acceso con el código.
4. Retirar el rol (`revokeClubAdmin`) cierra sus sesiones si no le queda ningún otro rol.

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
- Administradores de prueba: `revokeClubAdmin` y desactivar la identidad (`disabled_at`).
- **Todo de una vez en un entorno:** cambiar su `TOKEN_PEPPER` (`wrangler secret put`). Invalida a la vez todos los tokens, sesiones y códigos de ese entorno, porque sus hashes dejan de coincidir. Solo afecta al entorno elegido.

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
  - identidad administrativa: nombre y, opcionalmente, un correo de contacto;
  - ni fechas de nacimiento ni fotos;
  - las IP solo como hash.
- **Acceso:** cada dato se ve con un permiso del equipo o del club. El superadministrador lo ve todo; sus operaciones quedan auditadas. Los rankings de club no mostrarán a quienes estén por debajo del décimo puesto, salvo la fila del jugador destacado del propio dispositivo.
- **Revocación:** de códigos, permisos, sesiones y dispositivos, con efecto inmediato.
- **Supresión:** el borrado físico de un jugador, equipo o club elimina en cascada sus datos. El borrado lógico sirve para sincronizar; habrá que fijar un plazo de purga definitiva.
- **Pendiente de decisión** antes de abrir el servicio a otros clubes:
  - responsable del tratamiento: plataforma, club o ambos;
  - información y consentimiento para menores;
  - plazo de conservación;
  - qué ve exactamente el rol de consulta;
  - acuerdos con cada club.
  - Aceptar un aviso genérico no autoriza mostrar datos de otros jugadores.
