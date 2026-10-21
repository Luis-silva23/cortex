/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Escala NAVAL do CÓRTEX (tema claro), derivada dos tokens HSL de apps/admin-web/app/globals.css:
        //   600 = --primary (222 47% 14%, botão/ação principal) · 500 = --ring (222 47% 30%, foco)
        //   200 = --border (214 25% 88%) · 100 = --muted (214 32% 94%). 700+ = hover/pressed.
        // Antes era um azul-céu saturado (#0284c7…), fora da regra "preto/branco/cinza/grafite/azul-naval".
        primary: {
          50: '#f5f7fa',
          100: '#ebeff5',
          200: '#d9dfe8',
          300: '#a9b6c6',
          400: '#63769c',
          500: '#293e70',
          600: '#131d34',
          700: '#0e1525',
          800: '#090e1a',
          900: '#070a13',
        },
      },
    },
  },
  plugins: [],
}
