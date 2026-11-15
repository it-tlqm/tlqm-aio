export const configurationKinds = [
  'directory-people',
  'directory-org-units',
  'directory-job-titles',
  'directory-positions',
  'workflow',
  'lms-course',
  'lms-path',
] as const;
export type ConfigurationKind = (typeof configurationKinds)[number];
export type ReferenceType = 'unit' | 'account' | 'group' | 'courseVersion' | 'media';
export type ConfigurationReference = { type: ReferenceType; id: string; label: string };
export type ReferenceOptions = Record<ReferenceType, { id: string; name: string }[]>;
export type ConfigurationPackage = {
  format: 'tlqm-aio-configuration';
  version: 1;
  kind: ConfigurationKind;
  label: string;
  createdAt: string;
  content: unknown;
  references: ConfigurationReference[];
};
export type ConfigurationReview = {
  kind: ConfigurationKind;
  target: string;
  tenantId: string;
  accountId: string;
  personId: string;
  revision: number;
  content: unknown;
  metadata: Record<string, unknown>;
  importEvidence?: ConfigurationImportEvidence;
};
export type ConfigurationImportEvidence = {
  packageSha256: string;
  mappingSha256: string;
  mappingCount: number;
};
export type SignedConfigurationReview = { payload: ConfigurationReview; proof: string };
export type ConfigurationMapping = { type: ReferenceType; from: string; to: string };
export class ConfigurationTransferError extends Error {
  constructor(
    readonly code: string,
    readonly status = 400,
  ) {
    super(code);
  }
}
const refTypes: ReferenceType[] = ['unit', 'account', 'group', 'courseVersion', 'media'];
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
export const configUuid = (id: unknown) =>
  typeof id === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
