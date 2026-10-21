import { useEffect } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { NavigationContainer, DarkTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useAuthStore } from '../store/auth.store';
import LoginScreen from '../screens/LoginScreen';
import MfaScreen from '../screens/MfaScreen';
import PainelScreen from '../screens/PainelScreen';

const Stack = createNativeStackNavigator();

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
      <Stack.Navigator screenOptions={{ headerShown: false, contentStyle: { backgroundColor: '#050A10' } }}>
        {status === 'signedOut' && <Stack.Screen name="Login" component={LoginScreen} />}
        {status === 'mfaPending' && <Stack.Screen name="Mfa" component={MfaScreen} />}
        {status === 'signedIn' && <Stack.Screen name="Painel" component={PainelScreen} />}
      </Stack.Navigator>
    </NavigationContainer>
  );
}
