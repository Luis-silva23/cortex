// Tempo nos gráficos do Super Admin. Os pontos chegam da API como INSTANTES (ISO, UTC); a apresentação é sempre no fuso do produto,
// America/Sao_Paulo (decisão 58), e não no do navegador de quem abre a tela. Só formata: nenhum agrupamento é feito aqui.
export const APP_TIME_ZONE = 'America/Sao_Paulo';

/** Instante ISO → milissegundos (posição no eixo de tempo). Texto inválido vira NaN. */
export function toInstant(iso: string | Date): number {
  return typeof iso === 'string' ? Date.parse(iso) : iso.getTime();
}

/** Rótulo curto do eixo: só hora:minuto em períodos curtos; dia/mês e hora ("21/09 09h") quando o período passa de um dia. */
export function tickFormatter(longRange: boolean) {
  return (t: number): string => {
    const date = new Date(t);
    if (!longRange) return date.toLocaleTimeString('pt-BR', { timeZone: APP_TIME_ZONE, hour: '2-digit', minute: '2-digit' });
    const day = date.toLocaleDateString('pt-BR', { timeZone: APP_TIME_ZONE, day: '2-digit', month: '2-digit' });
    const hour = date.toLocaleTimeString('pt-BR', { timeZone: APP_TIME_ZONE, hour: '2-digit', hourCycle: 'h23' });
    return `${day} ${hour}h`;
  };
}

/** Rótulo completo da dica: data e hora de Brasília. */
export function labelFormatter(t: number): string {
  return new Date(t).toLocaleString('pt-BR', { timeZone: APP_TIME_ZONE });
}
