import { schemaFields } from '../forms/contracts.js';
import type { Answers, Scalar } from '../forms/contracts.js';
import { HttpError } from '../security.js';
import { workflowUuid } from './contracts.js';
import type { WorkflowSpec } from './contracts.js';
import { mayReadField } from './field-access.js';
import type { FieldAudience } from './field-access.js';

type LinkFieldOrigin = 'input' | 'step';
export type WorkflowLinkInput = {
  sourceDefinitionId: string;
  sourceVersionId: string;
  targetDefinitionId: string;
  targetVersionId: string;
  unitId: string;
  name: string;
  mapping: { from: string; to: string; origin?: LinkFieldOrigin }[];
  predicate?: { fieldId: string; equals: Scalar; origin?: LinkFieldOrigin };
  recipientAccountId?: string;
  sourceStepId?: string;
  recipientIsStepActor?: boolean;
};
export type WorkflowLinkRule = {
  id: string;
  tenant_id: string;
  org_unit_id: string;
  source_definition_id: string;
  source_version_id: string;
  target_definition_id: string;
  target_version_id: string;
  name: string;
  mapping: WorkflowLinkInput['mapping'];
  predicate: WorkflowLinkInput['predicate'] | null;
  recipient_account_id: string | null;
  recipient_person_id: string | null;
  source_step_id: string | null;
  recipient_is_step_actor: boolean;
  enabled: boolean;
  revision: number;
};
export type WorkflowLinkJob = {
  id: string;
  tenant_id: string;
  rule_id: string;
  source_run_id: string;
  source_round: number;
  source_task_id: string | null;
  attempts: number;
  status: 'queued' | 'retry' | 'done' | 'blocked' | 'skipped';
  error_code: string | null;
  target_request_id: string | null;
};

export function validateLinkInput(input: WorkflowLinkInput) {
  for (const id of [
    input.sourceDefinitionId,
    input.sourceVersionId,
    input.targetDefinitionId,
    input.targetVersionId,
    input.unitId,
  ])
    workflowUuid(id);
  if (input.recipientAccountId !== undefined) workflowUuid(input.recipientAccountId);
  if (
    (input.sourceStepId !== undefined &&
      (typeof input.sourceStepId !== 'string' ||
        !input.sourceStepId ||
        input.sourceStepId.length > 64)) ||
    (input.recipientIsStepActor !== undefined && typeof input.recipientIsStepActor !== 'boolean') ||
    (input.recipientIsStepActor && (!input.sourceStepId || input.recipientAccountId)) ||
    input.sourceDefinitionId.toLowerCase() === input.targetDefinitionId.toLowerCase() ||
    typeof input.name !== 'string' ||
    !input.name.trim() ||
    input.name.length > 120 ||
    !Array.isArray(input.mapping) ||
    input.mapping.length > 50 ||
    input.mapping.some(
      (pair) =>
        !pair ||
        typeof pair.from !== 'string' ||
        typeof pair.to !== 'string' ||
        (pair.origin !== undefined && !['input', 'step'].includes(pair.origin)),
    ) ||
    new Set(input.mapping.map(({ to }) => to)).size !== input.mapping.length
  )
    throw new HttpError(400, 'WORKFLOW_LINK_INVALID');
  if (
    input.predicate !== undefined &&
    (!input.predicate ||
      typeof input.predicate.fieldId !== 'string' ||
      (input.predicate.origin !== undefined &&
        !['input', 'step'].includes(input.predicate.origin)) ||
      !['string', 'number', 'boolean'].includes(typeof input.predicate.equals) ||
      (typeof input.predicate.equals === 'string' && input.predicate.equals.length > 1000) ||
      (typeof input.predicate.equals === 'number' && !Number.isFinite(input.predicate.equals)))
  )
    throw new HttpError(400, 'WORKFLOW_LINK_INVALID');
}

export function validateLinkFields(
  source: WorkflowSpec,
  target: WorkflowSpec,
  input: WorkflowLinkInput,
) {
  const fields = (spec: WorkflowSpec) =>
    new Map(schemaFields(spec.input).map((field) => [field.id, field]));
  const from = fields(source),
    to = fields(target);
  const step = source.nodes.find((node) => node.id === input.sourceStepId);
  if (input.sourceStepId && (!step || (step.kind !== 'task' && step.kind !== 'approval')))
    throw new HttpError(400, 'WORKFLOW_LINK_STEP_INVALID');
  const stepFields = new Map(
    step && 'form' in step && step.form
      ? schemaFields(step.form).map((field) => [field.id, field])
      : [],
  );
  const sourceField = (id: string, origin?: LinkFieldOrigin) =>
    (origin === 'step' ? stepFields : from).get(id);
  for (const pair of input.mapping) {
    const a = sourceField(pair.from, pair.origin),
      b = to.get(pair.to);
    if (!a || !b || a.type !== b.type || a.type === 'attachment' || a.currency !== b.currency)
      throw new HttpError(400, 'WORKFLOW_LINK_MAPPING_INVALID');
  }
  if (input.predicate) {
    const field = sourceField(input.predicate.fieldId, input.predicate.origin);
    if (
      !field ||
      ['attachment', 'table', 'multipleChoice', 'person', 'orgUnit'].includes(field.type)
    )
      throw new HttpError(400, 'WORKFLOW_LINK_CONDITION_INVALID');
  }
}

export function linkSourceFields(rule: WorkflowLinkRule) {
  const fields = rule.mapping.map(({ from, origin }) => ({
    id: from,
    scope: origin === 'step' ? rule.source_step_id! : 'input',
  }));
  if (rule.predicate)
    fields.push({
      id: rule.predicate.fieldId,
      scope: rule.predicate.origin === 'step' ? rule.source_step_id! : 'input',
    });
  return fields;
}

export function requireLinkFields(rule: WorkflowLinkRule, spec: WorkflowSpec, who: FieldAudience) {
  if (linkSourceFields(rule).some(({ id, scope }) => !mayReadField(spec, scope, id, who)))
    throw new HttpError(403, 'WORKFLOW_LINK_FIELD_DENIED');
}

export function linkedAnswers(
  rule: WorkflowLinkRule,
  spec: WorkflowSpec,
  answers: Answers,
  who: FieldAudience,
  stepAnswers: Answers = {},
) {
  requireLinkFields(rule, spec, who);
  const values = (origin?: LinkFieldOrigin) => (origin === 'step' ? stepAnswers : answers);
  if (
    rule.predicate &&
    values(rule.predicate.origin)[rule.predicate.fieldId] !== rule.predicate.equals
  )
    return null;
  return Object.fromEntries(
    rule.mapping
      .filter(({ from, origin }) => Object.hasOwn(values(origin), from))
      .map(({ from, to, origin }) => [to, values(origin)[from]!]),
  );
}
