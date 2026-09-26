/**
 * Application error taxonomy shared by server and client.
 *
 * Every error that can reach a user maps to a code with a plain-language
 * message. Internal details (stack traces, FFmpeg stderr, model output) are
 * logged server-side and never sent to the browser.
 */

export const ERROR_CODES = [
  "VALIDATION_ERROR",
  "NOT_FOUND",
  "UPLOAD_FAILED",
  "UPLOAD_TOO_LARGE",
  "UNSUPPORTED_FORMAT",
  "CORRUPTED_VIDEO",
  "VIDEO_TOO_LONG",
  "VIDEO_TOO_LARGE",
  "FFMPEG_UNAVAILABLE",
  "AI_TIMEOUT",
  "MODEL_UNAVAILABLE",
  "INVALID_AI_RESPONSE",
  "COMMAND_NOT_UNDERSTOOD",
  "TARGET_NOT_FOUND",
  "NO_SELECTION",
  "SEGMENTATION_FAILED",
  "TRACKING_FAILED",
  "EXPORT_FAILED",
  "FORMAT_UNAVAILABLE",
  "INSUFFICIENT_RESOURCES",
  "RATE_LIMITED",
  "JOB_CANCELLED",
  "CONFLICT",
  "INTERNAL",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

interface CatalogEntry {
  status: number;
  message: string;
  hint?: string;
  retryable: boolean;
}

export const ERROR_CATALOG: Record<ErrorCode, CatalogEntry> = {
  VALIDATION_ERROR: { status: 400, message: "Some of the information sent was invalid.", retryable: false },
  NOT_FOUND: { status: 404, message: "We couldn't find what you were looking for.", retryable: false },
  UPLOAD_FAILED: {
    status: 400,
    message: "The upload didn't finish.",
    hint: "Check your connection and try again.",
    retryable: true,
  },
  UPLOAD_TOO_LARGE: {
    status: 413,
    message: "This file is too large.",
    hint: "Try a shorter clip or a lower-resolution export of your video.",
    retryable: false,
  },
  UNSUPPORTED_FORMAT: {
    status: 415,
    message: "This file type isn't supported.",
    hint: "Upload an MP4, MOV, or WebM video.",
    retryable: false,
  },
  CORRUPTED_VIDEO: {
    status: 422,
    message: "We couldn't read this video. It may be damaged or use an unusual codec.",
    hint: "Try re-exporting it as H.264 MP4 from your editor or phone.",
    retryable: false,
  },
  VIDEO_TOO_LONG: {
    status: 422,
    message: "This video is longer than the current limit.",
    hint: "Trim it to a shorter clip and upload again.",
    retryable: false,
  },
  VIDEO_TOO_LARGE: {
    status: 422,
    message: "This video's resolution is higher than we can process.",
    hint: "Try a 4K or lower version of the clip.",
    retryable: false,
  },
  FFMPEG_UNAVAILABLE: {
    status: 503,
    message: "Video processing isn't available on this server.",
    hint: "FFmpeg could not be found. See the README section “FFmpeg setup”.",
    retryable: false,
  },
  AI_TIMEOUT: {
    status: 504,
    message: "The AI took too long to respond.",
    hint: "Try again, or try a shorter clip.",
    retryable: true,
  },
  MODEL_UNAVAILABLE: {
    status: 503,
    message: "The AI model is unavailable right now.",
    hint: "Check that the model server is running, or switch to mock mode in Settings.",
    retryable: true,
  },
  INVALID_AI_RESPONSE: {
    status: 502,
    message: "The AI returned a response we couldn't use.",
    hint: "Try rephrasing your request.",
    retryable: true,
  },
  COMMAND_NOT_UNDERSTOOD: {
    status: 422,
    message: "We didn't understand that request.",
    hint: "Try something like “Track the red car” or “Remove the background behind the dog”.",
    retryable: false,
  },
  TARGET_NOT_FOUND: {
    status: 422,
    message: "We couldn't find that in the video.",
    hint: "Try describing it differently, or click on the object with the Select tool.",
    retryable: false,
  },
  NO_SELECTION: {
    status: 422,
    message: "Select an object first.",
    hint: "Click an object with the Select tool, or describe it to the AI.",
    retryable: false,
  },
  SEGMENTATION_FAILED: {
    status: 500,
    message: "We couldn't create a mask for that selection.",
    hint: "Try clicking closer to the center of the object, or draw a box around it.",
    retryable: true,
  },
  TRACKING_FAILED: {
    status: 500,
    message: "We couldn't follow the object through the video.",
    hint: "Try a shorter range, or add another click on a frame where tracking drifted.",
    retryable: true,
  },
  EXPORT_FAILED: {
    status: 500,
    message: "The export didn't complete.",
    hint: "Try a lower resolution or a different format.",
    retryable: true,
  },
  FORMAT_UNAVAILABLE: {
    status: 422,
    message: "That export format isn't available on this server.",
    hint: "Choose another format, such as PNG sequence.",
    retryable: false,
  },
  INSUFFICIENT_RESOURCES: {
    status: 503,
    message: "The server is too busy or low on space to do this right now.",
    hint: "Wait for running jobs to finish, or free up disk space, then try again.",
    retryable: true,
  },
  RATE_LIMITED: {
    status: 429,
    message: "You're going a little fast.",
    hint: "Wait a moment and try again.",
    retryable: true,
  },
  JOB_CANCELLED: { status: 409, message: "This job was cancelled.", retryable: false },
  CONFLICT: { status: 409, message: "That can't be done in the current state.", retryable: false },
  INTERNAL: {
    status: 500,
    message: "Something went wrong on our side.",
    hint: "Try again. If it keeps happening, restart the server and check its logs.",
    retryable: true,
  },
};

export interface SerializedError {
  code: ErrorCode;
  message: string;
  hint?: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly hint?: string;
  readonly retryable: boolean;
  /** Safe, user-facing extra fields (e.g. `{ maxMb: 500 }`). */
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    opts: { message?: string; hint?: string; cause?: unknown; details?: Record<string, unknown> } = {},
  ) {
    const entry = ERROR_CATALOG[code];
    super(opts.message ?? entry.message, { cause: opts.cause });
    this.name = "AppError";
    this.code = code;
    this.status = entry.status;
    this.hint = opts.hint ?? entry.hint;
    this.retryable = entry.retryable;
    this.details = opts.details;
  }

  toJSON(): SerializedError {
    return {
      code: this.code,
      message: this.message,
      hint: this.hint,
      retryable: this.retryable,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

/** Normalizes anything thrown into an AppError without leaking internals. */
export function toAppError(err: unknown, fallback: ErrorCode = "INTERNAL"): AppError {
  if (isAppError(err)) return err;
  if (err instanceof Error && (err.name === "AbortError" || err.name === "CancelledError")) {
    return new AppError("JOB_CANCELLED", { cause: err });
  }
  return new AppError(fallback, { cause: err });
}

export function isSerializedError(value: unknown): value is SerializedError {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as SerializedError).code === "string" &&
    typeof (value as SerializedError).message === "string"
  );
}
