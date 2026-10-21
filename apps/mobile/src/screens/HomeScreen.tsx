import { useEffect, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { apiClient } from '../api/client';
import { FollowUpDashboard } from '../api/types';
import { useAuthStore } from '../store/auth.store';

export default function HomeScreen() {
  const navigation = useNavigation<any>();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const [dashboard, setDashboard] = useState<FollowUpDashboard | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    try {
      const data = await apiClient.getFollowUpDashboard(user?.branchId);
      setDashboard(data);
    } catch {
      // dashboard é um resumo secundário — uma falha aqui não deve travar
      // a tela inicial nem exigir tratamento de erro visível.
    }
  };

  useEffect(() => {
    load();
  }, []);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <Text style={styles.greeting}>Olá, {user?.name?.split(' ')[0]}</Text>
      <Text style={styles.company}>{user?.company?.name}{user?.branch ? ` · ${user.branch.name}` : ''}</Text>

      <View style={styles.cardsRow}>
        <View style={[styles.card, { backgroundColor: '#10171F' }]}>
          <Text style={styles.cardValue}>{dashboard?.upcomingRevisions ?? '—'}</Text>
          <Text style={styles.cardLabel}>Próximas revisões</Text>
        </View>
        <View style={[styles.card, { backgroundColor: '#10171F' }]}>
          <Text style={styles.cardValue}>{dashboard?.scheduled ?? '—'}</Text>
          <Text style={styles.cardLabel}>Agendadas</Text>
        </View>
        <View style={[styles.card, { backgroundColor: '#10171F' }]}>
          <Text style={styles.cardValue}>{dashboard?.cancelled ?? '—'}</Text>
          <Text style={styles.cardLabel}>Canceladas</Text>
        </View>
      </View>

      <TouchableOpacity style={styles.menuItem} onPress={() => navigation.navigate('Agenda')}>
        <Text style={styles.menuItemText}>Agenda</Text>
      </TouchableOpacity>
      <TouchableOpacity style={styles.menuItem} onPress={() => navigation.navigate('ServiceOrders')}>
        <Text style={styles.menuItemText}>Ordens de serviço</Text>
      </TouchableOpacity>

      <TouchableOpacity style={styles.logout} onPress={() => logout()}>
        <Text style={styles.logoutText}>Sair</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#050A10' },
  content: { padding: 20, paddingTop: 60 },
  greeting: { fontSize: 24, fontWeight: '700', color: '#fff' },
  company: { fontSize: 14, color: '#9AA5B1', marginBottom: 24 },
  cardsRow: { flexDirection: 'row', gap: 10, marginBottom: 24 },
  card: { flex: 1, borderRadius: 12, padding: 16, alignItems: 'center', borderWidth: 1, borderColor: '#1C2733' },
  cardValue: { fontSize: 26, fontWeight: '700', color: '#F6F7F9' },
  cardLabel: { fontSize: 12, color: '#9AA5B1', marginTop: 4, textAlign: 'center' },
  menuItem: { backgroundColor: '#10171F', borderRadius: 10, padding: 18, marginBottom: 12 },
  menuItemText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  logout: { marginTop: 24, alignItems: 'center' },
  logoutText: { color: '#C95C5C', fontSize: 15 },
});
