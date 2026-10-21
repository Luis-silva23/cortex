/**
 * Smoke do Electron REAL: sobe o `main.js` compilado (com todos os handlers de IPC) sobre o
 * renderer compilado (`dist/index.html`, carregado por file://, como no aplicativo instalado)
 * e confere que a tela de login aparece e que a ponte de impressão do preload existe.
 *
 * Por que existe: o PDV não tem infra de teste de UI, e dois defeitos só apareciam no app
 * empacotado — janela EM BRANCO (BrowserRouter sob file://) e impressão morta (`ipcRenderer`
 * importado no renderer com contextIsolation ligada). Ambos passavam em `tsc` e no `vite dev`.
 *
 * Uso: `npm run smoke:electron` (faz o build antes). Sai com código 1 se algo falhar.
 */
const path = require('path');
const http = require('http');
const electron = require('electron');

// Com ELECTRON_RUN_AS_NODE=1 no ambiente o binário roda como Node puro e `require('electron')` devolve só o
// caminho do executável (string) — sem isso o erro seria o críptico "Cannot read properties of undefined".
if (typeof electron === 'string') {
  console.error('SMOKE FALHOU: o Electron rodou como Node puro (ELECTRON_RUN_AS_NODE definida no ambiente). Remova a variável e rode de novo.');
  process.exit(1);
}
const { app, BrowserWindow } = electron;

const root = path.resolve(__dirname, '..');
require(path.join(root, 'dist-electron', 'main.js'));

const fail = (message) => {
  console.error(`SMOKE FALHOU: ${message}`);
  app.exit(1);
};

