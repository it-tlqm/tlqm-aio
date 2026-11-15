export const workCenterTabs = [
  'assigned',
  'requested',
  'returned',
  'overdue',
  'notifications',
  'managed',
  'settings',
] as const;

export type WorkCenterTab = (typeof workCenterTabs)[number];

export type WorkCenterRoute = {
  source: string;
  tab: WorkCenterTab;
  page: number;
  search: string;
  unit: string;
  assignee: string;
  unread: boolean;
  taskTab: 'assigned' | 'reminders';
  taskSearch: string;
  formSearch: string;
  trainingView: 'work' | 'notices';
  trainingSearch: string;
  trainingPage: number;
};

const emptyRoute: WorkCenterRoute = {
  source: '',
  tab: 'assigned',
  page: 0,
  search: '',
  unit: '',
  assignee: '',
  unread: false,
  taskTab: 'assigned',
  taskSearch: '',
  formSearch: '',
  trainingView: 'work',
  trainingSearch: '',
  trainingPage: 0,
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sourceCode = /^[a-z][a-z0-9-]{1,63}$/;

function boundedUuid(value: string | null) {
  return value && uuid.test(value) ? value : '';
}

function boundedSource(value: string | null) {
  return value && sourceCode.test(value) ? value : '';
}

function boundedPage(value: string | null) {
  const page = Number(value);
  return Number.isInteger(page) && page >= 0 && page <= 9999 ? page : 0;
}

export function parseWorkCenterRoute(hash: string): WorkCenterRoute {
  if (!hash.startsWith('#work-center')) return { ...emptyRoute };
  const query = hash.startsWith('#work-center?')
    ? new URLSearchParams(hash.slice('#work-center?'.length))
    : new URLSearchParams();
  const candidateTab = query.get('tab');
  const candidateTaskTab = query.get('taskTab');
  const candidateTrainingView = query.get('trainingView');
  return {
    source: boundedSource(query.get('source')),
    tab: workCenterTabs.includes(candidateTab as WorkCenterTab)
      ? (candidateTab as WorkCenterTab)
      : 'assigned',
    page: boundedPage(query.get('page')),
    search: (query.get('search') ?? '').trim().slice(0, 120),
    unit: boundedUuid(query.get('unit')),
    assignee: boundedUuid(query.get('assignee')),
    unread: query.get('unread') === '1',
    taskTab: candidateTaskTab === 'reminders' ? 'reminders' : 'assigned',
    taskSearch: (query.get('taskSearch') ?? '').trim().slice(0, 120),
    formSearch: (query.get('formSearch') ?? '').trim().slice(0, 120),
    trainingView: candidateTrainingView === 'notices' ? 'notices' : 'work',
    trainingSearch: (query.get('trainingSearch') ?? '').trim().slice(0, 120),
    trainingPage: boundedPage(query.get('trainingPage')),
  };
}

export function updateWorkCenterRoute(
  hash: string,
  patch: Partial<Record<keyof WorkCenterRoute, string | number | boolean>>,
) {
  const query = new URLSearchParams(
    hash.startsWith('#work-center?') ? hash.slice('#work-center?'.length) : '',
  );
  for (const [key, raw] of Object.entries(patch)) {
    if (raw === '' || raw === false || raw === 0 || raw === undefined) query.delete(key);
    else query.set(key, key === 'unread' && raw === true ? '1' : String(raw));
  }
  const serialized = query.toString();
  return serialized ? '#work-center?' + serialized : '#work-center';
}
