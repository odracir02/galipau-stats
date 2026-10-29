# Guía de pruebas manuales

Usar **solo datos ficticios**. Preparar: `npm run build && npm run preview` y abrir `http://localhost:4173` en Chrome/Edge con las herramientas de desarrollo en modo móvil (p. ej. iPhone 12/13, 390 × 844).

Cada prueba indica qué hacer y qué debe pasar (✔).

## A. Equipo y plantilla

1. «+ Nuevo equipo»: nombre `Equipo Prueba`, código `ep 2627`. ✔ Se guarda como `EP2627` y se abre el equipo.
2. Crear otro equipo con el mismo código. ✔ Error «Ya existe un equipo con el código…».
3. Plantilla → «+ Añadir jugador»: añadir ~16 jugadores de campo y 2 porteros con «Guardar y añadir otro». ✔ Lista ordenada por dorsal, separada en campo/porteros.
4. Añadir un jugador con un dorsal ya usado. ✔ Error indicando quién lo tiene.
5. Marcar un jugador como inactivo y crear otro con su dorsal. ✔ Se permite.

## B. Crear partido

6. Partidos → «+ Nuevo partido». ✔ Fecha de hoy y temporada del equipo propuestas.
7. Seleccionar 14 de campo + 2 porteros. ✔ Contador «14 campo + 2 porteros = 16/16».
8. Seleccionar uno más. ✔ Contador en rojo y botón desactivado.
9. Crear partido. ✔ Se abre la pantalla de partido en «Preparado», reloj 00:00.

## C. Cronómetro

10. «▶ Iniciar partido». ✔ Cuenta, estado «En marcha», botón «Pausar» naranja.
11. Pausar y esperar 10 s. ✔ No avanza; botón verde «Reanudar».
12. Reanudar, bloquear el móvil / cambiar de pestaña 30 s y volver. ✔ El tiempo incluye esos 30 s.
13. Recargar la página (F5) con el reloj en marcha. ✔ Sigue en marcha con el tiempo correcto. Repetir pausado: ✔ sigue pausado.
14. ⋮ → Ajustar cronómetro → fijar `26:30`. ✔ Aparece «quedan ≈ 03:30» y va bajando; el botón de pausa no se mueve.
15. Fijar `31:00`. ✔ El reloj sigue contando; la cuenta atrás marca 00:00, nunca negativa.
16. ⋮ → Descanso → confirmar. ✔ Reloj parado, estado «Descanso», botón «Iniciar 2.ª parte».
17. «Iniciar 2.ª parte». ✔ Reloj en 30:00 en marcha, «2.ª parte».

## D. Registro rápido (debe hacerse sin mirar instrucciones)

18. Gol de 9 m del dorsal X: Lanzamiento → «Gol» en la fila 9 m → dorsal. ✔ 3 pulsaciones, marcador +1, aviso breve, vuelve al inicio sin jugador seleccionado.
19. Lanzamiento fuera y parado. ✔ El marcador no cambia.
20. Portería → parada 9 m → portero. Portería → gol de extremo → portero. ✔ Marcador rival +1.
21. Pérdida → Pasos → jugador. Recuperación → portero. Defensa y sanciones → Exclusión 2 min → jugador.
22. Empezar un lanzamiento y, a mitad, pulsar «Pausar». ✔ El reloj se para y el registro en curso sigue abierto.
23. Lanzamiento → Gol contraataque → «Sin identificar». ✔ Aparece «1 sin asignar».
24. «Deshacer». ✔ Desaparece la última acción y el marcador se corrige.

## E. Corrección

25. Cronología → tocar un gol → cambiar jugador → Guardar. ✔ En Estadísticas → Jugadores el gol pasa de uno a otro; total igual.
26. Cambiar un gol a «Fuera». ✔ El marcador baja.
27. Cambiar el minuto de una acción. ✔ La cronología se reordena.
28. Eliminar una acción de pasos. ✔ Desaparecen pasos y pérdida del jugador y del equipo.
29. «+ Añadir acción olvidada» con un minuto anterior. ✔ Aparece en su sitio de la cronología.
30. Asignar la acción pendiente desde la cronología (filtro «Sin asignar»). ✔ El contador de pendientes baja.
31. Tocar el marcador → «+» al rival. ✔ Aparece «*» y en Estadísticas se explica la corrección; eficacias sin cambios.

## F. Estadísticas

