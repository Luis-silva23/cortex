import { Logger } from '../services/logger.service';

/**
 * Este módulo existia como import quebrado (`../utils/logger`) em várias rotas
 * (auth, mfa, backup), apontando para um arquivo que nunca foi criado — o que
 * impedia a aplicação de sequer inicializar. Em vez de duplicar configuração
 * de logging, reexportamos a instância já configurada em services/logger.service.ts
 * (winston, com formato e transports já definidos) sob o nome que essas rotas
 * esperam.
 */
export const logger = Logger;
export default logger;
