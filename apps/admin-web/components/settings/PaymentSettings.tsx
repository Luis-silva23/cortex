'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import { api } from '@/lib/api';
import { getApiErrorMessage } from '@/lib/errors';
import { isCompanyAdminOrAbove } from '@/lib/role-gates';
import { useUserType } from '@/lib/hooks/useUserType';

type Effective = { cashDenominationControl: boolean; source: 'branch' | 'company' | 'default' };

// Configurações → Pagamentos: controle de cédulas por empresa, com override por filial. A API é a autoridade (só
// administrador altera); aqui só desenha o estado e envia a mudança.
export function PaymentSettings() {
  const { userType, ready } = useUserType();
  const canEdit = isCompanyAdminOrAbove(userType);
  const [company, setCompany] = useState<Effective | null>(null);
  const [branches, setBranches] = useState<Array<{ id: string; name: string; effective: Effective }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setCompany(await api.getPaymentSettings());
      if (!canEdit) return;
      const list = (await api.getBranches())?.data ?? [];
      setBranches(await Promise.all(list.map(async (b: any) => ({ id: b.id, name: b.name, effective: await api.getPaymentSettings(b.id) }))));
    } catch (err) {
      setError(getApiErrorMessage(err, 'Não foi possível carregar a configuração de pagamento.'));
    }
  }, [canEdit]);

  useEffect(() => {
    if (ready) load();
  }, [ready, load]);

  const save = async (body: { branchId?: string | null; cashDenominationControl: boolean | null }) => {
    setSaving(true);
    setError(null);
    try {
      await api.setPaymentSettings(body);
      await load();
    } catch (err) {
      setError(getApiErrorMessage(err, 'Não foi possível salvar.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Pagamentos</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {error && <p className="text-sm text-danger">{error}</p>}

        <div className="space-y-2">
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              className="mt-1 h-4 w-4"
              checked={company?.source !== 'branch' && !!company?.cashDenominationControl}
              disabled={!canEdit || saving || !company}
              onChange={(e) => save({ cashDenominationControl: e.target.checked })}
            />
            <span>
              <span className="block font-medium text-foreground">Controle de cédulas no dinheiro</span>
              <span className="block text-sm text-muted-foreground">
                Ligado: no PDV, o pagamento em dinheiro registra quantas notas e moedas de cada valor foram recebidas, e o
                fechamento do caixa mostra a composição. Desligado: registra só o valor recebido e o troco.
              </span>
            </span>
          </label>
          {!canEdit && <p className="text-xs text-muted-foreground">Somente leitura: só o administrador da empresa altera.</p>}
        </div>

        {canEdit && branches.length > 0 && (
          <div className="space-y-2">
            <p className="text-sm font-medium text-foreground">Por filial</p>
            {branches.map((b) => (
              <div key={b.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3">
                <span className="text-sm text-foreground">{b.name}</span>
                <Select
                  aria-label={`Controle de cédulas — ${b.name}`}
                  className="w-full sm:w-56"
                  disabled={saving}
                  value={b.effective.source === 'branch' ? (b.effective.cashDenominationControl ? 'on' : 'off') : 'inherit'}
                  onChange={(e) =>
                    save({ branchId: b.id, cashDenominationControl: e.target.value === 'inherit' ? null : e.target.value === 'on' })
                  }
                >
                  <option value="inherit">Igual à empresa</option>
                  <option value="on">Ligado nesta filial</option>
                  <option value="off">Desligado nesta filial</option>
                </Select>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
