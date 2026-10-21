import { contextBridge, ipcRenderer } from 'electron';

// Expor APIs seguras para o renderer process
contextBridge.exposeInMainWorld('electron', {
  // Device info
  getDeviceInfo: () => ipcRenderer.invoke('get-device-info'),
  // Telemetria do equipamento (CPU/RAM/disco/uptime) para o monitoramento da filial
  getSystemMetrics: () => ipcRenderer.invoke('system-metrics'),

  // Config
  saveConfig: (config: any) => ipcRenderer.invoke('save-config', config),
  loadConfig: () => ipcRenderer.invoke('load-config'),

  // Secure storage (token/refreshToken) — cifrado no processo principal via
  // Electron safeStorage (DPAPI/Keychain/libsecret), nunca em texto puro.
  // Ver comentário em electron/main.ts.
  secureStorage: {
    setItem: (key: string, value: string) => ipcRenderer.invoke('secure-storage:set-item', key, value),
    getItem: (key: string) => ipcRenderer.invoke('secure-storage:get-item', key),
    removeItem: (key: string) => ipcRenderer.invoke('secure-storage:remove-item', key),
  },

  // Printer — printerService (src/services/printer.service.ts) fala com o processo principal
  // por AQUI. Antes ele importava `ipcRenderer` de 'electron' direto no renderer, o que só
  // funciona com nodeIntegration (o main usa contextIsolation: true / nodeIntegration: false):
  // o plugin trocava por um stub e nenhuma impressão chegava ao main.
  printer: {
    list: () => ipcRenderer.invoke('printer:list'),
    print: (payload: { printerName: string; data: string; options?: Record<string, unknown> }) =>
      ipcRenderer.invoke('printer:print', payload),
  },

  // Encerramento do aplicativo: o processo principal segura o fechamento da janela e avisa o renderer para encerrar a sessão
  // (revogar no servidor). `confirmClose` libera o fechamento; sem resposta o principal fecha sozinho após o prazo.
  onBeforeClose: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on('app:before-close', handler);
    return () => {
      ipcRenderer.removeListener('app:before-close', handler);
    };
  },
  confirmClose: () => ipcRenderer.send('app:close-ready'),

  // Barcode scanner
  onBarcodeScanned: (callback: (barcode: string) => void) => {
    ipcRenderer.on('barcode-data', (_event, barcode) => callback(barcode));
  },
  removeBarcodeListener: () => {
    ipcRenderer.removeAllListeners('barcode-data');
  },
});

// TypeScript types
declare global {
  interface Window {
    electron: {
      getDeviceInfo: () => Promise<any>;
      getSystemMetrics: () => Promise<{ cpuLoadPct: number | null; memUsedPct: number | null; diskUsedPct: number | null; uptimeSec: number; appVersion: string; runtimeVersion: string }>;
      saveConfig: (config: any) => Promise<{ success: boolean; error?: string }>;
      loadConfig: () => Promise<{ success: boolean; config?: any; error?: string }>;
      secureStorage: {
        setItem: (key: string, value: string) => Promise<{ success: boolean; error?: string }>;
        getItem: (key: string) => Promise<{ success: boolean; value?: string | null; error?: string }>;
        removeItem: (key: string) => Promise<{ success: boolean; error?: string }>;
      };
      onBeforeClose: (callback: () => void) => () => void;
      confirmClose: () => void;
      onBarcodeScanned: (callback: (barcode: string) => void) => void;
      removeBarcodeListener: () => void;
      printer: {
        list: () => Promise<Array<{ name: string }>>;
        print: (payload: {
          printerName: string;
          data: string;
          options?: Record<string, unknown>;
        }) => Promise<{ success: boolean; error?: string }>;
      };
    };
  }
}

export {};
