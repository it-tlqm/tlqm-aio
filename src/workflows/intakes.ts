import { schemaFields } from '../forms/contracts.js';
import type { Answers, FormSchema } from '../forms/contracts.js';
import { HttpError } from '../security.js';

export type IntakeKind = 'hr-onboarding' | 'lms-training';
export type IntakeRuleInput = {
  kind: IntakeKind;
  definitionId: string;
  versionId: string;
  unitId: string;
  recipientAccountId: string;
  mapping: Record<string, string>;
};
export type IntakeRule = {
  id: string;
  tenant_id: string;
  kind: IntakeKind;
  definition_id: string;
  version_id: string;
  org_unit_id: string;
  recipient_account_id: string;
  recipient_person_id: string;
  mapping: Record<string, string>;
  enabled: boolean;
  revision: number;
};
export type IntakeJob = {
  id: string;
  tenant_id: string;
  rule_id: string;
  source_run_id: string;
  source_round: number;
  status: 'queued' | 'retry' | 'done' | 'blocked' | 'skipped';
  attempts: number;
};
export type IntakeReference = {
  id: string;
  kind: IntakeKind;
  tenantId: string;
  unitId: string;
  runId: string;
  versionId: string;
  round: number;
  accountId: string;
  personId: string;
};
export type IntakeProjection = IntakeReference & { title: string; values: Record<string, string> };
export type TrainingIntakeState = 'draft' | 'active' | 'cancelled';
export interface IntakeDestination {
  recipients(
    kind: IntakeKind,
    tenant: string,
    unit: string,
    search: string,
  ): Promise<{ id: string; name: string }[]>;
  assertRecipient(
    kind: IntakeKind,
    tenant: string,
    unit: string,
    account: string,
    person: string,
  ): Promise<void>;
  receive(reference: IntakeReference): Promise<void>;
  trainingStatus?(reference: IntakeReference): Promise<TrainingIntakeState>;
}

export function validateIntakeMapping(input: IntakeRuleInput, schema: FormSchema) {
  const types = new Map(schemaFields(schema).map(({ id, type }) => [id, type]));
  const target =
    input.kind === 'hr-onboarding' ? ['displayName', 'employeeCode'] : ['title', 'summary'];
  if (
    Object.entries(input.mapping).some(
      ([key, field]) =>
        !target.includes(key) ||
        (types.get(field) !== 'shortText' &&
          (key !== 'summary' || types.get(field) !== 'longText')),
    )
  )
    throw new HttpError(400, 'WORKFLOW_INTAKE_MAPPING_INVALID');
}

export function projectIntakeValues(
  mapping: IntakeRule['mapping'],
  schema: FormSchema,
  answers: Answers,
) {
  const visible = new Set(schemaFields(schema).map(({ id }) => id));
  const values: Record<string, string> = {};
  for (const [target, field] of Object.entries(mapping)) {
    if (!visible.has(field)) throw new HttpError(403, 'WORKFLOW_INTAKE_FIELD_DENIED');
    const value = answers[field];
    if (typeof value === 'string' && value.trim()) values[target] = value.trim();
  }
  return values;
}
