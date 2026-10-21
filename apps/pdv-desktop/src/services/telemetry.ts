import { api } from './api';

const INTERVAL_MS = 60_000;
const PINGS = 3;

/**
 * Telemetria do equipamento para o monitoramento da filial (Super Admin → Empresas → filial): CPU/RAM/disco do
 * computador (processo principal do Electron) e latência/perda até a API (medidas aqui). Só roda no PDV desktop com
 * equipamento ativo: sem sessão de equipamento o servidor responde 409 e o envio para até o próximo login. Nada é
 * inventado — o que não é medido vai nulo (Wi-Fi não é coletado).
 */
export function startTelemetry(): () => void {
  if (!window.electron?.getSystemMetrics) return () => undefined;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const tick = async () => {
    if (stopped) return;
    try {
      const rtts: number[] = [];
      let failed = 0;
      for (let i = 0; i < PINGS; i++) {
        const rtt = await api.pingApi();
        if (rtt === null) failed++;
        else rtts.push(rtt);
      }
      const system = await window.electron.getSystemMetrics();
      await api.sendTelemetry({
        collectedAt: new Date().toISOString(),
        ...system,
        apiRttMs: rtts.length ? Math.round(rtts.reduce((a, b) => a + b, 0) / rtts.length) : null,
        packetLossPct: Math.round((failed / PINGS) * 1000) / 10,
      });
    } catch (error: any) {
      if (error?.response?.status === 409) {
        stopped = true;
        return;
      }
    }
    if (!stopped) timer = setTimeout(tick, INTERVAL_MS);
  };

  timer = setTimeout(tick, 5_000);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
