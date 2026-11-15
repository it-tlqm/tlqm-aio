import { parseTaskTarget } from './task-target.js';
import { parseFormTarget, parseFormsDetailRoute } from './form-target.js';
import { isLmsReportRoute } from './lms-report-route.js';
const key = 'aio-login-target';
const id = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const workRoute = new RegExp(
  '^#(?:workflow-run/' + id + '(?:/' + id + ')?|training-batch/' + id + ')$',
  'i',
);
const valid = (value: string) =>
  value === '#work-center' ||
  isLmsReportRoute(value) ||
  parseFormsDetailRoute(value) !== null ||
  workRoute.test(value) ||
  parseTaskTarget(value) !== null ||
  parseFormTarget(value) !== null;
export function rememberLoginTarget(
  hash: string,
  storage: Pick<Storage, 'setItem'> = sessionStorage,
  now = Date.now(),
) {
  if (!valid(hash)) return;
  try {
    storage.setItem(key, JSON.stringify({ hash, expires: now + 600000 }));
  } catch {
    /* Optional navigation convenience; never auth state. */
  }
}
export function takeLoginTarget(
  storage: Pick<Storage, 'getItem' | 'removeItem'> = sessionStorage,
  now = Date.now(),
) {
  try {
    const raw = storage.getItem(key);
    storage.removeItem(key);
    if (!raw) return null;
    const value = JSON.parse(raw);
    return typeof value.hash === 'string' &&
      valid(value.hash) &&
      Number.isFinite(value.expires) &&
      value.expires > now &&
      value.expires <= now + 600000
      ? (value.hash as string)
      : null;
  } catch {
    return null;
  }
}
