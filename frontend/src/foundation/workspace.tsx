import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ResourcePanel } from '@/components/resource-panel';
import type { Me, Row } from '@/lib/api';
import { resourceByKey } from '@/lib/resources';
import { errorMessage } from '@/lib/messages';
import { orgKeys, peopleKeys, accessKeys } from './model';
import { canRead, useDirectoryData } from './data';
import { OrganizationView } from './organization';
import { PeopleView } from './people';
import { AccessView } from './access';
import { PersonnelPanel } from './personnel';
import { OrganizationImportPanel } from './import';
import { MetadataWorkspace } from './metadata';
import { parsePeopleRoute, peopleRoute } from '@/lib/directory-route';
import type { Edit } from './common';
const groups = {
  organization: ['legal-entities', 'org-units', 'job-titles', 'positions', 'unit-leaders'],
  people: [
    'people',
    'accounts',
    'employments',
    'assignments',
    'reporting-lines',
    'approval-substitutions',
  ],
  access: ['roles', 'permissions', 'bindings', 'grants'],
};
export type FoundationMode = keyof typeof groups;
type Request = { key: string; resource: string; row?: Row; defaults?: Row };
const lookups: Record<string, string[]> = {
  'personnel-operations': ['people', 'legal-entities', 'org-units', 'positions', 'employments'],
  'unit-leaders': ['legal-entities', 'org-units', 'people', 'employments'],
  'reporting-lines': ['legal-entities', 'people', 'employments'],
  'approval-substitutions': ['legal-entities', 'people', 'employments'],
  'org-units': ['legal-entities', 'org-units'],
  positions: ['legal-entities', 'org-units', 'job-titles'],
  accounts: ['people'],
  employments: ['people', 'legal-entities'],
  assignments: ['people', 'employments', 'positions', 'org-units', 'legal-entities'],
  roles: ['permissions'],
  bindings: ['accounts', 'people', 'roles', 'org-units'],
  grants: ['accounts', 'people'],
};
export function FoundationWorkspace({
  mode,
  me,
  tenantId,
  applications,
  onPerson,
  initialPersonId,
  onIdentity,
  initialTab,
}: {
  mode: FoundationMode;
  me: Me;
  tenantId: string;
  applications: Row[];
  onPerson: (id: string) => void;
  initialPersonId?: string;
  onIdentity: () => void;
  initialTab?: string;
}) {
  const route = mode === 'people' ? parsePeopleRoute(location.hash) : null;
  const requestedTab = route?.tab && groups.people.includes(route.tab) ? route.tab : 'overview';
  const [tab, setTab] = useState(initialTab ?? requestedTab),
    [version, setVersion] = useState(0),
    [appCode, setAppCode] = useState(me.appCode),
    [request, setRequest] = useState<Request | undefined>(),
    [message, setMessage] = useState('');
  useEffect(() => {
    if (mode !== 'people') return;
    const update = () => {
      const next = parsePeopleRoute(location.hash);
      if (next && groups.people.includes(next.tab)) setTab(next.tab);
      else if (location.hash.startsWith('#people')) setTab('overview');
    };
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, [mode]);
  useEffect(() => {
    if (mode !== 'people' || !location.hash.startsWith('#people')) return;
    const current = parsePeopleRoute(location.hash);
    if (!current) return;
    const next = peopleRoute({ ...current, tab });
    if (location.hash !== next) window.history.replaceState(null, '', next);
  }, [mode, tab]);
  const keys =
    tab === 'overview'
      ? mode === 'organization'
        ? orgKeys
        : mode === 'people'
          ? peopleKeys
          : [...accessKeys, 'applications']
      : [...(lookups[tab] ?? []), ...(mode === 'access' ? ['applications'] : [])];
  const { data, loading, error } = useDirectoryData(keys, me, tenantId, appCode, version);
  const edit: Edit = (resource, row, defaults) => {
    setMessage('');
    setRequest({ key: crypto.randomUUID(), resource, row, defaults });
  };
  const changed = () => {
    setRequest(undefined);
    setMessage('Đã lưu thay đổi và ghi nhận lịch sử.');
    setVersion((value) => value + 1);
  };
  const managedApplications = (
    canRead(me, tenantId, 'applications') ? (data.applications ?? []) : applications
  ).filter((row) => row.status !== 'planned' || !row.protected);
  const options = { ...data, applications: managedApplications },
    overviewTitle =
      mode === 'organization'
        ? 'Sơ đồ tổ chức'
        : mode === 'people'
          ? 'Danh bạ & hồ sơ'
          : 'Ma trận phân quyền';
  const canView = canRead(
    me,
    tenantId,
    mode === 'organization' ? 'org-units' : mode === 'people' ? 'people' : 'roles',
  );
  return (
    <Tabs
      value={tab}
      onValueChange={(value) => {
        setTab(value);
        setMessage('');
      }}
      className="min-w-0 space-y-5"
      role="region"
      aria-label="Không gian quản trị tổ chức"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <TabsList className="h-auto w-fit max-w-full flex-wrap">
          <TabsTrigger value="overview">{overviewTitle}</TabsTrigger>
          {groups[mode].map((key) => (
            <TabsTrigger key={key} value={key}>
              {resourceByKey[key]!.title}
            </TabsTrigger>
          ))}
          {mode === 'people' && (
            <TabsTrigger value="personnel-operations">
              Tiếp nhận / Điều chuyển / Nghỉ việc
            </TabsTrigger>
          )}
          {mode !== 'access' && <TabsTrigger value="organization-import">Nhập Excel</TabsTrigger>}
          {mode !== 'access' && <TabsTrigger value="metadata">Thông tin mở rộng</TabsTrigger>}
        </TabsList>
        <Button
          variant="outline"
          onClick={() => {
            setRequest(undefined);
            setVersion((value) => value + 1);
          }}
          aria-label="Tải lại không gian quản trị"
        >
          <RefreshCw className="size-4" />
          <span className="hidden sm:inline">Tải lại</span>
        </Button>
      </div>
      {mode === 'access' && (
        <div className="max-w-md space-y-2">
          <p className="text-sm font-medium">Ứng dụng đang quản trị</p>
          <Select
            value={appCode}
            onValueChange={(value) => {
              setAppCode(value);
              setRequest(undefined);
              setMessage('');
            }}
          >
            <SelectTrigger className="w-full" aria-label="Chọn ứng dụng quản trị">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {managedApplications.map((row) => (
                <SelectItem key={String(row.code)} value={String(row.code)}>
                  {String(row.name)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      {message && tab === 'overview' && (
        <Alert className="status-success" role="status">
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )}
      {loading && tab === 'overview' && (
        <div role="status" aria-label="Đang tải cơ cấu và nhân sự" className="space-y-4">
          <Skeleton className="h-24" />
          <Skeleton className="h-96" />
        </div>
      )}
      {Boolean(error) && (
        <Alert variant="destructive">
          <AlertDescription>{errorMessage(error)}</AlertDescription>
        </Alert>
      )}
      <div hidden={(loading && tab === 'overview') || !!error}>
        <TabsContent value={tab}>
          {tab === 'overview' ? (
            !canView ? (
              <Alert>
                <AlertDescription>Bạn chưa được cấp quyền xem phần quản trị này.</AlertDescription>
              </Alert>
            ) : mode === 'organization' ? (
              <OrganizationView
                data={data}
                me={me}
                tenantId={tenantId}
                edit={edit}
                openPerson={onPerson}
              />
            ) : mode === 'people' ? (
              <PeopleView
                data={data}
                me={me}
                tenantId={tenantId}
                edit={edit}
                initialPersonId={initialPersonId}
                applications={managedApplications}
                version={version}
                onIdentity={onIdentity}
              />
            ) : (
              <AccessView data={data} me={me} tenantId={tenantId} edit={edit} />
            )
          ) : tab === 'metadata' ? (
            <MetadataWorkspace
              key={tenantId + mode}
              me={me}
              tenantId={tenantId}
              people={mode === 'people'}
            />
          ) : tab === 'organization-import' ? (
            <OrganizationImportPanel
              key={tenantId}
              me={me}
              tenantId={tenantId}
              onChanged={changed}
            />
          ) : tab === 'personnel-operations' ? (
            <PersonnelPanel
              key={tenantId}
              me={me}
              tenantId={tenantId}
              options={options}
              onChanged={changed}
            />
          ) : (
            <ResourcePanel
              key={tab + appCode}
              refreshVersion={version}
              resource={resourceByKey[tab]!}
              me={me}
              tenantId={tenantId}
              appCode={appCode}
              options={options}
              onChanged={changed}
            />
          )}
        </TabsContent>
      </div>
      {!loading && !error && request && (
        <ResourcePanel
          key={request.key}
          editorOnly
          request={request}
          resource={resourceByKey[request.resource]!}
          me={me}
          tenantId={tenantId}
          appCode={appCode}
          options={options}
          onChanged={changed}
        />
      )}
    </Tabs>
  );
}
