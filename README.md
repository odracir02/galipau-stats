# GalipauStats

Aplicación de estadísticas de balonmano para cuerpos técnicos. Durante el partido, un entrenador registra cada acción desde el móvil en dos o tres pulsaciones; después, el equipo técnico consulta el rendimiento del equipo, de cada jugador y de cada portero, por partido y por temporada.

Funciona sin conexión a Internet: está pensada para pabellones sin cobertura.

> **Estado:** beta. Los datos se guardan en el propio dispositivo. La sincronización entre dispositivos, los informes PDF y las gráficas avanzadas están previstos para versiones posteriores.

## Funcionalidades

- **Equipos y plantillas:** código corto por equipo, temporada, dorsales únicos y jugadores de campo y porteros. Los partidos conservan el nombre y el dorsal que tenía cada jugador en ese momento.
- **Partidos:** rival, fecha, local o visitante y convocatoria, con propuesta automática de la convocatoria anterior.
- **Cronómetro orientativo:** iniciar, pausar, ajustar, descanso y segunda parte. Muestra una cuenta atrás en los últimos cinco minutos de cada parte y se recupera tras bloquear el móvil, cambiar de aplicación o recargar.
- **Registro en directo:** primero la acción y después el jugador.
  - Lanzamientos: 9 m, 6 m, penalti y contraataque; resultado gol, fuera o parada.
  - Portería: lanzamientos recibidos según procedencia.
  - Pérdidas: pasos, dobles, pase fallado y otras.
  - Recuperaciones y sanciones.
  - Deshacer siempre visible y acciones pendientes de atribuir.
- **Corrección:** cronología editable, acciones olvidadas y corrección del marcador separada de las estadísticas.
- **Disciplina:** roja automática a la tercera exclusión y aviso si se atribuye una acción posterior a una descalificación.
- **Estadísticas:**
  - Panel de equipo: indicadores principales, eficacia por tipo de lanzamiento, portería por procedencia, balance de balón, disciplina y evolución por intervalos de 5 minutos.
  - Fichas completas de cada jugador y de cada portero.
  - Acumulados de temporada calculados sobre totales.
- **Rankings del equipo:** Top 10 de la temporada en ocho clasificaciones (goleadores, eficacia, % de paradas, paradas, recuperaciones, exclusiones, pérdidas y lanzamientos), con empates y mínimos para los porcentajes.
- **Partidos:** se pueden eliminar (por ejemplo, los de prueba) sin afectar a la temporada ni a los demás partidos.
- **Instalable (PWA):** se añade a la pantalla de inicio en Android y iPhone.

## Tecnologías

React 19 · TypeScript (estricto) · Vite · vite-plugin-pwa (Workbox) · IndexedDB (`idb`) · Vitest · ESLint · lucide-react · Inter

## Instalación

Requisitos: Node.js 24 (fijado en `.node-version`) y npm.

```bash
git clone <url-del-repositorio> galipau-stats
cd galipau-stats
npm install
```

## Desarrollo local

```bash
npm run dev        # servidor de desarrollo → http://localhost:5173
```

El modo sin conexión solo funciona con el build de producción:

```bash
npm run build
npm run preview    # → http://localhost:4173
```

Desde un móvil en la misma red: `npm run preview -- --host` y abrir la dirección IP que aparece. Sin HTTPS los navegadores no instalan la PWA ni activan el modo sin conexión; para eso hace falta un entorno publicado con HTTPS (ver [Despliegue](docs/DESPLIEGUE.md)).

## Pruebas y calidad

```bash
npm test           # pruebas automatizadas (motor estadístico, cronómetro, persistencia…)
npm run lint       # ESLint
npm run typecheck  # TypeScript
npm run check      # lint + pruebas + build
```

> **Windows:** si `npm test` falla con «Vitest failed to find the runner», la terminal está en `c:\…` (unidad en minúscula). Abre la terminal en `C:\…` y repite.

## Arquitectura

```
src/
  domain/    Tipos, catálogo de acciones y validación (sin dependencias de interfaz)
  clock/     Cronómetro basado en referencias temporales
  stats/     Motor estadístico: funciones puras que derivan las cifras de los eventos
  data/      Interfaz de repositorio + implementación IndexedDB
  services/  Reglas de negocio de equipos, partidos y eventos
  app/       Rutas, avisos y hooks
  ui/        Pantallas y componentes
docs/        Documentación técnica
scripts/     Utilidades (generación de iconos)
```

Principios:

- **Los eventos son la fuente de verdad.** Las estadísticas se recalculan siempre a partir de ellos, de modo que corregir o borrar una acción actualiza todo de forma automática.
- **Cada acción se guarda en el dispositivo antes de darse por registrada.** Las escrituras son idempotentes y los identificadores se generan en el propio dispositivo, para preparar la sincronización futura.

## Documentación

- [Arquitectura](docs/ARQUITECTURA.md)
- [Despliegue e instalación en iPhone](docs/DESPLIEGUE.md)
- [Backend: Cloudflare Workers + D1](docs/BACKEND.md) (base preparada, aún sin uso)
- [Protocolo de sincronización](docs/SINCRONIZACION.md)
- [Permisos, seguridad y privacidad](docs/SEGURIDAD.md)
- [Autenticación administrativa](docs/AUTENTICACION_ADMIN.md) (Cloudflare Access)
- [Administración de clubes, equipos y códigos](docs/ADMINISTRACION.md) (panel en el Worker, sin desplegar)
- [Modelo de dominio y eventos](docs/MODELO_DATOS.md)
- [Fórmulas estadísticas](docs/FORMULAS.md)
- [Sistema de diseño](docs/DISENO.md)
- [Decisiones técnicas](docs/DECISIONES.md)
- [Limitaciones conocidas](docs/LIMITACIONES.md)
- [Guía de pruebas manuales](docs/PRUEBAS_MANUALES.md)
