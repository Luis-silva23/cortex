import { app, BrowserWindow, ipcMain, safeStorage } from 'electron';
import path from 'path';

// Definida pelo vite.config.ts (versão do package.json do PDV).
declare const __CORTEX_APP_VERSION__: string;

let mainWindow: BrowserWindow | null = null;

const isDev = process.env.NODE_ENV === 'development';

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1366,
    height: 768,
    minWidth: 1024,
    minHeight: 600,
    title: 'CÓRTEX PDV',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    autoHideMenuBar: true,
    frame: true,
  });

  // Carregar a aplicação
  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  // FECHAR A JANELA (botão, Alt+F4, encerramento do SO) = ENCERRAR A SESSÃO: o fechamento é segurado, o renderer revoga a sessão
  // no servidor (services/session.ts) e responde `app:close-ready`. Sem resposta em CLOSE_GRACE_MS (renderer travado, servidor
  // fora do ar) a janela fecha mesmo assim — o aplicativo nunca fica preso, e a sessão não é restaurável de qualquer forma
  // (o token só existia na memória do renderer). Fechar a janela NÃO fecha o caixa (operação financeira, à parte).
  let closeRequested = false;
  mainWindow.on('close', (event) => {
    if (closeRequested || !mainWindow || mainWindow.webContents.isDestroyed()) return;
    closeRequested = true;
    event.preventDefault();
    mainWindow.webContents.send('app:before-close');
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
    }, CLOSE_GRACE_MS);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

const CLOSE_GRACE_MS = 4500;

// O renderer terminou de encerrar a sessão: fecha de verdade.
ipcMain.on('app:close-ready', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
});

// Lifecycle
app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// ============================================
// IPC HANDLERS
// ============================================

// Telemetria do equipamento: CPU pelo delta entre leituras, RAM, disco do volume do sistema, uptime e versão do app.
let lastCpu: { idle: number; total: number } | null = null;
ipcMain.handle('system-metrics', async () => {
  const os = require('os');
  const fs = require('fs');
  const cpus = os.cpus() as Array<{ times: Record<string, number> }>;
  const now = cpus.reduce(
    (acc, c) => {
      const total = Object.values(c.times).reduce((a, b) => a + b, 0);
      return { idle: acc.idle + c.times.idle, total: acc.total + total };
    },
    { idle: 0, total: 0 }
  );
  let cpuLoadPct: number | null = null;
  if (lastCpu && now.total > lastCpu.total) {
    cpuLoadPct = Math.round((1 - (now.idle - lastCpu.idle) / (now.total - lastCpu.total)) * 1000) / 10;
  }
  lastCpu = now;
  const memUsedPct = Math.round((1 - os.freemem() / os.totalmem()) * 1000) / 10;
  let diskUsedPct: number | null = null;
  try {
    const root = process.platform === 'win32' ? `${process.env.SystemDrive || 'C:'}\\` : '/';
    const st = fs.statfsSync(root);
    diskUsedPct = Math.round((1 - st.bavail / st.blocks) * 1000) / 10;
  } catch {
    diskUsedPct = null;
  }
  return {
    cpuLoadPct,
    memUsedPct,
    diskUsedPct,
    uptimeSec: Math.round(os.uptime()),
    // app CÓRTEX (injetada no build) separada do runtime: sem empacotar, app.getVersion() é a versão do Electron.
    appVersion: typeof __CORTEX_APP_VERSION__ === 'string' ? __CORTEX_APP_VERSION__ : app.getVersion(),
    runtimeVersion: `electron ${process.versions.electron} · node ${process.versions.node} · chrome ${process.versions.chrome}`,
  };
});

// Obter informações do dispositivo
ipcMain.handle('get-device-info', async () => {
  const os = require('os');
  const { networkInterfaces } = os;

  const nets = networkInterfaces();
  const results: any[] = [];

  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        results.push({
          interface: name,
          address: net.address,
          mac: net.mac,
        });
      }
    }
  }

  return {
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    release: os.release(),
    networks: results,
    macAddress: results[0]?.mac || null,
  };
});

