let csrf = null;
const get = (id) => document.getElementById(id);
const item = (parent, text) => {
  const li = document.createElement('li');
  li.textContent = text;
  parent.append(li);
};
async function refresh() {
  get('apps').replaceChildren();
  get('directory').replaceChildren();
  get('identity').replaceChildren();
  const response = await fetch('/api/v1/me');
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    get('identity-status').textContent =
      response.status === 401
        ? 'Chưa có phiên đăng nhập.'
        : response.status === 403
          ? 'Tài khoản chưa được phép truy cập ứng dụng.'
          : 'Dịch vụ xác thực tạm thời chưa sẵn sàng.';
    get('identity-status').dataset.code = body.error || '';
    get('logout').hidden = !csrf;
    get('global-logout').hidden = !csrf;
    return;
  }
  const me = await response.json();
  csrf = me.csrfToken;
  get('identity-status').textContent = 'Đã đăng nhập: ' + me.displayName;
  get('identity-status').dataset.code = 'AUTHENTICATED';
  get('logout').hidden = false;
  get('global-logout').hidden = false;
  get('login').textContent = 'Đăng nhập lại';
  for (const [label, value] of [
    ['Ứng dụng', me.appCode],
    ['Danh tính', me.personId],
    ['Phạm vi quyền', String(me.permissions.length)],
  ]) {
    const dt = document.createElement('dt'),
      dd = document.createElement('dd');
    dt.textContent = label;
    dd.textContent = value;
    get('identity').append(dt, dd);
  }
  get('second-app').href =
    me.appCode === 'aio-foundation' ? 'http://127.0.0.1:4101/' : 'http://127.0.0.1:4100/';
  get('second-app').textContent =
    me.appCode === 'aio-foundation' ? 'Mở ứng dụng thử B' : 'Mở Foundation';
  const appsResponse = await fetch('/api/v1/applications');
  if (appsResponse.ok)
    for (const app of (await appsResponse.json()).items) {
      const li = document.createElement('li'),
        a = document.createElement('a');
      a.textContent = app.name;
      a.href = app.launchUrl;
      li.append(a);
      get('apps').append(li);
    }
  const tenants = [
    ...new Set(
      me.permissions.filter((p) => p.permission === 'directory:read').map((p) => p.tenantId),
    ),
  ];
  for (const tenant of tenants) {
    const result = await fetch('/api/v1/directory?tenantId=' + encodeURIComponent(tenant));
    if (result.ok)
      for (const unit of (await result.json()).units)
        item(get('directory'), unit.code + ' · ' + unit.name);
  }
  for (const assignment of me.assignments)
    item(
      get('directory'),
      assignment.unitName + ' — ' + (assignment.isPrimary ? 'Vị trí chính' : 'Kiêm nhiệm'),
    );
}
async function logout(global) {
  const response = await fetch('/auth/logout', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrf || '' },
    body: JSON.stringify({ global }),
  });
  if (response.ok) location.assign((await response.json()).redirectTo);
}
get('refresh').addEventListener('click', () => void refresh());
get('logout').addEventListener('click', () => void logout(false));
get('global-logout').addEventListener('click', () => void logout(true));
void refresh().catch(() => {
  get('identity-status').textContent = 'Không kết nối được dịch vụ.';
});
