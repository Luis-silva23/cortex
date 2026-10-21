// Build de PRODUÇÃO só aponta para uma API em HTTPS (ver apps/admin-web/next.config.js): http só para localhost.
const apiUrl = process.env.NEXT_PUBLIC_API_URL;
if (process.env.NODE_ENV === 'production' && apiUrl && !/^https:\/\//i.test(apiUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(apiUrl)) {
  throw new Error('NEXT_PUBLIC_API_URL precisa ser https:// em build de produção (http só para localhost)');
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Necessário para o Dockerfile multi-stage (apps/super-admin/Dockerfile)
  // — mesmo raciocínio já aplicado e testado em apps/admin-web/next.config.js
  // nesta sessão.
  output: 'standalone',
  transpilePackages: ['@ln-system/shared'],
  // Não anuncia o framework; cabeçalhos de segurança em toda página (igual ao Admin Web, inclusive a CSP sem nonce: ver comentário em apps/admin-web/next.config.js).
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
  // Em máquina corporativa/limitada: NEXT_BUILD_CPUS=2 reduz os processos de trabalho do `next build` (padrão: núcleos − 1), como no Admin Web.
  ...(process.env.NEXT_BUILD_CPUS && { experimental: { cpus: Math.max(1, Number(process.env.NEXT_BUILD_CPUS)) } }),
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001',
  },
};

module.exports = nextConfig;
