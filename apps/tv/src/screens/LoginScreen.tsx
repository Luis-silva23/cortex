import { useState } from 'react';
import { ActivityIndicator, Image, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { useAuthStore } from '../store/auth.store';

// Login é a ÚNICA tela deste app com entrada de texto — o painel em si
// (PainelScreen) é 100% somente leitura, sem formulários, pensado para
// ficar ligado sem interação depois deste passo único (um gerente
// configura o dispositivo uma vez). `hasTVPreferredFocus` garante que o
// controle remoto já chega com o campo de e-mail focado, sem precisar
// navegar pela tela às cegas.
export default function LoginScreen() {
  const login = useAuthStore((s) => s.login);
  const error = useAuthStore((s) => s.error);
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (!identifier || !password) return;
    setSubmitting(true);
    try {
      const isEmail = identifier.includes('@');
      await login(
        isEmail
          ? { email: identifier.trim(), password }
          : { numericId: Number(identifier.trim()), password }
      );
    } catch {
      // erro já fica em `error` no store.
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.card}>
        <Image source={require('../../assets/cortex-mark.png')} style={styles.mark} resizeMode="contain" accessibilityElementsHidden importantForAccessibility="no" />
        <Text style={styles.title}>CÓRTEX — Painel</Text>
        <Text style={styles.subtitle}>Configuração inicial deste dispositivo</Text>

        <TextInput
          style={styles.input}
          placeholder="E-mail ou ID (6 dígitos)"
          placeholderTextColor="#9AA5B1"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          value={identifier}
          onChangeText={setIdentifier}
          hasTVPreferredFocus
        />
        <TextInput
          style={styles.input}
          placeholder="Senha"
          placeholderTextColor="#9AA5B1"
          secureTextEntry
          value={password}
          onChangeText={setPassword}
        />

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <TouchableOpacity style={styles.button} onPress={handleSubmit} disabled={submitting}>
          {submitting ? <ActivityIndicator color="#050A10" /> : <Text style={styles.buttonText}>Entrar</Text>}
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#050A10' },
  card: { width: 480, padding: 32 },
  mark: { width: 72, height: 85, alignSelf: 'center', marginBottom: 14 },
  title: { fontSize: 32, fontWeight: '700', color: '#fff', textAlign: 'center' },
  subtitle: { fontSize: 16, color: '#9AA5B1', textAlign: 'center', marginBottom: 32 },
  input: {
    backgroundColor: '#10171F',
    color: '#fff',
    borderRadius: 8,
    paddingHorizontal: 20,
    paddingVertical: 16,
    marginBottom: 14,
    fontSize: 18,
  },
  button: { backgroundColor: '#F6F7F9', borderRadius: 8, paddingVertical: 16, alignItems: 'center', marginTop: 10 },
  buttonText: { color: '#050A10', fontSize: 18, fontWeight: '600' },
  error: { color: '#C95C5C', marginBottom: 12, textAlign: 'center', fontSize: 15 },
});
