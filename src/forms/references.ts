/** A reference is data, never an account grant or an assignment rule. */
export type ReferenceKind = 'person' | 'orgUnit';
export type ReferenceAnswer = { id: string; label: string };
export function isReferenceAnswer(value: unknown): value is ReferenceAnswer {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
    Object.keys(value).length === 2 &&
    'id' in value &&
    'label' in value &&
    typeof value.id === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.id) &&
    typeof value.label === 'string' &&
    value.label.length <= 240
  );
}
