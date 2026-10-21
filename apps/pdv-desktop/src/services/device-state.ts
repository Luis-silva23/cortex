/**
 * Estado do equipamento na tela de entrada (portão de autorização). Lógica pura, testada em scripts/device-enrollment.test.ts.
 * Fonte da verdade é SEMPRE o servidor: este módulo só traduz a resposta de POST /api/device/status (ou a falha) no que a tela mostra.
 */
export interface DeviceStatusPayload {
  deviceId: string;
  status: 'PENDING' | 'ACTIVE' | 'BLOCKED' | 'REVOKED' | string;
  deviceName?: string;
  enrollmentCode?: string | null;
  company?: { name: string } | null;
  branch?: { name: string } | null;
}

export type GateState =
  | { kind: 'checking' }
  | { kind: 'offline' }
  | { kind: 'pending'; code: string | null }
  | { kind: 'authorized'; company: string | null; branch: string | null }
  | { kind: 'blocked' }
  | { kind: 'revoked' }
  | { kind: 'reenroll' }; // a credencial guardada não vale mais no servidor: este equipamento precisa se registrar de novo

export function gateStateFromStatus(payload: DeviceStatusPayload): GateState {
  switch (payload.status) {
    case 'ACTIVE':
      return { kind: 'authorized', company: payload.company?.name ?? null, branch: payload.branch?.name ?? null };
    case 'PENDING':
      return { kind: 'pending', code: payload.enrollmentCode ?? null };
    case 'BLOCKED':
      return { kind: 'blocked' };
    case 'REVOKED':
      return { kind: 'revoked' };
    default:
      return { kind: 'checking' };
  }
}

/** Falha ao consultar o estado: 401 = credencial guardada inválida (registrar de novo); sem resposta = servidor inalcançável. */
export function gateStateFromError(httpStatus: number | undefined): GateState {
  if (httpStatus === 401) return { kind: 'reenroll' };
  return { kind: 'offline' };
}

export const GATE_MESSAGES: Record<Exclude<GateState['kind'], 'checking' | 'authorized'>, { title: string; body: string }> = {
  offline: { title: 'Sem conexão com o servidor', body: 'Verifique a rede. O CÓRTEX tentará novamente automaticamente.' },
  pending: { title: 'Dispositivo aguardando autorização', body: 'Informe o código abaixo ao administrador do CÓRTEX. Esta tela libera sozinha assim que ele autorizar.' },
  blocked: { title: 'Equipamento bloqueado', body: 'O administrador bloqueou este equipamento. Procure o administrador do CÓRTEX.' },
  revoked: { title: 'Equipamento revogado', body: 'O acesso deste equipamento foi encerrado. Para usá-lo de novo é preciso registrá-lo outra vez e aguardar a autorização.' },
  reenroll: { title: 'Equipamento não reconhecido', body: 'Este equipamento precisa ser registrado novamente e autorizado pelo administrador.' },
};
