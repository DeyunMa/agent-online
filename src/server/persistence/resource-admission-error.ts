/** Match only our static D1 constraint codes; never expose the database error. */
export function isResourceAdmissionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    /user_resource_(?:concurrency|admission_rate|model_budget)/u.test(error.message) ||
    (error.cause !== undefined && isResourceAdmissionError(error.cause))
  );
}
