'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Bike, Loader2 } from 'lucide-react';
import { cn } from '@/lib/cn';
import { api } from '@/lib/api';

export interface MotorcycleOption {
  id: string;
  brand: string;
  model: string;
  licensePlate?: string | null;
  year?: number | null;
  color?: string | null;
  kilometerReading?: number | string | null;
}

interface MotorcyclePickerProps {
  customerId: string | null;
  value: MotorcycleOption | null;
  onChange: (motorcycle: MotorcycleOption | null) => void;
  disabled?: boolean;
}

export function MotorcyclePicker({ customerId, value, onChange, disabled }: MotorcyclePickerProps) {
  const [motorcycles, setMotorcycles] = useState<MotorcycleOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!customerId) {
      setMotorcycles([]);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .getMotorcycles({ customerId, limit: 100 })
      .then((res) => {
        if (cancelled) return;
        const list: MotorcycleOption[] = res?.motorcycles ?? [];
        setMotorcycles(list);
        // Cliente com uma única moto: já seleciona (menos um clique).
        if (list.length === 1) onChange(list[0]);
      })
      .catch(() => {
        if (!cancelled) setError('Não foi possível carregar as motos deste cliente.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId]);

  if (!customerId) {
    return <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">Selecione o cliente para escolher o veículo.</p>;
  }

  if (loading) {
    return (
      <p className="flex items-center gap-2 rounded-lg border border-border p-4 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Carregando motos...
      </p>
    );
  }

  if (error) {
    return <p className="rounded-lg border border-border p-4 text-sm text-danger">{error}</p>;
  }

  if (motorcycles.length === 0) {
    return (
      <div className="space-y-2 rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground" data-testid="no-motorcycles">
        <p>Este cliente ainda não tem moto cadastrada — o orçamento precisa de um veículo.</p>
        <Link href="/dashboard/motorcycles/new" className="font-medium text-foreground underline underline-offset-4">
          Cadastrar moto
        </Link>
      </div>
    );
  }

  return (
    <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Veículo do cliente">
      {motorcycles.map((moto) => {
        const selected = value?.id === moto.id;
        return (
          <button
            key={moto.id}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            onClick={() => onChange(moto)}
            className={cn(
              'flex items-start gap-3 rounded-lg border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              selected ? 'border-foreground bg-accent' : 'border-border hover:bg-accent'
            )}
          >
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <Bike className="h-4 w-4" aria-hidden />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium text-foreground">
                {moto.brand} {moto.model}
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                {[moto.licensePlate, moto.year, moto.kilometerReading != null ? `${Number(moto.kilometerReading).toLocaleString('pt-BR')} km` : null]
                  .filter(Boolean)
                  .join(' · ') || 'Sem placa'}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
