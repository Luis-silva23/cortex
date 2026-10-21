import { useCallback, useState } from 'react';
import { Alert, FlatList, Modal, RefreshControl, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { apiClient, ConfirmationChannel } from '../api/client';
import { AppointmentListItem } from '../api/types';

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

const CHANNELS: Array<{ value: ConfirmationChannel; label: string }> = [
  { value: 'WHATSAPP', label: 'WhatsApp' },
  { value: 'PHONE', label: 'Telefone' },
  { value: 'IN_PERSON', label: 'Pessoalmente' },
  { value: 'SMS', label: 'SMS' },
  { value: 'EMAIL', label: 'E-mail' },
];

const COMPLETION_REASON_MIN = 10;
const apiMessage = (error: any, fallback: string) => error?.response?.data?.error ?? error?.response?.data?.message ?? fallback;

export default function AgendaScreen() {
  const [items, setItems] = useState<AppointmentListItem[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<string | null>(null);
  const [confirmName, setConfirmName] = useState('');
  const [confirmChannel, setConfirmChannel] = useState<ConfirmationChannel>('WHATSAPP');
  const [confirmError, setConfirmError] = useState<string | null>(null);
  // Concluir sem confirmação do cliente: autorização de um responsável (≠ quem pede) + motivo.
  const [completingId, setCompletingId] = useState<string | null>(null);
  const [authTarget, setAuthTarget] = useState<AppointmentListItem | null>(null);
  const [authId, setAuthId] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authMfa, setAuthMfa] = useState('');
  const [authReason, setAuthReason] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await apiClient.getAppointments({ limit: 50 });
      setItems(data.appointments);
    } catch {
      // mantém a última lista carregada em caso de falha de rede — melhor
      // que esvaziar a tela.
    }
  }, []);

  // Recarrega toda vez que a tela ganha foco (ex.: voltando da confirmação)
  // — uma agenda que não atualiza sozinha é pior que uma que demora 1s a
  // mais para abrir.
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  // REGRA FUNDAMENTAL do domínio (ver appointment.service.ts): confirmar = o cliente/responsável pelo veículo aceitou.
  // O funcionário só registra: quem confirmou e por qual canal são obrigatórios.
  const confirm = (id: string) => {
    setConfirmTarget(id);
    setConfirmName('');
    setConfirmChannel('WHATSAPP');
    setConfirmError(null);
  };

  const submitConfirm = async () => {
    if (!confirmTarget) return;
    setConfirmingId(confirmTarget);
    setConfirmError(null);
    try {
      await apiClient.confirmAppointment(confirmTarget, { channel: confirmChannel, confirmedByName: confirmName.trim() });
      setConfirmTarget(null);
      await load();
    } catch (error: any) {
      setConfirmError(error?.response?.data?.error ?? 'Não foi possível confirmar o agendamento.');
    } finally {
      setConfirmingId(null);
    }
  };

  const complete = async (item: AppointmentListItem) => {
    setCompletingId(item.id);
    try {
      await apiClient.completeAppointment(item.id);
      await load();
    } catch (error: any) {
      if (error?.response?.status === 409 && error?.response?.data?.code === 'APPOINTMENT_NOT_CONFIRMED') {
        setAuthTarget(item);
        setAuthId('');
        setAuthPassword('');
        setAuthMfa('');
        setAuthReason('');
        setAuthError(null);
      } else {
        Alert.alert('Não foi possível concluir', apiMessage(error, 'Tente novamente.'));
      }
    } finally {
      setCompletingId(null);
    }
  };

  const submitAuthorization = async () => {
    if (!authTarget) return;
    if (!/^\d+$/.test(authId.trim())) return setAuthError('Informe o código (ID numérico) do responsável.');
    if (!authPassword) return setAuthError('Informe a senha do responsável.');
    if (authReason.trim().length < COMPLETION_REASON_MIN) return setAuthError(`Informe o motivo (mínimo ${COMPLETION_REASON_MIN} caracteres).`);
    setCompletingId(authTarget.id);
    setAuthError(null);
    try {
      await apiClient.completeAppointment(authTarget.id, {
        authorization: {
          authorizerNumericId: parseInt(authId.trim(), 10),
          authorizerPassword: authPassword,
          ...(authMfa.trim() ? { authorizerMfaCode: authMfa.trim() } : {}),
          reason: authReason.trim(),
        },
      });
      setAuthTarget(null);
      await load();
    } catch (error: any) {
      setAuthPassword('');
      setAuthError(apiMessage(error, 'Não foi possível concluir o agendamento.'));
    } finally {
      setCompletingId(null);
    }
  };

  const cancel = (id: string) => {
    Alert.alert('Cancelar agendamento', 'O cliente não vai mais comparecer neste horário?', [
      { text: 'Voltar', style: 'cancel' },
      {
        text: 'Cancelar agendamento',
        style: 'destructive',
        onPress: async () => {
          setCancellingId(id);
          try {
            await apiClient.cancelAppointment(id, 'Cancelado pelo app');
            await load();
          } finally {
            setCancellingId(null);
          }
        },
      },
    ]);
  };

  return (
    <>
      <FlatList
        style={styles.container}
        contentContainerStyle={styles.content}
        data={items}
        keyExtractor={(item) => item.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        ListEmptyComponent={<Text style={styles.empty}>Nenhum agendamento encontrado.</Text>}
        renderItem={({ item }) => (
          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <Text style={styles.customerName}>{item.customer?.name ?? 'Cliente'}</Text>
              <View style={[styles.badge, { backgroundColor: STATUS_COLOR[item.status] }]}>
                <Text style={styles.badgeText}>{STATUS_LABEL[item.status]}</Text>
              </View>
            </View>
            <Text style={styles.detail}>
              {item.motorcycle ? `${item.motorcycle.brand} ${item.motorcycle.model}` : 'Moto não informada'}
            </Text>
            <Text style={styles.detail}>
              {new Date(item.scheduledAt).toLocaleString('pt-BR')}
              {item.effectiveDurationMinutes ? ` · ${item.effectiveDurationMinutes} min` : ''}
            </Text>
            {item.mechanic && <Text style={styles.detail}>Mecânico: {item.mechanic.name ?? 'não identificado'}</Text>}
            {(item.status === 'PROPOSED' || item.status === 'CONFIRMED') && (
              <View style={styles.actionsRow}>
                {item.status === 'PROPOSED' && (
                  <TouchableOpacity
                    style={[styles.actionButton, styles.confirmButton]}
                    onPress={() => confirm(item.id)}
                    disabled={confirmingId === item.id}
                    accessibilityRole="button"
                  >
                    <Text style={styles.confirmButtonText}>
                      {confirmingId === item.id ? 'Confirmando…' : 'Cliente confirmou'}
                    </Text>
                  </TouchableOpacity>
                )}
                <TouchableOpacity
                  style={[styles.actionButton, styles.completeButton]}
                  onPress={() => complete(item)}
                  disabled={completingId === item.id}
                  accessibilityRole="button"
                >
                  <Text style={styles.completeButtonText}>{completingId === item.id ? 'Concluindo…' : 'Concluir'}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.actionButton, styles.cancelButton]}
                  onPress={() => cancel(item.id)}
                  disabled={cancellingId === item.id}
                  accessibilityRole="button"
                >
                  <Text style={styles.cancelButtonText}>{cancellingId === item.id ? 'Cancelando…' : 'Cancelar'}</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        )}
      />

      <Modal visible={!!confirmTarget} transparent animationType="fade" onRequestClose={() => setConfirmTarget(null)}>
        <View style={styles.backdrop}>
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>Confirmação do cliente</Text>
            <Text style={styles.detail}>Registre só quando o cliente ou o responsável pelo veículo aceitou este horário.</Text>
            <Text style={styles.label}>Quem confirmou</Text>
            <TextInput
              style={styles.input}
              value={confirmName}
              onChangeText={setConfirmName}
              placeholder="Ex.: Carlos (dono da moto)"
              placeholderTextColor="#9AA5B1"
              accessibilityLabel="Quem confirmou"
            />
            <Text style={styles.label}>Canal</Text>
            <View style={styles.channels}>
              {CHANNELS.map((c) => (
                <TouchableOpacity
                  key={c.value}
                  style={[styles.channel, confirmChannel === c.value && styles.channelSelected]}
                  onPress={() => setConfirmChannel(c.value)}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: confirmChannel === c.value }}
                >
                  <Text style={confirmChannel === c.value ? styles.channelSelectedText : styles.channelText}>{c.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
            {confirmError && (
              <Text style={styles.error} accessibilityRole="alert">
                {confirmError}
              </Text>
            )}
            <View style={styles.actionsRow}>
              <TouchableOpacity style={[styles.actionButton, styles.cancelButton]} onPress={() => setConfirmTarget(null)} accessibilityRole="button">
                <Text style={styles.cancelButtonText}>Voltar</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.actionButton, styles.confirmButton, confirmName.trim().length < 2 && styles.disabled]}
                onPress={submitConfirm}
                disabled={confirmName.trim().length < 2 || !!confirmingId}
                accessibilityRole="button"
              >
                <Text style={styles.confirmButtonText}>{confirmingId ? 'Registrando…' : 'Registrar'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={!!authTarget} transparent animationType="fade" onRequestClose={() => setAuthTarget(null)}>
        <View style={styles.backdrop}>
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>Concluir sem confirmação do cliente</Text>
            <Text style={styles.detail}>
              {authTarget?.customer?.name ?? 'O cliente'} ainda não confirmou este horário. Um responsável precisa autorizar com as
              próprias credenciais — quem pede não pode autorizar.
            </Text>
            <Text style={styles.label}>Código do responsável</Text>
            <TextInput style={styles.input} value={authId} onChangeText={setAuthId} keyboardType="number-pad" accessibilityLabel="Código do responsável" />
            <Text style={styles.label}>Senha do responsável</Text>
            <TextInput style={styles.input} value={authPassword} onChangeText={setAuthPassword} secureTextEntry accessibilityLabel="Senha do responsável" />
            <Text style={styles.label}>Código MFA (se o responsável tiver)</Text>
            <TextInput style={styles.input} value={authMfa} onChangeText={setAuthMfa} keyboardType="number-pad" accessibilityLabel="Código MFA do responsável" />
            <Text style={styles.label}>Motivo (mínimo {COMPLETION_REASON_MIN} caracteres)</Text>
            <TextInput
              style={styles.input}
              value={authReason}
              onChangeText={setAuthReason}
              placeholder="Ex.: cliente trouxe a moto sem confirmar"
              placeholderTextColor="#9AA5B1"
              accessibilityLabel="Motivo"
            />
            {authError && (
              <Text style={styles.error} accessibilityRole="alert">
                {authError}
              </Text>
            )}
            <View style={styles.actionsRow}>
              <TouchableOpacity style={[styles.actionButton, styles.cancelButton]} onPress={() => setAuthTarget(null)} accessibilityRole="button">
                <Text style={styles.cancelButtonText}>Voltar</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.actionButton, styles.confirmButton]}
                onPress={submitAuthorization}
                disabled={!!completingId}
                accessibilityRole="button"
              >
                <Text style={styles.confirmButtonText}>{completingId ? 'Autorizando…' : 'Autorizar e concluir'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#050A10' },
  content: { padding: 16 },
  empty: { color: '#9AA5B1', textAlign: 'center', marginTop: 40 },
  card: { backgroundColor: '#10171F', borderRadius: 10, padding: 16, marginBottom: 12 },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  customerName: { color: '#fff', fontSize: 16, fontWeight: '600' },
  badge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 },
  badgeText: { color: '#050A10', fontSize: 11, fontWeight: '700' },
  detail: { color: '#9AA5B1', fontSize: 13, marginTop: 2 },
  actionsRow: { flexDirection: 'row', gap: 8, marginTop: 12 },
  actionButton: { flex: 1, borderRadius: 8, paddingVertical: 10, alignItems: 'center' },
  confirmButton: { backgroundColor: '#22c55e' },
  confirmButtonText: { color: '#050A10', fontWeight: '700' },
  cancelButton: { backgroundColor: '#1C2733' },
  completeButton: { backgroundColor: '#F6F7F9' },
  completeButtonText: { color: '#050A10', fontWeight: '700' },
  cancelButtonText: { color: '#C95C5C', fontWeight: '700' },
  disabled: { opacity: 0.5 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', padding: 16 },
  sheet: { backgroundColor: '#10171F', borderRadius: 12, padding: 16 },
  sheetTitle: { color: '#fff', fontSize: 17, fontWeight: '700', marginBottom: 4 },
  label: { color: '#F6F7F9', fontSize: 13, marginTop: 12, marginBottom: 6 },
  input: { borderWidth: 1, borderColor: '#1C2733', borderRadius: 8, color: '#fff', paddingHorizontal: 12, paddingVertical: 10 },
  channels: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  channel: { borderWidth: 1, borderColor: '#1C2733', borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 },
  channelSelected: { backgroundColor: '#22c55e', borderColor: '#22c55e' },
  channelText: { color: '#F6F7F9' },
  channelSelectedText: { color: '#050A10', fontWeight: '700' },
  error: { color: '#C95C5C', marginTop: 10 },
});
