# Arquitectura

## Capas

```
ui/ (React)  ──►  services/  ──►  data/Repository  ──►  IndexedDB
     │                │
     └──► stats/ ◄────┘      (motor puro: eventos → cifras)
          clock/             (cronómetro puro)
          domain/            (tipos, catálogo, validación)
```

- **domain/**: tipos (`types.ts`), catálogo cerrado de acciones y etiquetas (`catalog.ts`), validación (`validation.ts`), utilidades de eventos y formato. No depende de React ni del almacenamiento.
- **clock/**: funciones puras `start`, `pause`, `setTime`, `shift`, `elapsedMs`, `countdownMs`… Reciben el instante actual como parámetro, por eso son fáciles de probar.
- **stats/**: `computeMatchStats` y `computeSeasonStats`. Reciben partidos y eventos y devuelven contadores. No guardan nada. `rankings.ts` clasifica una lista de candidatos (jugador + contadores) sin saber de qué equipo salen: hoy recibe los de un equipo y una temporada; un ranking de club podrá pasarle los de varios equipos. Devuelve la clasificación completa (`rankPlayers`), de la que salen el Top 10 (`topOf`) y el puesto de un jugador concreto (`positionOf`).
- **data/**: `Repository` es la interfaz de acceso a datos; `IndexedDbRepository` la implementa con la librería `idb`. Cada escritura espera a que la transacción se confirme (`durability: 'strict'`) antes de resolver.
- **services/**: reglas de negocio (`teamService`, `matchService`) y carga de datos para la temporada y los rankings (`statsService`). Validan, construyen objetos nuevos (sin mutar) y los guardan antes de devolverlos.
- **app/** y **ui/**: React. Las pantallas llaman a servicios y recalculan estadísticas con `useMemo` a partir de los eventos en memoria.

## Flujo de un registro en directo

1. Primera pulsación (p. ej. «Lanzamiento»): se toma el **tiempo de partido** en ese instante.
2. Se elige tipo + resultado en una matriz (una sola pulsación) y después el jugador.
3. `recordEvent` valida (catálogo, jugador convocado, posición compatible) y guarda en IndexedDB.
4. Solo si el guardado se confirma, el evento entra en el estado de la pantalla, se muestra un aviso breve y el panel vuelve al inicio. Si falla, se muestra el error y la selección se mantiene para reintentar.

## Persistencia

Base de datos IndexedDB `galipaustats`, versión 1:

| Almacén   | Clave | Índice    |
| --------- | ----- | --------- |
| `teams`   | `id`  | —         |
| `players` | `id`  | `byTeam`  |
| `matches` | `id`  | `byTeam`  |
| `events`  | `id`  | `byMatch` |

Las migraciones se añaden en `openStatsDb` (bloque `upgrade`, por versión). El estado del cronómetro forma parte del registro del partido.

## Rutas

Enrutado por hash, sin librería: `#/`, `#/team/:id`, `#/team/:id/new-match`, `#/team/:id/rankings`, `#/match/:id`. Funciona con cualquier hosting estático y con el service worker.

## PWA y sin conexión

`vite-plugin-pwa` (Workbox `generateSW`) precachea todos los recursos del build. Tras la primera carga correcta la app funciona sin red. `registerType: 'prompt'`: cuando hay versión nueva se muestra un aviso y **solo se actualiza si el usuario pulsa «Actualizar»**, para no recargar la app en mitad de un partido.

## Preparación para sincronización

- Identificadores UUID generados en el dispositivo para equipos, jugadores, partidos y eventos.
- Todas las escrituras son `put` por id: repetirlas no duplica (idempotencia).
- Borrados lógicos (`deletedAt`) en eventos y partidos: se podrán propagar.
- `createdAt`/`updatedAt` en todos los registros, con marcas monotónicas en eventos.
- La UI solo conoce la interfaz `Repository`; se podrá envolver con una versión que encole cambios hacia Cloudflare Workers + D1 sin tocar pantallas ni servicios.
