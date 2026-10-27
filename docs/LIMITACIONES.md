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
- Faltan las rutas de alta de club y equipo, canje de códigos, transferencia de partidos y subida de partidos y plantillas (Tarea 005C).
- El inicio de sesión administrativo (llave de acceso) y sus rutas no existen todavía: el modelo, las reglas y el alta del primer superadministrador están preparados.
- La tabla de intentos de canje necesitará una purga periódica cuando se despliegue.

## PWA

- En iOS no hay aviso automático de instalación: Safari → Compartir → «Añadir a pantalla de inicio».
- iOS ignora la orientación del manifiesto, y mantener la pantalla encendida puede fallar con la app instalada en versiones anteriores a iOS 18.4 (alternativa: Bloqueo automático → Nunca).
- El service worker solo funciona con `npm run build && npm run preview` o en HTTPS. En `npm run dev` no hay modo sin conexión.
- Para probar desde el móvil por wifi (`--host`) la página carga, pero sin HTTPS no se instala como PWA ni funciona sin conexión.
- La primera visita debe hacerse con conexión para que se descarguen los recursos.
