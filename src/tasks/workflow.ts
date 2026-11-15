import { HttpError } from '../security.js';
import { taskStagePattern, taskStatuses } from './options.js';
import type { TaskWorkflow, ProjectRole } from './options.js';

const stageCode = new RegExp(taskStagePattern);
export const validStageCode = (code: unknown): code is string =>
  typeof code === 'string' && stageCode.test(code) && code !== 'all';
const invalid = () => new HttpError(400, 'TASKS_WORKFLOW_INVALID');

export function validateTaskWorkflow(workflow: TaskWorkflow): TaskWorkflow {
  if (
    !workflow ||
    !Array.isArray(workflow.stages) ||
    workflow.stages.length < 3 ||
    workflow.stages.length > 8 ||
    !Array.isArray(workflow.transitions) ||
    workflow.transitions.length > 56
  )
    throw invalid();
  const stages = workflow.stages.map((stage) => {
    if (
      !stage ||
      !validStageCode(stage.code) ||
      typeof stage.name !== 'string' ||
      !stage.name.trim() ||
      stage.name.length > 60 ||
      !taskStatuses.includes(stage.phase)
    )
      throw invalid();
    return { code: stage.code, name: stage.name.trim(), phase: stage.phase };
  });
  const byCode = new Map(stages.map((stage) => [stage.code, stage]));
  if (
    byCode.size !== stages.length ||
    taskStatuses.some((phase) => byCode.get(phase)?.phase !== phase) ||
    new Set(stages.map(({ name }) => name.toLocaleLowerCase('vi'))).size !== stages.length
  )
    throw invalid();
  const seen = new Set<string>();
  const transitions = workflow.transitions.map((transition) => {
    if (
      !transition ||
      !byCode.has(transition.from) ||
      !byCode.has(transition.to) ||
      transition.from === transition.to ||
      !Array.isArray(transition.roles) ||
      !transition.roles.length ||
      transition.roles.length > 2 ||
      transition.roles.some((role) => role !== 'manager' && role !== 'member') ||
      new Set(transition.roles).size !== transition.roles.length
    )
      throw invalid();
    const key = transition.from + '/' + transition.to;
    if (seen.has(key)) throw invalid();
    seen.add(key);
    return { from: transition.from, to: transition.to, roles: [...transition.roles] };
  });
  return { stages, transitions };
}

export function allowedTaskStages(workflow: TaskWorkflow, from: string, role: ProjectRole) {
  return workflow.transitions
    .filter((edge) => edge.from === from && edge.roles.some((allowed) => allowed === role))
    .map(({ to }) => to);
}
