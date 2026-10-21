import { useEffect } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { NavigationContainer, DarkTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useAuthStore } from '../store/auth.store';
import LoginScreen from '../screens/LoginScreen';
import MfaScreen from '../screens/MfaScreen';
import HomeScreen from '../screens/HomeScreen';
import AgendaScreen from '../screens/AgendaScreen';
import ServiceOrdersScreen from '../screens/ServiceOrdersScreen';
import ServiceOrderDetailScreen from '../screens/ServiceOrderDetailScreen';

const Stack = createNativeStackNavigator();

const screenOptions = {
  headerStyle: { backgroundColor: '#050A10' },
  headerTintColor: '#fff',
  contentStyle: { backgroundColor: '#050A10' },
} as const;

export default function RootNavigator() {
  const status = useAuthStore((s) => s.status);
  const loadSession = useAuthStore((s) => s.loadSession);

  useEffect(() => {
    loadSession();
  }, [loadSession]);

  if (status === 'loading') {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#050A10' }}>
        <ActivityIndicator size="large" color="#F6F7F9" />
      </View>
    );
  }

  return (
    <NavigationContainer theme={DarkTheme}>
      <Stack.Navigator screenOptions={screenOptions}>
        {status === 'signedOut' && (
          <Stack.Screen name="Login" component={LoginScreen} options={{ headerShown: false }} />
        )}
        {status === 'mfaPending' && (
          <Stack.Screen name="Mfa" component={MfaScreen} options={{ headerShown: false, title: 'Verificação' }} />
        )}
        {status === 'signedIn' && (
          <>
            <Stack.Screen name="Home" component={HomeScreen} options={{ headerShown: false }} />
            <Stack.Screen name="Agenda" component={AgendaScreen} options={{ title: 'Agenda' }} />
            <Stack.Screen name="ServiceOrders" component={ServiceOrdersScreen} options={{ title: 'Ordens de serviço' }} />
            <Stack.Screen name="ServiceOrderDetail" component={ServiceOrderDetailScreen} options={{ title: 'Ordem de serviço' }} />
          </>
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}
