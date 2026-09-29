// examples/capstone-saas-reference/src/errors/app-error.ts
export type ErrorCode =
  | "VALIDATION_ERROR"
  | "BAD_REQUEST"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "RESOURCE_NOT_FOUND"
  | "CONFLICT"
  | "IDEMPOTENCY_CONFLICT"
  | "PAYLOAD_TOO_LARGE"
  | "RATE_LIMIT_EXCEEDED"
  | "EXTERNAL_PROVIDER_ERROR"
  | "UPSTREAM_TIMEOUT"
  | "INTERNAL_SERVER_ERROR";

export interface ErrorDetail {
  field?: string;
  issue: string;
}

export class AppError extends Error {
  public readonly code: ErrorCode;
  public readonly statusCode: number;
  public readonly details: ErrorDetail[];

  constructor(params: {
    code: ErrorCode;
    statusCode: number;
    message: string;
    details?: ErrorDetail[];
    cause?: unknown;
  }) {
    super(params.message, { cause: params.cause });
    this.name = "AppError";
    this.code = params.code;
    this.statusCode = params.statusCode;
    this.details = params.details ?? [];
  }

  static validation(message: string, details: ErrorDetail[] = []) {
    return new AppError({ code: "VALIDATION_ERROR", statusCode: 422, message, details });
  }
  static unauthorized(message = "Authentication required") {
    return new AppError({ code: "UNAUTHENTICATED", statusCode: 401, message });
  }
  static forbidden(message = "Insufficient permissions for this operation") {
    return new AppError({ code: "FORBIDDEN", statusCode: 403, message });
  }
  static notFound(resource: string, id?: string) {
    return new AppError({
      code: "RESOURCE_NOT_FOUND",
      statusCode: 404,
      message: id ? `${resource} '${id}' was not found` : `${resource} was not found`,
    });
  }
  static conflict(message: string, code: ErrorCode = "CONFLICT") {
    return new AppError({ code, statusCode: 409, message });
  }
  static rateLimit(retryAfterSeconds: number) {
    return new AppError({
      code: "RATE_LIMIT_EXCEEDED",
      statusCode: 429,
      message: `Rate limit exceeded. Retry after ${retryAfterSeconds}s`,
      details: [{ issue: `retry_after:${retryAfterSeconds}` }],
    });
  }
}
