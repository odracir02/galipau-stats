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

32. Estadísticas → Equipo: comprobar a mano goles, lanzamientos, eficacia, pérdidas, sanciones e intervalos.
33. Jugadores → tocar un jugador. ✔ Ficha completa (lanzamientos por tipo, pérdidas desglosadas, sanciones…).
34. Porteros → ficha. ✔ % paradas = paradas / (paradas + goles), los «fuera» no cuentan.

## G. Persistencia, sin conexión y finalización

35. Cerrar la pestaña y volver a abrir. ✔ En Inicio aparece «Partido en curso · Continuar».
36. DevTools → Network → Offline y recargar. ✔ La app carga y se pueden registrar acciones.
37. ⋮ → Finalizar partido con alguna acción pendiente. ✔ Avisa de las pendientes pero permite finalizar.
38. Volver al equipo. ✔ Historial con fecha, rival, L/V, temporada, resultado y estado «Finalizado».
39. Abrir el partido finalizado. ✔ Se abre en Estadísticas; se puede corregir desde la cronología; ⋮ → Reabrir.
40. Pestaña Temporada con dos partidos. ✔ Totales sumados; PJ por jugador; porcentajes sobre totales.
41. Cambiar nombre o dorsal de un jugador en la plantilla. ✔ Los partidos anteriores muestran el nombre/dorsal de entonces.
