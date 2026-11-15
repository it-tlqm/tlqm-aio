const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const route = new RegExp(
  '^#tasks/(?:tenant/(' + uuid + ')/)?project/(' + uuid + ')(?:/(' + uuid + '))?$',
  'i',
);

export function parseTaskTarget(hash: string) {
  const match = route.exec(hash);
  return match
    ? {
        tenant: match[1]?.toLowerCase() ?? null,
        project: match[2]!.toLowerCase(),
        task: match[3]?.toLowerCase() ?? null,
      }
    : null;
}

export function taskTarget(tenant: string, project: string, task?: string | null) {
  return '#tasks/tenant/' + tenant + '/project/' + project + (task ? '/' + task : '');
}