32. Estadísticas → Equipo: comprobar a mano goles, lanzamientos, eficacia, pérdidas, sanciones e intervalos. ✔ Dos indicadores circulares: eficacia ofensiva y eficacia de portería (paradas / (paradas + goles recibidos), con las cifras absolutas; «—» si no hay tiros a puerta). En la cabecera del partido aparece el nombre en el marcador del equipo (Editar equipo → «Nombre en el marcador»), no su código.
33. Jugadores → tocar un jugador. ✔ Ficha completa (lanzamientos por tipo, pérdidas desglosadas, sanciones…).
34. Porteros → ficha. ✔ % paradas = paradas / (paradas + goles), los «fuera» no cuentan.

## G. Persistencia, sin conexión y finalización

35. Cerrar la pestaña y volver a abrir. ✔ En Inicio aparece «Partido en curso · Continuar».
36. DevTools → Network → Offline y recargar. ✔ La app carga y se pueden registrar acciones.
37. ⋮ → Finalizar partido con alguna acción pendiente. ✔ Avisa de las pendientes pero permite finalizar.
38. Confirmar «Finalizar». ✔ Vuelve sola a la pantalla del equipo, pestaña «Partidos», con el resultado y la etiqueta «Victoria» (verde), «Derrota» (roja) o «Empate» (amarilla) según nuestro marcador, también como visitante y con correcciones. Rival siempre como «vs Rival»; Local/Visitante en la línea de información.
39. Abrir el partido finalizado. ✔ Se abre en Estadísticas; se puede corregir desde la cronología; ⋮ → Reabrir.
40. Pestaña Temporada con dos partidos. ✔ Totales sumados; PJ por jugador; porcentajes sobre totales.
41. Cambiar nombre o dorsal de un jugador en la plantilla. ✔ Los partidos anteriores muestran el nombre/dorsal de entonces.

## H. Gol de portero

42. Lanzamiento → «Gol» 9 m → en la selección de autor, los porteros aparecen al final con la etiqueta «POR»; elegir un portero. ✔ Marcador propio +1.
43. Estadísticas → Porteros. ✔ Aparece la columna G/L; el % de paradas del portero no cambia.
44. Ficha del portero. ✔ Incluye la sección «Lanzamientos» con su gol; «Lanzamientos recibidos» no cambia.

## I. Diseño y ergonomía

45. Probar en tres tamaños de DevTools: 390 × 844, 375 × 667 (iPhone SE) y 360 × 780.
    - ✔ La cabecera no tapa ningún botón.
    - ✔ La barra inferior no tapa contenido.
    - ✔ El botón de pausa siempre es visible.
46. Ajustar el reloj a 24:55 y esperar al 25:00. ✔ Aparece «quedan 05:00» sin que nada se desplace.
47. Pulsar varias acciones seguidas. ✔ El aviso inferior nunca bloquea un botón.
48. Abrir el editor de una acción justo después de registrar. ✔ El aviso no tapa el formulario.
49. Con teclado (ordenador):
    - ✔ Tab recorre los botones con un foco visible.
    - ✔ Escape cierra las hojas.

## J. Descalificación por tercera exclusión

50. Registrar tres exclusiones al mismo jugador. ✔ En la tercera, el aviso dice «3.ª exclusión: roja por acumulación».
51. Iniciar cualquier acción. ✔ Ese jugador ya no aparece en la selección y debajo se indica «Descalificados (no disponibles)».
52. Cronología. ✔ La tercera exclusión lleva la nota «Roja por acumulación»; no aparece ninguna roja como acción.
53. Estadísticas → Jugadores → su ficha. ✔ Exclusiones 3 · Rojas «1 · por acumulación» · Sanciones 4. Equipo: «Expulsiones (rojas) 1 · por acumulación».
54. Registrar también una roja directa a ese jugador desde «Añadir acción olvidada». ✔ Sigue habiendo 1 roja; la cronología marca la directa «Ya descalificado: no suma».
55. «Añadir acción olvidada»: en la lista de jugadores aparece «(descalificado)» y se le puede atribuir un gol de antes. ✔ Cuenta en su ficha y en el marcador.
56. Recargar la página. ✔ Sigue descalificado y con las mismas cifras.
57. Eliminar la tercera exclusión. ✔ Desaparece la roja y vuelve a estar disponible.
58. Cambiar una de sus exclusiones a otro jugador que ya tenía dos. ✔ La roja pasa al otro jugador; el primero vuelve a estar disponible.
59. Repetir con un portero. ✔ Mismo comportamiento.
60. Roja directa a un jugador sin exclusiones. ✔ «1 · directa» y deja de estar disponible.

## K. Panel de estadísticas

