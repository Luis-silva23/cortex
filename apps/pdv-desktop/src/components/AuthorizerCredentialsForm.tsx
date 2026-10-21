import { ShieldCheck } from 'lucide-react';

// Formulário reutilizado por qualquer fluxo de dupla autorização do PDV
// (retirada de caixa, cancelamento de venda) — o autorizador é sempre um
// SEGUNDO usuário (gerência para cima) que se identifica com as PRÓPRIAS
// credenciais na mesma tela, nunca a mesma pessoa que está solicitando a
// operação. Mesmo shape em ambos os backends: numericId + password +
// mfaCode opcional (ver dual-authorization.service.ts).
export interface AuthorizerCredentials {
  numericId: string;
  password: string;
  mfaCode: string;
}

export const emptyAuthorizerCredentials: AuthorizerCredentials = {
  numericId: '',
  password: '',
  mfaCode: '',
};

interface AuthorizerCredentialsFormProps {
  value: AuthorizerCredentials;
  onChange: (value: AuthorizerCredentials) => void;
  disabled?: boolean;
  autoFocus?: boolean;
}

function AuthorizerCredentialsForm({ value, onChange, disabled, autoFocus }: AuthorizerCredentialsFormProps) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-gray-700">
        <ShieldCheck size={20} className="text-primary-600" />
        <p className="text-sm font-medium">
          Um responsável (gerência ou superior) precisa autorizar com as próprias credenciais
        </p>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">ID do Autorizador</label>
        <input
          type="number"
          value={value.numericId}
          onChange={(e) => onChange({ ...value, numericId: e.target.value })}
          disabled={disabled}
          className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none text-lg disabled:opacity-50"
          autoFocus={autoFocus}
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">Senha do Autorizador</label>
        <input
          type="password"
          value={value.password}
          onChange={(e) => onChange({ ...value, password: e.target.value })}
          disabled={disabled}
          className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none text-lg disabled:opacity-50"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Código MFA <span className="text-gray-400 font-normal">(se habilitado)</span>
        </label>
        <input
          type="text"
          value={value.mfaCode}
          onChange={(e) => onChange({ ...value, mfaCode: e.target.value })}
          disabled={disabled}
          placeholder="000000"
          className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none text-lg disabled:opacity-50"
        />
      </div>
    </div>
  );
}

export default AuthorizerCredentialsForm;
