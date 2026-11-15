/** Only source-owned server adapters construct this snapshot; never accepted by public start routes. */
import { HttpError } from '../security.js';
import { workflowUuid } from './contracts.js';
export type WorkflowSource = {
  kind: 'directory-profile';
  id: string;
  proposalId: string;
  subjectPersonId: string;
  subjectName: string;
  checksum: string;
  changes: { label: string; before: string; after: string }[];
};
export function parseWorkflowSource(value: WorkflowSource): WorkflowSource {
  if (
    !value ||
    value.kind !== 'directory-profile' ||
    Object.keys(value).some(
      (k) =>
        ![
          'kind',
          'id',
          'proposalId',
          'subjectPersonId',
          'subjectName',
          'checksum',
          'changes',
        ].includes(k),
    )
  )
    throw new HttpError(400, 'WORKFLOW_SOURCE_INVALID');
  for (const id of [value.id, value.proposalId, value.subjectPersonId]) workflowUuid(id);
  if (
    typeof value.subjectName !== 'string' ||
    !value.subjectName.trim() ||
    value.subjectName.length > 200 ||
    !/^[0-9a-f]{64}$/.test(value.checksum) ||
    !Array.isArray(value.changes) ||
    !value.changes.length ||
    value.changes.length > 200 ||
    value.changes.some(
      (c) =>
        !c ||
        Object.keys(c).some((k) => !['label', 'before', 'after'].includes(k)) ||
        typeof c.label !== 'string' ||
        !c.label.trim() ||
        c.label.length > 200 ||
        typeof c.before !== 'string' ||
        c.before.length > 10000 ||
        typeof c.after !== 'string' ||
        c.after.length > 10000,
    ) ||
    JSON.stringify(value).length > 131072
  )
    throw new HttpError(400, 'WORKFLOW_SOURCE_INVALID');
  return structuredClone(value);
}