// Salvar configuração local
ipcMain.handle('save-config', async (_event, config: any) => {
  const fs = require('fs').promises;
  const configPath = path.join(app.getPath('userData'), 'config.json');

  try {
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
});

// Carregar configuração local
ipcMain.handle('load-config', async () => {
  const fs = require('fs').promises;
  const configPath = path.join(app.getPath('userData'), 'config.json');

  try {
    const data = await fs.readFile(configPath, 'utf-8');
    return { success: true, config: JSON.parse(data) };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
});

// ============================================
// SECURE STORAGE (token/refreshToken da sessão)
// ============================================
//
// ACHADO DE AUDITORIA: auth.store.ts (zustand `persist`) gravava
// token/refreshToken em texto puro no localStorage do renderer — qualquer
// script rodando nesse mesmo contexto JS (XSS via dependência comprometida,
// ou futura falha de sanitização no React) conseguia ler
// `localStorage['pdv-auth-storage']` e exfiltrar a sessão inteira,
// incluindo o refresh token (de vida longa). `contextIsolation`/
// `nodeIntegration: false` acima protegem contra o renderer alcançar
// Node/Electron diretamente, mas não protegem localStorage de JS rodando
// no MESMO contexto da página. apps/mobile já trata esta mesma classe de
// segredo com Keystore via expo-secure-store (ver comentário em
// src/api/client.ts) — pdv-desktop nunca foi trazido ao mesmo padrão.
// `safeStorage` (Electron, backed por DPAPI/Keychain/libsecret conforme o
// SO) só existe no processo principal, então o valor cifrado é lido/gravado
// aqui e exposto ao renderer só como um blob opaco via IPC — o mesmo padrão
// de ponte já usado acima para save-config/load-config.
function secureStoragePath(key: string) {
  // Nome de arquivo derivado da chave, restrito a caracteres seguros —
  // auth.store.ts sempre usa a chave fixa 'pdv-auth-storage', mas não há
  // motivo para confiar cegamente numa string vinda do renderer via IPC.
  const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(app.getPath('userData'), `secure-${safeKey}.dat`);
}

ipcMain.handle('secure-storage:set-item', async (_event, key: string, value: string) => {
  const fs = require('fs').promises;
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      // Alguns Linux sem keyring/DE completo não têm um backend de
      // criptografia do SO disponível. Preferimos falhar de forma honesta
      // (erro explícito) a gravar em texto puro travestido de "seguro" —
      // o chamador (auth.store.ts) decide o fallback.
      return { success: false, error: 'OS secure storage not available on this system' };
    }
    const encrypted = safeStorage.encryptString(value);
    await fs.writeFile(secureStoragePath(key), encrypted);
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('secure-storage:get-item', async (_event, key: string) => {
  const fs = require('fs').promises;
  try {
    const encrypted = await fs.readFile(secureStoragePath(key));
    if (!safeStorage.isEncryptionAvailable()) {
      return { success: false, error: 'OS secure storage not available on this system' };
    }
    const value = safeStorage.decryptString(encrypted);
    return { success: true, value };
  } catch (error: any) {
    // ENOENT (nada salvo ainda) é o caso normal no primeiro login — não é
    // uma falha real, então devolve sucesso com valor nulo em vez de erro.
    if (error.code === 'ENOENT') {
      return { success: true, value: null };
    }
    return { success: false, error: error.message };
  }
});

ipcMain.handle('secure-storage:remove-item', async (_event, key: string) => {
  const fs = require('fs').promises;
  try {
    await fs.unlink(secureStoragePath(key));
    return { success: true };
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      return { success: true };
    }
    return { success: false, error: error.message };
  }
});

// Imprimir cupom
ipcMain.handle('printer:print', async (_event, { printerName = '', data, options = {} }) => {
  try {
    // Criar HTML para impressão
    const printContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <style>
          @page {
            size: ${printerName.includes('80') ? '80mm' : '58mm'} auto;
            margin: 0;
          }
          body {
            font-family: 'Courier New', monospace;
            font-size: 12px;
            line-height: 1.3;
            margin: 0;
            padding: 2mm;
            white-space: pre-wrap;
          }
        </style>
      </head>
      <body>${data}</body>
      </html>
    `;

    // Criar nova janela invisível para impressão
    const printWindow = new BrowserWindow({
      show: false,
      webPreferences: {
        nodeIntegration: false,
      },
    });

    await printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(printContent)}`);

    // Configurações de impressão
    const printOptions = {
      silent: options.silent !== false,
      printBackground: true,
      deviceName: printerName || undefined,
      copies: options.copies || 1,
      ...options,
    };

    // Imprimir. `webContents.print` é baseada em CALLBACK (não devolve Promise): antes o
    // `await` não esperava nada, a janela era fechada na hora (pode abortar o job) e o
    // retorno era sempre `success: true`, mesmo com a impressora recusando o trabalho.
    const result = await new Promise<{ success: boolean; error?: string }>((resolve) => {
      printWindow.webContents.print(printOptions, (success, failureReason) => {
        resolve(success ? { success: true } : { success: false, error: failureReason || 'Falha ao imprimir' });
      });
    });

    // Fechar janela só depois de o spooler responder
    printWindow.close();

    return result;
  } catch (error: any) {
    console.error('Erro ao imprimir:', error);
    return { success: false, error: error.message };
  }
});

// Listar impressoras
ipcMain.handle('printer:list', async () => {
  try {
    const { webContents } = mainWindow!;
    const printers = await webContents.getPrintersAsync();
    return printers;
  } catch (error: any) {
    console.error('Erro ao listar impressoras:', error);
    return [];
  }
});

// Ler código de barras (placeholder para leitor USB)
ipcMain.on('barcode-scanned', (_event, barcode: string) => {
  if (mainWindow) {
    mainWindow.webContents.send('barcode-data', barcode);
  }
});
