/// <reference types="vitest/config" />
import { defineConfig, loadEnv } from 'vite';
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

export default defineConfig(({ mode }) => {
  const apiUrl = apiUrlFor(mode);
  return {
    define: { 'import.meta.env.VITE_API_URL': JSON.stringify(apiUrl) },
    plugins: [
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
