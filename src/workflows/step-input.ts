import { fieldConditions, schemaFields } from '../forms/contracts.js';
import type { Answers, FormSchema } from '../forms/contracts.js';
import type { HumanStep } from './contracts.js';

export const stepInputModes = ['read', 'edit', 'required'] as const;
export type StepInputMode = (typeof stepInputModes)[number];
export const stepInputPrefix = 'input.';

export function stepInputCandidates(input: FormSchema) {
  return schemaFields(input).filter((field) => !fieldConditions(field).length);
}

export function stepReadbackSchema(input: FormSchema, step: HumanStep): FormSchema | null {
  const fields = stepInputCandidates(input).filter(
    (field) => step.inputFields?.[field.id] === 'read',
  );
  if (!fields.length) return null;
  return {
    ...input,
    sections: [{ id: 'step-input', title: 'Thông tin từ đề nghị', fields }],
  };
}

export function stepActionForm(input: FormSchema, step: HumanStep): FormSchema | null {
  if (!step.inputFields) return step.form;
  const fields = stepInputCandidates(input).flatMap((field) => {
    const mode = step.inputFields?.[field.id];
    return mode === 'edit' || mode === 'required'
      ? [{ ...field, id: stepInputPrefix + field.id, required: mode === 'required' }]
      : [];
  });
  if (!fields.length) return step.form;
  return {
    title: step.form?.title ?? step.label,
    schemaVersion: input.schemaVersion === 2 || step.form?.schemaVersion === 2 ? 2 : 1,
    sections: [
      { id: 'input.step', title: 'Thông tin đề nghị tại bước này', fields },
      ...(step.form?.sections ?? []),
    ],
  };
}

export function initialStepAnswers(step: HumanStep, inputs: Answers): Answers {
  return Object.fromEntries(
    Object.entries(inputs)
      .filter(([id]) => {
        const mode = step.inputFields?.[id];
        return mode === 'edit' || mode === 'required';
      })
      .map(([id, answer]) => [stepInputPrefix + id, answer]),
  );
}
