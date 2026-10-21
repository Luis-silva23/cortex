'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { LogOut, Menu, User } from 'lucide-react';
import { Button } from '@/components/ui/button';
import api from '@/lib/api';
import { ThemeToggle } from './theme-toggle';

export function Header({ onOpenMenu }: { onOpenMenu?: () => void }) {
  const router = useRouter();
  // Lido em useEffect (não durante o render): o servidor não tem localStorage e renderizava "Super Admin" sem
  // e-mail, o cliente renderizava o usuário real — erro de hidratação em toda carga de tela do painel.
  const [user, setUser] = useState<{ name?: string; email?: string }>({});

  useEffect(() => {
    try {
      setUser(JSON.parse(localStorage.getItem('user') || '{}'));
    } catch {
      setUser({});
    }
  }, []);

  const handleLogout = async () => {
    try {
      const refreshToken = localStorage.getItem('refreshToken');
      if (refreshToken) {
        await api.post('/auth/logout', { refreshToken });
      }
    } catch (error) {
      console.error('Logout error:', error);
    } finally {
      localStorage.removeItem('accessToken');
      localStorage.removeItem('refreshToken');
      localStorage.removeItem('user');
      router.push('/login');
    }
  };

  return (
    <header className="flex h-16 items-center justify-between gap-2 border-b bg-card px-4 md:px-6">
      <div className="flex min-w-0 items-center gap-2">
        <Button variant="outline" size="sm" className="md:hidden" onClick={onOpenMenu} aria-label="Abrir menu" aria-controls="sidebar">
          <Menu className="h-4 w-4" />
        </Button>
        <User className="hidden h-5 w-5 sm:block" />
        <div className="min-w-0 text-sm">
          <p className="truncate font-medium">{user.name || 'Super Admin'}</p>
          <p className="hidden truncate text-xs text-muted-foreground sm:block">{user.email}</p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <ThemeToggle />
        <Button variant="outline" size="sm" onClick={handleLogout}>
          <LogOut className="h-4 w-4 sm:mr-2" />
          <span className="sr-only sm:not-sr-only">Sair</span>
        </Button>
      </div>
    </header>
  );
}
