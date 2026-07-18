import type { ErrorCode } from '@qintopia/contracts';

const RETRYABLE = new Set<ErrorCode>([
  'AGGREGATE_VERSION_CONFLICT',
  'INVENTORY_CONFLICT',
  'ENTITLEMENT_CONFLICT',
  'COMMAND_STATUS_UNKNOWN',
  'SERVICE_NOT_READY',
]);

export class PmsError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, statusCode = 400, details?: unknown) {
    super(message);
    this.name = 'PmsError';
    this.code = code;
    this.statusCode = statusCode;
    this.retryable = RETRYABLE.has(code);
    this.details = details;
  }
}

export function invariant(condition: unknown, code: ErrorCode, message: string, statusCode = 400): asserts condition {
  if (!condition) throw new PmsError(code, message, statusCode);
}