// A API de dev (VITE_API_URL do build; padrão localhost:3001) só libera origens http(s) por CORS e o renderer
// file:// do app empacotado não tem origem http. Este smoke prova, com o Electron real, que a chamada da janela
// file:// à API funciona (o Chromium/Electron não aplica CORS a file://). Se a API não estiver no ar, a verificação
// é PULADA (avisando), nunca reprovada: "Failed to fetch" seria indistinguível de um bloqueio de CORS.
const API_URL = process.env.SMOKE_API_URL || 'http://localhost:3001';
const apiReachable = () =>
  new Promise((resolve) => {
    // qualquer resposta HTTP (até 429/5xx) prova que o servidor está no ar; só erro de conexão/timeout é "fora do ar"
    const req = http.get(`${API_URL}/api/health`, { timeout: 2000 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });

app.whenReady().then(() => {
  setTimeout(() => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return fail('o processo principal não criou nenhuma janela');
    win.hide();

    const consoleErrors = [];
    win.webContents.on('console-message', (_e, level, message) => {
      if (level >= 3) consoleErrors.push(String(message));
    });
    win.webContents.reload();

    setTimeout(async () => {
      try {
        const state = await win.webContents.executeJavaScript(`({
          hash: location.hash,
          text: document.body.innerText,
          inputs: Array.from(document.querySelectorAll('input')).map((i) => i.id),
          printerBridge: typeof (window.electron && window.electron.printer && window.electron.printer.print),
        })`);

        // O DeviceGate (App.tsx) vem ANTES do login: sem o servidor autorizando ESTE equipamento, o aplicativo mostra a tela do
        // portão (sem conexão / pendente / bloqueado) e não monta o roteador. Isso é o comportamento correto, não janela em
        // branco; nesse caso o login e a guarda de rota NÃO são verificados aqui (e o resumo final diz isso).
        const gateScreen =
          !state.text.includes('Entrar') &&
          /Sem conexão com o servidor|aguardando autoriza|Equipamento|Instalação inválida|bloqueado|revogado/i.test(state.text);
        if (!gateScreen) {
          if (!state.text.includes('CÓRTEX PDV') || !state.text.includes('Entrar')) {
            return fail(`tela de login não renderizou (janela em branco?) — texto: ${JSON.stringify(state.text.slice(0, 120))}`);
          }
          if (!state.inputs.includes('numericId') || !state.inputs.includes('password')) {
            return fail(`campos do login ausentes: ${JSON.stringify(state.inputs)}`);
          }
          if (state.hash !== '#/login') return fail(`rota inicial inesperada: ${state.hash}`);
        } else if (!state.text.trim()) {
          return fail('janela em branco');
        }
        if (state.printerBridge !== 'function') return fail('window.electron.printer.print não foi exposto pelo preload');
        // Coletor de telemetria real: 2 leituras (a CPU sai do delta entre elas); RAM e disco medidos do sistema.
        const metrics = await win.webContents.executeJavaScript(
          'window.electron.getSystemMetrics().then(() => new Promise((r) => setTimeout(r, 500))).then(() => window.electron.getSystemMetrics())'
        );
        const inRange = (v) => typeof v === 'number' && v >= 0 && v <= 100;
        if (!inRange(metrics.cpuLoadPct) || !inRange(metrics.memUsedPct) || !inRange(metrics.diskUsedPct) || !(metrics.uptimeSec > 0)) {
          return fail(`telemetria do equipamento inválida: ${JSON.stringify(metrics)}`);
        }
        // Versão do app = package.json do PDV (não a do Electron); runtime informado à parte.
        const expectedVersion = require('../package.json').version;
        if (metrics.appVersion !== expectedVersion) {
          return fail(`telemetria com versão errada do app: "${metrics.appVersion}" (esperado ${expectedVersion}, do package.json)`);
        }
        if (!String(metrics.runtimeVersion).startsWith(`electron ${process.versions.electron}`)) {
          return fail(`runtimeVersion inválido: ${metrics.runtimeVersion}`);
        }
        console.log(`TELEMETRIA: CPU ${metrics.cpuLoadPct}% · RAM ${metrics.memUsedPct}% · disco ${metrics.diskUsedPct}% · uptime ${metrics.uptimeSec}s · app ${metrics.appVersion} · ${metrics.runtimeVersion}`);
        if (consoleErrors.length) return fail(`erros no console do renderer: ${consoleErrors.join(' | ')}`);

        // Guarda de rota sob file:// (HashRouter): sem sessão, as rotas protegidas e as desconhecidas caem em #/login.
        for (const target of gateScreen ? [] : ['#/pos', '#/sales', '#/rota-inexistente']) {
          await win.webContents.executeJavaScript(`location.hash = ${JSON.stringify(target)}`);
          // o redirecionamento pode ser em cadeia (`*` -> `/` -> `/login`): espera com limite, sem sleep fixo
          let hash = target;
          for (let i = 0; i < 30 && hash !== '#/login'; i += 1) {
            await new Promise((resolve) => setTimeout(resolve, 100));
            hash = await win.webContents.executeJavaScript('location.hash');
          }
          if (hash !== '#/login') return fail(`sem sessão, ${target} deveria cair em #/login, mas ficou em ${hash}`);
        }

        // CORS: a janela file:// (sem Origin http) consegue chamar e LER a resposta da API?
        let corsNote;
        if (await apiReachable()) {
          const res = await win.webContents.executeJavaScript(
            `fetch(${JSON.stringify(`${API_URL}/api/health`)}).then(async (r) => ({ ok: r.ok, status: r.status, size: (await r.text()).length })).catch((e) => ({ error: String((e && e.message) || e) }))`
          );
          // o que prova a ausência de bloqueio é a promise RESOLVER (CORS bloqueado rejeita com "Failed to fetch"),
          // qualquer que seja o status HTTP (a API pode responder 429 sob carga)
          if (res.error) {
            return fail(`a janela file:// não conseguiu ler a resposta de ${API_URL}/api/health (${res.error}) — possível bloqueio de CORS`);
          }
          corsNote = `fetch file:// -> ${API_URL}/api/health com resposta legível (HTTP ${res.status}), sem bloqueio de CORS`;
        } else {
          corsNote = `CORS NÃO verificado (API fora do ar em ${API_URL})`;
        }
        if (consoleErrors.length) return fail(`erros no console do renderer: ${consoleErrors.join(' | ')}`);

        // Encerramento da sessão ao FECHAR a janela: o processo principal segura o fechamento, o renderer (App.tsx →
        // services/session.ts) responde `app:close-ready` e só então a janela fecha — bem antes do prazo de segurança (4,5 s).
        const bridge = await win.webContents.executeJavaScript(
          `({ before: typeof window.electron.onBeforeClose, ready: typeof window.electron.confirmClose })`
        );
        if (bridge.before !== 'function' || bridge.ready !== 'function') {
          return fail(`ponte de encerramento ausente no preload: ${JSON.stringify(bridge)}`);
        }
        const closedAfterMs = new Promise((resolve) => {
          const started = Date.now();
          win.once('closed', () => resolve(Date.now() - started));
        });
        win.close();
        if (win.isDestroyed()) return fail('a janela fechou na hora: o encerramento da sessão não foi segurado pelo processo principal');
        const waited = await Promise.race([closedAfterMs, new Promise((resolve) => setTimeout(() => resolve(-1), 3500))]);
        if (waited < 0) return fail('a janela não fechou em 3,5 s: o renderer não respondeu ao encerramento da sessão (app:close-ready)');

        console.log(
          `SMOKE OK: ${
            gateScreen
              ? 'tela do portão de equipamento renderizada por file:// (login e guarda de rota NÃO verificados: equipamento não autorizado neste ambiente)'
              : 'login renderizado por file://, rota #/login, guarda de rota'
          }, ponte de impressão presente, console sem erros, fechamento da janela com encerramento de sessão em ${waited} ms; ${corsNote}`
        );
        app.exit(0);
      } catch (error) {
        fail(error && error.message ? error.message : String(error));
      }
    }, 6000);
  }, 1500);
});
