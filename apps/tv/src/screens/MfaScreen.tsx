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
      <View style={styles.card}>
        <Text style={styles.title}>Verificação em duas etapas</Text>
        <Text style={styles.subtitle}>Digite o código do app autenticador de quem está configurando este painel</Text>

        <TextInput
          style={styles.input}
          placeholder="000000"
          placeholderTextColor="#9AA5B1"
          keyboardType="number-pad"
          maxLength={6}
          value={code}
          onChangeText={setCode}
          hasTVPreferredFocus
        />

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <TouchableOpacity style={styles.button} onPress={handleSubmit} disabled={submitting || code.length !== 6}>
          {submitting ? <ActivityIndicator color="#050A10" /> : <Text style={styles.buttonText}>Confirmar</Text>}
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#050A10' },
  card: { width: 480, padding: 32 },
  title: { fontSize: 26, fontWeight: '700', color: '#fff', textAlign: 'center' },
  subtitle: { fontSize: 15, color: '#9AA5B1', textAlign: 'center', marginBottom: 32 },
  input: {
    backgroundColor: '#10171F',
    color: '#fff',
    borderRadius: 8,
    paddingHorizontal: 20,
    paddingVertical: 16,
    marginBottom: 14,
    fontSize: 28,
    textAlign: 'center',
    letterSpacing: 10,
  },
  button: { backgroundColor: '#F6F7F9', borderRadius: 8, paddingVertical: 16, alignItems: 'center', marginTop: 10 },
  buttonText: { color: '#050A10', fontSize: 18, fontWeight: '600' },
  error: { color: '#C95C5C', marginBottom: 12, textAlign: 'center', fontSize: 15 },
});
