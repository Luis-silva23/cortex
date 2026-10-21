import { useState } from 'react';
import { ActivityIndicator, Image, KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { useAuthStore } from '../store/auth.store';

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
      // Mesmo critério do backend (auth.routes.ts): e-mail contém "@", o ID
      // numérico de 6 dígitos usado em balcão/oficina não.
      const isEmail = identifier.includes('@');
      await login(
        isEmail
          ? { email: identifier.trim(), password }
          : { numericId: Number(identifier.trim()), password }
      );
    } catch {
      // erro já fica em `error` no store — nada a fazer aqui.
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.container}>
      <Image source={require('../../assets/cortex-mark.png')} style={styles.mark} resizeMode="contain" accessibilityElementsHidden importantForAccessibility="no" />
      <Text style={styles.title}>CÓRTEX</Text>
      <Text style={styles.subtitle}>Entrar</Text>

      <TextInput
        style={styles.input}
        placeholder="E-mail ou ID (6 dígitos)"
        placeholderTextColor="#9AA5B1"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        value={identifier}
        onChangeText={setIdentifier}
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
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', padding: 24, backgroundColor: '#050A10' },
  title: { fontSize: 28, fontWeight: '700', color: '#fff', textAlign: 'center' },
  subtitle: { fontSize: 16, color: '#9AA5B1', textAlign: 'center', marginBottom: 32 },
  input: {
    backgroundColor: '#10171F',
    color: '#fff',
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 14,
    marginBottom: 12,
    fontSize: 16,
  },
  mark: { width: 56, height: 66, alignSelf: 'center', marginBottom: 12 },
  button: { backgroundColor: '#F6F7F9', borderRadius: 8, paddingVertical: 14, alignItems: 'center', marginTop: 8 },
  buttonText: { color: '#050A10', fontSize: 16, fontWeight: '600' },
  error: { color: '#C95C5C', marginBottom: 12, textAlign: 'center' },
});
