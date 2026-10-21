import { useCallback, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { apiClient } from '../api/client';
import { ServiceOrderListItem } from '../api/types';

export default function ServiceOrdersScreen() {
  const navigation = useNavigation<any>();
  const [items, setItems] = useState<ServiceOrderListItem[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await apiClient.getServiceOrders({ limit: 50 });
      setItems(data.orders);
    } catch {
      // mantém a última lista carregada em caso de falha de rede.
    }
  }, []);

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

  return (
    <FlatList
      style={styles.container}
      contentContainerStyle={styles.content}
      data={items}
      keyExtractor={(item) => item.id}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      ListEmptyComponent={<Text style={styles.empty}>Nenhuma ordem de serviço encontrada.</Text>}
      renderItem={({ item }) => (
        <TouchableOpacity
          style={styles.card}
          onPress={() => navigation.navigate('ServiceOrderDetail', { id: item.id, osNumber: item.osNumber })}
        >
          <View style={styles.cardHeader}>
            <Text style={styles.osNumber}>OS #{item.osNumber}</Text>
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{item.status}</Text>
            </View>
          </View>
          <Text style={styles.detail}>{item.customer?.name ?? 'Cliente não informado'}</Text>
          <Text style={styles.detail}>
            {item.motorcycle ? `${item.motorcycle.brand} ${item.motorcycle.model}` : 'Moto não informada'}
          </Text>
          <Text style={styles.detail}>{item.entryKilometer} km na entrada</Text>
        </TouchableOpacity>
      )}
    />
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#050A10' },
  content: { padding: 16 },
  empty: { color: '#9AA5B1', textAlign: 'center', marginTop: 40 },
  card: { backgroundColor: '#10171F', borderRadius: 10, padding: 16, marginBottom: 12 },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  osNumber: { color: '#fff', fontSize: 16, fontWeight: '600' },
  badge: { backgroundColor: '#1C2733', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 },
  badgeText: { color: '#F6F7F9', fontSize: 11, fontWeight: '700' },
  detail: { color: '#9AA5B1', fontSize: 13, marginTop: 2 },
});
