import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// Config só para servir o renderer do PDV num NAVEGADOR (http://localhost:5173) — sem os plugins
// `vite-plugin-electron*` de vite.config.ts, que compilam/abrem o Electron a cada start. Usado por
// `npm run dev:web` (desenvolvimento e auditoria E2E no navegador). O app empacotado continua
// sendo gerado por vite.config.ts (base './', file://).
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // regra de parcelamento compartilhada com a API: o .ts (o .js ao lado é CommonJS compilado e o Rollup não o importa)
      '@ln-system/shared/utils/installments': path.resolve(__dirname, '../../packages/shared/utils/installments.ts'),
      '@ln-system/shared/utils/server-url': path.resolve(__dirname, '../../packages/shared/utils/server-url.ts'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
