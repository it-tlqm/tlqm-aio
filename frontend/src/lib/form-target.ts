const id = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const route = new RegExp('^#forms/tenant/(' + id + ')/(' + id + ')/respond$', 'i');
const detailRoute = new RegExp('^#forms/(' + id + ')(?:\\?(.*))?$', 'i');
const detailTabs = [
  'design',
  'audience',
  'versions',
  'respond',
  'review',
  'analyze',
  'history',
] as const;

export function parseFormTarget(hash: string) {
  const match = route.exec(hash);
  return match ? { tenant: match[1]!.toLowerCase(), form: match[2]!.toLowerCase() } : null;
}

export function formTarget(tenant: string, form: string) {
  return '#forms/tenant/' + tenant + '/' + form + '/respond';
}

export function parseFormsDetailRoute(hash: string) {
  const match = detailRoute.exec(hash);
  if (!match) return null;
  const query = new URLSearchParams(match[2] ?? '');
  for (const key of query.keys()) if (key !== 'tab') return null;
  const tab = query.get('tab');
  if (tab && !(detailTabs as readonly string[]).includes(tab)) return null;
  return { form: match[1]!.toLowerCase(), tab: tab as (typeof detailTabs)[number] | null };
}

export function formsDetailRoute(form: string, tab?: string) {
  return tab && (detailTabs as readonly string[]).includes(tab)
    ? '#forms/' + form + '?tab=' + encodeURIComponent(tab)
    : '#forms/' + form;
}

export function parseFormsListRoute(hash: string) {
  if (hash !== '#forms' && !hash.startsWith('#forms?')) return null;
  const query = new URLSearchParams(hash.startsWith('#forms?') ? hash.slice('#forms?'.length) : '');
  for (const key of query.keys()) if (key !== 'search') return null;
  const search = (query.get('search') ?? '').trim();
  return search.length <= 120 ? { search } : null;
}

export function formsListRoute(search: string) {
  const value = search.trim().slice(0, 120);
  return value ? '#forms?search=' + encodeURIComponent(value) : '#forms';
}
