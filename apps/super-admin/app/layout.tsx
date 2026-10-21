import type { Metadata } from 'next';
import { Montserrat } from 'next/font/google';
import './globals.css';
import { THEME_INIT_SCRIPT } from '@/lib/theme';

// Tipografia oficial do quadro de marca CÓRTEX.
const montserrat = Montserrat({ subsets: ['latin'], weight: ['400', '500', '600', '700'], display: 'swap' });

export const metadata: Metadata = {
  title: 'CÓRTEX — Super Admin',
  description: 'Painel de administração Super ADM TI',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // suppressHydrationWarning: o script inline altera a classe do <html> (dark) antes de o React hidratar.
    <html lang="pt-BR" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className={montserrat.className}>{children}</body>
    </html>
  );
}
