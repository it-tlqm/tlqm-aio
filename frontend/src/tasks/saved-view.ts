export type SavedTaskView = {
  tab: 'list' | 'board';
  search: string;
  status: string;
  assignee: string;
  mine: boolean;
  overdue: boolean;
};
const key = (account: string, tenant: string, project: string) =>
  ['aio-task-view', account, tenant, project].join(':');

export function loadTaskView(
  account: string,
  tenant: string,
  project: string,
): SavedTaskView | null {
  try {
    const view = JSON.parse(
      localStorage.getItem(key(account, tenant, project)) ?? 'null',
    ) as SavedTaskView | null;
    if (
      view &&
      (view.tab === 'list' || view.tab === 'board') &&
      typeof view.search === 'string' &&
      view.search.length <= 120 &&
      typeof view.status === 'string' &&
      /^[a-z][a-z0-9-]{0,31}$/.test(view.status) &&
      typeof view.assignee === 'string' &&
      /^(all|[0-9a-f-]{36})$/.test(view.assignee) &&
      typeof view.mine === 'boolean' &&
      typeof view.overdue === 'boolean'
    )
      return view;
  } catch {
    /* Browser storage is optional. */
  }
  return null;
}

export function saveTaskView(
  account: string,
  tenant: string,
  project: string,
  view: SavedTaskView,
): boolean {
  try {
    localStorage.setItem(key(account, tenant, project), JSON.stringify(view));
    return true;
  } catch {
    return false;
  }
}
