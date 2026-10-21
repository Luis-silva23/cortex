import './globals.css';
import type { Metadata } from 'next';
import { Montserrat } from 'next/font/google';
import { QueryProvider } from '@/components/providers/QueryProvider';
import { ThemeProvider } from '@/components/providers/ThemeProvider';
import { THEME_INIT_SCRIPT } from '@/lib/theme';

// Tipografia oficial do quadro de marca CÓRTEX.
const montserrat = Montserrat({ subsets: ['latin'], weight: ['400', '500', '600', '700'], display: 'swap' });

export const metadata: Metadata = {
  title: 'CÓRTEX — Admin',
  description: 'Painel administrativo do CÓRTEX — Lógica de Negócios',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // suppressHydrationWarning: o script inline abaixo altera a classe do
    // <html> (dark) antes de o React hidratar — o servidor não tem como saber.
    <html lang="pt-BR" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className={montserrat.className}>
        <ThemeProvider>
          <QueryProvider>{children}</QueryProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
