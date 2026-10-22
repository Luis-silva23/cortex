// Build de PRODUÇÃO só aponta para uma API em HTTPS (o endereço é fixado no build). Exceção: loopback (homologação de um host só, sem
// TLS). Falha fechada: um build com http://servidor-real não sai, em vez de mandar senha e token em texto puro.
const apiUrl = process.env.NEXT_PUBLIC_API_URL;
if (process.env.NODE_ENV === 'production' && apiUrl && !/^https:\/\//i.test(apiUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(apiUrl)) {
  throw new Error('NEXT_PUBLIC_API_URL precisa ser https:// em build de produção (http só para localhost)');
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Necessário para o Dockerfile multi-stage (apps/admin-web/Dockerfile):
  // 'standalone' produz um server.js self-contained com só as dependências
  // realmente usadas (Next.js faz tree-shaking do node_modules), em vez de
  // precisar copiar node_modules inteiro (centenas de MB) pra imagem final.
  output: 'standalone',
  transpilePackages: ['@ln-system/shared'],
  // O build VALIDA tipos e lint (antes ignorava os dois: um erro de tipo ou de lint chegava a produção sem ninguém ver). Estavam limpos
  // em 2026-10-06 (`tsc --noEmit` e `next lint` sem erro); o CI também roda os dois antes do build.
  eslint: {
    ignoreDuringBuilds: false,
  },
  typescript: {
    ignoreBuildErrors: false,
  },
  // Nenhum código usa next/image (a imagem do produto vem da própria API). O otimizador (/_next/image) ficava ATIVO, com AVIF habilitado, e o next@14 tem
  // RCE crítico nele (AVIF, <15.5.24). Desligado: o endpoint responde 404 (provado com `next start`).
  images: { unoptimized: true },
  // Code splitting otimizado
  experimental: {
    optimizePackageImports: ['lucide-react', 'recharts'],
    // Em máquina corporativa/limitada: NEXT_BUILD_CPUS=2 reduz os processos de trabalho do `next build` (padrão: núcleos − 1).
    ...(process.env.NEXT_BUILD_CPUS && { cpus: Math.max(1, Number(process.env.NEXT_BUILD_CPUS)) }),
  },
  // Compressão
  compress: true,
  // Não anuncia o framework; cabeçalhos de segurança básicos em toda página (anti-clickjacking, anti-sniffing, referrer e permissões).
  // CSP sem nonce: o script de tema do layout é inline, então `script-src` mantém 'unsafe-inline' (não protege contra XSS por injeção de script inline).
  // O que ela garante: nenhuma origem externa de script/estilo/fonte/imagem, conexões só para a própria origem e a API configurada, sem <object>/<base>
  // estranho, sem frames e formulários só para a própria origem. Evolução: nonce por requisição (exige renderização dinâmica de todas as páginas).
  poweredByHeader: false,
  async headers() {
    const isDev = process.env.NODE_ENV !== 'production';
    let apiOrigin = '';
    try { apiOrigin = new URL(apiUrl || 'http://localhost:3001').origin; } catch { /* sem origem de API válida: só a própria origem */ }
    const csp = [
      "default-src 'self'",
      `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
      "style-src 'self' 'unsafe-inline'",
      `img-src 'self' data: blob: ${apiOrigin}`.trim(),
      "font-src 'self' data:",
      `connect-src 'self' ${apiOrigin}${isDev ? ' ws://localhost:* http://localhost:*' : ''}`.trim(),
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; ');
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
        ],
      },
    ];
  },
  // Otimizar produção
  ...(process.env.NODE_ENV === 'production' && {
    compiler: {
      removeConsole: {
        exclude: ['error', 'warn'],
      },
    },
  }),
}

module.exports = nextConfig
