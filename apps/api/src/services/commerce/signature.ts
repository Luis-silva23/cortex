/**
 * Assinatura de requisição da Commerce API (servidor → servidor). A implementação mora em `@ln-system/shared/utils/request-signature` (fonte única, também usada pelo
 * serviço de monitoramento independente); este arquivo só a reexporta para os chamadores existentes. Detalhes do formato: ver o arquivo de origem.
 */
export { SIGNATURE_TOLERANCE_SEC, bodyDigest, canonicalString, signRequest, verifyRequestSignature } from '@ln-system/shared/utils/request-signature';
export type { SignatureCheck } from '@ln-system/shared/utils/request-signature';
