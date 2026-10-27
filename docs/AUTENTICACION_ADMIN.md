# Autenticación administrativa

Cómo se identifican el **superadministrador** y los **administradores de club**. Entrenadores y familias no se ven afectados: siguen con dispositivos e invitaciones de equipo, que nunca dan acceso administrativo.

> **Estado:** implementado y probado en local. **No está operativo**:
>
> - falta crear en Cloudflare las aplicaciones de Access, rellenar su configuración y desplegar el Worker;
> - sin esa configuración, las rutas de administración responden **503** en cualquier entorno;
> - las **operaciones críticas** están **desactivadas** (`ADMIN_CRITICAL_OPS = "disabled"`, también 503) hasta superar la [verificación manual del segundo factor](#verificación-manual-del-segundo-factor).

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
- Copiar el *Application Audience (AUD) Tag* de cada aplicación y el dominio del equipo en `server/wrangler.jsonc` (`ACCESS_TEAM_DOMAIN`, `ACCESS_AUD_ADMIN`, `ACCESS_AUD_CRITICAL`). No son secretos.
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
7. Volver a pedirlo **antes** de que pase la duración configurada → no lo pide.
8. Volver a pedirlo **después** de esa duración → **lo pide de nuevo**, aunque la sesión general siga abierta. Este es el punto clave. Si no lo pide, la configuración no garantiza el segundo factor reciente y las operaciones críticas **no se habilitan**.
9. Revisar el registro de Access (*Logs → Access*) para confirmar los inicios de sesión y los segundos factores de los pasos anteriores.

**Habilitar**
10. Poner `ADMIN_CRITICAL_OPS = "enabled"` solo en ese entorno, desplegar y repetir el paso 8 con una operación real. Por ejemplo, crear un club de prueba en preview: responde 201 y aparece en `admin_audit`.
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
