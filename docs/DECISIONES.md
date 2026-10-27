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
| D52 | Llave de acceso (WebAuthn) como credencial administrativa, TOTP opcional, sesiones cortas y verificación reciente para operaciones críticas | Resistente al phishing y sin contraseñas que guardar. |
| D53 | Ninguna ruta crea superadministradores; el primero se crea por consola con la cuenta de Cloudflare | Quien no controla la cuenta no puede escalar. El SQL no hace nada si ya hay uno. |
| D54 | El administrador de club no nombra administradores | Evita que un club se autogestione sin control del propietario; lo hace el superadministrador. |
| D55 | Clave del límite de intentos: solo `CF-Connecting-IP`, IPv6 por /64, sin cabecera = contador compartido | El cliente no puede cambiar su clave con cabeceras inventadas. |
| D56 | Revocar un código puede retirar también los accesos concedidos con él | Respuesta definida ante un código filtrado, sin tocar otros accesos. |
| D57 | Códigos de invitación de 12 símbolos (≈59 bits) | Con 10 y muchos códigos vigentes, una red de bots muy grande podría acertar en meses; con 12, siglos. |
| D58 | Node 24 como mínimo declarado (`engines`), igual que `.node-version` | Las pruebas del servidor usan el SQLite integrado en Node. Pages ya compila con Node 24: la compilación no cambia. |
| D59 | Worker local con nombre propio y prueba automática de la separación de entornos | Un `deploy` sin `--env` no puede sustituir a producción; local y preview no pueden apuntar a la base de producción. |
