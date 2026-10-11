export type ErrorStatus = 401 | 403 | 404 | 409 | 422 | 501;

export class ApiError extends Error {
  constructor(
    readonly status: ErrorStatus,
    readonly errors: Record<string, string[]>,
  ) {
    super(JSON.stringify(errors));
  }
}

const one = (status: ErrorStatus, field: string, message: string) =>
  new ApiError(status, { [field]: [message] });

export const blank = (field: string) => one(422, field, "can't be blank");
export const invalid = (field: string) => one(422, field, "is invalid");
export const tooShort = (field: string, min: number) =>
  one(422, field, `is too short (minimum is ${min} characters)`);
export const taken = (field: string) => one(409, field, "has already been taken");
export const notFound = (entity: string) => one(404, entity, "not found");
export const forbidden = (entity: string) => one(403, entity, "forbidden");
export const tokenMissing = () => one(401, "token", "is missing");
export const tokenInvalid = () => one(401, "token", "is invalid");
export const credentialsInvalid = () => one(401, "credentials", "invalid");
export const notImplemented = (feature: string) => one(501, feature, "not implemented");
