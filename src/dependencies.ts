// Classify only transport/server-availability errors. Constraint and permission failures remain errors.
export function databaseUnavailable(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { code?: unknown; message?: unknown; cause?: unknown };
  if (
    typeof value.code === 'string' &&
    [
      'ECONNREFUSED',
      'ECONNRESET',
      'EPIPE',
      'ETIMEDOUT',
      '57P01',
      '57P02',
      '57P03',
      '53300',
      '08001',
      '08003',
      '08006',
    ].includes(value.code)
  )
    return true;
  return (
    typeof value.message === 'string' &&
    [
      'Connection terminated unexpectedly',
      'Connection terminated',
      'Connection terminated due to connection timeout',
      'timeout exceeded when trying to connect',
      'Query read timeout',
    ].includes(value.message)
  );
}
