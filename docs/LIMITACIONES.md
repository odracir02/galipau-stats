# Limitaciones conocidas

## Datos

- **Todo vive en este dispositivo y este navegador.** Si se borran los datos del sitio, se desinstala la PWA en algunos sistemas, se usa el modo incógnito o se pierde el móvil, los datos se pierden. Todavía no hay sincronización ni copias de seguridad.
- En iPhone, Safari puede borrar los datos de webs **no instaladas** tras 7 días sin uso. La app instalada en la pantalla de inicio no sufre ese borrado (la sincronización prevista es la solución de fondo).
- En iOS, la app instalada y Safari tienen almacenamientos distintos: los datos de uno no se ven en el otro. Hay que instalarla antes de crear datos.
- Eliminar la app de la pantalla de inicio borra sus datos. Ver [DESPLIEGUE.md](DESPLIEGUE.md#datos-en-ios).
- Si se abre el mismo partido en dos pestañas a la vez, la última escritura del partido (reloj, marcador) gana. No hay bloqueo entre pestañas.

## Cronómetro

- El tiempo se reconstruye con el reloj del sistema (`Date.now()`). Si alguien cambia la hora del móvil con el cronómetro en marcha, el tiempo de partido salta en la misma cantidad. Si la hora retrocede, el cronómetro no resta tiempo (se queda en su último valor de referencia) y conviene ajustarlo a mano. El cambio de horario de verano no afecta (`Date.now()` es UTC); una resincronización automática de la hora del móvil puede mover el reloj unos segundos, corregibles con «Ajustar cronómetro».
- Es **orientativo**: no sustituye al reloj oficial. No se detiene solo en el 30 ni en el 60.
- La cuenta atrás asume partes de 30 minutos (configurable en el modelo; aún no en la interfaz).

## Funcionalidad

- Duración de parte fija en 30 min desde la interfaz (el modelo admite otras).
- Un jugador de campo no puede figurar como portero (lanzamiento recibido). Si un jugador de campo se pone de portero, hay que registrarlo como acción pendiente.
- Tras cambiar el tipo de una acción a otro incompatible con el jugador (p. ej. de «Lanzamiento» a «Portería»), la acción queda sin asignar hasta que se elija portero.
- Los partidos eliminados no se pueden restaurar desde la interfaz (el dato se conserva; no hay papelera). Tampoco se pueden eliminar equipos.
- Sin PDF, sincronización, autenticación ni invitaciones (fuera del alcance de esta versión).
- La guionización de etiquetas largas depende del navegador; en anchos estrechos las tarjetas de cifras pasan a dos columnas para que no se corten.

## Backend (preparado, sin uso)

- El Worker y D1 existen solo en el repositorio y en local. No hay recursos en Cloudflare ni sincronización en la app.
- Faltan las rutas de alta de club y equipo, canje de códigos y subida de partidos y plantillas (Tarea 005C).
- La autenticación administrativa (Cloudflare Access) está implementada pero sin configurar: hasta crear las aplicaciones de Access, la administración responde 503. Ver [AUTENTICACION_ADMIN.md](AUTENTICACION_ADMIN.md#limitaciones-y-riesgos).
- La tabla de intentos de canje necesitará una purga periódica cuando se despliegue.

## PWA

- **Icono:** la rana con el balón. `npm run icons` (`scripts/generate-icons.mjs`) genera todos los tamaños a partir de `scripts/icon-source.png`, rellenando las esquinas blancas de la imagen con su propio fondo:
  - `favicon.png` (64 × 64, esquinas transparentes);
  - `apple-touch-icon.png` (180 × 180, iPhone, sin transparencia, al 92 %);
  - `pwa-192.png` y `pwa-512.png` (Android y manifiesto, a sangre);
  - `pwa-512-maskable.png` (al 86 %: la rana y el balón dentro del círculo seguro).
  - `og-image-v1.png` (1200 × 630): la vista previa al compartir el enlace (WhatsApp, Telegram, redes). Los metadatos `og:*` y `twitter:*` los escribe en `index.html` el plugin `shareMeta` de `vite.config.ts`, con la URL absoluta según la rama (`develop` → Preview; otra → producción). Si la imagen cambia, hay que subir la versión del nombre (`-v2`…) en el script y en `SHARE_IMAGE`.
  - WhatsApp guarda la vista previa de cada enlace durante un tiempo y no permite borrarla: los mensajes ya enviados conservan la anterior, y un enlace compartido de nuevo puede tardar en mostrar la imagen nueva. Para comprobarla al momento, comparte la dirección con algo distinto al final (por ejemplo, `/?v=2`).
  - Los PNG se guardan sin pérdida con el mejor filtro por fila. Los dos de 512 px no entran en la precaché del service worker (`globIgnores` en `vite.config.ts`): solo se usan al instalar y siguen en el manifiesto.
  - Un móvil con la app ya instalada puede tardar en mostrar el icono nuevo: en iPhone hay que quitarla de la pantalla de inicio y volver a añadirla; en Android, Chrome lo actualiza solo pasado un tiempo (o al reinstalarla).
- En iOS no hay aviso automático de instalación: Safari → Compartir → «Añadir a pantalla de inicio».
- iOS ignora la orientación del manifiesto, y mantener la pantalla encendida puede fallar con la app instalada en versiones anteriores a iOS 18.4 (alternativa: Bloqueo automático → Nunca).
- El service worker solo funciona con `npm run build && npm run preview` o en HTTPS. En `npm run dev` no hay modo sin conexión.
- Para probar desde el móvil por wifi (`--host`) la página carga, pero sin HTTPS no se instala como PWA ni funciona sin conexión.
- La primera visita debe hacerse con conexión para que se descarguen los recursos.