export function boundedConfiguration(value: unknown, maxBytes = 262144) {
  let count = 0;
  const visit = (v: unknown, depth: number) => {
    if (++count > 30000 || depth > 20)
      throw new ConfigurationTransferError('CONFIGURATION_TOO_LARGE');
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return;
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) throw new ConfigurationTransferError('CONFIGURATION_INVALID');
      return;
    }
    if (Array.isArray(v)) {
      if (v.length > 5000) throw new ConfigurationTransferError('CONFIGURATION_TOO_LARGE');
      for (const item of v) visit(item, depth + 1);
      return;
    }
    if (!object(v)) throw new ConfigurationTransferError('CONFIGURATION_INVALID');
    for (const [k, item] of Object.entries(v)) {
      if (['__proto__', 'prototype', 'constructor'].includes(k))
        throw new ConfigurationTransferError('CONFIGURATION_INVALID');
      visit(item, depth + 1);
    }
  };
  visit(value, 0);
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > maxBytes)
    throw new ConfigurationTransferError('CONFIGURATION_TOO_LARGE');
}
export function parseConfigurationPackage(
  value: unknown,
  expected: ConfigurationKind,
): ConfigurationPackage {
  boundedConfiguration(value);
  if (
    !object(value) ||
    value.format !== 'tlqm-aio-configuration' ||
    value.version !== 1 ||
    !configurationKinds.includes(value.kind as ConfigurationKind) ||
    value.kind !== expected ||
    Object.keys(value).some(
      (k) =>
        !['format', 'version', 'kind', 'label', 'createdAt', 'content', 'references'].includes(k),
    ) ||
    typeof value.label !== 'string' ||
    value.label.length > 200 ||
    typeof value.createdAt !== 'string' ||
    value.createdAt.length > 40 ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    !object(value.content) ||
    !Array.isArray(value.references) ||
    value.references.length > 1000 ||
    value.references.some(
      (r) =>
        !object(r) ||
        Object.keys(r).some((k) => !['type', 'id', 'label'].includes(k)) ||
        !refTypes.includes(r.type as ReferenceType) ||
        !configUuid(r.id) ||
        typeof r.label !== 'string' ||
        r.label.length > 200,
    )
  )
    throw new ConfigurationTransferError('CONFIGURATION_PACKAGE_INVALID');
  return structuredClone(value) as ConfigurationPackage;
}
export function configurationReferences(
  kind: ConfigurationKind,
  content: unknown,
): ConfigurationReference[] {
  const c = content as any,
    refs: ConfigurationReference[] = [];
  const add = (type: ReferenceType, id: unknown) => {
    if (typeof id === 'string' && id && !refs.some((r) => r.type === type && r.id === id))
      refs.push({ type, id, label: id });
  };
  if (kind === 'workflow' || kind === 'lms-course' || kind === 'lms-path')
    for (const unit of c.audienceUnits ?? []) add('unit', unit);
  if (kind === 'workflow')
    for (const node of c.nodes ?? [])
      if (['approval', 'task'].includes(node.kind)) {
        if (node.assigneeRule?.kind === 'group' || node.assigneeRule?.kind === 'pool')
          add('group', node.assigneeRule.groupId);
        else if (!node.assigneeRule) add('account', node.assignee);
      }
  if (kind === 'lms-course') {
    if (c.video?.kind === 'file') add('media', c.video.id);
    for (const attachment of c.attachments ?? []) add('media', attachment.mediaId);
    for (const id of c.policy?.prerequisiteVersionIds ?? []) add('courseVersion', id);
  }
  if (kind === 'lms-path') for (const id of c.courseVersionIds ?? []) add('courseVersion', id);
  if (refs.some((r) => !configUuid(r.id)))
    throw new ConfigurationTransferError('CONFIGURATION_REFERENCE_INVALID');
  return refs;
}
export function remapConfiguration(kind: ConfigurationKind, content: unknown, value: unknown) {
  const refs = configurationReferences(kind, content);
  if (
    !Array.isArray(value) ||
    value.length > 1000 ||
    value.some(
      (m) =>
        !object(m) ||
        Object.keys(m).some((k) => !['type', 'from', 'to'].includes(k)) ||
        !refTypes.includes(m.type as ReferenceType) ||
        !configUuid(m.from) ||
        !configUuid(m.to) ||
        !refs.some((r) => r.type === m.type && r.id === m.from),
    ) ||
    new Set(value.map((m) => m.type + ':' + m.from)).size !== value.length
  )
    throw new ConfigurationTransferError('CONFIGURATION_MAPPING_INVALID');
  const mappings = value as ConfigurationMapping[],
    c = structuredClone(content) as any,
    map = (type: ReferenceType, id: string) =>
      mappings.find((m) => m.type === type && m.from === id)?.to ?? id;
  if (kind === 'workflow' || kind === 'lms-course' || kind === 'lms-path')
    c.audienceUnits = c.audienceUnits.map((id: string) => map('unit', id));
  if (kind === 'workflow')
    for (const node of c.nodes)
      if (['approval', 'task'].includes(node.kind)) {
        if (node.assigneeRule?.kind === 'group' || node.assigneeRule?.kind === 'pool')
          node.assigneeRule.groupId = map('group', node.assigneeRule.groupId);
        else if (!node.assigneeRule && node.assignee) node.assignee = map('account', node.assignee);
      }
  if (kind === 'lms-course') {
    if (c.video?.kind === 'file') c.video.id = map('media', c.video.id);
    for (const a of c.attachments) a.mediaId = map('media', a.mediaId);
    if (c.policy)
      c.policy.prerequisiteVersionIds = c.policy.prerequisiteVersionIds.map((id: string) =>
        map('courseVersion', id),
      );
  }
  if (kind === 'lms-path')
    c.courseVersionIds = c.courseVersionIds.map((id: string) => map('courseVersion', id));
  return c as unknown;
}
export function validateConfigurationReferences(
  kind: ConfigurationKind,
  content: unknown,
  options: ReferenceOptions,
) {
  if (
    configurationReferences(kind, content).some((r) => !options[r.type].some((o) => o.id === r.id))
  )
    throw new ConfigurationTransferError('CONFIGURATION_REFERENCE_UNAVAILABLE');
}
export const emptyReferenceOptions = (): ReferenceOptions => ({
  unit: [],
  account: [],
  group: [],
  courseVersion: [],
  media: [],
});
export function makeConfigurationPackage(
  kind: ConfigurationKind,
  label: string,
  content: unknown,
  options: ReferenceOptions,
): ConfigurationPackage {
  const result: ConfigurationPackage = {
    format: 'tlqm-aio-configuration',
    version: 1,
    kind,
    label: label.slice(0, 200),
    createdAt: new Date().toISOString(),
    content: structuredClone(content),
    references: configurationReferences(kind, content).map((r) => ({
      ...r,
      label: options[r.type].find((o) => o.id === r.id)?.name ?? r.id,
    })),
  };
  boundedConfiguration(result);
  return result;
}
const canonical = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canonical)
    : object(v)
      ? Object.fromEntries(
          Object.entries(v)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([k, v]) => [k, canonical(v)]),
        )
      : v;
