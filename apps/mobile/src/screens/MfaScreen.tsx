import { useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { useAuthStore } from '../store/auth.store';

export default function MfaScreen() {
  const verifyMfa = useAuthStore((s) => s.verifyMfa);
  const error = useAuthStore((s) => s.error);
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (code.length !== 6) return;
    setSubmitting(true);
    try {
      await verifyMfa(code);
    } catch {
      // erro já fica em `error` no store.
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Verificação em duas etapas</Text>
      <Text style={styles.subtitle}>Digite o código do seu app autenticador</Text>

      <TextInput
        style={styles.input}
        placeholder="000000"
        placeholderTextColor="#9AA5B1"
        keyboardType="number-pad"
        maxLength={6}
        value={code}
        onChangeText={setCode}
        autoFocus
      />

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <TouchableOpacity style={styles.button} onPress={handleSubmit} disabled={submitting || code.length !== 6}>
        {submitting ? <ActivityIndicator color="#050A10" /> : <Text style={styles.buttonText}>Confirmar</Text>}
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', padding: 24, backgroundColor: '#050A10' },
  title: { fontSize: 22, fontWeight: '700', color: '#fff', textAlign: 'center' },
  subtitle: { fontSize: 14, color: '#9AA5B1', textAlign: 'center', marginBottom: 32 },
  input: {
    backgroundColor: '#10171F',
    color: '#fff',
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 14,
    marginBottom: 12,
    fontSize: 24,
    textAlign: 'center',
    letterSpacing: 8,
  },
  button: { backgroundColor: '#F6F7F9', borderRadius: 8, paddingVertical: 14, alignItems: 'center', marginTop: 8 },
  buttonText: { color: '#050A10', fontSize: 16, fontWeight: '600' },
  error: { color: '#C95C5C', marginBottom: 12, textAlign: 'center' },
});
