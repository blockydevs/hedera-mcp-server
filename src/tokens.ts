/**
 * DI tokens for the domain services. String tokens (not classes) because several of these
 * are nullable — they resolve to `null` in dev mode, where wallet signing is off — and
 * because the service classes stay framework-agnostic (constructed directly in tests, no
 * `@Injectable` decorator required).
 */
export const APP_OPTIONS = 'APP_OPTIONS';
export const HEDERA_CLIENT = 'HEDERA_CLIENT';
export const DATA_SOURCE = 'DATA_SOURCE';
export const SESSION_STORE = 'SESSION_STORE';
export const WALLET_APPROVER = 'WALLET_APPROVER';
export const OAUTH_PROVIDER = 'OAUTH_PROVIDER';
export const SIGNING_REGISTRY = 'SIGNING_REGISTRY';
export const INTENT_REGISTRY = 'INTENT_REGISTRY';
export const APPROVAL_HOOK = 'APPROVAL_HOOK';
