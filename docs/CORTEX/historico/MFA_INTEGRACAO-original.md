> **Documento original do commit inicial (2026-09-14), anterior a todas as auditorias — NÃO descreve o sistema atual.**
> Mantido só como histórico (antes na raiz do repositório). Diverge do código hoje nos mesmos pontos de MFA_EXPLICACAO-original.md. MFA atual:
> [SECURITY.md](../SECURITY.md#mfa).

---

# 🔌 Integração MFA - Guia Prático

## Como Ativar o MFA no Sistema

---

## 📁 Arquivos Criados

### Backend
```
apps/api/src/
├── services/
│   └── MFAService.ts              ✅ Serviço MFA (TOTP, SMS, Email)
├── middlewares/
│   └── mfaCheck.ts                ✅ Middleware para verificar MFA
├── routes/
│   ├── mfa.routes.ts              ✅ Rotas de configuração MFA
│   └── auth.routes.ts             ✅ Rotas de login com MFA
```

---

## 🚀 Passo a Passo para Ativar

### 1. Atualizar o Schema do Prisma

Adicione os campos MFA no seu schema:

```prisma
// packages/database/prisma/schema.prisma

model User {
  id                String   @id @default(uuid())
  email             String   @unique
  password          String
  name              String?
  phone             String?
  
  // ⭐ ADICIONAR ESTES CAMPOS:
  mfaEnabled        Boolean  @default(false)
  mfaSecret         String?
  backupCodes       String[]
  usedBackupCodes   String[]
  
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt
  
  @@map("users")
}
```

### 2. Criar Migration

```bash
cd packages/database
npx prisma migrate dev --name add_mfa_fields
npx prisma generate
```

### 3. Registrar as Rotas no Express

```typescript
// apps/api/src/index.ts ou app.ts

import authRoutes from './routes/auth.routes';
import mfaRoutes from './routes/mfa.routes';

// ...

app.use('/api/auth', authRoutes);      // Rotas de login
app.use('/api/mfa', mfaRoutes);        // Rotas de MFA
```

### 4. Configurar Variáveis de Ambiente

```bash
# .env

JWT_SECRET=sua-chave-secreta-aqui-256-bits
ENCRYPTION_KEY=sua-chave-de-encriptacao-32-chars

# Email (opcional - para MFA via email)
EMAIL_HOST=smtp.gmail.com
EMAIL_PORT=587
EMAIL_USER=seu-email@gmail.com
EMAIL_PASSWORD=sua-senha-app

# SMS (opcional - para MFA via SMS)
TWILIO_ACCOUNT_SID=seu-account-sid
TWILIO_AUTH_TOKEN=seu-auth-token
TWILIO_PHONE_NUMBER=+1234567890
```

---

## 💻 Implementação no Frontend

### Tela de Login com MFA

```typescript
// LoginPage.tsx
'use client';

import { useState } from 'react';
import { apiClient } from '@/lib/api-client';

export default function LoginPage() {
  const [step, setStep] = useState<'login' | 'mfa'>('login');
  const [credentials, setCredentials] = useState({
    email: '',
    password: '',
  });
  const [mfaData, setMfaData] = useState({
    token: '',
    code: '',
    methods: null as any,
  });

  // Etapa 1: Login
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();

    try {
      const response = await apiClient.post('/api/auth/login', credentials);

      if (response.data.mfaRequired) {
        // MFA necessário
        setMfaData({
          token: response.data.mfaToken,
          code: '',
          methods: response.data.mfaMethods,
        });
        setStep('mfa');
      } else {
        // Login sem MFA
        localStorage.setItem('token', response.data.token);
        window.location.href = '/dashboard';
      }
    } catch (error) {
      console.error('Login failed:', error);
      alert('Email ou senha inválidos');
    }
  };

  // Etapa 2: Verificar MFA
  const handleVerifyMFA = async (method: string) => {
    try {
      const response = await apiClient.post('/api/auth/verify-mfa', {
        mfaToken: mfaData.token,
        code: mfaData.code,
        method,
      });

      localStorage.setItem('token', response.data.token);
      window.location.href = '/dashboard';
    } catch (error) {
      console.error('MFA verification failed:', error);
      alert('Código MFA inválido');
    }
  };

  // Enviar código por SMS/Email
  const handleSendCode = async (method: 'sms' | 'email') => {
    try {
      await apiClient.post('/api/auth/send-mfa-code', {
        mfaToken: mfaData.token,
        method,
      });
      alert(`Código enviado via ${method === 'sms' ? 'SMS' : 'Email'}`);
    } catch (error) {
      console.error('Failed to send code:', error);
    }
  };

  if (step === 'login') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="max-w-md w-full space-y-8 p-8 bg-white rounded-lg shadow">
          <h2 className="text-3xl font-bold text-center">Login</h2>
          <form onSubmit={handleLogin} className="space-y-6">
            <div>
              <label className="block text-sm font-medium mb-2">Email</label>
              <input
                type="email"
                value={credentials.email}
                onChange={(e) =>
                  setCredentials({ ...credentials, email: e.target.value })
                }
                className="w-full px-3 py-2 border rounded-lg"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">Senha</label>
              <input
                type="password"
                value={credentials.password}
                onChange={(e) =>
                  setCredentials({ ...credentials, password: e.target.value })
                }
                className="w-full px-3 py-2 border rounded-lg"
                required
              />
            </div>
            <button
              type="submit"
              className="w-full py-2 px-4 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
            >
              Entrar
            </button>
          </form>
        </div>
      </div>
    );
  }

  // Tela de MFA
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="max-w-md w-full space-y-8 p-8 bg-white rounded-lg shadow">
        <div className="text-center">
          <h2 className="text-3xl font-bold mb-2">Verificação MFA</h2>
          <p className="text-gray-600">Digite o código de verificação</p>
        </div>

        <div>
          <input
            type="text"
            value={mfaData.code}
            onChange={(e) => setMfaData({ ...mfaData, code: e.target.value })}
            placeholder="000000"
            maxLength={6}
            className="w-full text-center text-2xl tracking-widest px-3 py-3 border rounded-lg"
          />
        </div>

        <div className="space-y-3">
          {/* Google Authenticator */}
          {mfaData.methods?.totp && (
            <button
              onClick={() => handleVerifyMFA('totp')}
              className="w-full py-3 px-4 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
            >
              Verificar com Google Authenticator
            </button>
          )}

          {/* SMS */}
          {mfaData.methods?.sms && (
            <div className="space-y-2">
              <button
                onClick={() => handleSendCode('sms')}
                className="w-full py-2 px-4 border border-blue-600 text-blue-600 rounded-lg hover:bg-blue-50"
              >
                Enviar código por SMS
              </button>
              <button
                onClick={() => handleVerifyMFA('sms')}
                className="w-full py-2 px-4 bg-green-600 text-white rounded-lg hover:bg-green-700"
              >
                Verificar código SMS
              </button>
            </div>
          )}

          {/* Email */}
          {mfaData.methods?.email && (
            <div className="space-y-2">
              <button
                onClick={() => handleSendCode('email')}
                className="w-full py-2 px-4 border border-purple-600 text-purple-600 rounded-lg hover:bg-purple-50"
              >
                Enviar código por Email
              </button>
              <button
                onClick={() => handleVerifyMFA('email')}
                className="w-full py-2 px-4 bg-purple-600 text-white rounded-lg hover:bg-purple-700"
              >
                Verificar código Email
              </button>
            </div>
          )}

          {/* Backup Code */}
          <button
            onClick={() => handleVerifyMFA('backup')}
            className="w-full py-2 px-4 text-gray-600 hover:bg-gray-100 rounded-lg"
          >
            Usar código de recuperação
          </button>
        </div>

        <button
          onClick={() => setStep('login')}
          className="w-full text-sm text-gray-600 hover:text-gray-900"
        >
          ← Voltar ao login
        </button>
      </div>
    </div>
  );
}
```

---

## ⚙️ Tela de Configuração MFA

```typescript
// MFASetupPage.tsx
'use client';

import { useState, useEffect } from 'react';
import { apiClient } from '@/lib/api-client';
import QRCode from 'qrcode';

export default function MFASetupPage() {
  const [step, setStep] = useState<'setup' | 'verify' | 'complete'>('setup');
  const [mfaData, setMfaData] = useState<any>(null);
  const [qrCodeUrl, setQrCodeUrl] = useState('');
  const [verificationCode, setVerificationCode] = useState('');

  // Etapa 1: Gerar QR Code
  const handleSetupMFA = async () => {
    try {
      const response = await apiClient.post('/api/mfa/setup');
      const data = response.data.data;
      setMfaData(data);

      // Gerar QR code como imagem
      const qrUrl = await QRCode.toDataURL(data.qrCode);
      setQrCodeUrl(qrUrl);

      setStep('verify');
    } catch (error) {
      console.error('MFA setup failed:', error);
    }
  };

  // Etapa 2: Verificar código
  const handleVerify = async () => {
    try {
      await apiClient.post('/api/mfa/verify', {
        code: verificationCode,
      });

      // MFA ativado com sucesso!
      setStep('complete');
    } catch (error) {
      console.error('Verification failed:', error);
      alert('Código inválido. Tente novamente.');
    }
  };

  if (step === 'setup') {
    return (
      <div className="max-w-2xl mx-auto p-8">
        <h1 className="text-3xl font-bold mb-6">
          Configurar Autenticação em Duas Etapas
        </h1>
        <p className="text-gray-600 mb-8">
          Adicione uma camada extra de segurança à sua conta usando autenticação
          em duas etapas (MFA).
        </p>
        <button
          onClick={handleSetupMFA}
          className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
        >
          Começar Configuração
        </button>
      </div>
    );
  }

  if (step === 'verify') {
    return (
      <div className="max-w-2xl mx-auto p-8">
        <h1 className="text-3xl font-bold mb-6">Escaneie o QR Code</h1>

        <div className="bg-white p-6 rounded-lg border mb-6">
          <p className="text-sm text-gray-600 mb-4">
            1. Abra o Google Authenticator no seu celular
          </p>
          <p className="text-sm text-gray-600 mb-4">
            2. Toque em "+" e escolha "Escanear código QR"
          </p>
          <p className="text-sm text-gray-600 mb-6">
            3. Escaneie este código:
          </p>

          <div className="flex justify-center mb-6">
            {qrCodeUrl && <img src={qrCodeUrl} alt="QR Code" />}
          </div>

          <details className="text-sm">
            <summary className="cursor-pointer text-blue-600">
              Não consegue escanear? Clique aqui
            </summary>
            <div className="mt-4 p-4 bg-gray-50 rounded">
              <p className="font-mono text-xs break-all">{mfaData?.secret}</p>
              <p className="text-xs text-gray-500 mt-2">
                Digite este código manualmente no app
              </p>
            </div>
          </details>
        </div>

        <div className="mb-6">
          <label className="block text-sm font-medium mb-2">
            Digite o código do app:
          </label>
          <input
            type="text"
            value={verificationCode}
            onChange={(e) => setVerificationCode(e.target.value)}
            placeholder="000000"
            maxLength={6}
            className="w-full text-center text-2xl tracking-widest px-3 py-3 border rounded-lg"
          />
        </div>

        <button
          onClick={handleVerify}
          className="w-full py-3 px-4 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
        >
          Verificar e Ativar MFA
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto p-8 text-center">
      <div className="mb-6">
        <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
          <svg
            className="w-8 h-8 text-green-600"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M5 13l4 4L19 7"
            />
          </svg>
        </div>
        <h1 className="text-3xl font-bold mb-2">MFA Ativado!</h1>
        <p className="text-gray-600">
          Sua conta agora está protegida com autenticação em duas etapas.
        </p>
      </div>

      <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-6 mb-6">
        <h3 className="font-semibold mb-2">⚠️ Códigos de Recuperação</h3>
        <p className="text-sm text-gray-700 mb-4">
          Guarde estes códigos em um local seguro. Você pode usá-los caso perca
          acesso ao Google Authenticator.
        </p>
        <div className="grid grid-cols-2 gap-2 font-mono text-sm">
          {mfaData?.backupCodes.map((code: string, index: number) => (
            <div key={index} className="bg-white p-2 rounded">
              {code}
            </div>
          ))}
        </div>
        <button
          onClick={() => {
            const text = mfaData?.backupCodes.join('\n');
            navigator.clipboard.writeText(text);
            alert('Códigos copiados!');
          }}
          className="mt-4 px-4 py-2 text-sm bg-yellow-200 hover:bg-yellow-300 rounded"
        >
          Copiar Códigos
        </button>
      </div>

      <a
        href="/dashboard"
        className="inline-block px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
      >
        Ir para Dashboard
      </a>
    </div>
  );
}
```

---

## 📋 Checklist Final

### Backend
- [ ] Adicionar campos MFA no schema Prisma
- [ ] Criar migration
- [ ] Registrar rotas auth e mfa no app
- [ ] Configurar variáveis de ambiente
- [ ] Testar endpoints com Postman/cURL

### Frontend
- [ ] Criar tela de login
- [ ] Criar tela de verificação MFA
- [ ] Criar tela de configuração MFA
- [ ] Instalar `qrcode` (`npm install qrcode`)
- [ ] Testar fluxo completo

### Opcional (Produção)
- [ ] Configurar Twilio para SMS
- [ ] Configurar Nodemailer para Email
- [ ] Adicionar Redis para cache de códigos temporários
- [ ] Implementar rate limiting no MFA
- [ ] Adicionar logs de auditoria

---

## 🎯 Resultado Final

Quando tudo estiver configurado:

1. ✅ Login pede senha
2. ✅ Se usuário tem MFA → Pede código
3. ✅ Usuário pode escolher: TOTP, SMS, Email ou Backup
4. ✅ Após verificar → Login completo
5. ✅ Rotas protegidas verificam MFA automaticamente

**MFA está pronto para produção!** 🎉

---

**Última atualização:** Janeiro 2024
