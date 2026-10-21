import { resolveDevCorsOrigins, resolveProductionCorsOrigins } from './cors';

describe('resolveDevCorsOrigins', () => {
  it('libera uma porta por frontend: super-admin 3000, admin-web 3002 e PDV 5173 (localhost e 127.0.0.1)', () => {
    const origins = resolveDevCorsOrigins({} as NodeJS.ProcessEnv);
    for (const port of [3000, 3002, 5173, 5174]) { // 5174 = aplicativo Balcão
      expect(origins).toContain(`http://localhost:${port}`);
      expect(origins).toContain(`http://127.0.0.1:${port}`);
    }
  });

  it('DEV_CORS_ORIGINS acrescenta origens sem duplicar e ignora vazios', () => {
    const origins = resolveDevCorsOrigins({ DEV_CORS_ORIGINS: ' http://localhost:8081 , ,http://localhost:5173' } as NodeJS.ProcessEnv);
    expect(origins).toContain('http://localhost:8081');
    expect(origins.filter((o) => o === 'http://localhost:5173')).toHaveLength(1);
  });

  it('nunca libera curinga nem a origem "null" (file://) em desenvolvimento', () => {
    const origins = resolveDevCorsOrigins({} as NodeJS.ProcessEnv);
    expect(origins).not.toContain('*');
    expect(origins).not.toContain('null');
  });
});

describe('resolveProductionCorsOrigins', () => {
  it('inclui SUPER_ADMIN_URL e WEB_URL quando ambos definidos', () => {
    const origins = resolveProductionCorsOrigins({
      SUPER_ADMIN_URL: 'https://admin.lnsystem.com',
      WEB_URL: 'https://app.lnsystem.com',
    } as NodeJS.ProcessEnv);
    expect(origins).toEqual(['https://admin.lnsystem.com', 'https://app.lnsystem.com']);
  });

  it('nunca inclui um domínio inventado quando as variáveis não estão definidas', () => {
    const origins = resolveProductionCorsOrigins({} as NodeJS.ProcessEnv);
    expect(origins).toEqual([]);
    expect(origins).not.toContain('https://seu-dominio.com');
  });

  it('inclui BALCAO_URL (aplicativo Balcão) junto das demais, sem inventar domínio quando ausente', () => {
    const origins = resolveProductionCorsOrigins({ WEB_URL: 'https://app.x.com', BALCAO_URL: 'https://balcao.x.com' } as NodeJS.ProcessEnv);
    expect(origins).toEqual(['https://app.x.com', 'https://balcao.x.com']);
    expect(resolveProductionCorsOrigins({ WEB_URL: 'https://app.x.com' } as NodeJS.ProcessEnv)).toEqual(['https://app.x.com']);
  });

  it('inclui só a variável que estiver definida quando a outra falta', () => {
    const origins = resolveProductionCorsOrigins({ WEB_URL: 'https://app.lnsystem.com' } as NodeJS.ProcessEnv);
    expect(origins).toEqual(['https://app.lnsystem.com']);
  });
});
