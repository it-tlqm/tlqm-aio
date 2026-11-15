import { LmsError } from './security.js';
export type TrainingPathSpec = {
  schemaVersion: 1;
  title: string;
  description: string;
  courseVersionIds: string[];
  audienceUnits: string[];
};
export function trainingIds(value: unknown, max = 50): string[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > max ||
    value.some(
      (v) =>
        typeof v !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v),
    ) ||
    new Set(value).size !== value.length
  )
    throw new LmsError(400, 'LMS_TRAINING_INVALID');
  return [...value] as string[];
}
export function parseTrainingPath(value: unknown, publish = false): TrainingPathSpec {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new LmsError(400, 'LMS_TRAINING_INVALID');
  const s = value as TrainingPathSpec;
  if (
    s.schemaVersion !== 1 ||
    Object.keys(s).some(
      (k) =>
        !['schemaVersion', 'title', 'description', 'courseVersionIds', 'audienceUnits'].includes(k),
    ) ||
    typeof s.title !== 'string' ||
    !s.title.trim() ||
    s.title.length > 150 ||
    typeof s.description !== 'string' ||
    s.description.length > 2000
  )
    throw new LmsError(400, 'LMS_TRAINING_INVALID');
  return {
    schemaVersion: 1,
    title: s.title.trim(),
    description: s.description.trim(),
    courseVersionIds:
      !publish && Array.isArray(s.courseVersionIds) && !s.courseVersionIds.length
        ? []
        : trainingIds(s.courseVersionIds),
    audienceUnits:
      !publish && Array.isArray(s.audienceUnits) && !s.audienceUnits.length
        ? []
        : trainingIds(s.audienceUnits, 200),
  };
}
export function trainingSchedule(value: { title: string; startsAt: number; dueAt: number }) {
  if (
    typeof value.title !== 'string' ||
    !value.title.trim() ||
    value.title.length > 150 ||
    !Number.isSafeInteger(value.startsAt) ||
    !Number.isSafeInteger(value.dueAt) ||
    value.startsAt < 0 ||
    value.dueAt <= value.startsAt ||
    value.dueAt > 253402300799999
  )
    throw new LmsError(400, 'LMS_TRAINING_INVALID');
  return { ...value, title: value.title.trim() };
}
