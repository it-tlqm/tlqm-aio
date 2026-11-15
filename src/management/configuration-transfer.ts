import type { Store } from '../store.js';
import { DirectoryMetadata, parseDirectoryConfiguration, metadataResources } from './metadata.js';
import { schemaFields } from '../forms/contracts.js';
import { HttpError } from '../security.js';
import type { MutationContext } from './mutations.js';
import { ConfigurationTransfer } from '../configuration-transfer.js';
import { ConfigurationTransferError, emptyReferenceOptions } from '../configuration-package.js';
import type { ConfigurationKind } from '../configuration-package.js';
export function directoryTransfer(
  store: Store,
  c: MutationContext,
  kind: ConfigurationKind,
  target: string,
  key: string,
  domain: string,
) {
  const resource = kind.replace(/^directory-/, ''),
    service = new DirectoryMetadata(store);
  if (
    !kind.startsWith('directory-') ||
    !metadataResources.some((r) => r === resource) ||
    target !== 'current' ||
    c.appCode !== 'aio-foundation'
  )
    throw new ConfigurationTransferError('CONFIGURATION_KIND_INVALID');
  return new ConfigurationTransfer(kind, target, key, domain, {
    async read() {
      const actor = await store.principal(c.identity, c.appCode),
        state = await service.configuration(actor, c.tenantId, resource),
        row = state.configuration;
      if (!row) throw new ConfigurationTransferError('CONFIGURATION_SAVE_FIRST', 409);
      return {
        tenantId: c.tenantId,
        accountId: actor.accountId,
        personId: actor.personId,
        revision: Number(row.revision),
        label: String((row.draft as any).schema.title),
        content: row.draft,
        metadata: { resource },
      };
    },
    normalize: (value) => parseDirectoryConfiguration(value, resource),
    options: async () => emptyReferenceOptions(),
    async validate(value) {
      const config = parseDirectoryConfiguration(value, resource),
        rows = (
          await store.pool.query(
            'SELECT configuration FROM directory_schema_versions WHERE tenant_id=$1 AND resource=$2',
            [c.tenantId, resource],
          )
        ).rows;
      for (const row of rows)
        if (
          schemaFields(config.schema).some((f) =>
            schemaFields(row.configuration.schema).some(
              (old) => old.id === f.id && old.type !== f.type,
            ),
          )
        )
          throw new HttpError(400, 'PROFILE_FIELD_TYPE_IMMUTABLE');
    },
    write: (review) => service.saveConfiguration(c, resource, review.content, review.revision),
  });
}
