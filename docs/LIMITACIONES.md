# Limitaciones conocidas

## Datos

- **Todo vive en este dispositivo y este navegador.** Si se borran los datos del sitio, se desinstala la PWA en algunos sistemas, se usa el modo incógnito o se pierde el móvil, los datos se pierden. Todavía no hay sincronización ni copias de seguridad.
- En iPhone, Safari puede borrar los datos de webs **no instaladas** tras unos días sin uso. Conviene instalar la PWA en la pantalla de inicio (y la sincronización de la Tarea 004 es la solución de fondo).
- PWA instalada y navegador son almacenamientos distintos en iOS: los datos de uno no se ven en el otro.
- Si se abre el mismo partido en dos pestañas a la vez, la última escritura del partido (reloj, marcador) gana. No hay bloqueo entre pestañas.

## Cronómetro

- El tiempo se reconstruye con el reloj del sistema (`Date.now()`). Si alguien cambia la hora del móvil con el cronómetro en marcha, el tiempo de partido salta en la misma cantidad. Si la hora retrocede, el cronómetro no resta tiempo (se queda en su último valor de referencia) y conviene ajustarlo a mano. El cambio de horario de verano no afecta (`Date.now()` es UTC); una resincronización automática de la hora del móvil puede mover el reloj unos segundos, corregibles con «Ajustar cronómetro».
- Es **orientativo**: no sustituye al reloj oficial. No se detiene solo en el 30 ni en el 60.
- La cuenta atrás asume partes de 30 minutos (configurable en el modelo; aún no en la interfaz).

## Funcionalidad

- Duración de parte fija en 30 min desde la interfaz (el modelo admite otras).
- Un portero no puede figurar como autor de un lanzamiento (p. ej. gol a portería vacía) ni un jugador de campo como portero. Se puede registrar como acción pendiente.
- Tras cambiar el tipo de una acción a otro incompatible con el jugador (p. ej. de «Lanzamiento» a «Portería»), la acción queda sin asignar hasta que se elija portero.
- No hay borrado de equipos ni de partidos desde la interfaz (el servicio `deleteMatch` existe, sin pantalla).
- Sin gráficas, PDF, sincronización, autenticación ni invitaciones (fuera del alcance de la Tarea 001).

## PWA

- El service worker solo funciona con `npm run build && npm run preview` o en HTTPS. En `npm run dev` no hay modo sin conexión.
- Para probar desde el móvil por wifi (`--host`) la página carga, pero sin HTTPS no se instala como PWA ni funciona sin conexión.
- La primera visita debe hacerse con conexión para que se descarguen los recursos.
