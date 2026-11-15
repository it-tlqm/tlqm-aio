import { learningPolicy, parseLearningPolicy } from './learning-policy.js';
import type { LearningPolicy } from './learning-policy.js';
/** Domain contracts adapted from the LMS question/lesson model. Never compile user content as code. */
import { parseVideoSource } from './video-sources.js';
import type { VideoSource } from './video-sources.js';
export type { VideoSource } from './video-sources.js';
export type QuestionType = 'single' | 'multiple' | 'text';
export type Answer = number | number[] | string;
export type Question = { id: string; type: QuestionType; question: string; options: string[] };
export type Checkpoint = Question & { time: number; title: string };
export type AnswerKey = { answer: Answer; explanation: string };
export type CourseSpec = {
  schemaVersion: 1 | 2 | 3;
  policy?: LearningPolicy;
  title: string;
  subtitle: string;
  series: string;
  duration: number;
  video: VideoSource | null;
  deadline: string;
  isMandatory: boolean;
  audienceUnits: string[];
  checkpoints: Checkpoint[];
  questions: Question[];
  answerKey: Record<string, AnswerKey>;
  attachments: { id: string; title: string; mediaId: string }[];
};
export type PublicCourseSpec = Omit<CourseSpec, 'answerKey'>;
export type AssessmentReview = {
  id: string;
  type: QuestionType;
  question: string;
  options: string[];
  selected: Answer;
  correct: boolean;
  correctAnswer: Answer;
  explanation: string;
};
export type AssessmentSnapshot = {
  schemaVersion: 1;
  policy?: LearningPolicy;
  lessonTitle: string;
  series: string;
  version: number;
  checksum: string;
  score: number;
  passed: boolean;
  review: AssessmentReview[];
  tabSwitchCount: number;
  tracking?: 'self-confirmed' | 'player-reported';
};
export class CourseValidationError extends Error {
  readonly status = 400;
  readonly code = 'LMS_INVALID_COURSE';
  constructor(readonly issues: { path: string; code: string }[]) {
    super('LMS_INVALID_COURSE');
  }
}
const idPattern = /^[A-Za-z0-9_-]{1,80}$/;
const unitPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function record(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
export function parseCourse(value: unknown, publish = false): CourseSpec {
  const issues: { path: string; code: string }[] = [];
  const issue = (path: string, code: string) => {
    issues.push({ path, code });
  };
  const text = (value: unknown, path: string, max: number, required = false) => {
    if (typeof value !== 'string' || value.length > max || (required && !value.trim())) {
      issue(path, 'TEXT_INVALID');
      return '';
    }
    return value.trim();
  };
  if (!record(value)) throw new CourseValidationError([{ path: '', code: 'OBJECT_REQUIRED' }]);
  if (typeof value.schemaVersion !== 'number' || ![1, 2, 3].includes(value.schemaVersion))
    issue('schemaVersion', 'VERSION_UNSUPPORTED');
  const title = text(value.title, 'title', 150, true),
    subtitle = text(value.subtitle, 'subtitle', 500),
    series = text(value.series, 'series', 100, true);
  const duration =
    typeof value.duration === 'number' && Number.isFinite(value.duration) ? value.duration : -1;
  if (duration < 0 || duration > 86400 || (publish && duration <= 0))
    issue('duration', 'DURATION_INVALID');
  const deadline = text(value.deadline, 'deadline', 10);
  if (
    deadline &&
    (!/^\d{4}-\d{2}-\d{2}$/.test(deadline) ||
      Number.isNaN(Date.parse(deadline)) ||
      new Date(deadline).toISOString().slice(0, 10) !== deadline)
  )
    issue('deadline', 'DATE_INVALID');
  if (typeof value.isMandatory !== 'boolean') issue('isMandatory', 'BOOLEAN_REQUIRED');
  let video: VideoSource | null = null;
  try {
    video = parseVideoSource(value.video, Number(value.schemaVersion));
  } catch {
    issue('video', 'VIDEO_INVALID');
  }
  if (publish && !video) issue('video', 'VIDEO_REQUIRED');
  let audienceUnits: string[] = [];
  if (
    !Array.isArray(value.audienceUnits) ||
    value.audienceUnits.length > 200 ||
    !value.audienceUnits.every((unit) => typeof unit === 'string' && unitPattern.test(unit))
  )
    issue('audienceUnits', 'UNITS_INVALID');
  else audienceUnits = [...new Set(value.audienceUnits as string[])];
  if (publish && !audienceUnits.length) issue('audienceUnits', 'AUDIENCE_REQUIRED');
  const ids = new Set<string>();
  const parseQuestions = (input: unknown, checkpoint: boolean): (Question | Checkpoint)[] => {
    const path = checkpoint ? 'checkpoints' : 'questions';
    if (!Array.isArray(input) || input.length > (checkpoint ? 30 : 100)) {
      issue(path, 'QUESTION_LIMIT');
      return [];
    }
    return input.flatMap((raw, index) => {
      const at = `${path}.${index}`;
      if (!record(raw)) {
        issue(at, 'QUESTION_INVALID');
        return [];
      }
      const id = text(raw.id, at + '.id', 80, true),
        type = raw.type as QuestionType;
      if (
        !idPattern.test(id) ||
        ids.has(id) ||
        ['__proto__', 'constructor', 'prototype'].includes(id)
      )
        issue(at + '.id', 'QUESTION_ID_INVALID');
      ids.add(id);
      if (!['single', 'multiple', 'text'].includes(type))
        issue(at + '.type', 'QUESTION_TYPE_INVALID');
      const question = text(raw.question, at + '.question', 2000, true);
      const options =
        Array.isArray(raw.options) && raw.options.length <= 12
          ? raw.options.map((option, i) => text(option, at + '.options.' + i, 500, true))
          : [];
      if (!Array.isArray(raw.options)) issue(at + '.options', 'OPTIONS_INVALID');
      if (
        (type === 'text' && options.length) ||
        (type !== 'text' && (options.length < 2 || new Set(options).size !== options.length))
      )
        issue(at + '.options', 'OPTIONS_INVALID');
      const q: Question = { id, type, question, options };
      if (!checkpoint) return [q];
      const time = typeof raw.time === 'number' && Number.isFinite(raw.time) ? raw.time : -1;
      if (time < 0 || time > duration) issue(at + '.time', 'CHECKPOINT_TIME_INVALID');
      return [{ ...q, time, title: text(raw.title, at + '.title', 150, true) }];
    });
  };
  const checkpoints = parseQuestions(value.checkpoints, true) as Checkpoint[];
  const questions = parseQuestions(value.questions, false) as Question[];
  if (checkpoints.some((q, i) => i > 0 && q.time <= checkpoints[i - 1]!.time))
    issue('checkpoints', 'CHECKPOINT_ORDER_INVALID');
  if (publish && !questions.length) issue('questions', 'QUIZ_REQUIRED');
  const answerKey: Record<string, AnswerKey> = {};
  if (!record(value.answerKey)) issue('answerKey', 'ANSWER_KEY_INVALID');
  else {
    for (const q of [...checkpoints, ...questions]) {
      const key = Object.hasOwn(value.answerKey, q.id) ? value.answerKey[q.id] : undefined;
      if (!record(key) || !validAnswer(q, key.answer)) {
        issue('answerKey.' + q.id, 'ANSWER_INVALID');
        continue;
      }
      answerKey[q.id] = {
        answer: key.answer,
        explanation: text(key.explanation, 'answerKey.' + q.id + '.explanation', 2000),
      };
    }
    if (Object.keys(value.answerKey).some((id) => !ids.has(id)))
      issue('answerKey', 'UNKNOWN_QUESTION');
  }
  let attachments: CourseSpec['attachments'] = [];
  if (!Array.isArray(value.attachments) || value.attachments.length > 20)
    issue('attachments', 'ATTACHMENT_LIMIT');
  else
    attachments = value.attachments.flatMap((item, index) => {
      const at = 'attachments.' + index;
      if (
        !record(item) ||
        typeof item.id !== 'string' ||
        !idPattern.test(item.id) ||
        typeof item.mediaId !== 'string' ||
        !/^[0-9a-f-]{36}$/.test(item.mediaId)
      ) {
        issue(at, 'ATTACHMENT_INVALID');
        return [];
      }
      return [
        { id: item.id, title: text(item.title, at + '.title', 150, true), mediaId: item.mediaId },
      ];
    });
  if (new Set(attachments.map((a) => a.id)).size !== attachments.length)
    issue('attachments', 'ATTACHMENT_ID_DUPLICATE');
  let policy: LearningPolicy | undefined;
  if (value.policy !== undefined) {
    if (value.schemaVersion !== 3) issue('policy', 'POLICY_VERSION_REQUIRED');
    try {
      policy = parseLearningPolicy(value.policy);
    } catch {
      issue('policy', 'POLICY_INVALID');
    }
  }
  if (issues.length) throw new CourseValidationError(issues);
  return {
    schemaVersion: value.schemaVersion as 1 | 2 | 3,
    ...(policy ? { policy } : {}),
    title,
    subtitle,
    series,
    duration,
    video,
    deadline,
    isMandatory: value.isMandatory as boolean,
    audienceUnits,
    checkpoints,
    questions,
    answerKey,
    attachments,
  };
}
export function validAnswer(question: Question, value: unknown): value is Answer {
  if (question.type === 'text')
    return typeof value === 'string' && value.trim().length > 0 && value.length <= 2000;
  if (question.type === 'multiple')
    return (
      Array.isArray(value) &&
      value.length > 0 &&
      value.length <= question.options.length &&
      new Set(value).size === value.length &&
      value.every((v) => Number.isInteger(v) && v >= 0 && v < question.options.length)
    );
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) < question.options.length;
}
export function checkAnswer(question: Question, key: AnswerKey, value: Answer) {
  if (!validAnswer(question, value) || !validAnswer(question, key.answer))
    throw new CourseValidationError([{ path: question.id, code: 'ANSWER_INVALID' }]);
  const normalize = (value: string) =>
    value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('vi-VN');
  const correct =
    question.type === 'text'
      ? normalize(value as string) === normalize(key.answer as string)
      : question.type === 'multiple'
        ? JSON.stringify([...(value as number[])].sort((a, b) => a - b)) ===
          JSON.stringify([...(key.answer as number[])].sort((a, b) => a - b))
        : value === key.answer;
  return { correct, correctAnswer: key.answer, explanation: key.explanation };
}
export function gradeCourse(spec: CourseSpec, answers: unknown) {
  if (
    !record(answers) ||
    !spec.questions.length ||
    Object.keys(answers).some((id) => !spec.questions.some((q) => q.id === id))
  )
    throw new CourseValidationError([{ path: 'answers', code: 'ANSWERS_INVALID' }]);
  const review: AssessmentReview[] = spec.questions.map((q) => {
    const selected = Object.hasOwn(answers, q.id) ? answers[q.id] : undefined;
    if (!validAnswer(q, selected) || !spec.answerKey[q.id])
      throw new CourseValidationError([{ path: 'answers.' + q.id, code: 'ANSWER_REQUIRED' }]);
    return { ...q, selected, ...checkAnswer(q, spec.answerKey[q.id]!, selected) };
  });
  const score = Math.round((review.filter((q) => q.correct).length / spec.questions.length) * 100);
  return { score, passed: score >= learningPolicy(spec).passScore, review };
}
export function publicCourse(spec: CourseSpec): PublicCourseSpec {
  const { answerKey: _, ...content } = spec;
  return content;
}
