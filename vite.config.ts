/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
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
    include: ['src/**/*.test.ts'],
  },
});
