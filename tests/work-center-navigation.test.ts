import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rememberLoginTarget, takeLoginTarget } from '../frontend/src/lib/login-target.js';
import { parseTaskTarget, taskTarget } from '../frontend/src/lib/task-target.js';
import {
  formTarget,
  formsListRoute,
  formsDetailRoute,
  parseFormTarget,
  parseFormsDetailRoute,
  parseFormsListRoute,
} from '../frontend/src/lib/form-target.js';
import { parsePeopleRoute, peopleRoute } from '../frontend/src/lib/directory-route.js';
import {
  parseWorkCenterRoute,
  updateWorkCenterRoute,
} from '../frontend/src/lib/work-center-route.js';
test('post-SSO target accepts only bounded local work routes and is consumed once', () => {
  const values = new Map<string, string>(),
    storage = {
      setItem: (k: string, v: string) => {
        values.set(k, v);
      },
      getItem: (k: string) => values.get(k) ?? null,
      removeItem: (k: string) => {
        values.delete(k);
      },
    };
  const route = '#workflow-run/40000000-0000-4000-8000-000000000001';
  rememberLoginTarget(route, storage, 100);
  assert.equal(takeLoginTarget(storage, 200), route);
  assert.equal(takeLoginTarget(storage, 200), null);
  const branch = route + '/40000000-0000-4000-8000-000000000002';
  rememberLoginTarget(branch, storage, 100);
  assert.equal(takeLoginTarget(storage, 200), branch);
  const learning = '#training-batch/40000000-0000-4000-8000-000000000001';
  rememberLoginTarget(learning, storage, 100);
  assert.equal(takeLoginTarget(storage, 200), learning);
  const tenant = '10000000-0000-4000-8000-000000000002';
  const project = '40000000-0000-4000-8000-000000000001';
  const task = '40000000-0000-4000-8000-000000000002';
  const assigned = taskTarget(tenant, project, task);
  const form = formTarget(tenant, project);
  rememberLoginTarget(form, storage, 100);
  assert.equal(takeLoginTarget(storage, 200), form);
  assert.deepEqual(parseFormTarget(form), { tenant, form: project });
  rememberLoginTarget(assigned, storage, 100);
  assert.equal(takeLoginTarget(storage, 200), assigned);
  assert.deepEqual(parseTaskTarget(assigned), { tenant, project, task });
  assert.deepEqual(parseTaskTarget('#tasks/project/' + project), {
    tenant: null,
    project,
    task: null,
  });
  for (const invalidRoute of [
    'https://evil.invalid',
    '//evil.invalid',
    '#workflow-run/not-an-id',
    route + '/not-an-id',
    branch + '/extra',
    '#training-batch/not-an-id',
    learning + '/40000000-0000-4000-8000-000000000002',
    '#training-batch/40000000-0000-4000-8000-000000000001?url=https://evil.invalid',
    '#work-center?url=https://evil.invalid',
    assigned + '/extra',
    form + '/extra',
    assigned + '?returnUrl=https://evil.invalid',
  ]) {
    rememberLoginTarget(invalidRoute, storage, 100);
    assert.equal(takeLoginTarget(storage, 200), null);
  }
  rememberLoginTarget('#work-center', storage, 100);
  assert.equal(takeLoginTarget(storage, 600101), null);
});

test('work center route restores bounded source, view, filters and page', () => {
  const unit = '10000000-0000-4000-8000-000000000002';
  const assignee = '40000000-0000-4000-8000-000000000001';
  const hash = updateWorkCenterRoute('#work-center', {
    source: 'aio-workflows',
    tab: 'managed',
    page: 3,
    search: '  hồ sơ mua sắm  ',
    unit,
    assignee,
    unread: true,
  });
  assert.deepEqual(parseWorkCenterRoute(hash), {
    source: 'aio-workflows',
    tab: 'managed',
    page: 3,
    search: 'hồ sơ mua sắm',
    unit,
    assignee,
    unread: true,
    taskTab: 'assigned',
    taskSearch: '',
    formSearch: '',
    trainingView: 'work',
    trainingSearch: '',
    trainingPage: 0,
  });
});

test('work center route rejects unbounded query values and clears filters', () => {
  const parsed = parseWorkCenterRoute(
    '#work-center?tab=unknown&page=-1&unit=bad&assignee=https%3A%2F%2Fevil.invalid&search=x&unread=yes',
  );
  assert.deepEqual(parsed, {
    source: '',
    tab: 'assigned',
    page: 0,
    search: 'x',
    unit: '',
    assignee: '',
    unread: false,
    taskTab: 'assigned',
    taskSearch: '',
    formSearch: '',
    trainingView: 'work',
    trainingSearch: '',
    trainingPage: 0,
  });
  assert.equal(
    updateWorkCenterRoute('#work-center?tab=managed&page=2&search=old', {
      tab: 'assigned',
      page: 0,
      search: '',
      unread: false,
    }),
    '#work-center?tab=assigned',
  );
});

test('work center route keeps source-specific module state', () => {
  const hash = updateWorkCenterRoute('#work-center?source=aio-tasks', {
    taskTab: 'reminders',
    taskSearch: 'dự án',
    formSearch: 'khảo sát',
    trainingView: 'notices',
    trainingSearch: 'an toàn',
    trainingPage: 2,
  });
  assert.deepEqual(parseWorkCenterRoute(hash), {
    source: 'aio-tasks',
    tab: 'assigned',
    page: 0,
    search: '',
    unit: '',
    assignee: '',
    unread: false,
    taskTab: 'reminders',
    taskSearch: 'dự án',
    formSearch: 'khảo sát',
    trainingView: 'notices',
    trainingSearch: 'an toàn',
    trainingPage: 2,
  });
});

test('Forms list route restores bounded search and rejects unrelated query keys', () => {
  const route = formsListRoute('  khảo sát quý  ');
  assert.deepEqual(parseFormsListRoute(route), { search: 'khảo sát quý' });
  assert.deepEqual(parseFormsListRoute('#forms'), { search: '' });
  assert.equal(parseFormsListRoute('#forms?url=https%3A%2F%2Fevil.invalid'), null);
  assert.equal(parseFormsListRoute('#forms?search=' + 'x'.repeat(121)), null);
});

test('Forms detail route restores an authorized tab and rejects unsafe query values', () => {
  const form = '40000000-0000-4000-8000-000000000001';
  assert.deepEqual(parseFormsDetailRoute(formsDetailRoute(form, 'analyze')), {
    form,
    tab: 'analyze',
  });
  assert.deepEqual(parseFormsDetailRoute('#forms/' + form), { form, tab: null });
  assert.equal(parseFormsDetailRoute('#forms/' + form + '?url=https%3A%2F%2Fevil.invalid'), null);
  assert.equal(parseFormsDetailRoute('#forms/' + form + '?tab=unknown'), null);
});

test('people directory route restores bounded search, unit, state and page', () => {
  const unit = '10000000-0000-4000-8000-000000000002';
  const route = peopleRoute({
    tab: 'overview',
    query: ' Nguyễn ',
    unit,
    state: 'inactive',
    page: 2,
  });
  assert.deepEqual(parsePeopleRoute(route), {
    tab: 'overview',
    query: 'Nguyễn',
    unit,
    state: 'inactive',
    page: 2,
  });
  assert.equal(parsePeopleRoute('#people?url=https%3A%2F%2Fevil.invalid'), null);
  assert.equal(parsePeopleRoute('#people?state=unknown'), null);
});
