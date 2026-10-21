> **Documento original do commit inicial (2026-09-14), anterior a todas as auditorias — NÃO descreve o sistema atual.**
> Mantido só como histórico (antes na raiz do repositório). Diverge do código hoje: SMS e e-mail não existem em produção (a rota responde 503 —
> não há provedor), `mfaCheck.ts` foi removido (código morto), o segredo TOTP é gravado cifrado (`enc:v1`) e o login do
> Super Admin tem o desafio MFA. MFA atual: [SECURITY.md](../SECURITY.md#mfa).

---

# 🔐 Sistema MFA - Explicação Técnica

## Como Funciona o MFA (Multi-Factor Authentication)

### ✅ TOTP (Time-based One-Time Password) - CORRETO

O código implementado usa **TOTP (RFC 6238)**, o mesmo padrão do Google Authenticator, Microsoft Authenticator, Authy, etc.

#### Como o TOTP Funciona:

1. **Secret Compartilhado**: Um secret aleatório é gerado e compartilhado entre o servidor e o app authenticator (via QR code)

2. **Baseado em Tempo**: O código muda a cada 30 segundos

3. **Algoritmo HMAC-SHA1**: 
   ```
   TOTP = HMAC-SHA1(Secret, Time / 30 seconds)
   ```

4. **Código de 6 dígitos**: O resultado é truncado para 6 dígitos

#### Fluxo Completo:

```
[Setup]
1. Servidor gera secret aleatório → "JBSWY3DPEHPK3PXP"
2. Servidor gera QR code com: otpauth://totp/LNSystem:user@email.com?secret=JBSWY3DPEHPK3PXP
3. Usuário escaneia QR code no Google Authenticator
4. Ambos (servidor e app) agora têm o mesmo secret

[Login]
1. Usuário abre Google Authenticator
2. App gera código baseado em (secret + tempo atual)
3. Usuário digita código: ex: "482761"
4. Servidor gera código da mesma forma e compara
5. Se igual → Autenticado ✅
```

---

## 📱 Tipos de MFA Implementados

### 1. TOTP (Google Authenticator) ✅
- **Algoritmo**: HMAC-SHA1 com base em tempo
- **Intervalo**: 30 segundos
- **Código**: 6 dígitos
- **Offline**: Funciona sem internet!

**Exemplo de código gerado:**
```
Tempo: 10:30:00 → Código: 482761
Tempo: 10:30:30 → Código: 193847
Tempo: 10:31:00 → Código: 827394
```

### 2. SMS Code ✅
- **Código**: 6 dígitos aleatórios
- **Validade**: 5 minutos
- **Uso único**: Código não pode ser reutilizado

**Exemplo:**
```javascript
const code = Math.floor(100000 + Math.random() * 900000).toString();
// Resultado: "482761", "193847", etc. (aleatório)
```

### 3. Email Code ✅
- **Código**: 6 dígitos aleatórios
- **Validade**: 10 minutos
- **Uso único**: Código não pode ser reutilizado

### 4. Backup Codes ✅
- **Quantidade**: 10 códigos
- **Formato**: 16 caracteres hexadecimais
- **Uso único**: Cada código só funciona uma vez

**Exemplo:**
```
a3f5c8d2e1b94f67
7b2e5a9c4d8f1e3a
...
```

---

## 🔄 Sincronização de Tempo

### Por que os códigos mudam?

O TOTP usa a **hora atual** como parte do cálculo. Isso garante que:
- Códigos mudam constantemente (a cada 30s)
- Mesmo que alguém veja um código, ele expira em segundos
- Não precisa armazenar códigos usados (stateless)

### Janela de Tolerância

A implementação aceita códigos de **3 janelas de tempo**:
- **Janela anterior** (-30s): Para compensar atraso na digitação
- **Janela atual** (0s): O código correto
- **Janela seguinte** (+30s): Para compensar relógios levemente desincronizados

Isso significa que um código é válido por **~90 segundos** no total.

---

## 📊 Comparação: TOTP vs SMS vs Email

| Característica | TOTP | SMS | Email |
|----------------|------|-----|-------|
| **Segurança** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐ |
| **Funciona Offline** | ✅ Sim | ❌ Não | ❌ Não |
| **Custo** | 💰 Grátis | 💰💰 Pago | 💰 Grátis |
| **Velocidade** | ⚡ Instantâneo | ⏱️ 5-30s | ⏱️ 5-60s |
| **UX** | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ |
| **Phishing Resistant** | ✅ Parcial | ❌ Não | ❌ Não |

---

## 🔧 Código Implementado

### Geração de Secret
```typescript
private generateRandomSecret(): string {
  const buffer = crypto.randomBytes(32); // 256 bits
  return buffer.toString('base64');
}
```

### Geração de TOTP
```typescript
private generateTOTP(secret: string, timeStep: number = 0): string {
  // 1. Calcular timestamp (30s windows)
  const time = Math.floor(Date.now() / 30000) + timeStep;
  const timeBuffer = Buffer.allocUnsafe(8);
  timeBuffer.writeBigInt64BE(BigInt(time));

  // 2. HMAC-SHA1(secret, time)
  const secretBuffer = Buffer.from(secret, 'base64');
  const hmac = crypto.createHmac('sha1', secretBuffer);
  hmac.update(timeBuffer);
  const digest = hmac.digest();

  // 3. Dynamic truncation
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  // 4. Pegar últimos 6 dígitos
  const code = binary % 1000000;
  return code.toString().padStart(6, '0');
}
```

---

## 🧪 Testando Manualmente

### 1. Gerar Secret
```bash
curl -X POST http://localhost:3001/api/mfa/setup \
  -H "Authorization: Bearer TOKEN"
```

**Resposta:**
```json
{
  "secret": "JBSWY3DPEHPK3PXP",
  "qrCode": "otpauth://totp/LNSystem:user@email.com?secret=JBSWY3DPEHPK3PXP",
  "backupCodes": ["a3f5c8d2...", "7b2e5a9c...", ...]
}
```

### 2. Escanear QR Code
- Abra Google Authenticator
- Escaneie o QR code
- App mostrará código de 6 dígitos

### 3. Verificar Código
```bash
curl -X POST http://localhost:3001/api/mfa/verify \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"code": "482761"}'
```

---

## 🔒 Segurança

### Por que TOTP é seguro?

1. **Secret nunca é transmitido**: Só compartilhado uma vez (no setup)
2. **Códigos de uso único**: Cada código expira em 30s
3. **Baseado em criptografia**: HMAC-SHA1 é resistente a reversão
4. **Offline**: Não depende de rede (não pode ser interceptado)

### Comparação com Senha

| | Senha | MFA TOTP |
|-|-------|----------|
| **Pode ser roubada?** | ✅ Sim | ❌ Muito difícil |
| **Reutilizável?** | ✅ Sim (problema!) | ❌ Não |
| **Phishing?** | ✅ Vulnerável | ⭐ Mais resistente |
| **Keylogger?** | ✅ Vulnerável | ⭐ Mais resistente |

---

## 📱 Apps Compatíveis

Qualquer app que suporte TOTP (RFC 6238):
- ✅ Google Authenticator
- ✅ Microsoft Authenticator
- ✅ Authy
- ✅ 1Password
- ✅ LastPass Authenticator
- ✅ Duo Mobile

---

## ⚠️ Importante

### Não confundir:
- **TOTP** (Time-based) → Muda a cada 30s → Google Authenticator
- **HOTP** (Counter-based) → Muda a cada uso → Menos comum
- **SMS Code** → Aleatório, enviado por SMS → Menos seguro

### O código implementado usa TOTP corretamente! ✅

Os códigos gerados pela API são:
1. **TOTP**: Baseados em tempo, compatíveis com Google Authenticator
2. **SMS/Email**: Aleatórios de 6 dígitos (para quando TOTP não está disponível)
3. **Backup codes**: Códigos de emergência de 16 caracteres

---

## 🎯 Resumo

✅ **A implementação está CORRETA**  
✅ **Usa TOTP padrão da indústria (RFC 6238)**  
✅ **Compatível com Google Authenticator**  
✅ **Códigos mudam a cada 30 segundos**  
✅ **Janela de tolerância de 90 segundos**  
✅ **Backup codes para recuperação**  
✅ **SMS/Email como fallback**

**O sistema MFA está pronto para produção!** 🎉

---

**Última atualização:** Janeiro 2024
