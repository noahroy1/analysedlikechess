import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ZodError, z } from 'zod';
import type { ApiErrorBody, ApiErrorCode, Job } from '@als/schema';
import { ProviderError } from '../analysis/providers/index.ts';
import {
  JobRunningError,
  NotAVideoError,
  NotFoundError,
  NotReadyError,
  OverCapError,
  UploadIncompleteError,
  VersionConflictError,
} from '../ports.ts';
import { RenderPresetError } from '../render/renders.ts';

/** An error with its HTTP status and stable code, thrown by routes. */
export class ApiError extends Error {
  readonly status: ContentfulStatusCode;
  readonly code: ApiErrorCode;
  readonly extra: { current?: number; job?: Job };

  constructor(status: ContentfulStatusCode, code: ApiErrorCode, message: string, extra: { current?: number; job?: Job } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

/** Any error as the contract's `{ error, code }` body and its status. */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof NotFoundError) return new ApiError(404, 'not_found', error.message);
  if (error instanceof VersionConflictError) {
    return new ApiError(409, 'version_conflict', 'the project changed since it was loaded', { current: error.current });
  }
  if (error instanceof JobRunningError) return new ApiError(409, 'job_running', error.message, { job: error.job });
  if (error instanceof NotReadyError) return new ApiError(409, 'not_ready', error.message);
  if (error instanceof OverCapError) return new ApiError(402, 'over_cap', error.message);
  if (error instanceof ZodError) return new ApiError(400, 'invalid_request', z.prettifyError(error));
  if (error instanceof SyntaxError) return new ApiError(400, 'invalid_request', 'the body is not valid JSON');
  if (error instanceof ProviderError) return new ApiError(502, 'provider_error', error.message);
  if (error instanceof RenderPresetError) return new ApiError(400, 'render_preset', error.message);
  if (error instanceof NotAVideoError) return new ApiError(400, 'not_a_video', `that file is not a playable video (${error.message})`);
  if (error instanceof UploadIncompleteError) return new ApiError(400, 'upload_incomplete', error.message);
  console.error(error);
  return new ApiError(500, 'internal', error instanceof Error ? error.message : String(error));
}

export function errorResponse(c: Context, error: unknown): Response {
  const api = toApiError(error);
  const body: ApiErrorBody = { error: api.message, code: api.code, ...api.extra };
  return c.json(body, api.status);
}
