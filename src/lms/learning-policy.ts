import { checkAnswer } from './course-contracts.js';
import type { CourseSpec, Answer, PublicCourseSpec } from './course-contracts.js';
export type LearningPolicy = {
  passScore: number;
  maxAttempts: number;
  cooldownMinutes: number;
  requireVideoCompletion: boolean;
  checkpointPolicy: 'answered' | 'correct' | 'none';
  prerequisiteVersionIds: string[];
};
export const defaultLearningPolicy: LearningPolicy = {
  passScore: 80,
  maxAttempts: 0,
  cooldownMinutes: 0,
  requireVideoCompletion: true,
  checkpointPolicy: 'answered',
  prerequisiteVersionIds: [],
};
export function learningPolicy(spec: Pick<PublicCourseSpec, 'policy'>): LearningPolicy {
  return spec.policy ?? structuredClone(defaultLearningPolicy);
}
export function parseLearningPolicy(value: unknown): LearningPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('LMS_POLICY_INVALID');
  const p = value as LearningPolicy;
  if (
    Object.keys(p).some((k) => !Object.keys(defaultLearningPolicy).includes(k)) ||
    !Number.isInteger(p.passScore) ||
    p.passScore < 1 ||
    p.passScore > 100 ||
    !Number.isInteger(p.maxAttempts) ||
    p.maxAttempts < 0 ||
    p.maxAttempts > 100 ||
    !Number.isInteger(p.cooldownMinutes) ||
    p.cooldownMinutes < 0 ||
    p.cooldownMinutes > 10080 ||
    typeof p.requireVideoCompletion !== 'boolean' ||
    !['answered', 'correct', 'none'].includes(p.checkpointPolicy) ||
    !Array.isArray(p.prerequisiteVersionIds) ||
    p.prerequisiteVersionIds.length > 20 ||
    p.prerequisiteVersionIds.some(
      (id) =>
        typeof id !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id),
    ) ||
    new Set(p.prerequisiteVersionIds).size !== p.prerequisiteVersionIds.length
  )
    throw new Error('LMS_POLICY_INVALID');
  return { ...p, prerequisiteVersionIds: [...p.prerequisiteVersionIds] };
}
export function completedCheckpoints(spec: CourseSpec, answers: Record<string, Answer>) {
  const policy = learningPolicy(spec);
  return spec.checkpoints
    .filter(
      (q) =>
        policy.checkpointPolicy === 'none' ||
        (Object.hasOwn(answers, q.id) &&
          (policy.checkpointPolicy === 'answered' ||
            checkAnswer(q, spec.answerKey[q.id]!, answers[q.id]!).correct)),
    )
    .map((q) => q.id);
}
export function assessmentWindow(policy: LearningPolicy, count: number, last: number | null) {
  return {
    count,
    remaining: policy.maxAttempts ? Math.max(0, policy.maxAttempts - count) : null,
    nextAllowedAt:
      last !== null && policy.cooldownMinutes > 0 ? last + policy.cooldownMinutes * 60000 : null,
  };
}
