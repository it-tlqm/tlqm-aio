import { useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { api, apiCollection, ApiError } from '@/lib/api';
import type { Me } from '@/lib/api';
import { errorMessage } from '@/lib/messages';

type Website = {
  id: string;
  code: string;
  name: string;
  status: string;
  defaultLocale: string;
  locales: string[];
  revision: number;
};
type Page = {
  id: string;
  websiteId: string;
  code: string;
  path: string;
  kind: string;
  status: string;
  revision: number;
  draftRevisionId?: string | null;
  publishedRevisionId?: string | null;
};
type PageRevision = {
  id: string;
  version: number;
  locale: string;
  state: string;
  title: string;
  seo: Record<string, unknown>;
  blocks: unknown[];
};
type ContentType = { id: string; code: string; name: string; active: boolean };
type ContentEntry = {
  id: string;
  code: string;
  contentTypeCode: string;
  status: string;
  revision: number;
};
type Asset = { id: string; name: string; publicUrl: string; mimeType: string; status: string };
type Domain = { id: string; websiteId: string; host: string; environment: string; active: boolean };
type Channel = {
  id: string;
  websiteId: string;
  provider: string;
  externalAccountId: string;
  displayName: string;
  status: string;
  revision: number;
  lastError?: string | null;
};
type Publication = {
  id: string;
  provider: string;
  displayName: string;
  targetKind: string;
  state: string;
  attemptCount: number;
  externalId?: string | null;
  lastError?: string | null;
};
type Menu = {
  id: string;
  code: string;
  name: string;
  locale: string;
  revision: number;
  draft: unknown[];
  published: unknown[];
};

function commandOptions(body: Record<string, unknown>): RequestInit {
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': crypto.randomUUID(),
    },
    body: JSON.stringify(body),
  };
}

