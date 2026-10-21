import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron';
import renderer from 'vite-plugin-electron-renderer';
import path from 'path';
import pkg from './package.json';

// Versão do app CÓRTEX PDV embutida no build do processo principal: `app.getVersion()` devolve a versão do Electron
// quando o app roda sem empacotar (a telemetria reportava "28.3.3").
const appVersionDefine = { __CORTEX_APP_VERSION__: JSON.stringify(pkg.version) };

export default defineConfig({
  plugins: [
    react(),
    electron([
      {
        entry: 'electron/main.ts',
        vite: {
          define: appVersionDefine,
          build: {
            outDir: 'dist-electron',
          },
        },
      },
      {
        entry: 'electron/preload.ts',
        onstart(options) {
          options.reload();
        },
        vite: {
          build: {
            outDir: 'dist-electron',
          },
        },
      },
    ]),
    renderer(),
  ],
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
  },
});
