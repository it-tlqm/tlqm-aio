import { parseCourse, CourseValidationError } from './course-contracts.js';
import type { Question, Checkpoint, AnswerKey, CourseSpec } from './course-contracts.js';
export type QuestionKind = 'quiz' | 'checkpoint';
export type QuestionEntry = { kind: QuestionKind; question: Question | Checkpoint; key: AnswerKey };
export type QuestionPreview = {
  id: string;
  kind: QuestionKind;
  sourceName: string;
  digest: string;
  expiresAt: number;
  items: { row: number; entry: QuestionEntry }[];
  errors: { row: number; column: string; message: string }[];
};
export type BankItem = {
  id: string;
  category: string;
  entry: QuestionEntry;
  revision: number;
  status: 'active' | 'archived';
  updatedAt: number;
};
export function parseQuestionEntry(value: unknown): QuestionEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new CourseValidationError([{ path: 'question', code: 'QUESTION_INVALID' }]);
  const item = value as QuestionEntry;
  if (
    !['quiz', 'checkpoint'].includes(item.kind) ||
    !item.question ||
    typeof item.question !== 'object' ||
    typeof item.question.id !== 'string'
  )
    throw new CourseValidationError([{ path: 'question', code: 'QUESTION_INVALID' }]);
  const spec: CourseSpec = {
    schemaVersion: 1,
    title: 'Question validation',
    subtitle: '',
    series: 'Question validation',
    duration: 86400,
    video: null,
    deadline: '',
    isMandatory: false,
    audienceUnits: [],
    checkpoints: item.kind === 'checkpoint' ? [item.question as Checkpoint] : [],
    questions: item.kind === 'quiz' ? [item.question] : [],
    answerKey: { [item.question.id]: item.key },
    attachments: [],
  };
  const validated = parseCourse(spec);
  return {
    kind: item.kind,
    question: (item.kind === 'quiz' ? validated.questions[0] : validated.checkpoints[0])!,
    key: validated.answerKey[item.question.id]!,
  };
}
export function mergeQuestions(
  spec: CourseSpec,
  entries: QuestionEntry[],
  kind: QuestionKind,
  mode: 'append' | 'replace',
): CourseSpec {
  if (
    !['quiz', 'checkpoint'].includes(kind) ||
    !['append', 'replace'].includes(mode) ||
    !entries.length ||
    entries.some((entry) => entry.kind !== kind)
  )
    throw new CourseValidationError([{ path: 'questions', code: 'IMPORT_KIND_INVALID' }]);
  const next = structuredClone(spec),
    field = kind === 'quiz' ? 'questions' : 'checkpoints';
  if (mode === 'replace') {
    for (const question of next[field]) delete next.answerKey[question.id];
    next[field] = [];
  }
  for (const value of entries) {
    const entry = parseQuestionEntry(value),
      id = 'q-' + crypto.randomUUID();
    if (kind === 'quiz') next.questions.push({ ...entry.question, id });
    else next.checkpoints.push({ ...entry.question, id } as Checkpoint);
    next.answerKey[id] = entry.key;
  }
  // Timeline order is meaningful. Never silently sort, drop duplicates or change keys.
  return parseCourse(next);
}
