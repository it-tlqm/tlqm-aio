import { useEffect, useRef, useState } from 'react';
import { Check, Copy, Link2, RefreshCw, ShieldAlert } from 'lucide-react';
import { api, apiCollection, allowed } from '@/lib/api';
import type { Me } from '@/lib/api';
import { errorMessage } from '@/lib/messages';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog';

type Proof = { code: string; issuer: string; subject: string; expiresAt: string };
type Target = {
  id: string;
  displayName: string;
  revision: number;
  active: boolean;
  personActive: boolean;
  isProtected: boolean;
};
type LinkedIdentity = {
  id: string;
  issuer: string;
  subject: string;
  active: boolean;
  revision: number;
  verificationMethod: string;
  verifiedAt: string | null;
};
type Preview = Omit<Proof, 'code'> & {
  accountId: string;
  accountRevision: number;
  displayName: string;
};
type Change = { kind: 'link' | 'revoke' | 'offboard' | 'toggle'; identity?: LinkedIdentity };

export function IdentityProofScreen() {
  const [proof, setProof] = useState<Proof | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    void api<Proof>('/api/v1/identity-proof', { signal: controller.signal })
      .then(setProof)
      .catch((error) => {
        if (!controller.signal.aborted) setError(error);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);
  return (
    <main className="mx-auto flex min-h-screen max-w-xl items-center px-5 py-12">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>Xác minh tài khoản SSO</CardTitle>
          <CardDescription>
            Mã xác minh dùng một lần để quản trị viên liên kết đúng hồ sơ nhân sự.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {loading ? (
            <Skeleton className="h-40" />
          ) : error ? (
            <Alert variant="destructive">
              <AlertDescription>{errorMessage(error)}</AlertDescription>
            </Alert>
          ) : (
            proof && (
              <>
                <div className="space-y-2 break-all text-sm">
                  <p>
                    <strong>Nguồn đăng nhập:</strong> {proof.issuer}
                  </p>
                  <p>
                    <strong>Định danh SSO:</strong> {proof.subject}
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="identity-verification-code">Mã xác minh</Label>
                  <Input
                    id="identity-verification-code"
                    type="password"
                    autoComplete="off"
                    readOnly
                    value={proof.code}
                  />
                  <p className="text-sm text-muted-foreground">
                    Hết hiệu lực lúc {new Date(proof.expiresAt).toLocaleTimeString('vi')}. Chỉ gửi
                    mã cho quản trị viên đang phụ trách liên kết hồ sơ của bạn.
                  </p>
                </div>
                <Button
                  className="w-full"
                  onClick={() =>
                    void navigator.clipboard
                      .writeText(proof.code)
                      .then(() => setCopied(true))
                      .catch(setError)
                  }
                >
                  {copied ? <Check /> : <Copy />}
                  {copied ? 'Đã sao chép mã' : 'Sao chép mã xác minh'}
                </Button>
                <p className="text-sm text-muted-foreground">
                  Sau khi được liên kết, quyền ứng dụng vẫn cần được quản trị viên cấp riêng.
                </p>
              </>
            )
          )}
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" asChild>
              <a href="/auth/identity-proof">Xác minh lại</a>
            </Button>
            <Button variant="ghost" asChild>
              <a href="/auth/login?reauth=1">Đăng nhập sau khi liên kết</a>
            </Button>
          </div>
        </CardContent>
      </Card>
    </main>
  );
}

export function IdentityPanel({
  me,
  tenantId,
  onChanged,
}: {
  me: Me;
  tenantId: string;
  onChanged: () => void;
}) {
  const canLink = allowed(me, tenantId, 'identity:link');
  const canManage = allowed(me, tenantId, 'accounts:manage');
  const [targets, setTargets] = useState<Target[]>([]);
  const [accountId, setAccountId] = useState('');
  const [identities, setIdentities] = useState<LinkedIdentity[]>([]);
  const [proofCode, setProofCode] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [message, setMessage] = useState('');
  const [change, setChange] = useState<Change | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const mutationKey = useRef(crypto.randomUUID());
  const target = targets.find((item) => item.id === accountId);
  const protectedTarget = target?.isProtected || target?.id === me.accountId;
  useEffect(() => {
    if (!canLink && !canManage) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setTargets([]);
    void apiCollection<Target>('/api/v1/manage/identity-targets?tenantId=' + tenantId, {
      signal: controller.signal,
    })
      .then((result) => {
        if (controller.signal.aborted) return;
        setTargets(result.items);
        setAccountId((previous) =>
          result.items.some((item) => item.id === previous) ? previous : '',
        );
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(error);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [tenantId, reload, canLink, canManage]);
  useEffect(() => {
    setPreview(null);
    setProofCode('');
    setIdentities([]);
    if (!accountId || !canLink) return;
    const controller = new AbortController();
    void api<{ items: LinkedIdentity[] }>(
      '/api/v1/manage/identities?' + new URLSearchParams({ tenantId, accountId }),
      { signal: controller.signal },
    )
      .then((result) => setIdentities(result.items))
      .catch((error) => {
        if (!controller.signal.aborted) setError(error);
      });
    return () => controller.abort();
  }, [accountId, tenantId, reload, canLink]);
  async function inspectProof() {
    setBusy(true);
    setError(null);
    setPreview(null);
    setMessage('');
    try {
      setPreview(
        await api<Preview>('/api/v1/manage/identities/preview', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-csrf-token': me.csrfToken },
          body: JSON.stringify({ tenantId, accountId, proofCode: proofCode.trim() }),
        }),
      );
    } catch (error) {
      setError(error);
    } finally {
      setBusy(false);
    }
  }
  function prepare(value: Change) {
    setReasonError('');
    setMessage('');
    setError(null);
    if (reason.trim().length < 5) {
      setReasonError('Nhập lý do thay đổi, tối thiểu 5 ký tự.');
      return;
    }
    trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    mutationKey.current = crypto.randomUUID();
    setChange(value);
  }
  async function apply() {
    if (!change || !target) return;
    setBusy(true);
    setError(null);
    try {
      let path: string;
      let method = 'POST';
      let body: Record<string, unknown> = { tenantId, reason: reason.trim() };
      if (change.kind === 'link') {
        if (!preview) return;
        path = '/api/v1/manage/identities/link';
        body = {
          ...body,
          accountId,
          proofCode: proofCode.trim(),
          expectedSubject: preview.subject,
          expectedAccountRevision: preview.accountRevision,
        };
      } else if (change.kind === 'revoke') {
        path = '/api/v1/manage/identities/' + change.identity!.id + '/revoke';
        body.expectedRevision = change.identity!.revision;
      } else if (change.kind === 'offboard') {
        path = '/api/v1/manage/accounts/' + accountId + '/offboard';
        body.expectedRevision = target.revision;
      } else {
        path = '/api/v1/manage/accounts/' + accountId;
        method = 'PATCH';
        body = { ...body, data: { active: !target.active }, expectedRevision: target.revision };
      }
      await api(path, {
        method,
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': me.csrfToken,
          'idempotency-key': mutationKey.current,
        },
        body: JSON.stringify(body),
      });
      setChange(null);
      setProofCode('');
      setPreview(null);
      setReason('');
      setMessage('Đã cập nhật và ghi nhận lịch sử.');
      setReload((value) => value + 1);
      onChanged();
    } catch (error) {
      setError(error);
    } finally {
      setBusy(false);
    }
  }
  if (!canLink && !canManage)
    return (
      <Alert>
        <ShieldAlert />
        <AlertDescription>
          Bạn chưa được cấp quyền quản lý định danh trong không gian này.
        </AlertDescription>
      </Alert>
    );
  const description =
    change?.kind === 'link'
      ? 'Đối chiếu đúng định danh SSO và hồ sơ đích trước khi liên kết. Quyền ứng dụng được cấp riêng.'
      : change?.kind === 'revoke'
        ? 'Liên kết bị vô hiệu và các phiên cũ của tài khoản bị thu hồi. Lịch sử và chủ sở hữu định danh được giữ nguyên.'
        : change?.kind === 'offboard'
          ? 'Khóa tài khoản, kết thúc phiên và thu hồi toàn bộ grant/role binding trong không gian này. Mở lại tài khoản sẽ không tự cấp lại quyền.'
          : target?.active
            ? 'Khóa tài khoản và kết thúc các phiên đang mở. Sau khi mở lại, người dùng phải xác thực mới.'
            : 'Mở lại tài khoản. Người dùng phải đăng nhập mới; các quyền đã bị thu hồi không tự khôi phục.';
  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">Định danh & vòng đời tài khoản</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Liên kết SSO đã xác minh, quản lý trạng thái và thu hồi truy cập.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => {
            setReload((value) => value + 1);
            setPreview(null);
          }}
        >
          <RefreshCw />
          Tải lại định danh
        </Button>
      </div>
      {message && (
        <p role="status" className="status-success rounded-md p-3 text-sm">
          {message}
        </p>
      )}
      {error && !change ? (
        <Alert variant="destructive">
          <AlertDescription>{errorMessage(error)}</AlertDescription>
        </Alert>
      ) : null}
      {loading ? (
        <Skeleton className="h-28" />
      ) : (
        <Card>
          <CardContent className="space-y-3 pt-6">
            <Label htmlFor="identity-target">Tài khoản đích</Label>
            <Select
              value={accountId}
              onValueChange={(value) => {
                setAccountId(value);
                setError(null);
                setMessage('');
                setReason('');
              }}
            >
              <SelectTrigger id="identity-target" className="w-full">
                <SelectValue placeholder="Chọn tài khoản cần quản lý" />
              </SelectTrigger>
              <SelectContent>
                {targets.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.displayName} · {item.id.slice(0, 8)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!targets.length && (
              <p className="text-sm text-muted-foreground">
                Chưa có tài khoản trong không gian này.
              </p>
            )}
            {target && (
              <div className="flex flex-wrap gap-2">
                <Badge className={target.active ? 'status-success' : 'status-warning'}>
                  {target.active ? 'Đang hoạt động' : 'Đã khóa'}
                </Badge>
                {protectedTarget && <Badge variant="secondary">Tài khoản được bảo vệ</Badge>}
              </div>
            )}
          </CardContent>
        </Card>
      )}
      {target && (
        <>
          <div className="space-y-2">
            <Label htmlFor="identity-reason">Lý do thay đổi</Label>
            <Textarea
              id="identity-reason"
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
                setReasonError('');
              }}
              aria-invalid={!!reasonError}
              aria-describedby={reasonError ? 'identity-reason-error' : undefined}
            />
            {reasonError && (
              <p id="identity-reason-error" role="alert" className="text-sm text-destructive">
                {reasonError}
              </p>
            )}
          </div>
          <div className="grid gap-5 xl:grid-cols-2">
            {canLink && (
              <Card>
                <CardHeader>
                  <CardTitle>Liên kết SSO đã xác minh</CardTitle>
                  <CardDescription>
                    Người dùng tự xác thực tại “Tạo mã xác minh SSO”, sau đó gửi mã dùng một lần cho
                    quản trị viên.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <Label htmlFor="identity-proof-input">Mã xác minh do người dùng cung cấp</Label>
                  <Input
                    id="identity-proof-input"
                    type="password"
                    autoComplete="off"
                    value={proofCode}
                    onChange={(event) => {
                      setProofCode(event.target.value);
                      setPreview(null);
                    }}
                    disabled={busy || !!protectedTarget || !target.active}
                  />
                  <Button
                    variant="outline"
                    onClick={() => void inspectProof()}
                    disabled={busy || !!protectedTarget || !target.active || !proofCode.trim()}
                  >
                    Kiểm tra mã xác minh
                  </Button>
                  {preview && (
                    <div className="space-y-2 rounded-md border p-4 text-sm">
                      <p className="break-all">
                        <strong>Nguồn:</strong> {preview.issuer}
                      </p>
                      <p className="break-all">
                        <strong>Định danh SSO:</strong> {preview.subject}
                      </p>
                      <p>
                        <strong>Hồ sơ đích:</strong> {preview.displayName}
                      </p>
                      <p className="text-muted-foreground">
                        Mã hết hiệu lực lúc {new Date(preview.expiresAt).toLocaleTimeString('vi')}.
                      </p>
                      <Button onClick={() => prepare({ kind: 'link' })} disabled={busy}>
                        <Link2 />
                        Liên kết định danh
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}
            {canManage && (
              <Card>
                <CardHeader>
                  <CardTitle>Trạng thái & thu hồi truy cập</CardTitle>
                  <CardDescription>
                    Khóa tài khoản tạm thời hoặc thu hồi quyền khi kết thúc nhu cầu sử dụng. Hồ sơ
                    nhân sự và lịch sử công tác được giữ lại.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <Button
                    variant="outline"
                    disabled={busy || !!protectedTarget || !target.personActive}
                    onClick={() => prepare({ kind: 'toggle' })}
                  >
                    {target.active ? 'Khóa tài khoản' : 'Mở lại tài khoản'}
                  </Button>
                  <Button
                    variant="destructive"
                    className="w-full"
                    disabled={busy || !!protectedTarget || !target.active}
                    onClick={() => prepare({ kind: 'offboard' })}
                  >
                    Khóa và thu hồi toàn bộ quyền
                  </Button>
                  <p className="text-sm text-muted-foreground">
                    Kết thúc quan hệ công tác và bổ nhiệm được ghi theo ngày hiệu lực ở mục Nhân sự
                    & tài khoản; không suy ra quyền từ chức danh.
                  </p>
                </CardContent>
              </Card>
            )}
          </div>
          {canLink && (
            <Card>
              <CardHeader>
                <CardTitle>Liên kết hiện có</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {identities.length ? (
                  identities.map((identity) => (
                    <div
                      key={identity.id}
                      className="flex flex-wrap items-start justify-between gap-3 rounded-md border p-4"
                    >
                      <div className="min-w-0 space-y-1 text-sm">
                        <p className="break-all font-medium">{identity.subject}</p>
                        <p className="break-all text-muted-foreground">{identity.issuer}</p>
                        <Badge className={identity.active ? 'status-success' : 'status-warning'}>
                          {identity.active ? 'Đang liên kết' : 'Đã thu hồi'}
                        </Badge>
                      </div>
                      {identity.active && (
                        <Button
                          variant="outline"
                          disabled={busy || !!protectedTarget || !target.active}
                          onClick={() => prepare({ kind: 'revoke', identity })}
                          aria-label={'Thu hồi liên kết ' + identity.subject}
                        >
                          Thu hồi liên kết
                        </Button>
                      )}
                    </div>
                  ))
                ) : (
                  <p className="text-sm text-muted-foreground">Chưa có liên kết định danh.</p>
                )}
              </CardContent>
            </Card>
          )}
        </>
      )}
      <AlertDialog
        open={!!change}
        onOpenChange={(open) => {
          if (!open && !busy) setChange(null);
        }}
      >
        <AlertDialogContent
          className="sm:max-w-lg"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            trigger.current?.focus();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Xác nhận thay đổi định danh</AlertDialogTitle>
            <AlertDialogDescription>{description}</AlertDialogDescription>
          </AlertDialogHeader>
          <p className="font-medium">{target?.displayName}</p>
          {change?.kind === 'link' && <p className="break-all text-sm">{preview?.subject}</p>}
          <p className="break-words text-sm text-muted-foreground">Lý do: {reason}</p>
          {Boolean(error) && (
            <Alert variant="destructive">
              <AlertDescription>{errorMessage(error)}</AlertDescription>
            </Alert>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Hủy</AlertDialogCancel>
            <Button onClick={() => void apply()} disabled={busy}>
              {busy ? 'Đang xử lý…' : 'Xác nhận thay đổi'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
