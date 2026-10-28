# Sistema de diseño

Estética deportiva y sobria. Una sola fuente de verdad: los tokens de `:root` en [`src/styles.css`](../src/styles.css). Los componentes **no** usan colores hexadecimales propios.

## Color

| Token | Valor | Uso |
| ----- | ----- | --- |
| `--c-bg` | `#F6F7F9` | Fondo general |
| `--c-surface` | `#FFFFFF` | Tarjetas, botones, hojas |
| `--c-surface-2` | `#EEF0F3` | Estado pulsado, rellenos neutros |
| `--c-header` | `#17212C` | Cabeceras; resultado favorable en portería (parada) |
| `--c-text` | `#17212C` | Texto principal |
| `--c-text-2` / `--c-text-3` | `#5F6B78` / `#8A949F` | Texto secundario / terciario |
| `--c-accent` | `#C9243D` | Acción principal, gol propio, pestaña activa, reloj parado («Reanudar») |
| `--c-secondary` | `#E9892C` | Uso puntual: cuenta atrás, pendientes, etiqueta de portero |
| `--c-danger` | `#B42318` | Errores, acciones destructivas y etiqueta «Derrota» |
| `--c-success` | `#1E7A4C` | Etiqueta «Victoria» |
| `--c-warning-soft` / `--c-warning-text` | `#FDF4CF` / `#7A5B00` | Etiqueta «Empate» |
| `--c-keeper` | `#1D6F8F` | Indicador circular de eficacia de portería |
| `--c-gold` / `--c-gold-text` | `#D6A83A` / `#8A6514` | Solo rankings: corona del líder y primer puesto |

Reglas:

- Las acciones del registro son **neutras** (superficie blanca con icono en acento). No hay un color por acción.
- El color solo transmite significado operativo:
  - Rojo relleno: gol propio, o reloj parado (botón «Reanudar»).
  - Rojo suave: gol recibido.
  - Oscuro: parada propia.
  - Contorno: resultado neutro (fuera).
  - Naranja: atención (cuenta atrás, acciones sin asignar).
- Contraste AA: texto principal sobre fondo ≈ 15:1; acento sobre blanco ≈ 5,6:1.

## Tipografía

Inter (variable, subconjunto latino, empaquetada para funcionar sin conexión), con la fuente del sistema como alternativa. Las cifras usan dígitos tabulares (`font-variant-numeric: tabular-nums`) para que el reloj y las tablas no «bailen».

## Espaciado, radios y áreas táctiles

- Espaciado en escala de 4 px: `--s-1` … `--s-6`.
- Radios: `--r-sm` 8, `--r-md` 12, `--r-lg` 16.
- Área táctil mínima `--tap` 48 px; botones principales `--tap-lg` 56 px. El botón del cronómetro mide 60 px de alto.

## Iconos

Un único juego, `lucide-react`, con trazo 2 y tamaño 20 px por defecto (componente `Icon`). Los iconos de las acciones están centralizados en `src/ui/components/icons.ts`.

## Estadísticas

- **Resumen**: anillo con el porcentaje principal (eficacia ofensiva o % de paradas) junto a las cifras que lo generan («5 goles / 7 lanzamientos») y tarjetas de cifras clave.
- **Barras horizontales** (`Meter`) para porcentajes por tipo o procedencia, siempre con «% · aciertos/intentos». Sin intentos se muestra «Sin datos» con una pista discontinua, nunca 0 %.
- **Barras de recuento** (`CountBar`) para la composición de pérdidas.
- **Intervalos de 5 minutos**: goles a favor hacia arriba (rojo) y en contra hacia abajo (oscuro), con números y leyenda; la dirección distingue las series sin depender del color.
- Las tablas completas quedan en desplegables «Ver cifras exactas».
- Tarjetas de cifras con columnas adaptativas (2 en móvil estrecho, 3 cuando caben).

## Rankings

- Cabecera con trofeo; acceso desde el trofeo de la cabecera del equipo y desde la pestaña Temporada.
- Selector en carrusel horizontal de píldoras (se desplaza dentro de sí mismo, no la página).
- Título y descripción de la clasificación; el mínimo de los porcentajes, en negrita.
- Tarjeta oscura del líder con corona dorada; si hay empate, «Líderes empatados» con todos sus nombres.
- Lista compacta, sin repetir al líder (empieza por el segundo clasificado): puesto, dorsal, nombre, partidos jugados y cifra (en porcentajes, también aciertos/intentos). Entre tarjeta y lista, como máximo el Top 10.
- Estado vacío con trofeo gris cuando no hay partidos o nadie cumple el mínimo.

## Pantalla de partido

1. **Cabecera fija (oscura):**
   - Primera fila: marcador pulsable para corregirlo, con nuestro equipo y el rival.
   - Segunda fila: cronómetro a la izquierda y botón grande de pausa/reanudación a la derecha.
   - La cuenta atrás tiene su espacio reservado: al aparecer no desplaza nada.
2. **Barra de última acción** con «Deshacer».
3. **Cuadrícula compacta** de cinco accesos: Lanzamiento, Portería, Pérdida, Recuperación y Defensa y sanciones.
4. **Navegación inferior fija** con iconos (Registro, Cronología, Estadísticas), respetando el área segura del dispositivo.

Los avisos de confirmación no interceptan pulsaciones y se ocultan mientras hay una hoja abierta.