61. Estadísticas → Equipo con un partido con datos variados.
    - ✔ El anillo de eficacia muestra el porcentaje y «X goles / Y lanzamientos».
    - ✔ Las barras por tipo muestran «% · goles/lanzamientos».
    - ✔ Los tipos sin lanzamientos dicen «Sin datos».
62. «Ver cifras exactas». ✔ Tabla con Gol, Fuera, Parada, Total y Eficacia, más la fila Total.
63. Portería, Balance de balón, Disciplina y defensa. ✔ Cuadran con la cronología; los golpes francos no aparecen.
64. Evolución por intervalos. ✔ Goles a favor hacia arriba y en contra hacia abajo, con números; «Ver detalle por intervalo» abre la tabla.
65. Jugadores y Porteros. ✔ Una tarjeta por jugador con su barra; al tocarla se abre la ficha (dorsal, contexto, anillo, bloques).
66. Temporada → ficha. ✔ Incluye «Promedios por partido».
67. Repetir en 320, 360, 375 y 390 px. ✔ Nada se sale de la pantalla ni de su tarjeta.

## L. Golpes francos

68. Registro → «Golpe». ✔ Un solo toque, sin elegir jugador; «Última: Golpe franco · Equipo» y aviso. Un doble toque rápido guarda una sola acción. No aparece en «Sin asignar».
69. Deshacer y, desde la cronología, eliminar un golpe. ✔ Deja de contar.
70. Estadísticas → Equipo → «Disciplina y defensa». ✔ «Golpes francos en contra» del partido; en Temporada, la suma. El marcador y el resto de cifras no cambian; las fichas de jugador no muestran golpes.
70b. Con datos antiguos que tengan golpes francos asignados a un jugador. ✔ Siguen en la cronología con su jugador, cuentan en el total del equipo y se pueden corregir o eliminar.

## L2. Exclusiones activas

70c. Con el partido en juego, Defensa → Exclusión 2 min → jugador. ✔ Bajo el cronómetro aparece una tarjeta con dorsal, nombre y 02:00 que baja con el reloj.
70d. Pausar. ✔ La cuenta atrás se detiene. Cerrar la app y volver a abrirla. ✔ Mismo tiempo restante.
70e. Dos exclusiones a la vez (y otra al mismo jugador). ✔ Una tarjeta por exclusión; primero la que antes acaba.
70f. Exclusión a 29:30 y descanso a los 30:20. ✔ En el descanso quedan 1:10; al iniciar la 2.ª parte siguen bajando desde 1:10.
70g. Deshacer o corregir el minuto de la exclusión. ✔ La tarjeta desaparece o cambia su tiempo. Al llegar a 00:00 desaparece; la exclusión sigue en la cronología y en las estadísticas.
70h. Partido preparado (registro sin reloj) o finalizado. ✔ No aparece ninguna tarjeta.
70i. Roja directa. ✔ Tarjeta de 2:00 con dorsal en rojo y etiqueta «Roja»; los mismos toques que antes, sin preguntas.
70j. 3.ª exclusión de un jugador. ✔ Una sola tarjeta de 2:00 con «Roja» (no aparece una segunda por la roja por acumulación). Registrar después una roja al mismo jugador no añade otra tarjeta.
70k. Exclusión y, antes de reanudar, roja al mismo jugador. ✔ Dos tarjetas. Tocar la de la exclusión → marcar la roja como «sanción adicional antes de reanudar». ✔ Queda una sola tarjeta «Roja 4'» de 04:00. Desmarcar. ✔ Vuelven las dos de 2:00. Las estadísticas (exclusiones y rojas) no cambian en ningún caso.
70l. Con una inferioridad de 4 min, pausar, ir al descanso, cerrar y reabrir la app. ✔ Conserva el tiempo y la etiqueta.

## M. Eliminar partidos

71. Crear un partido de prueba, iniciarlo y registrar acciones.
72. ⋮ → «Eliminar partido» (separado, en rojo).
    - ✔ La confirmación muestra rival y fecha.
    - ✔ «Cancelar» no elimina nada.
73. Confirmar.
    - ✔ Se sale al equipo.
    - ✔ El partido desaparece del historial y del aviso «Partido en curso».
    - ✔ La temporada se recalcula; los demás partidos y la plantilla no cambian.
74. Recargar. ✔ Sigue eliminado.
75. Repetir con un partido preparado y con uno finalizado.

## N. Advertencia de expulsión

76. Descalificar a un jugador (3 exclusiones o roja directa) en, por ejemplo, el 42:15.
77. Cronología → «Añadir acción olvidada»: ese jugador (descalificado), 2.ª parte, 47:20 → Guardar.
    - ✔ Aviso «El dorsal … fue descalificado en el minuto 42:15 … Esta acción corresponde al minuto 47:20», visible sin desplazar.
