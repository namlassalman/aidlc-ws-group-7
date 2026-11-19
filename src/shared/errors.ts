/**
 * Errors and the error body (contract C4). Owned by the walking skeleton.
 *
 * Feature code throws these classes (or lets a zod `parse` throw a ZodError); the error middleware
 * in this file turns every thrown error into one ErrorBody with the status from STATUS_OF:
 * validation 400, unauthorized 401, forbidden 403, not_found 404, conflict 409, internal 500.
 * On AWS, a missing or invalid token is refused earlier by the API Gateway JWT authorizer, whose
 * 401 body is `{"message":"Unauthorized"}`, not an ErrorBody: clients check only its status.
 *
 * Body-parser errors: malformed JSON gives 400 and a body over the 100 kB limit gives 413, both
 * with `error: "validation"`. Anything else gives a generic 500 (no stack in the body); the
 * error, its stack and the request id are logged instead.
 */
import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import { log } from "./log.js";

export type ErrorCode =
  "validation" | "unauthorized" | "forbidden" | "not_found" | "conflict" | "internal";

export type ErrorBody = {
  error: ErrorCode;
  message: string;
  /** zod issues for validation errors, otherwise empty. */
  details: unknown[];
};

export const STATUS_OF: Record<ErrorCode, number> = {
  validation: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  internal: 500,
};

export abstract class AppError extends Error {
  abstract readonly code: ErrorCode;
  readonly details: unknown[];

  constructor(message: string, details: unknown[] = [], options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.details = details;
  }

  get status(): number {
    return STATUS_OF[this.code];
  }
}

export class ValidationError extends AppError {
  override readonly code = "validation" as const;
}

export class UnauthorizedError extends AppError {
  override readonly code = "unauthorized" as const;
}

export class ForbiddenError extends AppError {
  override readonly code = "forbidden" as const;
}

export class NotFoundError extends AppError {
  override readonly code = "not_found" as const;
}

export class ConflictError extends AppError {
  override readonly code = "conflict" as const;
}

// ---------------------------------------------------------------------------------------------
// Middleware (mounted last by app.ts)
// ---------------------------------------------------------------------------------------------

const errorBody = (error: ErrorCode, message: string, details: unknown[] = []): ErrorBody => ({
  error,
  message,
  details,
});

/** Errors raised by express.json (body-parser) carry `type` and a 4xx `status`. */
type BodyParserError = { type: string; status: number };

function isBodyParserError(error: unknown): error is BodyParserError {
  const candidate = error as Partial<BodyParserError> | null;
  return (
    typeof candidate?.type === "string" &&
    typeof candidate.status === "number" &&
    candidate.status >= 400 &&
    candidate.status < 500
  );
}

/** The status and ErrorBody for any thrown value (BR6.1). */
export function toErrorResponse(error: unknown): { status: number; body: ErrorBody } {
  if (error instanceof AppError) {
    return { status: error.status, body: errorBody(error.code, error.message, error.details) };
  }
  if (error instanceof ZodError) {
    return { status: 400, body: errorBody("validation", "Invalid request", error.issues) };
  }
  if (isBodyParserError(error)) {
    if (error.type === "entity.too.large") {
      return { status: 413, body: errorBody("validation", "Request body is larger than 100 kB") };
    }
    const message =
      error.type === "entity.parse.failed"
        ? "Request body is not valid JSON"
        : "Invalid request body";
    return { status: error.status, body: errorBody("validation", message) };
  }
  return { status: 500, body: errorBody("internal", "Internal server error") };
}

/** Unmatched routes: 404 ErrorBody. */
export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new NotFoundError(`No route for ${req.method} ${req.path}`));
};

/** The one error middleware: every error becomes an ErrorBody; 500s are logged with their stack. */
export const errorHandler: ErrorRequestHandler = (error, req, res, next) => {
  if (res.headersSent) return next(error);
  const { status, body } = toErrorResponse(error);
  if (status >= 500) {
    const err = error instanceof Error ? error : new Error(String(error));
    log("error", "unhandled error", {
      requestId: res.locals.requestId,
      method: req.method,
      path: req.path,
      name: err.name,
      message: err.message,
      stack: err.stack,
    });
  }
  res.status(status).json(body);
};
