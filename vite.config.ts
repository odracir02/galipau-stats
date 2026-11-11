/// <reference types="vitest/config" />
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * Servidor de la API. Se fija al compilar, nunca en los componentes:
 * - en Cloudflare Pages decide SOLO la rama: develop usa el Worker de Preview y
 *   cualquier otra (main = producción) ninguno, aunque haya variables heredadas;
 * - fuera de Pages (desarrollo y pruebas locales), VITE_API_URL si se define;
 * - sin ella, la app funciona solo en local.
 */
const PREVIEW_API_URL = 'https://galipau-stats-api-preview.ricardosastrelopez.workers.dev';

function apiUrlFor(mode: string): string {
  if (process.env.CF_PAGES === '1') return process.env.CF_PAGES_BRANCH === 'develop' ? PREVIEW_API_URL : '';
  return loadEnv(mode, process.cwd(), 'VITE_').VITE_API_URL ?? '';
}

/**
 * Dirección pública de la app, para los metadatos al compartir el enlace (que
 * exigen URL absolutas). En Pages decide la rama, como con la API; fuera de
 * Pages, VITE_SITE_URL si se define (sin ella, rutas relativas).
 */
const PREVIEW_SITE_URL = 'https://develop.galipau-stats.pages.dev';
const PRODUCTION_SITE_URL = 'https://galipau-stats.pages.dev';

function siteUrlFor(mode: string): string {
  if (process.env.CF_PAGES === '1') return process.env.CF_PAGES_BRANCH === 'develop' ? PREVIEW_SITE_URL : PRODUCTION_SITE_URL;
  return (loadEnv(mode, process.cwd(), 'VITE_').VITE_SITE_URL ?? '').replace(/\/+$/, '');
}

/** Imagen al compartir el enlace (scripts/generate-icons.mjs); el nombre lleva versión. */
const SHARE_IMAGE = 'og-image-v1.png';
const SHARE_TITLE = 'GalipauStats';
const SHARE_DESCRIPTION = 'Estadísticas de balonmano en directo, sin conexión.';

/**
 * Metadatos para la vista previa del enlace (WhatsApp, Telegram, redes…),
 * escritos en el propio index.html: los robots no ejecutan JavaScript.
 */
function shareMeta(siteUrl: string): Plugin {
  const image = `${siteUrl}/${SHARE_IMAGE}`;
  const meta = (attr: 'property' | 'name', key: string, content: string) => ({ tag: 'meta', attrs: { [attr]: key, content }, injectTo: 'head' as const });
  return {
    name: 'galipau-share-meta',
    transformIndexHtml: () => [
      meta('property', 'og:type', 'website'),
      meta('property', 'og:site_name', SHARE_TITLE),
      meta('property', 'og:title', SHARE_TITLE),
      meta('property', 'og:description', SHARE_DESCRIPTION),
      meta('property', 'og:locale', 'es_ES'),
      ...(siteUrl ? [meta('property', 'og:url', `${siteUrl}/`)] : []),
      meta('property', 'og:image', image),
      ...(siteUrl.startsWith('https://') ? [meta('property', 'og:image:secure_url', image)] : []),
      meta('property', 'og:image:type', 'image/png'),
      meta('property', 'og:image:width', '1200'),
      meta('property', 'og:image:height', '630'),
      meta('property', 'og:image:alt', 'Icono de GalipauStats: una rana con un balón de balonmano'),
      meta('name', 'twitter:card', 'summary_large_image'),
      meta('name', 'twitter:title', SHARE_TITLE),
      meta('name', 'twitter:description', SHARE_DESCRIPTION),
      meta('name', 'twitter:image', image),
    ],
  };
}

export default defineConfig(({ mode }) => {
  const apiUrl = apiUrlFor(mode);
  return {
    define: { 'import.meta.env.VITE_API_URL': JSON.stringify(apiUrl) },
    plugins: [
      shareMeta(siteUrlFor(mode)),
      react(),
      VitePWA({
        // 'prompt': nunca recargamos la app por sorpresa en mitad de un partido.
        registerType: 'prompt',
        // Los iconos y el favicon ya entran por globPatterns: no se añaden dos veces.
        includeManifestIcons: false,
        manifest: {
          // Identidad estable de la app instalada, independiente de la URL de inicio.
          id: '/',
          name: 'GalipauStats',
          short_name: 'GalipauStats',
          description: 'Estadísticas de balonmano en directo, sin conexión.',
          lang: 'es',
          theme_color: '#17212c',
          background_color: '#17212c',
          display: 'standalone',
          orientation: 'portrait',
          start_url: '/',
          scope: '/',
          icons: [
            { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
            { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
            { src: 'pwa-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        },
        workbox: {
          // El manifiesto lo añade el propio plugin; no se repite aquí.
          globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
          // Los iconos de 512 px solo se usan al instalar (siguen en el manifiesto) y la
          // imagen para compartir, solo al compartir: no hacen falta sin conexión.
          globIgnores: ['**/pwa-512*.png', '**/og-image*.png'],
          navigateFallback: 'index.html',
        },
      }),
    ],
    test: {
      environment: 'node',
      include: ['src/**/*.test.ts', 'server/test/**/*.test.ts', 'admin/src/**/*.test.ts'],
    },
  };
});
