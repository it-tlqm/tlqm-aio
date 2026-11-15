import { FormValidationError, parseAnswers, schemaFields } from '../forms/contracts.js';
import type { Answers, FormSchema } from '../forms/contracts.js';
import { isReferenceAnswer } from '../forms/references.js';
import { HttpError } from '../security.js';
import { workflowAllowed } from './access.js';
import type { WorkflowActor, WorkflowDirectory, WorkflowReferenceQuery } from './access.js';
import { workflowUuid } from './contracts.js';

export function referenceScope(actor: WorkflowActor, tenant: string, unit: string) {
  if (
    !workflowAllowed(actor, tenant, 'workflows:act', unit) &&
    !(
      workflowAllowed(actor, tenant, 'workflows:start', unit) &&
      actor.units.some((u) => u.tenantId === tenant && u.orgUnitId === unit)
    )
  )
    throw new HttpError(403, 'WORKFLOW_PERMISSION_DENIED');
}
export async function referenceOptions(
  directory: WorkflowDirectory,
  actor: WorkflowActor,
  tenant: string,
  query: WorkflowReferenceQuery,
) {
  workflowUuid(query.unitId);
  if (query.id) workflowUuid(query.id);
  if (query.after) workflowUuid(query.after);
  if (
    !['person', 'orgUnit'].includes(query.kind) ||
    typeof (query.search ?? '') !== 'string' ||
    (query.search?.length ?? 0) > 100
  )
    throw new HttpError(400, 'INVALID_REQUEST');
  referenceScope(actor, tenant, query.unitId);
  if (!directory.references) throw new HttpError(503, 'WORKFLOW_DIRECTORY_UNAVAILABLE');
  return directory.references(tenant, actor, query);
}
/** Replace all client labels, including drafts, with current Foundation-owned labels. */
export async function workflowAnswers(
  directory: WorkflowDirectory,
  actor: WorkflowActor,
  tenant: string,
  unit: string,
  schema: FormSchema,
  value: unknown,
  mode: 'draft' | 'submit',
): Promise<Answers> {
  const answers = parseAnswers(schema, value, mode);
  for (const field of schemaFields(schema)) {
    if (field.type !== 'person' && field.type !== 'orgUnit') continue;
    const selected = answers[field.id];
    if (!isReferenceAnswer(selected)) continue;
    const result = await referenceOptions(directory, actor, tenant, {
      kind: field.type,
      unitId: unit,
      id: selected.id,
    });
    const item = result.items.find((item) => item.id === selected.id);
    if (!item || !isReferenceAnswer(item))
      throw new FormValidationError([
        { path: 'answers.' + field.id, code: 'REFERENCE_UNAVAILABLE' },
      ]);
    answers[field.id] = { id: item.id, label: item.label };
  }
  return answers;
}
