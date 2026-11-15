import type { Answers, FormSchema } from '../forms/contracts.js';
import { conditionRules, fieldConditions } from '../forms/contracts.js';
import type { WorkflowNode, WorkflowSpec } from './contracts.js';
import { stepInputPrefix } from './step-input.js';
export type FieldReaders = Record<string, string[]>;
export type FieldAudience = { owner: boolean; manager: boolean; steps: Set<string> };
export class FieldAccessError extends Error {
  readonly code = 'WORKFLOW_FIELD_POLICY_INVALID';
}
export function parseFieldReaders(
  value: unknown,
  input: FormSchema,
  nodes: WorkflowNode[],
): FieldReaders {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new FieldAccessError();
  const schemas = [
    { id: 'input', schema: input },
    ...nodes
      .filter((n) => 'form' in n && n.form)
      .map((n) => ({ id: n.id, schema: ('form' in n ? n.form : null)! })),
  ];
  const addresses = new Set(
    schemas.flatMap((s) =>
      s.schema.sections.flatMap((section) => section.fields.map((f) => s.id + '.' + f.id)),
    ),
  );
  const audience = new Set([
    'owner',
    'manager',
    ...nodes.filter((n) => n.kind === 'task' || n.kind === 'approval').map((n) => n.id),
  ]);
  const result: FieldReaders = {};
  if (Object.keys(value).length > 200) throw new FieldAccessError();
  for (const [address, readers] of Object.entries(value)) {
    if (
      !addresses.has(address) ||
      !Array.isArray(readers) ||
      readers.length > audience.size ||
      new Set(readers).size !== readers.length ||
      readers.some((r) => typeof r !== 'string' || !audience.has(r))
    )
      throw new FieldAccessError();
    result[address] = [...readers].sort();
  }
  // A displayed conditional field must not reveal a hidden field through its state.
  for (const { id, schema } of schemas)
    for (const section of schema.sections)
      for (const field of section.fields) {
        const target = result[id + '.' + field.id];
        for (const condition of fieldConditions(field))
          for (const rule of conditionRules(condition)) {
            const source = result[id + '.' + rule.fieldId];
            if (source && (!target || target.some((r) => !source.includes(r))))
              throw new FieldAccessError();
          }
      }
  return result;
}
export function mayReadField(
  spec: WorkflowSpec,
  origin: string,
  field: string,
  who: FieldAudience,
) {
  const readers = spec.fieldReaders?.[origin + '.' + field];
  if (!readers || (origin === 'input' ? who.owner : who.steps.has(origin))) return true;
  return readers.some((r) =>
    r === 'owner' ? who.owner : r === 'manager' ? who.manager : who.steps.has(r),
  );
}
export function visibleAnswers(
  spec: WorkflowSpec,
  origin: string,
  answers: Answers,
  who: FieldAudience,
): Answers {
  return Object.fromEntries(
    Object.entries(answers).filter(([id]) =>
      origin !== 'input' && id.startsWith(stepInputPrefix)
        ? mayReadField(spec, 'input', id.slice(stepInputPrefix.length), who)
        : mayReadField(spec, origin, id, who),
    ),
  );
}
export function visibleSpec(spec: WorkflowSpec, who: FieldAudience): WorkflowSpec {
  if (!spec.fieldReaders) return spec;
  const schema = (value: FormSchema, origin: string): FormSchema => ({
    ...value,
    sections: value.sections
      .map((s) => ({ ...s, fields: s.fields.filter((f) => mayReadField(spec, origin, f.id, who)) }))
      .filter((s) => s.fields.length),
  });
  return {
    ...spec,
    input: schema(spec.input, 'input'),
    nodes: spec.nodes.map((n) => {
      if (!('form' in n)) return n;
      return {
        ...n,
        form: n.form && schema(n.form, n.id),
        ...(n.inputFields && {
          inputFields: Object.fromEntries(
            Object.entries(n.inputFields).filter(([id]) => mayReadField(spec, 'input', id, who)),
          ),
        }),
      };
    }),
  };
}
