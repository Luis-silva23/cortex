# PDV Desktop - LN System Cloud

Aplicativo desktop de Ponto de Venda (PDV) construído com Electron + React + TypeScript.

## Funcionalidades

### ✅ Implementadas
- **Autenticação**: Login com ID numérico e senha, sessão **só em memória** (nada é restaurado ao reabrir), bloqueio de tela com a própria senha e encerramento/revogação da sessão ao sair ou fechar a janela (docs/CORTEX/CONSOLIDACAO_FINAL.md)
- **Vendas (POS)**:
  - Busca rápida de produtos (código ou nome)
  - Carrinho de compras interativo
  - Ajuste de quantidade
  - Aplicação de descontos
  - Seleção de cliente
  - Atalhos de teclado (F2, F4, F8, ESC)
- **Pagamentos**:
  - Múltiplas formas: Dinheiro, Débito, Crédito, PIX
  - Parcelamento (cartão de crédito)
  - Cálculo automático de troco
  - Impressão de cupom (estrutura)
- **Gerenciamento de Caixa**:
  - Abertura de caixa com valor inicial
  - Fechamento com conferência e diferenças
  - Visualização de saldo esperado
- **Histórico de Vendas**:
  - Listagem com filtros
  - Visualização de detalhes
  - Cancelamento de vendas
- **Configurações**:
  - Endereço do servidor (somente leitura: fixado no build, `VITE_API_URL`)
  - Configuração de impressora
  - Informações do dispositivo

## Tecnologias

- **Electron**: Para aplicativo desktop
- **React**: UI framework
- **TypeScript**: Tipagem estática
- **Vite**: Build tool
- **Zustand**: State management
- **React Router**: Navegação
- **Axios**: HTTP client
- **Tailwind CSS**: Estilização
- **Lucide React**: Ícones
- **React Hot Toast**: Notificações

## Como executar

### Desenvolvimento

```bash
# Instalar dependências
cd apps/pdv-desktop
npm install

# Criar arquivo .env
cp .env.example .env

# Executar em modo desenvolvimento
npm run dev
```

### Build para produção

```bash
# Build para Windows
npm run build:win

# Build para Linux
npm run build:linux

# Build para Mac
npm run build:mac
```

Os instaladores serão gerados na pasta `dist-installer/`.

## Estrutura do Projeto

```
apps/pdv-desktop/
├── electron/               # Código Electron (main process)
│   ├── main.ts            # Processo principal
│   └── preload.ts         # Preload script (IPC)
├── src/
│   ├── components/        # Componentes React
│   │   ├── Layout.tsx
│   │   ├── PaymentModal.tsx
│   │   └── CustomerSearchModal.tsx
│   ├── pages/             # Páginas
│   │   ├── LoginPage.tsx
│   │   ├── POSPage.tsx           # Tela principal de vendas
│   │   ├── CashRegisterPage.tsx
│   │   ├── SalesPage.tsx
│   │   └── SettingsPage.tsx
│   ├── store/             # Zustand stores
│   │   ├── auth.store.ts
│   │   └── cart.store.ts
│   ├── services/          # APIs
│   │   └── api.ts
│   ├── App.tsx
│   └── main.tsx
├── package.json
├── vite.config.ts
└── electron-builder.json  # Configuração do instalador
```

## Atalhos de Teclado

Na tela de vendas (POS):
- **F2**: Buscar/Selecionar cliente
- **F4**: Finalizar venda
- **F8**: Cancelar venda
- **ESC**: Limpar busca

## Configuração

O aplicativo pode ser configurado através da página de Configurações:

1. **URL da API**: Endereço do servidor LN System Cloud
2. **Impressora**: Nome da impressora para cupom fiscal
3. **Auto-impressão**: Imprimir automaticamente após venda

As configurações são salvas localmente no dispositivo.

## Integração com API

O PDV se conecta ao backend LN System Cloud através da API REST.

Endpoints utilizados:
- `/api/auth/*` - Autenticação
- `/api/products/*` - Produtos
- `/api/customers/*` - Clientes
- `/api/sales/*` - Vendas
- `/api/payments/*` - Pagamentos
- `/api/cash-register/*` - Caixa

## Próximos Passos

- [ ] Integração com leitor de código de barras USB
- [ ] Integração com impressora térmica (node-thermal-printer)
- [ ] Integração com TEF (maquininhas)
- [ ] Modo offline com sincronização
- [ ] Relatórios de vendas
- [ ] Gerenciamento de gaveta de dinheiro
- [ ] Multi-idioma

## Licença

Proprietário - LN System Cloud
