'use client';

import { Monitor, Moon, Sun } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/cn';
import type { ThemeMode } from '@/lib/theme';
import { useTheme } from '@/components/providers/ThemeProvider';

const OPTIONS: Array<{ value: ThemeMode; label: string; description: string; icon: typeof Sun }> = [
  { value: 'dark', label: 'Escuro', description: 'Fundo escuro em todas as telas.', icon: Moon },
  { value: 'light', label: 'Claro', description: 'Fundo claro (branco) em todas as telas.', icon: Sun },
  {
    value: 'system',
    label: 'Sistema',
    description: 'Segue a preferência do seu computador e muda junto com ela.',
    icon: Monitor,
  },
];

// Único lugar do Admin Web onde o tema é escolhido (Configurações → Aparência).
// A escolha fica salva neste navegador (localStorage `ln-theme`) e vale para
// todas as telas, inclusive depois de sair e entrar de novo.
export function ThemeSettings() {
  const { mode, resolved, setMode } = useTheme();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Aparência</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Escolha o tema da interface. A preferência fica salva neste navegador.
        </p>

        <div role="radiogroup" aria-label="Tema da interface" className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {OPTIONS.map(({ value, label, description, icon: Icon }) => {
            const active = mode === value;
            return (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={active}
                data-theme-option={value}
                onClick={() => setMode(value)}
                className={cn(
                  'flex flex-col items-start gap-2 rounded-lg border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  active
                    ? 'border-primary bg-accent text-foreground'
                    : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground'
                )}
              >
                <Icon className="h-5 w-5" aria-hidden />
                <span className="text-sm font-medium text-foreground">{label}</span>
                <span className="text-xs text-muted-foreground">{description}</span>
              </button>
            );
          })}
        </div>

        {mode === 'system' && (
          <p className="text-xs text-muted-foreground" data-testid="theme-system-note">
            No momento o sistema está em modo {resolved === 'dark' ? 'escuro' : 'claro'}.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
