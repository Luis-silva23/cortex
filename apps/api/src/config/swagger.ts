export const swaggerOptions = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'LN System Cloud API',
      version: '1.0.0',
      description: 'API completa para gestão de lojas multi-tenant',
      contact: {
        name: 'LN System',
        email: 'suporte@lnsystem.com',
        url: 'https://lnsystem.com',
      },
      license: {
        name: 'Proprietary',
        url: 'https://lnsystem.com/license',
      },
    },
    servers: [
      {
        url: 'http://localhost:3001/api',
        description: 'Servidor de Desenvolvimento',
      },
      {
        url: 'https://staging-api.lnsystem.com/api',
        description: 'Servidor de Staging',
      },
      {
        url: 'https://api.lnsystem.com/api',
        description: 'Servidor de Produção',
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'JWT token obtido via /auth/login',
        },
      },
      schemas: {
        Error: {
          type: 'object',
          properties: {
            success: {
              type: 'boolean',
              example: false,
            },
            error: {
              type: 'string',
              example: 'Mensagem de erro',
            },
            code: {
              type: 'string',
              example: 'ERROR_CODE',
            },
          },
        },
        SuccessResponse: {
          type: 'object',
          properties: {
            success: {
              type: 'boolean',
              example: true,
            },
            message: {
              type: 'string',
              example: 'Operação realizada com sucesso',
            },
          },
        },
        User: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              format: 'uuid',
            },
            numericId: {
              type: 'integer',
              example: 123456,
            },
            email: {
              type: 'string',
              format: 'email',
            },
            name: {
              type: 'string',
            },
            userType: {
              type: 'string',
              enum: ['SUPER_ADMIN', 'COMPANY_ADMIN', 'MANAGER', 'OPERATOR', 'VIEWER'],
            },
            status: {
              type: 'string',
              enum: ['ACTIVE', 'INACTIVE', 'BLOCKED'],
            },
          },
        },
        Company: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              format: 'uuid',
            },
            companyName: {
              type: 'string',
            },
            tradeName: {
              type: 'string',
            },
            cnpj: {
              type: 'string',
            },
            status: {
              type: 'string',
              enum: ['ACTIVE', 'INACTIVE', 'SUSPENDED'],
            },
          },
        },
        Product: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              format: 'uuid',
            },
            name: {
              type: 'string',
            },
            sku: {
              type: 'string',
            },
            barcode: {
              type: 'string',
            },
            costPrice: {
              type: 'number',
              format: 'decimal',
            },
            salePrice: {
              type: 'number',
              format: 'decimal',
            },
            minStock: {
              type: 'number',
              format: 'decimal',
            },
            status: {
              type: 'string',
              enum: ['ACTIVE', 'INACTIVE'],
            },
          },
        },
        Sale: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              format: 'uuid',
            },
            numericId: {
              type: 'integer',
            },
            total: {
              type: 'number',
              format: 'decimal',
            },
            discount: {
              type: 'number',
              format: 'decimal',
            },
            status: {
              type: 'string',
              enum: ['PENDING', 'COMPLETED', 'CANCELLED'],
            },
            items: {
              type: 'array',
              items: {
                $ref: '#/components/schemas/SaleItem',
              },
            },
            payments: {
              type: 'array',
              items: {
                $ref: '#/components/schemas/Payment',
              },
            },
          },
        },
        SaleItem: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              format: 'uuid',
            },
            productId: {
              type: 'string',
              format: 'uuid',
            },
            quantity: {
              type: 'number',
              format: 'decimal',
            },
            unitPrice: {
              type: 'number',
              format: 'decimal',
            },
            discount: {
              type: 'number',
              format: 'decimal',
            },
            total: {
              type: 'number',
              format: 'decimal',
            },
          },
        },
        Payment: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              format: 'uuid',
            },
            method: {
              type: 'string',
              enum: ['CASH', 'DEBIT', 'CREDIT', 'PIX', 'CHECK', 'OTHER'],
            },
            amount: {
              type: 'number',
              format: 'decimal',
            },
            installments: {
              type: 'integer',
            },
            status: {
              type: 'string',
              enum: ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'],
            },
          },
        },
        Customer: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              format: 'uuid',
            },
            name: {
              type: 'string',
            },
            email: {
              type: 'string',
              format: 'email',
            },
            phone: {
              type: 'string',
            },
            document: {
              type: 'string',
            },
            customerType: {
              type: 'string',
              enum: ['INDIVIDUAL', 'BUSINESS'],
            },
          },
        },
        HealthCheck: {
          type: 'object',
          properties: {
            uptime: {
              type: 'number',
            },
            message: {
              type: 'string',
              enum: ['OK', 'DEGRADED'],
            },
            timestamp: {
              type: 'string',
              format: 'date-time',
            },
            environment: {
              type: 'string',
            },
            services: {
              type: 'object',
              properties: {
                database: {
                  type: 'string',
                  enum: ['connected', 'disconnected', 'unknown'],
                },
                redis: {
                  type: 'string',
                  enum: ['connected', 'disconnected', 'unknown'],
                },
                queue: {
                  type: 'string',
                  enum: ['connected', 'disconnected', 'unknown'],
                },
              },
            },
          },
        },
      },
    },
    security: [
      {
        bearerAuth: [],
      },
    ],
    tags: [
      {
        name: 'Health',
        description: 'Endpoints de health check',
      },
      {
        name: 'Auth',
        description: 'Autenticação e autorização',
      },
      {
        name: 'Companies',
        description: 'Gestão de empresas (Super Admin)',
      },
      {
        name: 'Licenses',
        description: 'Gestão de licenças (Super Admin)',
      },
      {
        name: 'Users',
        description: 'Gestão de usuários',
      },
      {
        name: 'Products',
        description: 'Gestão de produtos',
      },
      {
        name: 'Categories',
        description: 'Gestão de categorias',
      },
      {
        name: 'Customers',
        description: 'Gestão de clientes',
      },
      {
        name: 'Sales',
        description: 'Gestão de vendas',
      },
      {
        name: 'Payments',
        description: 'Gestão de pagamentos',
      },
      {
        name: 'Stock',
        description: 'Controle de estoque',
      },
      {
        name: 'Cash Register',
        description: 'Gestão de caixa',
      },
      {
        name: 'Reports',
        description: 'Relatórios e análises',
      },
    ],
  },
  apis: ['./src/routes/*.ts'], // Caminho dos arquivos de rotas com anotações JSDoc
};

export const swaggerUiOptions = {
  customCss: '.swagger-ui .topbar { display: none }',
  customSiteTitle: 'LN System Cloud API Docs',
};
