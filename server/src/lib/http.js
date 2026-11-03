// Small helpers shared by the routes.

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

/** Validate req.body (or any value) against a zod schema, throwing a 400 with field messages. */
export function parse(schema, value) {
  const r = schema.safeParse(value);
  if (!r.success) {
    const details = r.error.issues.map(i => ({ field: i.path.join("."), message: i.message }));
    throw new HttpError(400, details.map(d => (d.field ? `${d.field}: ${d.message}` : d.message)).join("; "), details);
  }
  return r.data;
}

/** Same normalisation the front end uses to build record keys. */
export const normTitle = t => (t || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
export const recordKey = r => (r.doi ? "doi:" + r.doi.toLowerCase() : "t:" + normTitle(r.title));
