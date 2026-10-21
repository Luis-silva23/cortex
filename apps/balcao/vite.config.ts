import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import pkg from './package.json';

// Build reproduzível e por ambiente: o endereço do servidor vem de VITE_API_URL (fixado no build; em produção só https, ver
// src/config.ts). Os utilitários compartilhados com a API e o PDV (parcelamento em centavos, regra do endereço do servidor) são
// resolvidos para o `.ts` do pacote: o `.js` ao lado é CommonJS compilado e o Rollup não o importa.
export default defineConfig({
  plugins: [react()],
  define: { __BALCAO_VERSION__: JSON.stringify(pkg.version) },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@ln-system/shared/utils/installments': path.resolve(__dirname, '../../packages/shared/utils/installments.ts'),
      '@ln-system/shared/utils/server-url': path.resolve(__dirname, '../../packages/shared/utils/server-url.ts'),
    },
  },
  server: { port: 5174, strictPort: true },
  preview: { port: 5174, strictPort: true },
});
