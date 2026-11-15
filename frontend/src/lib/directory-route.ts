const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const states = ['active', 'inactive', 'all'] as const;

export type PeopleRoute = {
  tab: string;
  query: string;
  unit: string;
  state: (typeof states)[number];
  page: number;
};

export function parsePeopleRoute(hash: string): PeopleRoute | null {
  if (hash !== '#people' && !hash.startsWith('#people?')) return null;
  const query = new URLSearchParams(
    hash.startsWith('#people?') ? hash.slice('#people?'.length) : '',
  );
  for (const key of query.keys())
    if (!['tab', 'search', 'unit', 'state', 'page'].includes(key)) return null;
  const tab = query.get('tab') ?? 'overview';
  const unit = query.get('unit');
  const state = query.get('state') ?? 'active';
  const pageValue = Number(query.get('page') ?? '0');
  if (unit && unit !== 'all' && !uuid.test(unit)) return null;
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(tab)) return null;
  if (!(states as readonly string[]).includes(state)) return null;
  if (!Number.isInteger(pageValue) || pageValue < 0 || pageValue > 9999) return null;
  const search = (query.get('search') ?? '').trim();
  if (search.length > 120) return null;
  return {
    tab,
    query: search,
    unit: unit && unit !== 'all' ? unit : 'all',
    state: state as PeopleRoute['state'],
    page: pageValue,
  };
}

export function peopleRoute(route: PeopleRoute) {
  const query = new URLSearchParams();
  if (route.tab !== 'overview') query.set('tab', route.tab);
  if (route.query.trim()) query.set('search', route.query.trim().slice(0, 120));
  if (route.unit !== 'all') query.set('unit', route.unit);
  if (route.state !== 'active') query.set('state', route.state);
  if (route.page > 0) query.set('page', String(Math.min(route.page, 9999)));
  const serialized = query.toString();
  return serialized ? '#people?' + serialized : '#people';
}