export function CmsApp({ me, logout }: { me: Me; logout: () => Promise<void> }) {
  const tenantId = me.memberships[0]?.id ?? '';
  const [websites, setWebsites] = useState<Website[]>([]);
  const [pages, setPages] = useState<Page[]>([]);
  const [editingPage, setEditingPage] = useState<Page | null>(null);
  const [editorRevision, setEditorRevision] = useState(0);
  const [editorTitle, setEditorTitle] = useState('');
  const [editorBlocks, setEditorBlocks] = useState('[]');
  const [contentTypes, setContentTypes] = useState<ContentType[]>([]);
  const [entries, setEntries] = useState<ContentEntry[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [domains, setDomains] = useState<Domain[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [publications, setPublications] = useState<Publication[]>([]);
  const [menus, setMenus] = useState<Menu[]>([]);
  const [selectedWebsite, setSelectedWebsite] = useState('');
  const [code, setCode] = useState('talung-logistics');
  const [name, setName] = useState('Tà Lùng Quang Minh Logistics');
  const [pageCode, setPageCode] = useState('homepage');
  const [pagePath, setPagePath] = useState('/');
  const [pageTitle, setPageTitle] = useState('Trang chủ');
  const [domainHost, setDomainHost] = useState('cms.localhost');
  const [domainEnvironment, setDomainEnvironment] = useState('local');
  const [channelProvider, setChannelProvider] = useState('website');
  const [channelAccount, setChannelAccount] = useState('cms-local');
  const [channelName, setChannelName] = useState('Website local');
  const [channelTokenRef, setChannelTokenRef] = useState('');
  const [menuCode, setMenuCode] = useState('main');
  const [menuName, setMenuName] = useState('Main menu');
  const [menuItems, setMenuItems] = useState('[{"id":"home","label":"Trang chủ","path":"/"}]');
  const [contentTypeCode, setContentTypeCode] = useState('service-local');
  const [contentTypeName, setContentTypeName] = useState('Dịch vụ local');
  const [contentTypeSchema, setContentTypeSchema] = useState('{"fields":{"summary":"text"}}');
  const [entryCode, setEntryCode] = useState('service-local-1');
  const [entryTitle, setEntryTitle] = useState('Dịch vụ local');
  const [entrySlug, setEntrySlug] = useState('dich-vu-local');
  const [entryData, setEntryData] = useState('{"summary":"Nội dung local"}');
  const [assetName, setAssetName] = useState('local-asset');
  const [assetUrl, setAssetUrl] = useState('/assets/placeholder.svg');
  const [assetMimeType, setAssetMimeType] = useState('image/svg+xml');
  const [blocks, setBlocks] = useState(
    '[{"id":"hero-main","type":"hero","data":{"headline":"Kết nối biên giới"}}]',
  );
  const [busy, setBusy] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const selected = useMemo(
    () => websites.find((website) => website.id === selectedWebsite),
    [websites, selectedWebsite],
  );

  async function loadWebsites() {
    if (!tenantId) return;
    setBusy(true);
    try {
      const result = await api<{ items?: Website[] } | Website[]>(
        '/api/v1/cms/websites?tenantId=' + encodeURIComponent(tenantId),
      );
      const items = Array.isArray(result) ? result : (result.items ?? []);
      setWebsites(items);
      const current = items.find((item) => item.id === selectedWebsite) ?? items[0];
      setSelectedWebsite(current?.id ?? '');
      if (current) await loadWorkspace(current.id);
      setError(null);
    } catch (reason) {
      setError(reason);
    } finally {
      setBusy(false);
    }
  }

  async function loadPages(websiteId: string) {
    const result = await api<Page[]>(
      '/api/v1/cms/pages?tenantId=' +
        encodeURIComponent(tenantId) +
        '&websiteId=' +
        encodeURIComponent(websiteId),
    );
    setPages(Array.isArray(result) ? result : ((result as { items?: Page[] }).items ?? []));
  }

  async function loadWorkspace(websiteId: string) {
    await Promise.all([
      loadPages(websiteId),
      loadContentTypes(websiteId),
      loadEntries(websiteId),
      loadAssets(websiteId),
      loadDomains(websiteId),
      loadChannels(websiteId),
      loadPublications(websiteId),
      loadMenus(websiteId),
    ]);
  }

  async function loadDomains(websiteId: string) {
    const result = await api<Domain[]>(
      '/api/v1/cms/domains?tenantId=' +
        encodeURIComponent(tenantId) +
        '&websiteId=' +
        encodeURIComponent(websiteId),
    );
    setDomains(Array.isArray(result) ? result : []);
  }

  async function loadChannels(websiteId: string) {
    const result = await api<Channel[]>(
      '/api/v1/cms/channels?tenantId=' +
        encodeURIComponent(tenantId) +
        '&websiteId=' +
        encodeURIComponent(websiteId),
    );
    setChannels(Array.isArray(result) ? result : []);
  }

  async function loadPublications(websiteId: string) {
    const result = await api<Publication[]>(
      '/api/v1/cms/publications?tenantId=' +
        encodeURIComponent(tenantId) +
        '&websiteId=' +
        encodeURIComponent(websiteId),
    );
    setPublications(Array.isArray(result) ? result : []);
  }

  async function loadMenus(websiteId: string) {
    const result = await api<Menu[]>(
      '/api/v1/cms/menus?tenantId=' +
        encodeURIComponent(tenantId) +
        '&websiteId=' +
        encodeURIComponent(websiteId),
    );
    setMenus(Array.isArray(result) ? result : []);
  }

  async function loadContentTypes(websiteId: string) {
    const result = await api<ContentType[]>(
      '/api/v1/cms/content-types?tenantId=' +
        encodeURIComponent(tenantId) +
        '&websiteId=' +
        encodeURIComponent(websiteId),
    );
    setContentTypes(Array.isArray(result) ? result : []);
  }

  async function loadEntries(websiteId: string) {
    const result = await api<ContentEntry[]>(
      '/api/v1/cms/content-entries?tenantId=' +
        encodeURIComponent(tenantId) +
        '&websiteId=' +
        encodeURIComponent(websiteId),
    );
    setEntries(Array.isArray(result) ? result : []);
  }

  async function loadAssets(websiteId: string) {
    const result = await api<Asset[]>(
      '/api/v1/cms/assets?tenantId=' +
        encodeURIComponent(tenantId) +
        '&websiteId=' +
        encodeURIComponent(websiteId),
    );
    setAssets(Array.isArray(result) ? result : []);
  }

  useEffect(() => {
    void loadWebsites();
  }, [tenantId]);

  async function createWebsite() {
    setSaving(true);
    try {
      await api('/api/v1/cms/websites', {
        ...commandOptions({
          tenantId,
          reason: 'Tạo website CMS local',
          code,
          name,
          defaultLocale: 'vi',
          locales: ['vi', 'en', 'zh'],
        }),
      });
      await loadWebsites();
    } catch (reason) {
      setError(reason);
    } finally {
      setSaving(false);
    }
  }

  async function createPage() {
    if (!selectedWebsite) return;
    let parsedBlocks: unknown;
    try {
      parsedBlocks = JSON.parse(blocks);
    } catch {
      setError(new ApiError(400, 'CMS_INVALID_BLOCKS'));
      return;
    }
    setSaving(true);
    try {
      await api(
        '/api/v1/cms/pages',
        commandOptions({
          tenantId,
          reason: 'Tạo trang CMS local',
          websiteId: selectedWebsite,
          code: pageCode,
          path: pagePath,
          kind: 'landing',
          locale: 'vi',
          document: { title: pageTitle, seo: {}, blocks: parsedBlocks },
        }),
      );
      await loadPages(selectedWebsite);
    } catch (reason) {
      setError(reason);
    } finally {
      setSaving(false);
    }
  }

  async function openPage(pageId: string) {
    try {
      const detail = await api<{ page: Page; revisions: PageRevision[] }>(
        '/api/v1/cms/pages/' +
          encodeURIComponent(pageId) +
          '?tenantId=' +
          encodeURIComponent(tenantId),
      );
      const revision =
        detail.revisions.find((item) => item.id === detail.page.draftRevisionId) ??
        detail.revisions.find((item) => item.locale === 'vi');
      setEditingPage(detail.page);
      setEditorRevision(detail.page.revision);
      setEditorTitle(revision?.title ?? '');
      setEditorBlocks(JSON.stringify(revision?.blocks ?? [], null, 2));
    } catch (reason) {
      setError(reason);
    }
  }

  async function savePageDraft() {
    if (!editingPage) return;
    let parsedBlocks: unknown;
    try {
      parsedBlocks = JSON.parse(editorBlocks);
    } catch {
      setError(new ApiError(400, 'CMS_INVALID_BLOCKS'));
      return;
    }
    setSaving(true);
    try {
      await api(
        '/api/v1/cms/pages/' + editingPage.id + '/draft',
        commandOptions({
          tenantId,
          reason: 'Lưu draft page từ CMS Studio',
          expectedRevision: editorRevision,
          locale: 'vi',
          document: { title: editorTitle, seo: {}, blocks: parsedBlocks },
        }),
      );
      await openPage(editingPage.id);
      await loadWorkspace(selectedWebsite);
    } catch (reason) {
      setError(reason);
    } finally {
      setSaving(false);
    }
  }

  async function reviewPage() {
    if (!editingPage) return;
    setSaving(true);
    try {
      await api(
        '/api/v1/cms/pages/' + editingPage.id + '/review',
        commandOptions({
          tenantId,
          reason: 'Gửi page CMS để duyệt',
          expectedRevision: editorRevision,
          locale: 'vi',
        }),
      );
      await openPage(editingPage.id);
    } catch (reason) {
      setError(reason);
    } finally {
      setSaving(false);
    }
  }

  async function publishPage() {
    if (!editingPage) return;
    setSaving(true);
    try {
      await api(
        '/api/v1/cms/pages/' + editingPage.id + '/publish',
        commandOptions({
          tenantId,
          reason: 'Phát hành page CMS',
          expectedRevision: editorRevision,
          locale: 'vi',
        }),
      );
      await openPage(editingPage.id);
      await loadWorkspace(selectedWebsite);
    } catch (reason) {
      setError(reason);
    } finally {
      setSaving(false);
    }
  }

  async function createDomain() {
    if (!selectedWebsite || !domainHost.trim()) return;
    setSaving(true);
    try {
      await api(
        '/api/v1/cms/domains',
        commandOptions({
          tenantId,
          reason: 'Đăng ký domain CMS local',
          websiteId: selectedWebsite,
          host: domainHost.trim(),
          environment: domainEnvironment,
        }),
      );
      await loadDomains(selectedWebsite);
    } catch (reason) {
      setError(reason);
    } finally {
      setSaving(false);
    }
  }

  async function createChannel() {
    if (!selectedWebsite || !channelAccount.trim() || !channelName.trim()) return;
    setSaving(true);
    try {
      await api(
        '/api/v1/cms/channels',
        commandOptions({
          tenantId,
          reason: 'Đăng ký kênh CMS local',
          websiteId: selectedWebsite,
          provider: channelProvider,
          externalAccountId: channelAccount.trim(),
          displayName: channelName.trim(),
          ...(channelTokenRef.trim() ? { tokenRef: channelTokenRef.trim() } : {}),
        }),
      );
      await loadChannels(selectedWebsite);
    } catch (reason) {
      setError(reason);
    } finally {
      setSaving(false);
    }
  }

  async function saveMenuDraft() {
    if (!selectedWebsite) return;
    let items: unknown;
    try {
      items = JSON.parse(menuItems);
    } catch {
      setError(new ApiError(400, 'CMS_INVALID_MENU'));
      return;
    }
    const existing = menus.find((menu) => menu.code === menuCode && menu.locale === 'vi');
    setSaving(true);
    try {
      await api(
        '/api/v1/cms/menus/draft',
        commandOptions({
          tenantId,
          reason: 'Lưu menu CMS local',
          websiteId: selectedWebsite,
          code: menuCode,
          name: menuName,
          locale: 'vi',
          items,
          ...(existing ? { expectedRevision: existing.revision } : {}),
        }),
      );
      await loadMenus(selectedWebsite);
    } catch (reason) {
      setError(reason);
    } finally {
      setSaving(false);
    }
  }

  async function publishMenu() {
    if (!selectedWebsite) return;
    const menu = menus.find((item) => item.code === menuCode && item.locale === 'vi');
    if (!menu) return;
    setSaving(true);
    try {
      await api(
        '/api/v1/cms/menus/' + menu.id + '/publish',
        commandOptions({
          tenantId,
          reason: 'Phát hành menu CMS local',
          expectedRevision: menu.revision,
        }),
      );
      await loadMenus(selectedWebsite);
    } catch (reason) {
      setError(reason);
    } finally {
      setSaving(false);
    }
  }

  async function queuePagePublication() {
    if (!selectedWebsite || !editingPage?.publishedRevisionId) return;
    const channel = channels.find((item) => item.status === 'connected');
    if (!channel) {
      setError(new ApiError(409, 'CMS_CHANNEL_NOT_FOUND'));
      return;
    }
    setSaving(true);
    try {
      await api(
        '/api/v1/cms/publications',
        commandOptions({
          tenantId,
          reason: 'Đưa page CMS vào hàng đợi xuất bản',
          websiteId: selectedWebsite,
          connectionId: channel.id,
          targetKind: 'page',
          targetId: editingPage.id,
          revisionId: editingPage.publishedRevisionId,
        }),
      );
      await loadPublications(selectedWebsite);
    } catch (reason) {
      setError(reason);
    } finally {
      setSaving(false);
    }
  }

  async function retryPublication(publicationId: string) {
    if (!selectedWebsite) return;
    setSaving(true);
    try {
      await api(
        '/api/v1/cms/publications/' + publicationId + '/retry',
        commandOptions({
          tenantId,
          reason: 'Thử lại xuất bản CMS',
        }),
      );
      await loadPublications(selectedWebsite);
    } catch (reason) {
      setError(reason);
    } finally {
      setSaving(false);
    }
  }

  async function createContentType() {
    if (!selectedWebsite) return;
    let schema: unknown;
    try {
      schema = JSON.parse(contentTypeSchema);
    } catch {
      setError(new ApiError(400, 'CMS_INVALID_CONTENT_SCHEMA'));
      return;
    }
    setSaving(true);
    try {
      await api(
        '/api/v1/cms/content-types',
        commandOptions({
          tenantId,
          reason: 'Tạo collection type CMS local',
          websiteId: selectedWebsite,
          code: contentTypeCode,
          name: contentTypeName,
          schema,
        }),
      );
      await loadContentTypes(selectedWebsite);
    } catch (reason) {
      setError(reason);
    } finally {
      setSaving(false);
    }
  }

  async function createEntry() {
    if (!selectedWebsite || !contentTypes[0]) return;
    let data: unknown;
    try {
      data = JSON.parse(entryData);
    } catch {
      setError(new ApiError(400, 'CMS_INVALID_CONTENT_DATA'));
      return;
    }
    setSaving(true);
    try {
      await api(
        '/api/v1/cms/content-entries',
        commandOptions({
          tenantId,
          reason: 'Tạo collection entry CMS local',
          websiteId: selectedWebsite,
          contentTypeCode: contentTypes[0].code,
          code: entryCode,
          locale: selected?.defaultLocale ?? 'vi',
          document: { slug: entrySlug, title: entryTitle, seo: {}, data },
        }),
      );
      await loadEntries(selectedWebsite);
    } catch (reason) {
      setError(reason);
    } finally {
      setSaving(false);
    }
  }

  async function registerAsset() {
    if (!selectedWebsite) return;
    setSaving(true);
    try {
      await api(
        '/api/v1/cms/assets',
        commandOptions({
          tenantId,
          reason: 'Đăng ký media metadata CMS local',
          websiteId: selectedWebsite,
          storageProvider: 'local',
          storageKey: assetUrl,
          publicUrl: assetUrl,
          name: assetName,
          mimeType: assetMimeType,
          byteSize: 0,
          alt: { [selected?.defaultLocale ?? 'vi']: assetName },
          metadata: { source: 'cms-studio' },
        }),
      );
      await loadAssets(selectedWebsite);
    } catch (reason) {
      setError(reason);
    } finally {
      setSaving(false);
    }
  }

  if (busy)
    return (
      <main className="p-8" role="status">
        Đang tải CMS…
      </main>
    );
  return (
    <main className="mx-auto max-w-6xl space-y-6 p-6 md:p-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm text-muted-foreground">AIO CMS · WEBSITE FOUNDATION</p>
          <h1 className="mt-2 text-3xl font-semibold">Quản lý website và nội dung</h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            Lát cắt đầu tiên quản lý website, page và revision theo tenant. Nội dung công khai chỉ
            đọc bản đã phát hành.
          </p>
        </div>
        <Button variant="outline" onClick={() => void logout()}>
          Đăng xuất SSO
        </Button>
      </div>
      {Boolean(error) && (
        <Alert variant="destructive">
          <AlertDescription>{String(errorMessage(error))}</AlertDescription>
        </Alert>
      )}
      <div className="grid gap-6 lg:grid-cols-[1fr_1.4fr]">
        <Card>
          <CardHeader>
            <CardTitle>Website</CardTitle>
            <CardDescription>{websites.length} website trong tenant hiện tại</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {websites.map((website) => (
              <button
                key={website.id}
                type="button"
                className={
                  'w-full rounded-lg border p-3 text-left ' +
                  (selectedWebsite === website.id ? 'border-primary bg-primary/5' : 'border-border')
                }
                onClick={() => {
                  setSelectedWebsite(website.id);
                  void loadWorkspace(website.id);
                }}
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="font-medium">{website.name}</span>
                  <Badge variant={website.status === 'active' ? 'default' : 'secondary'}>
                    {website.status}
                  </Badge>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {website.code} · {website.locales.join(', ')}
                </p>
              </button>
            ))}
            <div className="space-y-3 border-t pt-4">
              <p className="text-sm font-medium">Tạo website</p>
              <Input
                value={code}
                onChange={(event) => setCode(event.target.value)}
                placeholder="mã website"
              />
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="tên website"
              />
              <Button onClick={() => void createWebsite()} disabled={saving || !code || !name}>
                Tạo website
              </Button>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Pages</CardTitle>
            <CardDescription>
              {selected ? selected.name : 'Chọn website để xem pages'}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {pages.map((page) => (
              <div
                key={page.id}
                className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border p-3 hover:border-primary"
                onClick={() => void openPage(page.id)}
              >
                <div>
                  <p className="font-medium">{page.code}</p>
                  <p className="text-xs text-muted-foreground">
                    {page.path} · revision {page.revision}
                  </p>
                </div>
                <Badge variant="secondary">{page.status}</Badge>
              </div>
            ))}
            {selected && (
              <div className="space-y-3 border-t pt-4">
                <p className="text-sm font-medium">Tạo page thử nghiệm</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Input
                    value={pageCode}
                    onChange={(event) => setPageCode(event.target.value)}
                    placeholder="mã page"
                  />
                  <Input
                    value={pagePath}
                    onChange={(event) => setPagePath(event.target.value)}
                    placeholder="/path"
                  />
                </div>
                <Input
                  value={pageTitle}
                  onChange={(event) => setPageTitle(event.target.value)}
                  placeholder="tiêu đề"
                />
                <Textarea
                  value={blocks}
                  onChange={(event) => setBlocks(event.target.value)}
                  className="min-h-32 font-mono text-xs"
                  aria-label="Danh sách block JSON"
                />
                <Button onClick={() => void createPage()} disabled={saving}>
                  Tạo draft page
                </Button>
              </div>
            )}
            {editingPage && (
              <div className="space-y-3 border-t pt-4">
                <p className="text-sm font-medium">
                  Page Studio · {editingPage.code} · revision {editorRevision}
                </p>
                <Input
                  value={editorTitle}
                  onChange={(event) => setEditorTitle(event.target.value)}
                  placeholder="Tiêu đề page"
                />
                <Textarea
                  value={editorBlocks}
                  onChange={(event) => setEditorBlocks(event.target.value)}
                  className="min-h-48 font-mono text-xs"
                  aria-label="Blocks JSON đang chỉnh sửa"
                />
                <div className="flex flex-wrap gap-2">
                  <Button onClick={() => void savePageDraft()} disabled={saving}>
                    Lưu draft
                  </Button>
                  <Button variant="outline" onClick={() => void reviewPage()} disabled={saving}>
                    Gửi duyệt
                  </Button>
                  <Button variant="secondary" onClick={() => void publishPage()} disabled={saving}>
                    Phát hành
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => void queuePagePublication()}
                    disabled={saving || !editingPage.publishedRevisionId}
                  >
                    Đưa vào hàng đợi
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
      {selected && (
        <>
          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Collections</CardTitle>
                <CardDescription>
                  {contentTypes.length} content type · {entries.length} entry
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {contentTypes.map((type) => (
                  <div
                    key={type.id}
                    className="flex items-center justify-between rounded-lg border p-3"
                  >
                    <div>
                      <p className="font-medium">{type.name}</p>
                      <p className="text-xs text-muted-foreground">{type.code}</p>
                    </div>
                    <Badge variant={type.active ? 'default' : 'secondary'}>
                      {entries.filter((entry) => entry.contentTypeCode === type.code).length} entry
                    </Badge>
                  </div>
                ))}
                {entries.slice(0, 8).map((entry) => (
                  <div
                    key={entry.id}
                    className="flex items-center justify-between rounded-lg bg-muted/40 px-3 py-2 text-sm"
                  >
                    <span>
                      {entry.contentTypeCode} · {entry.code}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {entry.status} · v{entry.revision}
                    </span>
                  </div>
                ))}
                <div className="space-y-2 border-t pt-3">
                  <p className="text-sm font-medium">Tạo collection type</p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <Input
                      value={contentTypeCode}
                      onChange={(event) => setContentTypeCode(event.target.value)}
                      placeholder="service-local"
                      aria-label="Mã collection type"
                    />
                    <Input
                      value={contentTypeName}
                      onChange={(event) => setContentTypeName(event.target.value)}
                      placeholder="Tên collection type"
                      aria-label="Tên collection type"
                    />
                  </div>
                  <Textarea
                    value={contentTypeSchema}
                    onChange={(event) => setContentTypeSchema(event.target.value)}
                    className="min-h-20 font-mono text-xs"
                    aria-label="Schema collection JSON"
                  />
                  <Button onClick={() => void createContentType()} disabled={saving}>
                    Tạo type
                  </Button>
                </div>
                <div className="space-y-2 border-t pt-3">
                  <p className="text-sm font-medium">Tạo entry thử nghiệm</p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <Input
                      value={entryCode}
                      onChange={(event) => setEntryCode(event.target.value)}
                      placeholder="entry-code"
                      aria-label="Mã entry"
                    />
                    <Input
                      value={entrySlug}
                      onChange={(event) => setEntrySlug(event.target.value)}
                      placeholder="slug"
                      aria-label="Slug entry"
                    />
                  </div>
                  <Input
                    value={entryTitle}
                    onChange={(event) => setEntryTitle(event.target.value)}
                    placeholder="Tiêu đề entry"
                    aria-label="Tiêu đề entry"
                  />
                  <Textarea
                    value={entryData}
                    onChange={(event) => setEntryData(event.target.value)}
                    className="min-h-20 font-mono text-xs"
                    aria-label="Dữ liệu entry JSON"
                  />
                  <Button
                    onClick={() => void createEntry()}
                    disabled={saving || !contentTypes.length}
                  >
                    Tạo entry
                  </Button>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Media registry</CardTitle>
                <CardDescription>
                  {assets.length} asset trong phạm vi website và asset dùng chung
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {assets.slice(0, 8).map((asset) => (
                  <div key={asset.id} className="flex items-center gap-3 rounded-lg border p-2">
                    <img
                      src={asset.publicUrl}
                      alt={asset.name}
                      className="size-12 rounded object-cover"
                    />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{asset.name}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {asset.mimeType} · {asset.status}
                      </p>
                    </div>
                  </div>
                ))}
                <div className="space-y-2 border-t pt-3">
                  <p className="text-sm font-medium">Đăng ký media metadata</p>
                  <Input
                    value={assetName}
                    onChange={(event) => setAssetName(event.target.value)}
                    placeholder="Tên asset"
                    aria-label="Tên asset"
                  />
                  <Input
                    value={assetUrl}
                    onChange={(event) => setAssetUrl(event.target.value)}
                    placeholder="/assets/image.jpg hoặc URL"
                    aria-label="Public URL asset"
                  />
                  <Input
                    value={assetMimeType}
                    onChange={(event) => setAssetMimeType(event.target.value)}
                    placeholder="image/jpeg"
                    aria-label="MIME type asset"
                  />
                  <Button
                    onClick={() => void registerAsset()}
                    disabled={saving || !assetName.trim() || !assetUrl.trim()}
                  >
                    Lưu metadata
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
          <div className="grid gap-6 lg:grid-cols-3">
            <Card>
              <CardHeader>
                <CardTitle>Domains</CardTitle>
                <CardDescription>{domains.length} domain mapping</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {domains.map((domain) => (
                  <div
                    key={domain.id}
                    className="flex items-center justify-between rounded-lg border p-2 text-sm"
                  >
                    <span>{domain.host}</span>
                    <Badge variant={domain.active ? 'default' : 'secondary'}>
                      {domain.environment}
                    </Badge>
                  </div>
                ))}
                <Input
                  value={domainHost}
                  onChange={(event) => setDomainHost(event.target.value)}
                  placeholder="cms.localhost"
                  aria-label="Domain host"
                />
                <select
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                  value={domainEnvironment}
                  onChange={(event) => setDomainEnvironment(event.target.value)}
                  aria-label="Môi trường domain"
                >
                  <option value="local">local</option>
                  <option value="preview">preview</option>
                  <option value="production">production</option>
                </select>
                <Button onClick={() => void createDomain()} disabled={saving || !domainHost.trim()}>
                  Thêm domain
                </Button>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Channels</CardTitle>
                <CardDescription>Kênh Website, Facebook, TikTok, Zalo OA</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {channels.map((channel) => (
                  <div key={channel.id} className="rounded-lg border p-2 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span>{channel.displayName}</span>
                      <Badge variant={channel.status === 'connected' ? 'default' : 'secondary'}>
                        {channel.provider}
                      </Badge>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {channel.externalAccountId} · {channel.status}
                    </p>
                  </div>
                ))}
                <select
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                  value={channelProvider}
                  onChange={(event) => setChannelProvider(event.target.value)}
                  aria-label="Nhà cung cấp kênh"
                >
                  <option value="website">Website</option>
                  <option value="facebook">Facebook</option>
                  <option value="tiktok">TikTok</option>
                  <option value="zalo-oa">Zalo OA</option>
                </select>
                <Input
                  value={channelAccount}
                  onChange={(event) => setChannelAccount(event.target.value)}
                  placeholder="external account id"
                  aria-label="External account id"
                />
                <Input
                  value={channelName}
                  onChange={(event) => setChannelName(event.target.value)}
                  placeholder="Tên hiển thị"
                  aria-label="Tên kênh"
                />
                {channelProvider !== 'website' && (
                  <Input
                    value={channelTokenRef}
                    onChange={(event) => setChannelTokenRef(event.target.value)}
                    placeholder="token reference (không nhập token)"
                    aria-label="Token reference"
                  />
                )}
                <Button
                  onClick={() => void createChannel()}
                  disabled={saving || !channelAccount.trim()}
                >
                  Thêm kênh
                </Button>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Publication queue</CardTitle>
                <CardDescription>{publications.length} job xuất bản</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {publications.slice(0, 8).map((publication) => (
                  <div key={publication.id} className="rounded-lg border p-2 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span>
                        {publication.provider} · {publication.targetKind}
                      </span>
                      <Badge
                        variant={
                          publication.state === 'published'
                            ? 'default'
                            : publication.state === 'failed'
                              ? 'destructive'
                              : 'secondary'
                        }
                      >
                        {publication.state}
                      </Badge>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      attempt {publication.attemptCount}
                      {publication.externalId ? ' · ' + publication.externalId : ''}
                    </p>
                    {publication.state === 'failed' && (
                      <Button
                        className="mt-2"
                        size="sm"
                        variant="outline"
                        onClick={() => void retryPublication(publication.id)}
                        disabled={saving}
                      >
                        Thử lại
                      </Button>
                    )}
                  </div>
                ))}
                {!publications.length && (
                  <p className="text-sm text-muted-foreground">Chưa có job.</p>
                )}
              </CardContent>
            </Card>
          </div>
          <Card>
            <CardHeader>
              <CardTitle>Menu editor</CardTitle>
              <CardDescription>
                Soạn menu theo locale, lưu draft và phát hành có kiểm soát revision.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 lg:grid-cols-[180px_1fr_2fr_auto]">
              <Input
                value={menuCode}
                onChange={(event) => setMenuCode(event.target.value)}
                placeholder="main"
                aria-label="Mã menu"
              />
              <Input
                value={menuName}
                onChange={(event) => setMenuName(event.target.value)}
                placeholder="Tên menu"
                aria-label="Tên menu"
              />
              <Textarea
                value={menuItems}
                onChange={(event) => setMenuItems(event.target.value)}
                className="min-h-24 font-mono text-xs"
                aria-label="Menu items JSON"
              />
              <div className="flex flex-wrap items-start gap-2">
                <Button onClick={() => void saveMenuDraft()} disabled={saving}>
                  Lưu draft
                </Button>
                <Button
                  variant="outline"
                  onClick={() => void publishMenu()}
                  disabled={
                    saving || !menus.some((menu) => menu.code === menuCode && menu.locale === 'vi')
                  }
                >
                  Phát hành
                </Button>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </main>
  );
}
