# GalipauStats

Estadísticas de balonmano para entrenadores. El segundo entrenador registra el partido en directo desde el móvil; después se consultan las estadísticas del partido y de la temporada.

**Estado:** beta local (Tarea 001). Todo se guarda en el propio dispositivo (IndexedDB). Todavía no hay sincronización, cuentas, PDF ni despliegue.

## Requisitos

- Node.js 20 o superior (desarrollado con Node 24) y npm.

## Ejecutar en local

```bash
npm install
npm run dev          # desarrollo: http://localhost:5173
```

Para probar la PWA y el modo sin conexión hay que usar el build de producción (el service worker no se activa en `dev`):

```bash
npm run build
npm run preview      # http://localhost:4173
```

Para probar desde un móvil en la misma red wifi: `npm run preview -- --host` y abrir la IP que muestra. Ojo: fuera de `localhost` los navegadores solo instalan la PWA y activan el service worker con **HTTPS**, así que la prueba completa de instalación sin conexión en el móvil necesitará la vista previa publicada de una tarea posterior.

## Scripts

| Script              | Qué hace                                       |
| ------------------- | ---------------------------------------------- |
| `npm run dev`       | Servidor de desarrollo                         |
| `npm run build`     | Comprobación de tipos + build de producción    |
| `npm run preview`   | Sirve el build (con service worker)            |
| `npm test`          | Pruebas automatizadas (Vitest)                 |
| `npm run lint`      | ESLint                                         |
| `npm run typecheck` | TypeScript estricto                            |
| `npm run check`     | lint + test + build                            |
| `npm run icons`     | Regenera los iconos PNG de la PWA              |

> **Windows:** si `npm test` falla con «Vitest failed to find the runner», la terminal está en `c:\…` (unidad en minúscula). Abre la terminal en `C:\…` o haz `cd C:\Users\...\GalipauStats` y repite.

## Estructura

```
src/
  domain/      Tipos, catálogo de acciones, validación, utilidades (sin React)
  clock/       Cronómetro puro basado en referencias temporales
  stats/       Motor estadístico (funciones puras)
  data/        Interfaz Repository + implementación IndexedDB
  services/    Reglas de negocio: equipos, partidos, eventos
  app/         Infraestructura de UI: rutas, avisos, hooks
  ui/          Pantallas y componentes React
docs/          Documentación interna
scripts/       Utilidades (generación de iconos)
```

## Documentación

- [Arquitectura](docs/ARQUITECTURA.md)
- [Modelo de dominio y eventos](docs/MODELO_DATOS.md)
- [Fórmulas estadísticas](docs/FORMULAS.md)
- [Decisiones técnicas](docs/DECISIONES.md)
- [Limitaciones conocidas](docs/LIMITACIONES.md)
- [Guía de pruebas manuales](docs/PRUEBAS_MANUALES.md)
