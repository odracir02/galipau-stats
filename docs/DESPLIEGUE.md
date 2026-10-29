# Despliegue e instalación en iPhone

## Cloudflare Pages

GalipauStats es un sitio estático (React + Vite + service worker). No necesita servidor, base de datos ni variables secretas.

| Ajuste | Valor |
| ------ | ----- |
| Proyecto | `galipau-stats` (independiente de cualquier otro proyecto) |
| Repositorio | `odracir02/galipau-stats` (autorizar solo este repositorio) |
| Preset de framework | React (Vite) |
| Comando de build | `npm run build` |
| Directorio de salida | `dist` |
| Directorio raíz | `/` |
| Node.js | 24, fijado en `.node-version` (alternativa: variable `NODE_VERSION=24`) |
| Rama de producción | `main` → `https://galipau-stats.pages.dev` |
| Vistas previas | solo `develop` → `https://develop.galipau-stats.pages.dev` |

Notas:

- **Despliegue inmediato:** al conectar el repositorio, Cloudflare despliega `main` en producción. La dirección `pages.dev` es pública.
- **Rutas:** usan `#`, así que no hacen falta reglas de redirección.
- **Cabeceras:** [`public/_headers`](../public/_headers) se copia a `dist/` y Cloudflare lo aplica.
  - `sw.js`, `index.html` y el manifiesto se revalidan siempre, para que las versiones nuevas lleguen.
  - `/assets/*` (archivos con huella en el nombre) se guardan en caché un año.
  - Cabeceras de seguridad básicas.
- **Coste:** el plan gratuito de Pages cubre este uso.

### Servidor de la API

La dirección del servidor se fija al compilar, en [`vite.config.ts`](../vite.config.ts), nunca en los componentes:

| Compilación | Servidor |
| ----------- | -------- |
| Cloudflare Pages, rama `develop` (`CF_PAGES=1`, `CF_PAGES_BRANCH=develop`) | Worker de Preview |
| Cloudflare Pages, `main` (producción) o cualquier otra rama | Ninguno, **aunque haya una variable `VITE_API_URL` definida en Pages**: en Pages solo decide la rama |
| Fuera de Pages (desarrollo y pruebas locales) con `VITE_API_URL` | La indicada |
| Fuera de Pages sin `VITE_API_URL` | Ninguno: la app funciona solo en local y no muestra «Equipos del club» |

El Worker solo admite peticiones de la PWA desde `https://develop.galipau-stats.pages.dev` (CORS). Las vistas previas por commit (`<hash>.galipau-stats.pages.dev`) no pueden usar el servidor.

### Flujo de trabajo

1. Los cambios se suben a `develop` y Cloudflare publica una vista previa en `develop.galipau-stats.pages.dev`.
2. Se prueba la vista previa, también en el iPhone.
3. Cuando se aprueba, `develop` se integra en `main` y Cloudflare publica la producción.

## Instalación en iPhone

Requisitos: iOS 16.4 o superior (recomendado). Desde iOS 15.4 funciona todo salvo mantener la pantalla encendida.

1. Abrir la dirección **en Safari**.
2. Botón **Compartir** → **Añadir a pantalla de inicio** → Añadir. iOS no muestra ningún aviso automático de instalación.
3. Abrir GalipauStats **desde el icono** de la pantalla de inicio y usarla siempre desde ahí.
4. La primera vez, abrirla con conexión. Después funciona sin Internet.

Recomendado durante los partidos:

- **Ajustes → Pantalla y brillo → Bloqueo automático → Nunca.** La app pide mantener la pantalla encendida, pero en versiones anteriores a iOS 18.4 esto podía no funcionar con la app instalada.
- Activar el **bloqueo de rotación**: iOS ignora la orientación vertical indicada en el manifiesto.

Actualizaciones: cuando hay una versión nueva, al abrir la app aparece «Hay una versión nueva de GalipauStats». Solo se actualiza al pulsar «Actualizar», nunca en mitad de un partido.

## Datos en iOS

- **La app instalada y Safari tienen almacenamientos separados.** Lo creado en Safari no aparece en la app instalada, ni al revés. Instálala antes de crear equipos.
- **Eliminar la app** de la pantalla de inicio **borra sus datos**. Borrar los datos de sitios web en los ajustes de Safari también puede borrarlos.
- **Borrado automático:** el que Safari aplica a las webs sin uso durante 7 días no afecta a la app instalada.
- **Espacio:** un partido ocupa unos pocos kilobytes; el espacio disponible es más que suficiente.
- **Sin copia de seguridad:** hasta que exista la sincronización, perder, cambiar o restaurar el iPhone supone perder los datos. Las copias de iCloud no garantizan conservar los datos de las apps web.

## Comprobaciones en el iPhone tras el primer despliegue

1. **Tipografía:** las cifras y los títulos se ven en negrita. Si no, hay que sustituir la fuente variable por pesos fijos.
2. **Instalación:** el icono, el nombre y la apertura a pantalla completa son correctos, y la barra de estado no tapa la cabecera.
3. **Recorrido completo:**
   - Crear equipo, plantilla y partido.
   - Registrar acciones.
   - Bloquear el iPhone 1 minuto y volver: el cronómetro sigue correcto.
4. **Sin conexión:** cerrar la app, activar el modo avión y abrirla. Carga y permite registrar acciones.
5. **Persistencia:** forzar el cierre de la app y volver a abrirla. Los datos siguen ahí.
6. **Actualización:** tras una nueva subida a `develop`, al abrir la app aparece el aviso de versión nueva.
