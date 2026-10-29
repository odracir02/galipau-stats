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
| D24 | Roja por acumulación derivada, sin evento | Borrar o corregir una exclusión la elimina o la traslada sola; no puede quedar una roja «huérfana» ni duplicada. |
| D25 | Una descalificación por jugador y partido, la primera en tiempo de partido | Evita contar dos rojas si se registra una roja directa tras la 3.ª exclusión. Orden por minuto (no por orden de registro) para que una exclusión olvidada añadida después se sitúe correctamente. |
| D26 | El descalificado solo desaparece de la selección rápida | Sus acciones anteriores olvidadas se pueden atribuir desde el editor; la validación no lo bloquea. |
| D27 | Golpe franco como categoría histórica (`LEGACY_KINDS`) | Ya no se ofrece ni se puede crear (también lo impide el servicio), pero los eventos antiguos siguen siendo válidos y nunca se borran solos. |
| D28 | Advertencia de acción posterior a la expulsión solo en el editor | Es donde se pueden elegir descalificados; en la selección rápida ya no aparecen. Se calcula con la acción ya colocada (corregir la propia 3.ª exclusión no avisa contra sí misma). No bloquea: «Revisar» o «Guardar igualmente». |
| D29 | Eliminación de partidos con el borrado lógico existente | Permite restaurar más adelante y no reaparecer al sincronizar. Las acciones se conservan pero dejan de contar porque el partido no se lista. |
| D30 | Gráficas propias con CSS/SVG (anillo, barras, intervalos) | Son pocas y sencillas; una librería añadiría peso sin aportar nada. Todas muestran los valores en texto. |
| D31 | Cifras exactas en desplegables «Ver cifras exactas» | Las barras resumen; las tablas completas siguen disponibles sin alargar la pantalla. |
| D32 | Rankings calculados sobre el acumulado de temporada del motor | Las cifras coinciden siempre con las de la pestaña Temporada; no hay fórmulas duplicadas. |
| D33 | El cálculo recibe candidatos genéricos (jugador + contadores) y devuelve la clasificación completa | El Top 10 y la posición individual salen de la misma lista; un ranking de club solo tendrá que reunir candidatos de varios equipos. |
| D34 | Empates con puesto compartido (1, 1, 3) y orden por dorsal dentro del empate | Es el criterio habitual de las clasificaciones. El dorsal solo decide el orden de presentación, no el puesto. |
| D35 | Top 10 estricto: si hay más empatados en el último puesto, se avisa de cuántos no caben | Respeta el máximo de diez sin ocultar el empate. |
| D36 | Porcentajes comparados con un decimal | Lo que se ve es lo que clasifica: dos jugadores con «66,7 %» comparten puesto. |
| D37 | Mínimos: 10 lanzamientos (francotirador) y 20 tiros a puerta (el muro), en `RANKING_THRESHOLDS` | Evitan que un 1/1 lidere. Equivalen a dos o tres partidos de un lanzador habitual y a un partido de un portero. Se cambian en un solo sitio. |
| D38 | Rankings en una pantalla propia (`#/team/:id/rankings`) | Una cuarta pestaña no cabe con holgura a 320 px y los rankings necesitan su propio selector. |
| D39 | Backend en `server/` con su propio `package.json` | El build de Pages (raíz) no instala Wrangler ni compila el Worker: el despliegue actual no cambia. |
| D40 | Sin framework ni ORM en el Worker: enrutado propio y SQL parametrizado | Cuatro rutas; SQL explícito y migraciones versionadas de D1. Menos dependencias y nada que actualizar. |
| D41 | Pruebas de D1 con el SQLite integrado en Node (`node:sqlite`) tras una interfaz mínima de D1 | D1 es SQLite: se prueban las migraciones, restricciones y consultas reales sin dependencias nuevas. La migración se comprobó además en la D1 local de Wrangler. |
| D42 | Mismos UUID en el dispositivo y en el servidor; campos remotos (club, versión…) aparte | La subida es idempotente y los datos locales no cambian. |
| D43 | Claves foráneas compuestas (`id, team_id` / `id, club_id`) | El aislamiento entre equipos y clubes lo garantiza también la base de datos, no solo el código. |
| D44 | Entrenador y consulta: identidad por dispositivo con token aleatorio (solo HMAC en el servidor), sin cuentas | Cubre los casos acordados (entrenador, consulta compartida) sin contraseñas ni datos personales. Los roles administrativos usan identidades aparte (D51). |
| D45 | Códigos de 12 símbolos sin confundibles, solo hash, rotación = revocar + crear, límite de intentos en D1 | Difíciles de adivinar, fáciles de dictar y revocables. El límite en D1 es exacto; el de Cloudflare es aproximado. |
| D46 | Sin relación con el equipo o club → 404; con permiso insuficiente → 403 | No se revela qué equipos o clubes existen. |
| D47 | Concurrencia optimista por `version` + `opId` idempotente + registro de cambios con `seq` | Reintentos seguros, conflictos detectados y descarga incremental sin relojes de dispositivo. |
| D48 | Un dispositivo registra cada partido (`recorder_device_id`) | Evita conflictos en directo; la transferencia controlada cubre los casos excepcionales. |
| D49 | `people` opcional para jugadores en varios equipos | Ranking de club sin duplicar personas; solo el nombre visible (minimización). |
| D50 | Validación de acciones compartida (`src/domain/validation.ts`) entre aplicación y Worker | Las reglas de catálogo, convocatoria y porteros son idénticas en ambos lados. |
| D51 | Cuatro roles en dos sujetos: dispositivos (`coach`, `viewer` en `grants`) e identidades administrativas (`superadmin`, `club_admin` en `admin_roles`) | Los roles administrativos exigen una persona con credencial fuerte; los de equipo, solo un dispositivo. La base de datos impide mezclarlos. |
| D52 | ~~Llave de acceso (WebAuthn) propia como credencial administrativa~~ Sustituida por D60 | — |
| D53 | Ninguna ruta crea superadministradores; el primero se crea por consola con la cuenta de Cloudflare | Quien no controla la cuenta no puede escalar. El SQL no hace nada si ya hay uno. |
| D54 | El administrador de club no nombra administradores | Evita que un club se autogestione sin control del propietario; lo hace el superadministrador. |
| D55 | Clave del límite de intentos: solo `CF-Connecting-IP`, IPv6 por /64, sin cabecera = contador compartido | El cliente no puede cambiar su clave con cabeceras inventadas. |
| D56 | Revocar un código puede retirar también los accesos concedidos con él | Respuesta definida ante un código filtrado, sin tocar otros accesos. |
| D57 | Códigos de invitación de 12 símbolos (≈59 bits) | Con 10 y muchos códigos vigentes, una red de bots muy grande podría acertar en meses; con 12, siglos. |
| D58 | Node 24 como mínimo declarado (`engines`), igual que `.node-version` | Las pruebas del servidor usan el SQLite integrado en Node. Pages ya compila con Node 24: la compilación no cambia. |
| D59 | Worker local con nombre propio y prueba automática de la separación de entornos | Un `deploy` sin `--env` no puede sustituir a producción; local y preview no pueden apuntar a la base de producción. |
| D60 | Autenticación administrativa con Cloudflare Access (proveedor de identidad + segundo factor independiente); roles siempre en D1 | Menos código de seguridad propio que WebAuthn, recuperación de autenticadores resuelta, Face ID en iPhone. La híbrida duplicaría el segundo factor sin ganar seguridad. Las tablas de credenciales propias de 0001 se eliminan en 0002 (nunca se usaron). |
| D61 | El Worker verifica el JWT de Access (RS256, emisor, audiencia, vigencia) aunque Access ya filtre | Ninguna URL que no pase por Access (p. ej. workers.dev) permite entrar. Sin dependencias: Web Crypto. |
| D62 | Identidad por correo, vinculada a la cuenta de Access (`sub`) en el primer acceso | Otra cuenta con el mismo correo no puede ocupar la identidad. |
| D63 | Operaciones críticas bajo `/api/admin/critical/*`, una segunda aplicación de Access con su propia política y segundo factor reciente; el Worker exige su audiencia | La audiencia separa los dos niveles de forma verificable. No prueba el segundo factor (ver D66). |
| D64 | Sin configuración de Access, administración desactivada (503) en todos los entornos | No existe modo de desarrollo que la abra; en local y en pruebas se usan claves generadas en memoria. |
| D65 | Peticiones de administración sin dispositivo y sin CORS | Una sesión de administración no registra acciones ni canjea códigos; la API de administración solo se usa desde su propia URL. |
| D66 | Operaciones críticas desactivadas (`ADMIN_CRITICAL_OPS = "disabled"`) hasta una verificación manual del segundo factor en cada entorno | El JWT de Access no incluye el método ni el momento del segundo factor: el Worker no puede comprobarlo. Se habilitan solo tras comprobar en Cloudflare que se vuelve a pedir. |
| D67 | La aplicación de Access crítica lleva su propia política explícita | En Access, la ruta más específica prevalece y no hereda las reglas de la general. |
| D68 | Solo rutas canónicas en el Worker y sin URLs de vista previa | El Worker enruta exactamente lo que Access protege; no hay otra URL por versión que llegue al Worker. El JWT se exige igualmente en cualquier hostname. |
| D69 | Protección CSRF propia en las escrituras administrativas: `Sec-Fetch-Site` = `same-origin`, `Origin` exacto, ambas ausentes = rechazo y JSON obligatorio | La cookie de Access usa `SameSite=None` por defecto; la protección no puede depender de esa configuración. Se comprueba antes de autenticar. |
| D70 | No se limita aún la antigüedad del token crítico por `iat` | `iat` no es la hora de la biometría y su semántica no está documentada; un límite fijo podría bloquear sin motivo. Propuesta: medir en preview y, si `exp − iat` refleja la sesión, exigir `exp − iat ≤ 15 min`. |
| D71 | `authorize()` excluye equipos de clubes eliminados, para todos los roles | Eliminar un club corta todos los accesos a sus equipos sin borrar datos; el canje de invitaciones lo comprueba también. |
| D72 | Panel de administración servido por el Worker en `/admin`, mismo origen que la API | La protección CSRF y la cookie de Access siguen sin cambios; sin dominio nuevo; separado de la PWA. |
| D73 | El Worker se ejecuta antes que los archivos del panel (`run_worker_first`) y verifica Access y el rol | El panel no depende solo de la configuración de Access; cabeceras de seguridad propias. |
| D74 | Todas las escrituras administrativas son críticas; toda ruta `/critical` exige el token crítico | Siguen bloqueadas por `ADMIN_CRITICAL_OPS` y piden biometría reciente. |
| D75 | Códigos guardados como HMAC (canje) y como copia AES-GCM con `INVITE_CODE_KEY` (mostrar), con datos asociados de fila | Se pueden volver a consultar sin regenerar; una copia cifrada no sirve en otra fila; una clave distinta para cada uso. |
| D76 | Dos códigos creados con el equipo, independientes, válidos hasta el 1 de agosto siguiente al inicio de la temporada | Nunca falta un código; la temporada nueva usa equipos y códigos nuevos. |
| D77 | El entrenador ve los dos códigos pero no los regenera; consulta solo ve el suyo | Requisito aprobado; regenerar y revocar son administrativos. |
| D78 | Clubes `active`/`suspended` (migración aditiva 0003); la suspensión corta el acceso operativo y solo el superadministrador la gestiona | Reversible, sin borrar datos. |
| D79 | El módulo de entrada del Worker solo exporta el manejador | Con archivos estáticos, el runtime rechaza otras exportaciones con nombre y el Worker no arrancaría. |
| D80 | Canje público con token opcional; con un token no válido, 401 sin crear dispositivo | Evita crear dispositivos huérfanos cuando la app tiene un token caducado o revocado; la app sabe que debe volver a empezar. |
| D81 | El token se entrega una vez en el cuerpo de la respuesta y solo se acepta en `Authorization` | Fuera de URLs, historiales y registros. |
| D82 | `GET /api/session` muestra los equipos no disponibles en vez de ocultarlos | La app puede explicar la situación (club suspendido) sin borrar datos locales; el acceso sigue cerrado. |
| D83 | Cerrar sesión revoca el dispositivo completo; dejar un equipo, solo ese permiso | Dos acciones claras para el usuario; ninguna toca otros dispositivos. |
| D84 | El golpe franco vuelve como acción de equipo (sustituye a D27) | Se registra con un toque y sin jugador, con el mismo tipo `free_throw` que ya aceptan el modelo, D1 y la sincronización. Los eventos antiguos asignados a un jugador se conservan tal cual. La regla «sin jugador» la aplica el servicio local, no la validación compartida con el servidor, para no rechazar esos eventos antiguos. |
| D85 | Las acciones de equipo no son «pendientes de atribuir» | Un golpe sin jugador no espera a nadie: no suma en «Sin asignar», en el aviso al finalizar ni en el filtro de la cronología. |
| D86 | Exclusiones activas derivadas, sin estado guardado | Se calculan con el evento y el cronómetro: se pausan con el reloj, sobreviven a cerrar la app y se corrigen solas al deshacer, borrar o editar. |
| D87 | Fin real de la 1.ª parte en `clock.firstHalfEndMs` | La 2.ª parte empieza en 30:00 aunque la 1.ª terminara después; sin este dato una exclusión que atraviesa el descanso se descontaría mal. Va dentro de `clock_json`, que el servidor guarda sin interpretar: no hace falta cambiar D1. Los partidos anteriores usan el final nominal. |
| D88 | Sin cuenta atrás en partidos preparados o finalizados | El registro de partidos ya jugados se hace sin reloj: todas las exclusiones quedarían congeladas en 2:00. |
| D89 | Sanción individual separada de la inferioridad del equipo | La sanción (evento) cuenta en las estadísticas; la inferioridad se deriva de ella. Así la 3.ª exclusión abre una sola inferioridad aunque además descalifique, y una roja a un jugador ya descalificado no abre ninguna. |
| D90 | La roja directa abre 2 min de inferioridad | Regla habitual: el jugador queda descalificado y el equipo juega 2 min con uno menos. Se identifica como «Roja» en la tarjeta. |
| D91 | 4 min solo cuando el registrador marca una sanción como adicional antes de reanudar (`addsToPrevious`) | No se deduce de los tiempos ni se encadenan todas las sanciones del mismo jugador. Se marca tocando la tarjeta de la inferioridad: el registro normal sigue con los mismos toques. |
| D92 | La marca de sanción adicional no cambia estadísticas y se pierde si la sanción pasa a otro jugador | Solo tiene sentido sobre la inferioridad anterior de ese mismo jugador. |
| D93 | La sesión del dispositivo vive en una base IndexedDB propia (`galipaustats-cuenta`) | Añadirla no exige migrar ni abrir la base de equipos y partidos, que sigue en la versión 1; borrarla nunca afecta a los datos locales. |
| D94 | La URL del servidor se fija al compilar (`VITE_API_URL` o rama `develop` de Pages) | Ningún componente lleva direcciones; producción sigue funcionando solo en local hasta que se decida otra cosa. |
| D95 | El canje no se reintenta solo; la comprobación de sesión sí | Un canje repetido sin respuesta podría crear un segundo dispositivo; la comprobación es de solo lectura. |
| D96 | Cerrar sesión y salir de un equipo exigen conexión | La revocación tiene que ocurrir en el servidor; olvidar el token solo en el móvil daría una falsa sensación de cierre. |
| D97 | Vínculo explícito y único entre equipo local y equipo del club, guardado aparte | Los ids locales no cambian; la correspondencia vive en `galipaustats-cuenta`. Coincidir en nombre o código nunca vincula. |
| D98 | Envío manual, con previsualización y confirmación del primero | El usuario decide cuándo salen datos del dispositivo; nada se envía al vincular, al abrir la app ni al registrar. |
| D99 | El envío se detiene ante cualquier conflicto o rechazo | Nunca se sobrescribe ni se transforma un dato; el motivo se muestra y lo ya enviado queda anotado para continuar. |
| D100 | Los partidos eliminados en el dispositivo no se envían | El servidor no admite acciones de partidos eliminados; enviarlos exigiría pasos artificiales. Se indican y se conservan en el dispositivo. |
| D101 | «Sincronización completada» solo tras comparar con el servidor | Se descarga el equipo y se comparan registros, versiones, resultados y estadísticas; cualquier diferencia se muestra. |
| D102 | La consulta de equipos del club es solo lectura para cualquier rol | Un único dispositivo registra cada partido; los demás, también los de entrenador, solo consultan. Evita conflictos y escrituras accidentales. |
| D103 | Lo descargado vive en `galipaustats-consulta`, separado | No puede mezclarse con los datos del registrador ni sobrescribirlos, y se puede borrar sin tocar nada más. |
| D104 | Se reutilizan las vistas de temporada y rankings | Mismos cálculos y presentación que en local: `SeasonView` y `RankingsView` reciben los partidos, vengan del dispositivo o del club. |
| D105 | Los datos descargados se retiran solo cuando la falta de acceso está verificada | 401/403/404 o una comprobación correcta de la sesión sin el equipo; sin conexión se conservan con aviso de que pueden estar desactualizados. |
| D106 | Envío automático incremental, con agrupación de 3 s (máximo 15 s) | Una petición por acción, no por pulsación; las ráfagas se agrupan y el registro nunca espera. |
| D107 | El repositorio avisa después de guardar, sin cambiar cómo se guarda | El envío automático no puede retrasar ni alterar una escritura local; si falla, el dato ya está guardado. |
| D108 | Ante conflicto, rechazo o falta de permiso, el envío automático se detiene y queda detenido | Nunca se insiste ni se sobrescribe; un envío manual comprobado lo reanuda. |
| D109 | El borrado de un partido ya enviado se envía como marca de borrado | Así el club deja de verlo; sus acciones se conservan en el servidor tal cual. |
| D110 | Sin envío en segundo plano con la app cerrada | Las PWA de iPhone no lo permiten de forma fiable; al abrir se comprueba lo pendiente. |
| D111 | El envío automático está desactivado por defecto y se activa expresamente por equipo y dispositivo | Actualizar la app no puede empezar a enviar datos sin que el entrenador lo decida; si hay algo pendiente, se muestra antes de enviarlo. |
| D112 | Eliminar un partido ya enviado pide una confirmación específica | El borrado llega a los móviles de consulta; cancelar no borra nada y, si el envío falla, queda pendiente sin darse por hecho. |
