# Decisiones técnicas

| # | Decisión | Motivo |
|---|----------|--------|
| D1 | React 19 + Vite 8 + TypeScript 6.0 estricto | Stack acordado. TypeScript se fija en 6.0 porque `typescript-eslint` aún no admite TS 7. |
| D2 | Persistencia con `idb` (≈1 KB) sobre IndexedDB | Envoltorio mínimo y mantenido; evita errores de la API nativa de callbacks. |
| D3 | Sin librería de rutas ni de estado | Cuatro pantallas; enrutado por hash y estado local bastan. Menos dependencias. |
| D4 | Eventos como única fuente de verdad; estadísticas siempre recalculadas | Editar/borrar un evento corrige automáticamente todas sus consecuencias. Recalcular un partido entero cuesta milisegundos. |
| D5 | Cronómetro como estado `{baseMs, anchorWallMs, running}` | Sobrevive a bloqueo, cambio de app y recarga. Los intervalos de pantalla solo repintan. |
| D6 | El tiempo del evento se toma en la **primera** pulsación del recorrido | Es el momento más cercano a la jugada real; elegir el dorsal puede llevar unos segundos. |
| D7 | Matriz tipo × resultado en una sola vista | Lanzamiento = 3 pulsaciones (Lanzamiento → celda → dorsal). |
| D8 | Convocatoria copiada en el partido (`squad`) | Los partidos históricos conservan nombre/dorsal/posición del momento. |
| D9 | Borrado lógico (`deletedAt`) para eventos y partidos | Deshacer fiable y preparado para sincronizar borrados. |
| D10 | Ids generados al abrir el formulario | Doble pulsación o reintento devuelven el mismo equipo/partido, sin duplicar. |
| D11 | Corrección del marcador en `scoreAdjustment`, aparte de los eventos | No se inventan lanzamientos ni goles atribuidos; las eficacias no se falsean. |
| D12 | «Deshacer» = anular la última acción **registrada** | Lo que el usuario espera tras un error de pulsación, aunque haya añadido antes una acción olvidada con un minuto anterior. |
| D13 | Descanso → «Iniciar 2.ª parte» arranca el reloj en 30:00 con una pulsación | El cambio de parte se confirma al ir al descanso; el arranque coincide con el pitido. |
| D14 | Service worker en modo `prompt` | Nunca se recarga la app sola en mitad de un partido. |
| D15 | Wake Lock de pantalla durante el partido (si el navegador lo admite) | Evita que el móvil se bloquee durante el registro. No es imprescindible: el reloj no depende de ello. |
| D16 | `navigator.storage.persist()` al arrancar | Reduce el riesgo de que el navegador borre los datos por falta de espacio. No es una garantía. |
| D17 | Partido válido para temporada si se ha iniciado o tiene acciones | Evita contar convocatorias de partidos creados por error y nunca jugados. |
| D18 | Lanzamientos recibidos solo a porteros; lanzamientos propios a cualquier convocado | Un portero puede marcar (portería vacía). En la selección de autor los porteros aparecen al final, marcados «POR». |
| D19 | Iconos PNG generados con un script propio sin dependencias | Evita instalar herramientas de imagen solo para cuatro iconos. |
| D20 | Sistema de diseño con tokens CSS centralizados en `src/styles.css` | Una sola fuente para colores, espaciado, radios y tipografía. Ver [DISENO.md](DISENO.md). |
| D21 | Iconos de `lucide-react` | Un único juego homogéneo (mismo trazo); solo se empaquetan los iconos usados. |
| D22 | Tipografía Inter empaquetada (solo subconjunto latino) | Aspecto uniforme en Android e iPhone y disponible sin conexión (≈48 kB). |
| D23 | Cronómetro y botón de pausa en la misma fila de la cabecera | Gana altura útil para el registro sin reducir el área táctil del botón (60 px). |
