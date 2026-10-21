import { useCallback, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useRoute } from '@react-navigation/native';
import { apiClient } from '../api/client';
import { ServiceOrderDetail } from '../api/types';

const STATUS_LABEL: Record<string, string> = {
  ENTRADA: 'Entrada',
  DIAGNOSTICO: 'Diagnóstico',
  ORCAMENTO: 'Orçamento',
  APROVACAO: 'Aguardando aprovação',
  EXECUCAO: 'Em execução',
  PRONTO: 'Pronto',
  ENTREGA: 'Entrega',
  ENCERRADA: 'Encerrada',
  CANCELADA: 'Cancelada',
};

function formatMoney(v: number) {
  return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

// Somente leitura de propósito — edição de itens/status/pagamento continua
// exclusiva do admin-web (Oficina), que já tem o fluxo completo com as
// validações de transição de estado. O mobile é para o mecânico/atendente
// consultar rapidamente o que já foi lançado, não para lançar.
export default function ServiceOrderDetailScreen() {
  const route = useRoute<any>();
  const { id, osNumber } = route.params ?? {};

  const [os, setOs] = useState<ServiceOrderDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const result = await apiClient.getServiceOrder(id);
      setOs(result);
    } catch {
      setError('Não foi possível carregar a ordem de serviço.');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color="#F6F7F9" size="large" />
      </View>
    );
  }

  if (error || !os) {
    return (
      <View style={styles.center}>
        <Text style={styles.empty}>{error ?? 'Ordem de serviço não encontrada.'}</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.headerRow}>
        <Text style={styles.title}>OS #{osNumber ?? os.osNumber}</Text>
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{STATUS_LABEL[os.status] ?? os.status}</Text>
        </View>
      </View>
      <Text style={styles.subtitle}>{os.customer?.name ?? 'Cliente não informado'}</Text>
      <Text style={styles.subtitle}>
        {os.motorcycle ? `${os.motorcycle.brand} ${os.motorcycle.model}` : 'Moto não informada'} —{' '}
        {os.entryKilometer} km
      </Text>

      <View style={styles.totalsRow}>
        <View style={styles.totalCard}>
          <Text style={styles.totalLabel}>Mão de obra</Text>
          <Text style={styles.totalValue}>{formatMoney(Number(os.laborTotal))}</Text>
        </View>
        <View style={styles.totalCard}>
          <Text style={styles.totalLabel}>Peças</Text>
          <Text style={styles.totalValue}>{formatMoney(Number(os.partsTotal))}</Text>
        </View>
        <View style={styles.totalCard}>
          <Text style={styles.totalLabel}>Total</Text>
          <Text style={styles.totalValue}>{formatMoney(Number(os.finalTotal))}</Text>
        </View>
      </View>
      {os.isPaid && (
        <View style={[styles.badge, { alignSelf: 'flex-start', backgroundColor: '#22c55e', marginBottom: 16 }]}>
          <Text style={[styles.badgeText, { color: '#050A10' }]}>Pago</Text>
        </View>
      )}

      <Text style={styles.sectionTitle}>Itens</Text>
      {os.items?.length ? (
        os.items.map((item) => (
          <View key={item.id} style={styles.itemRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.itemDescription}>{item.description}</Text>
              <Text style={styles.itemMeta}>
                {item.itemType === 'PART' ? 'Peça' : 'Serviço'} · qtd {item.quantity}
              </Text>
            </View>
            <Text style={styles.itemPrice}>{formatMoney(Number(item.totalPrice))}</Text>
          </View>
        ))
      ) : (
        <Text style={styles.empty}>Nenhum item lançado ainda.</Text>
      )}

      <Text style={styles.sectionTitle}>Histórico</Text>
      {os.statusHistory?.length ? (
        os.statusHistory.map((h) => (
          <View key={h.id} style={styles.historyRow}>
            <Text style={styles.historyText}>
              {h.fromStatus ? `${STATUS_LABEL[h.fromStatus] ?? h.fromStatus} → ` : ''}
              {STATUS_LABEL[h.toStatus] ?? h.toStatus}
            </Text>
            <Text style={styles.historyDate}>{new Date(h.changedAt).toLocaleString('pt-BR')}</Text>
          </View>
        ))
      ) : (
        <Text style={styles.empty}>Sem histórico ainda.</Text>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#050A10' },
  content: { padding: 16, paddingBottom: 32 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#050A10' },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  title: { color: '#fff', fontSize: 22, fontWeight: '700' },
  subtitle: { color: '#9AA5B1', fontSize: 13, marginTop: 2 },
  badge: { backgroundColor: '#1C2733', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 },
  badgeText: { color: '#F6F7F9', fontSize: 11, fontWeight: '700' },
  totalsRow: { flexDirection: 'row', gap: 10, marginTop: 16, marginBottom: 8 },
  totalCard: { flex: 1, backgroundColor: '#10171F', borderRadius: 10, padding: 12 },
  totalLabel: { color: '#9AA5B1', fontSize: 11 },
  totalValue: { color: '#fff', fontSize: 15, fontWeight: '700', marginTop: 2 },
  sectionTitle: { color: '#F6F7F9', fontSize: 15, fontWeight: '700', marginTop: 16, marginBottom: 8 },
  itemRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#10171F',
    borderRadius: 8,
    padding: 12,
    marginBottom: 8,
  },
  itemDescription: { color: '#fff', fontSize: 14, fontWeight: '600' },
  itemMeta: { color: '#9AA5B1', fontSize: 12, marginTop: 2 },
  itemPrice: { color: '#fff', fontSize: 14, fontWeight: '600' },
  historyRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8, borderBottomColor: '#10171F', borderBottomWidth: 1 },
  historyText: { color: '#F6F7F9', fontSize: 13 },
  historyDate: { color: '#9AA5B1', fontSize: 12 },
  empty: { color: '#9AA5B1', fontSize: 13, textAlign: 'center', marginTop: 12 },
});
