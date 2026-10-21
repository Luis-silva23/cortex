/** @type {import('tailwindcss').Config} */
module.exports = {
  // Tema Escuro/Claro/Automático: a classe `dark` no <html> é aplicada por
  // components/providers/ThemeProvider.tsx (e por um script inline no
  // layout raiz, antes da pintura, para não piscar).
  darkMode: 'class',
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    // `lib/` guarda mapas de status -> classes (ex.: lib/quotes.ts); sem
    // isto o Tailwind removeria essas classes do CSS final.
    './lib/**/*.{js,ts,jsx,tsx}',
    // Os testes e o auditor de design contêm exemplos de classes PROIBIDAS: não podem virar CSS.
    '!./**/*.test.{ts,tsx}',
    '!./lib/design-guard.ts',
  ],
  theme: {
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        // Cores semânticas: SÓ para indicadores (status, setas, alertas) —
        // nunca como cor de KPI/valor numérico, que é neutro.
        success: {
          DEFAULT: 'hsl(var(--success))',
          soft: 'hsl(var(--success-soft))',
        },
        warning: {
          DEFAULT: 'hsl(var(--warning))',
          soft: 'hsl(var(--warning-soft))',
        },
        danger: {
          DEFAULT: 'hsl(var(--danger))',
          soft: 'hsl(var(--danger-soft))',
          foreground: 'hsl(var(--danger-foreground))',
        },
        overlay: 'hsl(var(--overlay))',
        chart: {
          1: 'hsl(var(--chart-1))',
          2: 'hsl(var(--chart-2))',
          3: 'hsl(var(--chart-3))',
          4: 'hsl(var(--chart-4))',
          5: 'hsl(var(--chart-5))',
          6: 'hsl(var(--chart-6))',
        },
      },
    },
  },
  plugins: [],
}
