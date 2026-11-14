export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    /** Extra response headers (e.g. Retry-After). */
    public headers?: Record<string, string>,
  ) {
    super(message);
  }
}
