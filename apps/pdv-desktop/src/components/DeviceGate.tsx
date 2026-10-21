import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, ShieldAlert, ShieldCheck, WifiOff } from 'lucide-react';
import { SERVER_URL_PROBLEM } from '../services/server-config';
import { clearDeviceIdentity, enrollThisDevice, fetchDeviceStatus, getDeviceIdentity } from '../services/device-enrollment';
import { GATE_MESSAGES, gateStateFromError, gateStateFromStatus, type GateState } from '../services/device-state';

/**
 * PORTÃO DE AUTORIZAÇÃO DO EQUIPAMENTO (docs/CORTEX/DISPOSITIVOS.md). Nada do CÓRTEX (nem a tela de login) aparece antes de o servidor
 * dizer que ESTE equipamento está autorizado. Fluxo: primeira abertura → registra o equipamento e mostra "Dispositivo aguardando
 * autorização" com o código → consulta o servidor até o administrador autorizar → libera o aplicativo. Revogado/bloqueado enquanto em uso:
 * a próxima consulta volta a travar. A SEGURANÇA é do servidor (o login exige equipamento ativo + chave); esta tela é a experiência.
 * Fora do Electron (navegador de desenvolvimento) não há identidade de equipamento e o portão não se aplica.
 */
// Intervalo até a próxima consulta, por estado. Sem entrada = não consulta sozinho (espera o operador: revogado/não reconhecido).
const POLL_MS: Partial<Record<GateState['kind'], number>> = { checking: 0, pending: 5000, authorized: 60000, blocked: 30000, offline: 8000 };

export default function DeviceGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<GateState>({ kind: 'checking' });
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);

  const check = useCallback(async () => {
    try {
      let identity = await getDeviceIdentity();
      if (!identity) identity = (await enrollThisDevice()).identity;
      const payload = await fetchDeviceStatus(identity);
      if (alive.current) setState(gateStateFromStatus(payload));
    } catch (error: any) {
      const httpStatus: number | undefined = error?.response?.status;
      // Queda de rede com o aplicativo já liberado NÃO trava o balcão no meio de uma venda: mantém "autorizado" (objeto novo, para
      // reagendar a consulta). Só o servidor dizendo que o equipamento não vale (401/bloqueado/revogado) trava a tela.
      if (alive.current) setState((prev) => (prev.kind === 'authorized' && httpStatus === undefined ? { ...prev } : gateStateFromError(httpStatus)));
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Consulta o servidor no ritmo do estado atual; cada resposta troca o estado e agenda a seguinte (autorizado: de minuto em minuto,
  // para que revogar/bloquear com o aplicativo aberto trave a tela sem esperar o próximo login).
  useEffect(() => {
    if (!window.electron || SERVER_URL_PROBLEM) return undefined;
    const delay = POLL_MS[state.kind];
    if (delay === undefined) return undefined;
    const timer = setTimeout(check, delay);
    return () => clearTimeout(timer);
  }, [state, check]);

  const registerAgain = async () => {
    setBusy(true);
    await clearDeviceIdentity();
    setState({ kind: 'checking' });
    setBusy(false);
  };

  if (SERVER_URL_PROBLEM) return <Screen icon="alert" title="Instalação inválida" body={SERVER_URL_PROBLEM} />;
  if (!window.electron) return <>{children}</>;
  if (state.kind === 'authorized') return <>{children}</>;
  if (state.kind === 'checking') {
    return (
      <div className="flex h-screen items-center justify-center bg-gray-50 text-gray-600">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Verificando este equipamento…
      </div>
    );
  }
  const msg = GATE_MESSAGES[state.kind];
  return (
    <Screen icon={state.kind === 'offline' ? 'offline' : state.kind === 'pending' ? 'wait' : 'alert'} title={msg.title} body={msg.body}>
      {state.kind === 'pending' && state.code && (
        <div className="mt-4 rounded-lg border border-gray-300 bg-white px-6 py-3 text-center font-mono text-3xl font-bold tracking-widest text-gray-900">{state.code}</div>
      )}
      {(state.kind === 'revoked' || state.kind === 'reenroll') && (
        <button onClick={registerAgain} disabled={busy} className="mt-4 rounded-lg bg-blue-600 px-4 py-2 font-semibold text-white hover:bg-blue-700 disabled:opacity-60">
          Registrar este equipamento novamente
        </button>
      )}
    </Screen>
  );
}

function Screen({ icon, title, body, children }: { icon: 'alert' | 'wait' | 'offline'; title: string; body: string; children?: React.ReactNode }) {
  const Icon = icon === 'wait' ? ShieldCheck : icon === 'offline' ? WifiOff : ShieldAlert;
  return (
    <div className="flex h-screen items-center justify-center bg-gray-50 p-6">
      <div className="w-full max-w-md rounded-xl bg-white p-8 text-center shadow">
        <Icon className="mx-auto mb-3 h-10 w-10 text-blue-600" />
        <h1 className="text-xl font-bold text-gray-900">{title}</h1>
        <p className="mt-2 text-sm text-gray-600">{body}</p>
        {children}
      </div>
    </div>
  );
}
