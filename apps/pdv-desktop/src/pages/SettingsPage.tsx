import { useState, useEffect } from 'react';
import { Settings, Server, Printer, Info, Save } from 'lucide-react';
import toast from 'react-hot-toast';

import { API_URL as EFFECTIVE_API_URL } from '../services/server-config';

function SettingsPage() {
  const apiUrl = EFFECTIVE_API_URL;
  const [deviceInfo, setDeviceInfo] = useState<any>(null);
  const [printerName, setPrinterName] = useState('');
  const [autoprint, setAutoprint] = useState(true);

  useEffect(() => {
    loadSettings();
    loadDeviceInfo();
  }, []);

  const loadSettings = async () => {
    if (window.electron) {
      const result = await window.electron.loadConfig();
      if (result.success && result.config) {
        setPrinterName(result.config.printerName || '');
        setAutoprint(result.config.autoprint !== false);
      }
    }
  };

  const loadDeviceInfo = async () => {
    if (window.electron) {
      const info = await window.electron.getDeviceInfo();
      setDeviceInfo(info);
    }
  };

  const handleSaveSettings = async () => {
    if (window.electron) {
      const config = {
        apiUrl,
        printerName,
        autoprint,
      };

      const result = await window.electron.saveConfig(config);
      if (result.success) {
        toast.success('Configurações salvas com sucesso!');
      } else {
        toast.error('Erro ao salvar configurações');
      }
    } else {
      // Salvar no localStorage se não estiver no Electron
      localStorage.setItem('pdv-config', JSON.stringify({ apiUrl, printerName, autoprint }));
      toast.success('Configurações salvas!');
    }
  };

  return (
    <div className="h-full bg-gray-50 p-6 overflow-y-auto">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="mb-6">
          <h1 className="text-3xl font-bold text-gray-900 flex items-center gap-3">
            <Settings size={32} />
            Configurações
          </h1>
          <p className="text-gray-600 mt-1">Configure o PDV Desktop</p>
        </div>

        <div className="space-y-6">
          {/* Server Settings */}
          <div className="bg-white rounded-lg shadow p-6">
            <div className="flex items-center gap-3 mb-4">
              <Server size={24} className="text-primary-600" />
              <h2 className="text-xl font-bold text-gray-900">Servidor</h2>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                URL da API
              </label>
              {/* O PDV fala SEMPRE com o servidor definido na instalação (VITE_API_URL). O campo editável antes era
                  salvo e nunca usado — o operador "trocava" o servidor e nada mudava. Mostrado só para conferência. */}
              <input
                type="text"
                value={EFFECTIVE_API_URL}
                readOnly
                aria-readonly="true"
                className="w-full px-4 py-3 rounded-lg border border-gray-200 bg-gray-50 text-gray-700 outline-none"
              />
              <p className="text-sm text-gray-500 mt-2">
                Servidor em uso por este PDV, definido na instalação. Para trocar, peça ao suporte uma nova instalação/atualização.
              </p>
            </div>
          </div>

          {/* Printer Settings */}
          <div className="bg-white rounded-lg shadow p-6">
            <div className="flex items-center gap-3 mb-4">
              <Printer size={24} className="text-primary-600" />
              <h2 className="text-xl font-bold text-gray-900">Impressora</h2>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Nome da Impressora
                </label>
                <input
                  type="text"
                  value={printerName}
                  onChange={(e) => setPrinterName(e.target.value)}
                  placeholder="Deixe em branco para usar a padrão"
                  className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none"
                />
              </div>

              <div className="flex items-center gap-3">
                <input
                  type="checkbox"
                  id="autoprint"
                  checked={autoprint}
                  onChange={(e) => setAutoprint(e.target.checked)}
                  className="w-5 h-5 text-primary-600 border-gray-300 rounded focus:ring-primary-500"
                />
                <label htmlFor="autoprint" className="text-sm font-medium text-gray-700">
                  Imprimir cupom automaticamente após finalizar venda
                </label>
              </div>
              {!window.electron && (
                <p className="text-sm text-amber-800">
                  Aberto fora do aplicativo instalado: a impressão não funciona aqui (o aviso da venda informa "cupom não impresso").
                </p>
              )}
            </div>
          </div>

          {/* Device Info */}
          {deviceInfo && (
            <div className="bg-white rounded-lg shadow p-6">
              <div className="flex items-center gap-3 mb-4">
                <Info size={24} className="text-primary-600" />
                <h2 className="text-xl font-bold text-gray-900">Informações do Dispositivo</h2>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="bg-gray-50 rounded-lg p-4">
                  <p className="text-sm text-gray-600 mb-1">Hostname</p>
                  <p className="font-semibold text-gray-900">{deviceInfo.hostname}</p>
                </div>

                <div className="bg-gray-50 rounded-lg p-4">
                  <p className="text-sm text-gray-600 mb-1">Sistema Operacional</p>
                  <p className="font-semibold text-gray-900">
                    {deviceInfo.platform} ({deviceInfo.arch})
                  </p>
                </div>

                {deviceInfo.macAddress && (
                  <div className="bg-gray-50 rounded-lg p-4 md:col-span-2">
                    <p className="text-sm text-gray-600 mb-1">Endereço MAC</p>
                    <p className="font-semibold text-gray-900 font-mono">{deviceInfo.macAddress}</p>
                  </div>
                )}
              </div>

              <div className="mt-4 p-4 bg-gray-50 border border-gray-200 rounded-lg">
                <p className="text-sm text-gray-800">
                  <strong>Ativação:</strong> Este dispositivo deve ser autorizado pelo Super ADM TI antes de poder ser usado.
                  Entre em contato com o administrador se ainda não foi ativado.
                </p>
              </div>
            </div>
          )}

          {/* Save Button */}
          <div className="flex justify-end">
            <button
              onClick={handleSaveSettings}
              className="px-8 py-3 bg-primary-600 hover:bg-primary-700 text-white rounded-lg font-semibold transition-colors flex items-center gap-2"
            >
              <Save size={20} />
              Salvar Configurações
            </button>
          </div>

          {/* Version Info */}
          <div className="text-center text-sm text-gray-500 pt-6 border-t border-gray-200">
            <p>CÓRTEX PDV Desktop</p>
            <p className="mt-1">CÓRTEX · Lógica de Negócios © {new Date().getFullYear()}</p>
          </div>
        </div>
      </div>
    </div>
  );
}

export default SettingsPage;