const encode = (v: string) => new TextEncoder().encode(v);
async function configurationSha256(value: unknown) {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', encode(JSON.stringify(canonical(value)))),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
export async function configurationImportEvidence(pack: ConfigurationPackage, mappings: unknown[]) {
  const [packageSha256, mappingSha256] = await Promise.all([
    configurationSha256(pack),
    configurationSha256(mappings),
  ]);
  return { packageSha256, mappingSha256, mappingCount: mappings.length };
}
async function key(secret: string, domain: string) {
  const material = await crypto.subtle.importKey('raw', encode(secret), 'HKDF', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encode(domain),
      info: encode('aio-configuration-review-v1'),
    },
    material,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign', 'verify'],
  );
}
export async function signConfigurationReview(
  secret: string,
  domain: string,
  payload: ConfigurationReview,
): Promise<SignedConfigurationReview> {
  boundedConfiguration(payload, 393216);
  const bytes = new Uint8Array(
    await crypto.subtle.sign(
      'HMAC',
      await key(secret, domain),
      encode(JSON.stringify(canonical(payload))),
    ),
  );
  return { payload, proof: Array.from(bytes, (v) => v.toString(16).padStart(2, '0')).join('') };
}
export async function verifyConfigurationReview(
  secret: string,
  domain: string,
  review: unknown,
): Promise<ConfigurationReview> {
  boundedConfiguration(review, 393216);
  if (
    !object(review) ||
    Object.keys(review).some((k) => !['payload', 'proof'].includes(k)) ||
    !object(review.payload) ||
    typeof review.proof !== 'string' ||
    !/^[0-9a-f]{64}$/.test(review.proof) ||
    !(await crypto.subtle.verify(
      'HMAC',
      await key(secret, domain),
      Uint8Array.from(review.proof.match(/../g)!, (v) => parseInt(v, 16)),
      encode(JSON.stringify(canonical(review.payload))),
    ))
  )
    throw new ConfigurationTransferError('CONFIGURATION_REVIEW_INVALID', 403);
  const p = review.payload;
  if (
    Object.keys(p).some(
      (k) =>
        ![
          'kind',
          'target',
          'tenantId',
          'accountId',
          'personId',
          'revision',
          'content',
          'metadata',
          'importEvidence',
        ].includes(k),
    ) ||
    !configurationKinds.includes(p.kind as ConfigurationKind) ||
    typeof p.target !== 'string' ||
    !configUuid(p.tenantId) ||
    !configUuid(p.accountId) ||
    !configUuid(p.personId) ||
    !Number.isInteger(p.revision) ||
    Number(p.revision) < 0 ||
    !object(p.content) ||
    !object(p.metadata) ||
    (p.importEvidence !== undefined && !validImportEvidence(p.importEvidence))
  )
    throw new ConfigurationTransferError('CONFIGURATION_REVIEW_INVALID', 403);
  return structuredClone(p) as ConfigurationReview;
}
function validImportEvidence(value: unknown): value is ConfigurationImportEvidence {
  return (
    object(value) &&
    Object.keys(value).length === 3 &&
    typeof value.packageSha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(value.packageSha256) &&
    typeof value.mappingSha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(value.mappingSha256) &&
    Number.isInteger(value.mappingCount) &&
    Number(value.mappingCount) >= 0 &&
    Number(value.mappingCount) <= 1000
  );
}
export function configurationDiff(before: unknown, after: unknown) {
  const changes: { path: string; before: string; after: string }[] = [],
    display = (v: unknown) => (v === undefined ? '(Chưa có)' : (JSON.stringify(v) ?? '(Chưa có)')),
    walk = (a: unknown, b: unknown, path: string) => {
      if (JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))) return;
      if (object(a) && object(b)) {
        for (const key of new Set([...Object.keys(a), ...Object.keys(b)]))
          walk(a[key], b[key], path ? path + '.' + key : key);
        return;
      }
      if (Array.isArray(a) && Array.isArray(b)) {
        for (let i = 0; i < Math.max(a.length, b.length); i++)
          walk(a[i], b[i], path + '[' + (i + 1) + ']');
        return;
      }
      changes.push({ path, before: display(a), after: display(b) });
    };
  walk(before, after, '');
  return changes;
}
