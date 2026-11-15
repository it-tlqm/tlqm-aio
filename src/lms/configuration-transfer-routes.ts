import type { LmsConfigurationTransfer } from './configuration-transfer.js';
import type { ConfigurationKind } from '../configuration-package.js';
import { ConfigurationTransferError } from '../configuration-package.js';
import { LmsError } from './security.js';
export async function lmsConfigurationRoute(
  service: LmsConfigurationTransfer,
  request: Request,
  bodyText: string,
) {
  if (
    request.method !== 'POST' ||
    !request.headers.get('content-type')?.startsWith('application/json')
  )
    throw new LmsError(400, 'INVALID_REQUEST');
  let body: Record<string, any>;
  try {
    body = JSON.parse(bodyText);
  } catch {
    throw new LmsError(400, 'INVALID_REQUEST');
  }
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    !['lms-course', 'lms-path'].includes(body.kind) ||
    !['export', 'options', 'preview', 'apply'].includes(body.action) ||
    typeof body.target !== 'string' ||
    typeof body.reason !== 'string' ||
    body.reason.trim().length < 5 ||
    body.reason.length > 240 ||
    Object.keys(body).some(
      (k) =>
        ![
          'kind',
          'target',
          'action',
          'reason',
          ...(body.action === 'preview'
            ? ['package', 'mappings']
            : body.action === 'apply'
              ? ['review']
              : []),
        ].includes(k),
    )
  )
    throw new LmsError(400, 'INVALID_REQUEST');
  const key = request.headers.get('idempotency-key') ?? '';
  if (!/^[A-Za-z0-9-]{16,80}$/.test(key)) throw new LmsError(400, 'IDEMPOTENCY_KEY_REQUIRED');
  const transfer = service.service(body.kind as ConfigurationKind, body.target, {
    key,
    reason: body.reason,
  });
  try {
    return body.action === 'export'
      ? await transfer.export()
      : body.action === 'options'
        ? await transfer.options()
        : body.action === 'preview'
          ? await transfer.preview(body.package, body.mappings)
          : await transfer.apply(body.review);
  } catch (e) {
    if (e instanceof ConfigurationTransferError) throw new LmsError(e.status, e.code);
    throw e;
  }
}
