import { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { apiClient } from '../api/client';
import { useAuthStore } from '../store/auth.store';
import { AppointmentListItem, ServiceOrderListItem } from '../api/types';

const REFRESH_INTERVAL_MS = 30_000;

const STATUS_LABEL: Record<AppointmentListItem['status'], string> = {
  PROPOSED: 'Proposto',
  CONFIRMED: 'Confirmado',
  CANCELLED: 'Cancelado',
  COMPLETED: 'Concluído',
  NO_SHOW: 'Não compareceu',
};

const STATUS_COLOR: Record<AppointmentListItem['status'], string> = {
  PROPOSED: '#D6A84F',
  CONFIRMED: '#22c55e',
  CANCELLED: '#C95C5C',
  COMPLETED: '#9AA5B1',
  NO_SHOW: '#a855f7',
};

const OS_STATUS_LABEL: Record<string, string> = {
  ENTRADA: 'Entrada',
  DIAGNOSTICO: 'Diagnóstico',
  ORCAMENTO: 'Orçamento',
  APROVACAO: 'Aguardando aprovação',
  EXECUCAO: 'Em execução',
  PRONTO: 'Pronto',
  ENTREGA: 'Entrega',
};

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function formatClock(date: Date) {
  return date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

// Painel para exibição contínua na oficina/recepção — NÃO é um espelho da
// tela do desktop (que é densa, orientada a formulários/edição). Aqui:
// somente leitura, sem navegação, texto grande o bastante para ler de
// longe, e atualização automática por polling (sem pull-to-refresh — não
// há controle remoto apontando para "puxar a lista"). Mostra hoje: agenda
// do dia (com destaque para quem ainda não confirmou), OS em andamento e
// veículos prontos para retirada (status PRONTO — a seção mais "acionável"
// do painel: alguém precisa ligar pro cliente).
//
// NÃO inclui "boxes"/baias de trabalho — não existe esse conceito no
// schema hoje (nenhum modelo Box/Bay em packages/database/prisma/
// schema.prisma); adicionar aqui exigiria decidir e construir esse
// domínio no backend primeiro, não apenas na tela.
export default function PainelScreen() {
  const user = useAuthStore((s) => s.user);
  const [appointments, setAppointments] = useState<AppointmentListItem[]>([]);
  const [orders, setOrders] = useState<ServiceOrderListItem[]>([]);
  const [readyOrders, setReadyOrders] = useState<ServiceOrderListItem[]>([]);
  const [now, setNow] = useState(new Date());
  const [lastSync, setLastSync] = useState<Date | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    // allSettled: as 3 colunas são independentes. Com Promise.all, UMA chamada falhando (ex.: módulo
    // Pós-venda desligado → 403 na agenda) impedia o setState das três e o painel ficava congelado/vazio
    // sem nenhum aviso.
    const [appointmentsRes, ordersRes, readyRes] = await Promise.allSettled([
      apiClient.getAppointmentsToday(user?.branchId),
      apiClient.getActiveServiceOrders(user?.branchId),
      apiClient.getReadyServiceOrders(user?.branchId),
    ]);

    // Sucesso atualiza a coluna. 403 (módulo desativado/sem permissão) é estado estável: esvazia a
    // coluna em vez de manter dado velho para sempre. Falha transitória (rede/5xx): painel sem interação
    // humana não deve travar nem pedir "tentar de novo" — mantém os últimos dados válidos até o próximo
    // ciclo de polling funcionar.
    const apply = <T,>(res: PromiseSettledResult<T>, set: (value: T) => void, empty: T): boolean => {
      if (res.status === 'fulfilled') {
        set(res.value);
        return true;
      }
      if ((res.reason as any)?.response?.status === 403) set(empty);
      return false;
    };

    const results = [
      apply(appointmentsRes, (r) => setAppointments(r.appointments), { appointments: [] } as any),
      apply(ordersRes, (r) => setOrders(r.orders), { orders: [] } as any),
      apply(readyRes, (r) => setReadyOrders(r.orders), { orders: [] } as any),
    ];
    if (results.some(Boolean)) setLastSync(new Date());
  }, [user?.branchId]);

  useEffect(() => {
    load();
    intervalRef.current = setInterval(load, REFRESH_INTERVAL_MS);
    const clockInterval = setInterval(() => setNow(new Date()), 60_000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      clearInterval(clockInterval);
    };
  }, [load]);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View>
          <Text style={styles.headerTitle}>{user?.company?.name}</Text>
          <Text style={styles.headerSubtitle}>{user?.branch?.name ?? 'Todas as filiais'}</Text>
        </View>
        <Text style={styles.clock}>{formatClock(now)}</Text>
      </View>

      <View style={styles.columns}>
        <View style={styles.column}>
          <Text style={styles.columnTitle}>Agenda de hoje</Text>
          <FlatList
            data={appointments}
            keyExtractor={(item) => item.id}
            ListEmptyComponent={<Text style={styles.empty}>Nenhum agendamento para hoje.</Text>}
            renderItem={({ item }) => (
              <View style={styles.row}>
                <Text style={styles.rowTime}>{formatTime(item.scheduledAt)}</Text>
                <View style={styles.rowMain}>
                  <Text style={styles.rowTitle}>{item.customer?.name ?? 'Cliente'}</Text>
                  <Text style={styles.rowDetail}>
                    {item.motorcycle ? `${item.motorcycle.brand} ${item.motorcycle.model}` : ''}
                  </Text>
                </View>
                <View style={[styles.badge, { backgroundColor: STATUS_COLOR[item.status] }]}>
                  <Text style={styles.badgeText}>{STATUS_LABEL[item.status]}</Text>
                </View>
              </View>
            )}
          />
        </View>

        <View style={styles.column}>
          <Text style={styles.columnTitle}>OS em andamento</Text>
          <FlatList
            data={orders}
            keyExtractor={(item) => item.id}
            ListEmptyComponent={<Text style={styles.empty}>Nenhuma OS em andamento.</Text>}
            renderItem={({ item }) => (
              <View style={styles.row}>
                <Text style={styles.rowTime}>#{item.osNumber}</Text>
                <View style={styles.rowMain}>
                  <Text style={styles.rowTitle}>{item.customer?.name ?? 'Cliente'}</Text>
                  <Text style={styles.rowDetail}>
                    {item.motorcycle ? `${item.motorcycle.brand} ${item.motorcycle.model}` : ''}
                  </Text>
                </View>
                <View style={styles.badgeNeutral}>
                  <Text style={styles.badgeTextNeutral}>{OS_STATUS_LABEL[item.status] ?? item.status}</Text>
                </View>
              </View>
            )}
          />
        </View>

        <View style={styles.column}>
          <Text style={styles.columnTitle}>Veículos prontos</Text>
          <FlatList
            data={readyOrders}
            keyExtractor={(item) => item.id}
            ListEmptyComponent={<Text style={styles.empty}>Nenhum veículo pronto para retirada.</Text>}
            renderItem={({ item }) => (
              <View style={styles.row}>
                <Text style={styles.rowTime}>#{item.osNumber}</Text>
                <View style={styles.rowMain}>
                  <Text style={styles.rowTitle}>{item.customer?.name ?? 'Cliente'}</Text>
                  <Text style={styles.rowDetail}>
                    {item.motorcycle ? `${item.motorcycle.brand} ${item.motorcycle.model}` : ''}
                  </Text>
                </View>
                <View style={[styles.badge, { backgroundColor: '#22c55e' }]}>
                  <Text style={styles.badgeText}>Pronto</Text>
                </View>
              </View>
            )}
          />
        </View>
      </View>

      <Text style={styles.footer}>
        {lastSync ? `Atualizado às ${formatClock(lastSync)}` : 'Sincronizando…'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#050A10', padding: 32 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 },
  headerTitle: { fontSize: 28, fontWeight: '700', color: '#fff' },
  headerSubtitle: { fontSize: 16, color: '#9AA5B1' },
  clock: { fontSize: 36, fontWeight: '700', color: '#fff' },
  columns: { flex: 1, flexDirection: 'row', gap: 32 },
  column: { flex: 1 },
  columnTitle: { fontSize: 20, fontWeight: '700', color: '#F6F7F9', marginBottom: 16 },
  empty: { color: '#9AA5B1', fontSize: 15, marginTop: 12 },
  row: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#10171F', borderRadius: 10, padding: 16, marginBottom: 10 },
  rowTime: { color: '#9AA5B1', fontSize: 15, width: 64, fontWeight: '600' },
  rowMain: { flex: 1 },
  rowTitle: { color: '#fff', fontSize: 17, fontWeight: '600' },
  rowDetail: { color: '#9AA5B1', fontSize: 13, marginTop: 2 },
  badge: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999 },
  badgeNeutral: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, backgroundColor: '#1C2733' },
  badgeText: { color: '#050A10', fontSize: 12, fontWeight: '700' },
  badgeTextNeutral: { color: '#F6F7F9', fontSize: 12, fontWeight: '700' },
  footer: { color: '#9AA5B1', fontSize: 12, textAlign: 'center', marginTop: 16 },
});
