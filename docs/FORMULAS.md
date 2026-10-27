# Fórmulas estadísticas

Implementación: [`src/stats/engine.ts`](../src/stats/engine.ts). Pruebas: `src/stats/engine.test.ts`.

Todas las cifras se calculan a partir de los eventos **no borrados**. Un porcentaje sin denominador se muestra como «—» (sin datos), nunca como 0 %.

## Lanzamientos propios y equipo (ataque)

Se aplican a cualquier autor de un lanzamiento, también a un portero que marca (p. ej. a portería vacía).

| Métrica            | Fórmula                                       |
| ------------------ | --------------------------------------------- |
| Lanzamientos       | goles + fuera + parados                       |
| Fallos             | fuera + parados                               |
| Eficacia           | goles / lanzamientos × 100                    |
| Pérdidas (total)   | pérdida general + pasos + dobles + pase fallado |
| Sanciones          | amarillas + exclusiones + rojas               |

## Tarjetas rojas y descalificación

Implementación: [`src/stats/discipline.ts`](../src/stats/discipline.ts). Las rojas **no** se cuentan evento a evento: se derivan recorriendo las acciones en orden de tiempo de partido.

- **Roja directa**: un evento `red`.
- **Roja por acumulación**: la **tercera** exclusión de un jugador en el partido. No existe como evento: es una consecuencia derivada.
- **Una sola descalificación por jugador y partido**: cuenta la que ocurre primero. Una roja registrada cuando el jugador ya estaba descalificado (p. ej. tras su 3.ª exclusión) no suma otra; una 4.ª exclusión tampoco.
- Rojas = rojas directas + rojas por acumulación (las dos cuentan como una tarjeta roja y se muestran desglosadas).
- Las rojas sin jugador asignado cuentan, cada una, en el equipo. Las exclusiones sin jugador no acumulan para nadie.
- La roja por acumulación cuenta en el intervalo de 5 minutos de la exclusión que la provoca.
- Corregir o borrar una exclusión recalcula todo: si el jugador deja de tener tres, pierde la roja y vuelve a estar disponible.
- Se aplica igual a jugadores de campo y porteros.

Por tipo de lanzamiento (9 m, 6 m, penalti, contraataque) se aplican las mismas fórmulas.

## Porteros

| Métrica                 | Fórmula                                      |
| ----------------------- | -------------------------------------------- |
| Lanzamientos recibidos  | goles + paradas + fuera                      |
| Entre los tres palos    | paradas + goles                              |
| % paradas               | paradas / (paradas + goles) × 100            |

Los lanzamientos **fuera** cuentan como recibidos pero **no** entran en el % de paradas. Mismo cálculo por procedencia (9 m, 6 m, extremo, contraataque, penalti).

## Marcador

- Propio = goles de `shot` (incluidos los pendientes de atribución) + `scoreAdjustment.own`.
- Rival = goles de `gk_shot` (incluidos pendientes) + `scoreAdjustment.opponent`.
- Nunca inferior a 0.
- La corrección manual solo cambia el marcador. **No** cambia goles, lanzamientos ni eficacias de nadie, y la pantalla muestra siempre cuánto viene de acciones y cuánto de corrección.

## Acciones pendientes de atribución

Cuentan en los totales del equipo, en el marcador y en los intervalos, pero en ningún jugador.

## Intervalos de 5 minutos

Con partes de 30 min hay 12 tramos (5', 10', … 60'). Un evento se asigna según su parte y su tiempo: `floor((t − inicioParte) / 5 min)`. El tiempo añadido de una parte (p. ej. 31:00 en la 1.ª) cae en su **último** tramo, nunca en la parte siguiente. GF/GC por tramo son goles con acción (sin correcciones manuales).

## Temporada

- Se suman los **contadores** de todos los partidos de la temporada y los porcentajes se calculan después sobre los totales. Ejemplo: 1/1 en un partido y 1/3 en otro = 2/4 = **50 %** (no la media 66,7 %).
- «Partidos» de un jugador = partidos en cuya convocatoria figura (no minutos jugados, que no se registran).
- Goles a favor/en contra de la temporada sí incluyen las correcciones manuales del marcador.
- Cuentan los partidos que se han iniciado o tienen acciones (un partido creado pero nunca empezado no cuenta). Filtro opcional «Solo finalizados».
- Medias por partido = total / partidos.

## Lo que NO se calcula

Minutos jugados, tiempo en pista, +/−, ni ninguna métrica que no se pueda derivar de los eventos registrados.