78. «Revisar». ✔ No guarda; se puede cambiar el minuto.
79. Cambiar a un minuto anterior → Guardar. ✔ Se guarda sin aviso.
80. Repetir con un minuto posterior → «Guardar igualmente». ✔ Se guarda; las sanciones no cambian.
81. Mover la 3.ª exclusión a un minuto posterior a la acción. ✔ La acción deja de considerarse posterior y ya no avisa.

## O. Rankings

82. Con un equipo sin partidos, pulsar el trofeo de la cabecera del equipo.
    - ✔ Pantalla «Rankings» con trofeo y estado vacío «Todavía no hay partidos».
83. Jugar (o usar) dos partidos con goles, lanzamientos, paradas, recuperaciones, exclusiones y pérdidas de varios jugadores.
84. Volver a Rankings (también desde Temporada → «Rankings»). Recorrer las siete clasificaciones del selector («Muro defensivo» ya no existe).
    - ✔ Cada una muestra su descripción; el francotirador y el muro indican su mínimo.
    - ✔ Las cifras coinciden con Temporada → Jugadores / Porteros.
    - ✔ Tarjeta oscura del líder con corona; empates con el mismo puesto (1, 1, 3) y «Líderes empatados».
    - ✔ El líder no se repite en la lista, que empieza por el 2.º clasificado; entre tarjeta y lista, nunca más de 10 jugadores.
    - ✔ Nadie con 0 en la cifra aparece en la lista.
85. Francotirador con un jugador de 9 lanzamientos. ✔ No aparece; con el 10.º, sí.
86. El muro: un portero con muchos lanzamientos fuera. ✔ No cambian su %.
87. Editar un gol a otro jugador y borrar otro desde la cronología. Volver a Rankings. ✔ Las cifras cambian.
88. Eliminar uno de los partidos. ✔ Sus acciones dejan de contar.
89. Probar a 320 px y en el iPhone. ✔ El selector se desliza en horizontal sin mover la página; los nombres largos se recortan sin desbordar.

## P. Acceso con código (005E.2C, solo en la vista previa de `develop`)

90. Inicio. ✔ Dos secciones: «En este dispositivo» (equipos locales, sin cambios) y «Equipos del club».
91. «Unirse con código» con un código de prueba incorrecto. ✔ «Código no válido o caducado.» Con menos de 12 caracteres el botón no se activa.
92. Código de entrenador (mayúsculas o minúsculas, con o sin guiones). ✔ «Acceso concedido»: equipo, club y permiso «Entrenador», sin haber elegido el rol. Los equipos y partidos locales siguen igual.
93. «Ver el equipo». ✔ Club, equipo, código, temporada, «Tu permiso» y «Todavía no hay partidos sincronizados».
94. Cerrar la app y volver a abrirla. ✔ El equipo del club sigue en la lista.
95. Modo avión y abrir la app. ✔ Se ve la lista con «Sin conexión: se muestra la última comprobación (hora)». Los equipos locales funcionan igual.
96. «Salir de este equipo». ✔ Desaparece de la lista. «Sesión de este dispositivo → Cerrar sesión». ✔ La sección queda vacía; los datos locales no cambian.
97. Con la sesión retirada desde el servidor, abrir la app. ✔ Aviso «La sesión de este dispositivo ya no es válida» y lista vacía.

## Q. Vincular y enviar (005E.2D, vista previa de `develop`, con datos de prueba)

98. Con el código de entrenador canjeado, abrir un equipo local. ✔ Tarjeta «Servidor del club» con «Vincular con un equipo del club». Con solo acceso de consulta no aparece.
99. Vincular: ningún equipo viene seleccionado; elegir uno → «Continuar» → se ven los dos equipos → «Volver». ✔ No queda vinculado. Repetir y «Vincular». ✔ «Vinculado con…»; no se ha enviado nada.
100. «Enviar al servidor». ✔ Previsualización con origen, destino y cifras; partidos eliminados indicados aparte. «Enviar al servidor» → «Primer envío» → «Enviar». ✔ «Sincronización completada».
101. Repetir el envío. ✔ Sin confirmación de primer envío; «ya estaban al día»; nada se duplica.
102. Modo avión y enviar. ✔ «Envío detenido» por conexión; la app sigue funcionando en local.
103. Otro móvil de entrenador con los mismos datos: vincular y enviar. ✔ «Otro dispositivo registra ese partido»; nada se sobrescribe.
104. Comprobar en todos los casos que los partidos del dispositivo siguen igual (resultados, acciones, copia de seguridad).

