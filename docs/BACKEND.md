# Backend: Cloudflare Workers + D1

Base técnica para clubes, equipos, permisos y sincronización. **La aplicación todavía no lo usa**: sigue funcionando solo con IndexedDB. No hay recursos creados en Cloudflare.

## Estado

| Parte | Estado |
| ----- | ------ |
| Esquema D1 y migraciones (0001, 0002) | Hecho; probado en SQLite y en la D1 local de Wrangler |
| Autorización (4 roles), invitaciones, sincronización de acciones | Lógica del servidor hecha y probada |
| Autenticación administrativa (Cloudflare Access + roles en D1) y rutas `/api/admin/*` | Hecha y probada en local; **sin configurar en Cloudflare** (desactivada: 503). Operaciones críticas desactivadas hasta la verificación manual del segundo factor |
| Rutas de canje de códigos, alta de equipos, gestión de códigos, transferencia de partidos | **Pendiente** |
| Paneles de administración | **Pendiente** |
| Cliente de sincronización en la aplicación | **Pendiente** |
| Base de datos D1 de preview (`galipau-stats-preview`, jurisdicción UE) | **Creada**, con las migraciones 0001 y 0002 aplicadas |
| Worker de preview (`galipau-stats-api-preview`) | Preparado para su primer despliegue (ver [Primer despliegue de preview](#primer-despliegue-de-preview)); **no desplegado** |
| Base de datos D1 de producción, Workers, secretos y Access | **No creados** |

Relacionado: [Sincronización](SINCRONIZACION.md) · [Permisos, seguridad y privacidad](SEGURIDAD.md).

## Estructura

```
server/                     Subproyecto independiente (no forma parte del build de Pages)
  package.json              Solo Wrangler, como dependencia de desarrollo
  wrangler.jsonc            Worker, D1 y entornos local / preview / production
  .dev.vars.example         Plantilla de secretos locales (el real, .dev.vars, no se sube)
  migrations/
    0001_initial.sql        Esquema inicial
  src/
    index.ts                Punto de entrada del Worker y rutas
    auth.ts                 Autenticación del dispositivo y autorización por equipo
    permissions.ts          Matriz de permisos por rol
    access.ts               Verificación del JWT de Cloudflare Access
    invites.ts              Códigos de invitación, canje, revocación y límite de intentos
    admin.ts                Clubes, equipos y administradores de club (con auditoría)
    sync.ts                 Subida idempotente de acciones y descarga de cambios
    mapping.ts              Modelos de la aplicación ↔ filas de D1
    secrets.ts              Códigos, tokens y HMAC (Web Crypto)
    model.ts, db.ts, errors.ts
  scripts/
    bootstrap-superadmin.mjs  Alta del primer superadministrador (ver AUTENTICACION_ADMIN.md)
  test/                     Pruebas (se ejecutan con «npm test» desde la raíz)
```

El Worker reutiliza código de la aplicación: tipos (`src/domain/types.ts`), validación de acciones (`src/domain/validation.ts`) y, en el futuro, el motor estadístico para los rankings de club. Las reglas son las mismas en el dispositivo y en el servidor.

Por qué en `server/`: Cloudflare Pages instala y compila desde la raíz. Al tener su propio `package.json`, el despliegue actual de la aplicación no instala Wrangler ni compila el Worker. No cambia nada en producción.

## Modelo de datos

Ver los comentarios de [`0001_initial.sql`](../server/migrations/0001_initial.sql). Resumen:

| Tabla | Contenido | Relación |
| ----- | --------- | -------- |
| `clubs` | Club (nombre, nombre corto) | — |
| `teams` | Equipo: nombre, código corto, temporada, categoría, modalidad | Un club; código único dentro del club |
| `people` | Persona del club que puede jugar en varios equipos (solo nombre visible) | Un club |
| `players` | Jugador de la plantilla (= `Player` local) | Un equipo; opcionalmente una persona del mismo club |
| `matches` | Partido (= `Match` local) y dispositivo que lo registra | Un equipo |
| `match_squad` | Convocatoria con nombre/dorsal/posición del momento | Partido y jugadores del mismo equipo |
| `events` | Acción (= `MatchEvent` local); `player_id` nulo = pendiente | Partido y jugador del mismo equipo |
| `devices`, `device_tokens` | Dispositivos y hash de sus credenciales | — |
| `grants` | Permiso de un dispositivo: `coach` o `viewer` en un equipo | Equipo del club indicado |
| `admin_identities` | Personas con rol administrativo: correo (vínculo con Cloudflare Access), cuenta de Access vinculada (`access_subject`) y último acceso | — |
| `admin_roles` | `superadmin` (sin club) o `club_admin` (de un club) | Club |
| `admin_audit` | Registro de operaciones administrativas | Identidad |
| `invites` | Códigos de entrenador y de consulta (solo hash) | Equipo del club indicado |
| `auth_attempts` | Contador de intentos de canje (clave en hash) | — |
| `sync_ops`, `change_log` | Operaciones aplicadas (idempotencia) y registro de cambios por equipo | Equipo |

Integridad:

- Claves foráneas compuestas, por ejemplo `events (match_id, team_id) → matches (id, team_id)`. Impiden por construcción que una acción, una convocatoria, un permiso o una invitación apunten a otro equipo o club. D1 aplica siempre las claves foráneas.
- Restricciones `CHECK` con el catálogo de acciones (cada tipo con exactamente sus campos), formato del código corto, roles, modalidad, dorsal y parte.
- Dorsal único entre los jugadores activos del equipo, como en la aplicación.
- Borrado lógico (`deleted_at`) para propagar eliminaciones. El borrado definitivo de un club, equipo o jugador arrastra a sus dependientes (`ON DELETE CASCADE`).
- `version` en cada registro sincronizable, para detectar conflictos.

Correspondencia con IndexedDB:

- Los identificadores son los mismos UUID que ya existen en el dispositivo.
- Los campos que solo existen en el servidor (club, categoría, modalidad, persona, versión, dispositivo que registra) se guardan aparte. **No cambian los datos locales.**
- La conversión está en [`mapping.ts`](../server/src/mapping.ts). Las pruebas comprueban que un partido completo da exactamente las mismas estadísticas antes y después de pasar por la base de datos (tercera exclusión, % de paradas, pendientes, borrados).

### Rankings de club (preparado, no implementado)

- Candidatos = jugadores de los equipos del club a los que el dispositivo tiene acceso, con filtros opcionales por equipo y categoría.
- Clave de agregación: `person_id` si el jugador está vinculado a una persona y `player_id` si no. Una persona que juega en dos equipos suma una sola vez. Cada acción pertenece a un único partido y equipo, así que no se cuenta dos veces.
- El cálculo reutiliza `src/stats/rankings.ts`. `rankPlayers` produce la clasificación completa, `topOf` el Top 10 y `positionOf` el puesto del jugador seleccionado. La respuesta del servidor solo incluirá el Top 10 y, si procede, la fila de ese jugador; nunca el resto de puestos por debajo del décimo.
- Hasta que existan personas vinculadas, el ranking de club agrupa por jugador de plantilla.

## API (fase actual)

| Método y ruta | Permiso | Uso |
| ------------- | ------- | --- |
| `GET /api/health` | ninguno | Comprobación |
| `GET /api/teams/:teamId` | consulta | Datos del equipo y rol del dispositivo |
| `GET /api/teams/:teamId/changes?since=N` | consulta | Cambios posteriores al cursor N |
| `POST /api/sync/events` | entrenador, administrador de club o superadministrador | Subir una acción (alta, edición o borrado) |

Autenticación: `Authorization: Bearer <token del dispositivo>`. Las rutas de administración (`/api/admin/*`) usan Cloudflare Access y están en [AUTENTICACION_ADMIN.md](AUTENTICACION_ADMIN.md#operaciones-implementadas). Roles y permisos: [SEGURIDAD.md](SEGURIDAD.md).

De fases posteriores son:

- las rutas de crear equipos, gestionar códigos y canjearlos;
- la transferencia de partidos;
- la subida de partidos y plantillas.

La lógica de invitaciones ([`invites.ts`](../server/src/invites.ts)) y la de creación de equipos ([`admin.ts`](../server/src/admin.ts)) ya existen y están probadas.

## Entornos

| Entorno | Worker | D1 | Orígenes permitidos (CORS) |
| ------- | ------ | -- | -------------------------- |
| local | `wrangler dev` | `galipau-stats-local` (en `server/.wrangler/`, nunca en Cloudflare) | `localhost:5173`, `localhost:4173` |
| preview | `galipau-stats-api-preview` | `galipau-stats-preview` | `https://develop.galipau-stats.pages.dev` |
| production | `galipau-stats-api` | `galipau-stats-production` | `https://galipau-stats.pages.dev` |

Pruebas y producción usan bases de datos distintas. La de preview ya existe en Cloudflare, creada con jurisdicción de la Unión Europea, y su `database_id` real está en `wrangler.jsonc`. La de producción todavía no existe: su `database_id` es un marcador (`00000000-…`) hasta que se cree. La jurisdicción se fija al crear la base y no requiere ningún campo en la configuración.

Configuración:

- `TOKEN_PEPPER` (secret): clave del HMAC de tokens y códigos. Se configura con `wrangler secret put` y nunca va en el repositorio. Sin ella, el Worker no autentica a nadie.
- `ENVIRONMENT`, `ALLOWED_ORIGINS` (vars): no son secretos.

## Desarrollo local

Requisitos: Node.js 24, el mismo que fija `.node-version` (las pruebas usan el SQLite integrado en Node).

```bash
# Pruebas del servidor (con el resto, desde la raíz). Base de datos SQLite en memoria.
npm test
npm run typecheck          # también comprueba server/

# Worker real en local (opcional)
cd server
npm install                # solo la primera vez: instala Wrangler
cp .dev.vars.example .dev.vars
npm run db:migrate:local   # aplica las migraciones a la D1 local
npm run dev                # http://localhost:8787/api/health
npm run bundle:check       # empaqueta sin desplegar
```

Ninguno de estos comandos necesita una cuenta de Cloudflare ni toca recursos remotos. Comprobado en esta tarea: la migración se aplica en la D1 local de Wrangler, el Worker empaqueta (18,5 KiB) y en `wrangler dev` responde `/api/health` → 200 y sin credencial → 401.

Nuevas migraciones: `npx wrangler d1 migrations create DB <nombre>` crea `000N_<nombre>.sql`. Nunca se edita una migración ya aplicada en preview o producción.

## Primer despliegue de preview

Estado previsto justo después de desplegar, sin Access ni secretos:

| Ruta | Respuesta | Por qué |
| ---- | --------- | ------- |
| `GET /api/health` | 200 `{ ok, environment: "preview" }` | Pública; no consulta la base de datos |
| `/api/admin/*` (cualquier método y ruta) | **503** `admin_disabled` | Sin `ACCESS_TEAM_DOMAIN`/AUD no hay forma de autenticarse; las cabeceras falsificadas se ignoran |
| `/api/admin/critical/*` | **503** `critical_disabled` | `ADMIN_CRITICAL_OPS = "disabled"` |
| Rutas de dispositivos (`/api/teams/…`, `/api/sync/…`) | **503** `not_configured` mientras falte `TOKEN_PEPPER`; después **401** sin token válido | No llegan a la base de datos sin clave; aún no hay dispositivos (no existe la ruta de canje) |

Ninguna ruta crea administradores ni concede permisos. El primer superadministrador solo se crea por consola. Las pruebas `server/test/first-deploy.test.ts` reproducen este estado con las variables reales de `preview`, también con cabeceras falsificadas, y comprueban que no se escribe nada.

### Secretos

Solo uno es obligatorio: **`TOKEN_PEPPER`** (al menos 32 caracteres; 32 bytes aleatorios). No se escribe en ningún archivo ni en el historial de la terminal. Wrangler lo pide de forma interactiva:

```bash
# 1. Generar el valor (se muestra una vez en pantalla; no redirigirlo a ningún archivo)
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
# 2. Pegarlo cuando Wrangler lo pida
npx wrangler secret put TOKEN_PEPPER --env preview
```

- Guardarlo en un gestor de contraseñas.
- Producción tendrá **otro** valor distinto.
- Cambiarlo invalida todos los tokens y códigos de ese entorno.
- `ACCESS_*` y `ADMIN_CRITICAL_OPS` no son secretos: van en `wrangler.jsonc`.

### Comandos (desde `server/`, solo con autorización)

```bash
npx wrangler whoami                                   # cuenta correcta
npx wrangler deploy --dry-run --env preview           # revisar bindings: DB = galipau-stats-preview
npx wrangler deploy --env preview                     # despliegue
npx wrangler secret put TOKEN_PEPPER --env preview    # inmediatamente después
```

- Hasta configurar el secreto, las rutas de dispositivos responden 503 (sin efecto: aún no hay dispositivos).
- Ejecutar `secret put` antes del primer `deploy` también funciona, pero Wrangler crearía el Worker vacío solo para guardar el secreto.

Comprobación tras desplegar:

- `/api/health` → 200;
- `/api/admin/me` → 503;
- `/api/teams/x` → 401 tras configurar el secreto.

### URL y Cloudflare Access después

- URL: `https://galipau-stats-api-preview.<subdominio-de-la-cuenta>.workers.dev`. El subdominio es el de la cuenta (*Workers → Settings → Subdomain*) y Wrangler lo muestra al desplegar.
- Las URLs de vista previa por versión están desactivadas (`preview_urls: false`).
- **No usar** la protección de Access «a nivel de Worker» (el interruptor de *Domains & Routes*): protege todos los hostnames y rutas del Worker y bloquearía las rutas de entrenadores y familias.
- **Usar aplicaciones de Access autoalojadas por ruta** sobre el hostname `workers.dev` del Worker:
  - `/api/admin` y `/api/admin/*`;
  - `/api/admin/critical` y `/api/admin/critical/*`, con su propia política.
  - Ver [AUTENTICACION_ADMIN.md](AUTENTICACION_ADMIN.md#configuración-pendiente-en-cloudflare).
- Las rutas `/api/health`, `/api/teams/*` y `/api/sync/*` quedan fuera de Access; las protege el token de dispositivo.
- La documentación de Workers admite aplicaciones por hostname `workers.dev` y por ruta, pero no muestra un ejemplo con ambas cosas a la vez. **Hay que comprobarlo** al crearlas (paso 4 de la verificación manual). Si no funcionara, la alternativa es un dominio propio para la API.
- El Worker sigue validando el JWT de Access por su cuenta, aunque Cloudflare ofrezca la identidad en `ctx.access`. Así el control no depende de cómo esté configurada la protección.

## Pasos manuales en Cloudflare (próxima fase, con autorización)

Requiere `npx wrangler login` con tu cuenta. Hecho hasta ahora: la base de datos de preview y sus migraciones.

1. Crear las bases de datos y copiar cada `database_id` en `server/wrangler.jsonc`:
   - preview: **hecho** (`galipau-stats-preview`, jurisdicción UE);
   - producción: pendiente, con la misma jurisdicción:
     ```bash
     npx wrangler d1 create galipau-stats-production --jurisdiction=eu
     ```
2. Configurar el secreto de cada entorno con un valor aleatorio largo y distinto en cada uno (por ejemplo, `openssl rand -base64 32`). No se apunta en ningún archivo:
   ```bash
   npx wrangler secret put TOKEN_PEPPER --env preview
   npx wrangler secret put TOKEN_PEPPER --env production
   ```
3. Aplicar las migraciones en remoto: preview **hecho** (0001 y 0002):
   ```bash
   npx wrangler d1 migrations apply DB --env preview --remote
   ```
4. Desplegar el Worker de preview: ver [Primer despliegue de preview](#primer-despliegue-de-preview).
5. Decidir la URL de la API: `*.workers.dev` o una ruta propia. Si cambia, actualizar `ALLOWED_ORIGINS`.
6. Añadir a la aplicación la URL de la API por entorno (variable de build en Pages) cuando exista el cliente de sincronización (005C).
7. Producción, solo tras validar preview: pasos 3 y 4 con `--env production`.
8. Configurar Cloudflare Access y crear el primer superadministrador en cada entorno: [AUTENTICACION_ADMIN.md](AUTENTICACION_ADMIN.md#configuración-pendiente-en-cloudflare).
9. Recomendado: una regla de limitación (WAF) y Turnstile para el canje de códigos.

Plan gratuito: Workers y D1 tienen capa gratuita suficiente para este uso. Se recomienda revisar sus límites vigentes antes de abrir el uso a varios clubes.
