// Compilación del panel de administración. Sale a server/admin-dist/admin, que
// el Worker sirve en /admin (mismo origen que la API). No afecta a la PWA.
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root,
  base: '/admin/',
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL('../server/admin-dist/admin', import.meta.url)),
    emptyOutDir: true,
    // Nada en línea: la política de seguridad del panel solo admite archivos propios.
    assetsInlineLimit: 0,
  },
});
