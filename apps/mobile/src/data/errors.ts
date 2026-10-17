import type { Problem } from '@nem/contracts';

/**
 * Every repository failure is an RFC 9457 problem with a stable `code`, whether it
 * came from the API (http) or from the mock bank's own rules, so screens handle
 * both the same way.
 */
export class ApiError extends Error {
  readonly problem: Problem;

  constructor(problem: Problem) {
    super(problem.detail ?? problem.title);
    this.name = 'ApiError';
    this.problem = problem;
  }

  get status(): number {
    return this.problem.status;
  }

  get code(): string {
    return this.problem.code;
  }
}

export function isApiError(error: unknown, code?: string): error is ApiError {
  return error instanceof ApiError && (code === undefined || error.code === code);
}

export function problem(
  status: number,
  code: string,
  title: string,
  extra: Partial<Omit<Problem, 'status' | 'code' | 'title'>> = {},
): ApiError {
  return new ApiError({ type: `https://nem.bank/problems/${code}`, title, status, code, ...extra });
}
