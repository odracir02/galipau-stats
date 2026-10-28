# Autenticación administrativa

Cómo se identifican el **superadministrador** y los **administradores de club**. Entrenadores y familias no se ven afectados: siguen con dispositivos e invitaciones de equipo, que nunca dan acceso administrativo.

> **Estado:**
>
> - **Preview:** las dos aplicaciones de Access (general y crítica) están creadas y configuradas, y el Worker está desplegado. El primer superadministrador está dado de alta y vinculado a su cuenta. La aplicación crítica ya pide autenticación y biometría, pero **la funcionalidad crítica no está habilitada en el Worker**: `ADMIN_CRITICAL_OPS = "disabled"` (503) hasta completar la [verificación manual del segundo factor](#verificación-manual-del-segundo-factor).
> - **Cookies de Access en preview: completado.** Las dos aplicaciones tienen `SameSite=Lax` y *Binding Cookie* activada, y siguen permitiendo el acceso. Es independiente de la verificación pendiente del segundo factor y de la antigüedad del token crítico.
> - **Producción:** sin configurar; las rutas de administración responden **503**.
> - En cualquier entorno sin configuración de Access, la administración está desactivada.

## Evaluación

| Criterio | Cloudflare Access + roles en D1 | WebAuthn/passkeys propio | Híbrido (Access + WebAuthn propio) |
| -------- | ------------------------------- | ------------------------ | ---------------------------------- |
| Seguridad del inicio de sesión | Proveedor de identidad + **segundo factor de Access** (Face ID/Touch ID, llaves de seguridad, TOTP) | Muy alta si está bien hecho | La más alta en teoría |
| Código propio sensible | Verificar un JWT RS256 (~150 líneas, Web Crypto) | Verificación WebAuthn completa: desafíos, CBOR/COSE, contadores, alta, recuperación | Ambos |
| Comprobación del segundo factor en el servidor | **No posible**: el JWT de Access no indica el método ni el momento | Sí | Sí, por la parte propia |
| iPhone | Safari con Face ID (biometría de Access) | Passkeys nativas | Ambos |
| Recuperación (llave perdida) | Panel de Cloudflare: borrar el autenticador y volver a darlo de alta | Hay que diseñarla e implementarla | Ambas |
| Revocación | Roles en D1 (inmediata) + sesiones de Access (panel) | Propia | Ambas |
| Mantenimiento | Bajo; rotación de claves automática | Alto | El más alto |
| Dependencia | Cloudflare Zero Trust (gratuito hasta 50 usuarios) | Ninguna externa | Cloudflare |

**Elección: Cloudflare Access para autenticar y D1 para autorizar.**

- Cumple los requisitos con la menor cantidad de código de seguridad propio. Verificar llaves de acceso y recuperar cuentas lo resuelve un servicio especializado.
- El proyecto ya está en Cloudflare y funciona en iPhone con Face ID.
- Su límite principal es que el Worker no puede comprobar el segundo factor, solo confiar en la configuración de Access. Se compensa con la verificación manual previa y manteniendo las operaciones críticas desactivadas hasta entonces.
- Si esa verificación no fuera posible (por ejemplo, por el plan de la cuenta), la alternativa sería añadir una confirmación WebAuthn propia **solo** para las operaciones críticas. Eso se valoraría entonces, no ahora.

**Cambio respecto a la Tarea 005B:**

- La 005B había previsto credenciales y sesiones propias (`admin_credentials`, `admin_enrollments`, `admin_sessions`), pero nunca llegaron a usarse. La migración [`0002_cloudflare_access.sql`](../server/migrations/0002_cloudflare_access.sql) las elimina y añade el vínculo con la cuenta de Access.
- Se mantienen intactos:
  - las identidades y los roles;
  - la auditoría;
  - la matriz de permisos;
  - la separación entre roles de dispositivo y roles administrativos.

## Cómo funciona

```
Navegador ── Cloudflare Access ──► Worker (/api/admin/*) ──► D1
              │ proveedor de identidad   │ 1. ruta canónica (si no, 404)
              │ + segundo factor         │ 2. verifica el JWT (firma, emisor, audiencia, vigencia)
              └ añade Cf-Access-Jwt-     │ 3. busca la identidad por correo y comprueba el vínculo (sub)
                Assertion                │ 4. carga sus roles vigentes (admin_roles)
                                         └ 5. autoriza la operación (authorizeClub / authorizePlatform)
```

1. **Pasar por Access no da ningún rol.** Una cuenta autenticada sin identidad en D1, o sin roles vigentes, recibe **403 `not_admin`**. El rol de superadministrador solo existe si está en `admin_roles`.
2. **El JWT se verifica siempre en el Worker** ([`access.ts`](../server/src/access.ts)), aunque Access ya filtre la petición.
   - Algoritmo: solo RS256.
   - Firma: con las claves públicas del equipo de Access, en caché 10 minutos y recargadas tras una rotación.
   - Emisor exacto, audiencia, `exp`, `nbf` e `iat`, con 60 s de margen.
   - Solo tokens de persona.
3. **Vínculo con la cuenta:** en el primer acceso se guarda el `sub` de Access; otra cuenta con el mismo correo recibe **403 `identity_mismatch`**.
4. **Separación de credenciales:**
   - un token de dispositivo no sirve en `/api/admin/*`;
   - una sesión de administración no registra acciones ni canjea códigos;
   - la API de administración no envía cabeceras CORS.

### Operaciones críticas: qué comprueba el Worker y qué no

Las operaciones críticas (crear o eliminar clubes, nombrar o retirar administradores) van bajo `/api/admin/critical/*`.

**Lo que el Worker verifica:**

- que el token pertenece a la **aplicación de Access crítica** (su audiencia);
- que la identidad es **superadministradora** en D1;
- que las operaciones críticas están **habilitadas** en ese entorno.

**Lo que el Worker no puede verificar:** que Cloudflare haya pedido **de verdad** un segundo factor, ni hace cuánto.

- El JWT de Access no incluye el método de autenticación (no hay `amr`), y `get-identity` solo da la hora de inicio de sesión.
- Que el token sea de la aplicación crítica **no prueba** que se pidiera el segundo factor. Lo garantiza únicamente la configuración de esa aplicación en Cloudflare.

**Consecuencia:**

- `ADMIN_CRITICAL_OPS` vale `"disabled"` en todos los entornos del repositorio; una prueba lo vigila.
- Con ese valor, las rutas críticas responden **503 `critical_disabled`**, y ningún token cuenta como crítico, ni siquiera en las funciones internas.
- Solo se cambia a `"enabled"`, entorno por entorno, después de superar la [verificación manual](#verificación-manual-del-segundo-factor).

### Protección CSRF de las escrituras administrativas

La cookie de Access (`CF_Authorization`) tiene `SameSite=None` por defecto: el navegador la envía también en peticiones iniciadas desde otra web. Por eso el Worker no se fía solo de la sesión. Toda petición de administración `POST`, `PUT`, `PATCH` o `DELETE` pasa por [`csrf.ts`](../server/src/csrf.ts) **antes de autenticar**, sin llegar a la base de datos:

| Situación | Resultado |
| --------- | --------- |
| `Sec-Fetch-Site` presente y distinto de `same-origin` (`cross-site`, `same-site`, `none`, vacío…) | **403** `csrf_rejected` (`fetch_site`) |
| `Origin` presente y distinto del origen exacto de la API (incluido `null`, otro esquema, puerto o subdominio) | **403** `csrf_rejected` (`origin`) |
| Ni `Sec-Fetch-Site` ni `Origin` | **403** `csrf_rejected` (`missing_headers`) |
| Mismo origen, pero `POST`/`PUT`/`PATCH` sin `Content-Type: application/json` | **415** `unsupported_media_type` |
| Mismo origen y JSON | Sigue la autenticación y autorización normales |

- Si faltan las dos cabeceras se **rechaza**. Los navegadores actuales envían al menos una en estas peticiones. Un script, que no lleva la cookie de la víctima, puede añadir `Origin` sin problema.
- Las lecturas (`GET`) no cambian: no modifican nada, y sin CORS la otra web no puede leer la respuesta.
- No depende de la configuración de cookies de Cloudflare. Esa configuración ya está endurecida en preview (`SameSite=Lax` y *Binding Cookie*) como capa adicional.
- El panel de administración futuro funcionará sin cambios: el navegador envía `Sec-Fetch-Site: same-origin` y `Origin` en un `fetch` del mismo origen con JSON.

### Antigüedad del token crítico: por qué no se impone todavía un límite

Lo que se sabe por la documentación de Access:

- La caducidad del token de aplicación (`exp`) es la duración de sesión de la política o, si no hay, la de la aplicación (24 h por defecto).
- Cuando caduca el token de aplicación y la sesión global sigue vigente, Access emite **otro token sin volver a pedir el inicio de sesión**.
- El segundo factor se exige cuando el último queda fuera de su propia duración. Las duraciones de MFA no determinan cuánto dura el acceso a la aplicación.
- **No está documentado** si `iat` es la hora de emisión del token o la del inicio de sesión. Desde luego **no es la hora de la última biometría**: un token renovado en silencio tiene un `iat` nuevo aunque la biometría sea anterior.

Consecuencias:

- Un límite de 15 minutos sobre `iat` no garantiza biometría reciente.
- Con una sesión de aplicación más larga provocaría **bloqueos falsos**: el Worker rechazaría un token que Access sigue considerando válido y que no renovaría, así que el usuario quedaría atascado hasta cerrar sesión.
- No se impone. La biometría reciente la garantiza la configuración de MFA de la aplicación crítica, comprobada a mano.

Propuesta segura, para cuando se pueda medir:

1. En preview, con la aplicación crítica configurada con sesión de 15 minutos, medir `iat` y `exp` de un token crítico real (paso 6 de la verificación manual).
2. Si `exp − iat` coincide con la sesión configurada, añadir en el Worker la comprobación **`exp − iat ≤ 15 min`** para los tokens críticos. Confirma criptográficamente que la sesión crítica es corta y no puede bloquear a nadie si la configuración es correcta. Si alguien alargara la sesión, el Worker dejaría de aceptar operaciones críticas: un fallo seguro y visible.
3. Si no coincide, no añadir el límite y documentar lo observado.

En ningún caso se tratará `iat` como hora de la biometría.

## Operaciones implementadas

| Ruta | Quién | Notas |
| ---- | ----- | ----- |
| `GET /api/admin/me` | cualquier administrador | Identidad y roles |
| `GET /api/admin/clubs` | superadmin: todos; club_admin: los suyos | |
| `POST /api/admin/critical/clubs` | superadmin | Crear club (desactivada por defecto) |
| `DELETE /api/admin/critical/clubs/:clubId` | superadmin | Eliminación lógica (desactivada por defecto) |
| `POST /api/admin/critical/clubs/:clubId/admins` | superadmin | Nombrar administrador por correo; el rol siempre es `club_admin` de ese club (desactivada por defecto) |
| `DELETE /api/admin/critical/clubs/:clubId/admins/:identityId` | superadmin | Efecto en la siguiente petición (desactivada por defecto) |

Todas quedan en `admin_audit`. Mientras las operaciones críticas estén desactivadas:

- el primer superadministrador se crea por consola (sección siguiente);
- si hiciera falta un administrador de club antes de habilitarlas, el propietario puede crearlo con una sentencia SQL revisada y aplicada con `wrangler d1 execute`. Sin ruta todavía:

- crear equipos;
- crear, rotar y revocar códigos;
- retirar accesos de dispositivos.

No hay paneles visuales.

## Primer superadministrador

Ninguna ruta crea ni concede el rol de superadministrador; una prueba lo verifica revisando el código del servidor. El primero se crea por consola, **con la cuenta de Cloudflare del propietario**:

```bash
cd server
node scripts/bootstrap-superadmin.mjs propietario@example.com "Nombre visible" > bootstrap.local.sql
npx wrangler d1 execute DB --env preview --remote --file bootstrap.local.sql   # y después production
rm bootstrap.local.sql
```

- El correo debe ser el de la cuenta con la que el propietario entra en Access.
- El SQL no contiene secretos. `*.local.sql` está excluido de Git.
- **Si ya existe un superadministrador vigente, no inserta nada.**
- En su primer acceso, la identidad queda vinculada a esa cuenta.
- Para recuperar el acceso o añadir otro superadministrador se usa el mismo camino por consola, nunca la aplicación.

## Administradores de club

1. El superadministrador lo nombra con `POST /api/admin/critical/clubs/:clubId/admins` (cuando las operaciones críticas estén habilitadas), indicando el correo.
2. El correo se añade a la política de **las dos** aplicaciones de Access de administración, porque no heredan una de otra (ver más abajo).
3. La persona entra con Access, configura su segundo factor y queda vinculada.
4. Desde ese momento administra solo su club.
5. Retirarlo tiene efecto en la siguiente petición. Para cerrar también su sesión de Access: panel de Cloudflare → usuario → *Revoke*. Y se quita su correo de las dos políticas.

## Configuración pendiente en Cloudflare

Nada de esto está hecho; requiere tu autorización y tu cuenta.

### 1. Zero Trust y segundo factor

- Activar el plan gratuito, elegir el nombre del equipo (`https://<equipo>.cloudflareaccess.com`) y un método de inicio de sesión (código por correo de Access o un proveedor como Google).
- **Comprobar que la cuenta permite el segundo factor independiente.** Es imprescindible para habilitar las operaciones críticas.
- Activarlo en *Access settings → Allow multi-factor authentication* con *Biometrics* y *Security keys* (TOTP de reserva). Dar de alta al menos dos autenticadores por administrador para no quedarse fuera.

### 2. Hostname de la API, sin puertas traseras

Access protege **hostnames y rutas**. El Worker también puede alcanzarse por su subdominio `workers.dev` y por las URLs de vista previa. Medidas:

- **Hostname propio** para la API de cada entorno (recomendado), con:
  - `workers_dev: false` en ese entorno de `wrangler.jsonc`;
  - URLs de vista previa desactivadas (`preview_urls: false`, ya puesto en todos los entornos).
- **Si se usa `workers.dev`:** las aplicaciones de Access se crean sobre ese hostname. Cloudflare ofrece además proteger con Access todos los hostnames de un Worker, incluidos `workers.dev` y las vistas previas.
- **Previews de Pages:** no exponen la API; la API es otro Worker.
- **En cualquier caso el Worker rechaza** peticiones sin JWT, con JWT de otra aplicación, de otro entorno o de otro equipo (401), aunque lleguen directamente sin pasar por Access. Las pruebas lo cubren.
- **Rutas no canónicas:** el Worker solo enruta rutas canónicas. Responde 404 a barras dobles o finales, barras o puntos codificados y mayúsculas en `api`/`admin`. Así no puede llegar a una ruta que Access no haya reconocido. Los segmentos `..` los resuelve el estándar de URLs antes del Worker y la ruta resultante aplica su propia autenticación.

### 3. Dos aplicaciones de Access por entorno, cada una con su propia política

Según la documentación de Access, **la aplicación de la ruta más específica prevalece y no hereda las reglas de la general**. La aplicación crítica necesita, por tanto, su propia política completa.

| | «GalipauStats admin» | «GalipauStats admin crítico» |
| - | - | - |
| Destinos | `<api>/api/admin` y `<api>/api/admin/*` | `<api>/api/admin/critical` y `<api>/api/admin/critical/*` |
| Política *Allow* | Solo los correos de los administradores (no «todo el mundo») | **Los mismos correos, puestos explícitamente**; idealmente solo el superadministrador, que es quien hace operaciones críticas |
| Segundo factor | Obligatorio | Obligatorio, con **duración de autenticación corta** (5–15 min) en la configuración de MFA de la aplicación o de la política |
| Sesión de la aplicación | Por ejemplo, 8 h | Corta (la misma que la del MFA) |

- Se incluye cada ruta con y sin `/*`, porque un comodín en la ruta no cubre la ruta padre.
- Una política compartida (*reusable policy*) para los correos evita que las listas se desincronicen, pero cada aplicación debe tenerla asignada.
- **Cookies**, en las dos aplicaciones (*Settings → Cookie settings*):
  - `SameSite` en `Lax` (o `Strict` si no causa redirecciones en bucle);
  - `HttpOnly` activado (por defecto);
  - **Binding Cookie** activada.
  - Complementa, no sustituye, la protección CSRF del Worker.
  - **Preview: hecho.** Las dos aplicaciones tienen `SameSite=Lax` y *Binding Cookie*, y se ha comprobado que siguen dando acceso. Producción: pendiente cuando se configure.
- Copiar el *Application Audience (AUD) Tag* de cada aplicación y el dominio del equipo en `server/wrangler.jsonc` (`ACCESS_TEAM_DOMAIN`, `ACCESS_AUD_ADMIN`, `ACCESS_AUD_CRITICAL`). No son secretos.
  - El dominio va con esquema: `https://<equipo>.cloudflareaccess.com`, igual que el emisor (`iss`) de los JWT.
  - `ACCESS_AUD_CRITICAL` es opcional: sin ella, la administración general funciona y las operaciones críticas quedan desactivadas aunque `ADMIN_CRITICAL_OPS` diga `enabled`.
  - Preview: equipo y las dos aplicaciones configurados. La crítica existe, pero sus operaciones siguen desactivadas en el Worker.
- Cada entorno con sus propias aplicaciones; una prueba impide que preview y producción compartan AUD.

### 4. Despliegue

Desplegar el Worker con `ADMIN_CRITICAL_OPS = "disabled"` y crear el primer superadministrador por consola.

## Verificación manual del segundo factor

Se hace **en cada entorno** (primero preview), con el Worker desplegado y las operaciones críticas aún desactivadas. Solo si todo sale como se espera se pasa `ADMIN_CRITICAL_OPS` a `"enabled"` en ese entorno y se vuelve a desplegar.

**Políticas y rutas**
1. Ventana privada, sin sesión: abrir `<api>/api/admin/me` → Access pide iniciar sesión.
2. Iniciar sesión con un correo **no** incluido en las políticas → Access deniega el acceso.
3. Iniciar sesión con un correo incluido en la aplicación general pero **no** en la crítica → `/api/admin/me` responde; `<api>/api/admin/critical/clubs` es **denegado por Access**. Esto demuestra que la crítica no hereda la política general.
4. Repetir 1–3 con `<api>/api/admin/critical/` (barra final), `<api>/api/admin//critical/clubs` y, si existe, la URL `workers.dev`:
   - nunca debe obtenerse una respuesta de la administración sin pasar por Access;
   - el Worker responde 404 a las variantes y 401 sin JWT.

**Segundo factor**
5. Con el superadministrador: al iniciar sesión, Access pide el segundo factor (Face ID, Touch ID o llave) **además** del proveedor de identidad.
6. Pedir `<api>/api/admin/critical/clubs` (por ejemplo, con `GET`, que el Worker responderá con 404 o 503) y anotar la hora. Access debe pedir el segundo factor.
   - Para la propuesta de antigüedad del token, anotar también `iat` y `exp` del token crítico.
   - Se obtiene en las herramientas del navegador (cookie `CF_Authorization` de la API, con la ruta crítica abierta) y se decodifica **en local**, nunca en webs externas. Por ejemplo:
     ```bash
     node -e "const p=JSON.parse(Buffer.from(process.argv[1].split('.')[1],'base64url'));console.log({iat:p.iat,exp:p.exp,vida_min:(p.exp-p.iat)/60})" "<token>"
     ```
   - Solo se apuntan esos tres valores; el token no se guarda ni se comparte.
7. Volver a pedirlo **antes** de que pase la duración configurada → no lo pide.
8. Volver a pedirlo **después** de esa duración → **lo pide de nuevo**, aunque la sesión general siga abierta. Este es el punto clave. Si no lo pide, la configuración no garantiza el segundo factor reciente y las operaciones críticas **no se habilitan**.
9. Revisar el registro de Access (*Logs → Access*) para confirmar los inicios de sesión y los segundos factores de los pasos anteriores.

**Habilitar**
10. Poner `ADMIN_CRITICAL_OPS = "enabled"` solo en ese entorno, desplegar y repetir el paso 8 con una operación real. Por ejemplo, crear un club de prueba en preview: responde 201 y aparece en `admin_audit`.
    - Por la protección CSRF, la operación se lanza **desde la propia API en el navegador**: abrir `<api>/api/admin/me` y, en la consola, `fetch('/api/admin/critical/clubs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Club de prueba' }) })`.
    - Comprobar también que la misma petición desde otra web es rechazada con 403.
11. Repetir la verificación cuando se cambie cualquier ajuste de Access (políticas, MFA, duraciones) y, como rutina, periódicamente.

Si la cuenta no permite configurar el segundo factor con duración corta por aplicación o por política, las operaciones críticas siguen desactivadas, y los clubes y administradores se gestionan por consola hasta resolverlo.

## Limitaciones y riesgos

- **El segundo factor depende de la configuración de Access.** El Worker no puede comprobarlo; de ahí la verificación manual y el interruptor. Un cambio posterior en Access que relaje el MFA no lo detectaría el Worker: hay que repetir la verificación tras cualquier cambio.
- **Políticas sin herencia:** un error en la política de la aplicación crítica (por ejemplo, dejarla abierta) no lo compensaría la general. Lo mitiga que el Worker siga exigiendo el rol de superadministrador en D1.
- **Disponibilidad:** si Access o su servidor de claves no responden, la administración no funciona (503). La app de entrenadores y familias no depende de ello.
- **iPhone:** para administrar, mejor Safari que la PWA instalada.
- **Plan:** hay que confirmar en la cuenta que el segundo factor independiente y su duración por aplicación o política están disponibles.
- **Correo como vínculo inicial:** quien controle el correo de un administrador **antes** de su primer acceso podría vincular su propia cuenta. Hay que nombrar con correos verificados y pedir que entren cuanto antes.
- **Sin paneles:** todas las operaciones se usan por API o por consola.
