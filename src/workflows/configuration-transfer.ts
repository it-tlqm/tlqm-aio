import type { WorkflowsService, Definition } from './service.js';
import type { WorkflowCommand } from './access.js';
import { workflowRequire } from './access.js';
import { parseWorkflow, workflowUuid } from './contracts.js';
import { ConfigurationTransfer } from '../configuration-transfer.js';
import { ConfigurationTransferError, emptyReferenceOptions } from '../configuration-package.js';
export type WorkflowConfigurationLookups = {
  units: { id: string; name: string }[];
  accounts: { id: string; name: string; unitIds: string[] }[];
};
export function workflowTransfer(
  service: WorkflowsService,
  c: WorkflowCommand,
  target: string,
  key: string,
  domain: string,
  lookups: () => Promise<WorkflowConfigurationLookups>,
) {
  workflowUuid(target);
  const read = async () => {
    const a = await c.actor(),
      row = (
        await service.pool.query(
          'SELECT * FROM workflow_definitions WHERE tenant_id=$1 AND id=$2',
          [c.tenantId, target],
        )
      ).rows[0] as Definition | undefined;
    if (!row) throw new ConfigurationTransferError('CONFIGURATION_TARGET_NOT_FOUND', 404);
    workflowRequire(a, c.tenantId, 'workflows:design', row.org_unit_id);
    return { actor: a, row };
  };
  return new ConfigurationTransfer('workflow', target, key, domain, {
    trackImport: true,
    async read() {
      const { actor, row } = await read();
      return {
        tenantId: c.tenantId,
        accountId: actor.accountId,
        personId: actor.personId,
        revision: row.revision,
        label: row.name,
        content: row.draft,
        metadata: { code: row.code, unitId: row.org_unit_id },
      };
    },
    normalize: (value) => parseWorkflow(value, false),
    async options() {
      const { row } = await read(),
        refs = await lookups(),
        groups = (await service.groups(c)).items;
      return {
        ...emptyReferenceOptions(),
        unit: refs.units,
        account: refs.accounts
          .filter((a) => a.unitIds.includes(row.org_unit_id))
          .map(({ id, name }) => ({ id, name })),
        group: groups
          .filter((g) => g.active && (g.org_unit_id === null || g.org_unit_id === row.org_unit_id))
          .map((g) => ({ id: g.id, name: g.name })),
      };
    },
    async write(review) {
      const { row } = await read();
      if (review.metadata.code !== row.code || review.metadata.unitId !== row.org_unit_id)
        throw new ConfigurationTransferError('CONFIGURATION_PREVIEW_STALE', 409);
      return service.saveDefinition(
        c,
        { code: row.code, orgUnitId: row.org_unit_id, spec: review.content },
        target,
        review.revision,
        review.importEvidence,
      );
    },
  });
}
