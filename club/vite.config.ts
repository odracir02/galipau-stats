// Compilación del panel de clubes. Sale a server/admin-dist/club, que el Worker
// sirve en /club/ (mismo origen que la API de cuentas) solo con ACCOUNTS_ENABLED.
// Independiente de la PWA deportiva y del panel de superadministración.
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root,
  base: '/club/',
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL('../server/admin-dist/club', import.meta.url)),
    emptyOutDir: true,
    // Nada en línea: la política de seguridad del panel solo admite archivos propios.
    assetsInlineLimit: 0,
  },
});
