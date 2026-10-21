/** @type {import('tailwindcss').Config} */
// Escala naval do CÓRTEX (mesma do PDV e do Admin Web): 600 = ação principal, 500 = foco, 200 = borda, 100 = fundo suave.
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
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
};
