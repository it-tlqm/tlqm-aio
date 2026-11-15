import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from '@/components/ui/table';
import { api, allowed } from '@/lib/api';
import type { Me } from '@/lib/api';
import { errorMessage } from '@/lib/messages';
type Preview = {
  snapshot: string;
  canCommit: boolean;
  items: { sheet: string; row: number; name: string }[];
  errors: { sheet: string; row: number; column: string; message: string }[];
};
export function OrganizationImportPanel({
  me,
  tenantId,
  onChanged,
}: {
  me: Me;
  tenantId: string;
  onChanged: () => void;
}) {
  const [file, setFile] = useState(''),
    [name, setName] = useState(''),
    [preview, setPreview] = useState<Preview | null>(null),
    [reason, setReason] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [done, setDone] = useState(''),
    [key, setKey] = useState(() => crypto.randomUUID());
  const permitted = ['directory:read', 'directory:manage', 'people:read', 'people:manage'].every(
    (p) => allowed(me, tenantId, p),
  );
  async function choose(selected?: File) {
    setPreview(null);
    setFile('');
    setError('');
    setDone('');
    setKey(crypto.randomUUID());
    if (!selected) return;
    setName(selected.name);
    if (!/\.xlsx$/i.test(selected.name) || selected.size > 2 * 1024 * 1024) {
      setError('Chọn tệp .xlsx tối đa 2 MB.');
      return;
    }
    setBusy(true);
    try {
      const bytes = new Uint8Array(await selected.arrayBuffer());
      let text = '';
      for (let i = 0; i < bytes.length; i += 8192)
        text += String.fromCharCode(...bytes.subarray(i, i + 8192));
      setFile(btoa(text));
    } catch {
      setError('Không đọc được tệp.');
    } finally {
      setBusy(false);
    }
  }
  async function run(commit: boolean) {
    setBusy(true);
    setError('');
    try {
      const response = await api<Preview>(
        '/api/v1/manage/organization-import/' + (commit ? 'commit' : 'preview'),
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-csrf-token': me.csrfToken,
            ...(commit ? { 'idempotency-key': key } : {}),
          },
          body: JSON.stringify({
            tenantId,
            file,
            ...(commit ? { snapshot: preview!.snapshot, reason } : {}),
          }),
        },
      );
      if (commit) {
        setDone('Đã nhập toàn bộ ' + response.items.length + ' dòng và ghi lịch sử.');
        setPreview(null);
        setFile('');
        onChanged();
      } else {
        setPreview(response);
        setKey(crypto.randomUUID());
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  if (!permitted)
    return (
      <Alert>
        <AlertDescription>
          Cần quyền quản trị cơ cấu và nhân sự trên toàn không gian để nhập Excel.
        </AlertDescription>
      </Alert>
    );
  return (
    <div className="space-y-5">
      <Card>
        <CardHeader>
          <CardTitle role="heading" aria-level={2}>
            Nhập cơ cấu & nhân sự từ Excel
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Tối đa 500 dòng trong tệp .xlsx 2 MB. Chỉ tạo mới, báo lỗi khi mã đã tồn tại; không tạo
            tài khoản SSO hoặc cấp quyền.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <a
            className="inline-flex min-h-11 items-center rounded-md border bg-white px-4 text-sm font-medium"
            href={
              '/api/v1/manage/organization-import/template?tenantId=' + encodeURIComponent(tenantId)
            }
          >
            Tải tệp mẫu Excel
          </a>
          <div className="rounded-lg bg-muted p-4 text-sm space-y-2">
            <p>
              Điền các sheet DonVi, ChucDanh, ViTri, NhanSu; giữ nguyên tiêu đề. Pháp nhân phải có
              trước.
            </p>
            <p>
              ViTri.MaNhap là mã tham chiếu trong tệp. NhanSu.ViTri nhận mã đó hoặc ID vị trí hiện
              có. NgayBatDau dùng YYYY-MM-DD; đặt mã nhân sự ở dạng văn bản để giữ số 0 đầu.
            </p>
            <p>
              NhanSuId để trống sẽ tạo hồ sơ mới; chỉ nhập ID đã đối soát nếu muốn bổ sung quan hệ
              công tác cho người có sẵn. Không ghép người bằng tên/email.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="organization-file">Tệp dữ liệu</Label>
            <Input
              id="organization-file"
              type="file"
              accept=".xlsx"
              disabled={busy}
              onChange={(e) => void choose(e.target.files?.[0])}
            />
            {name && <p className="text-sm text-muted-foreground">{name}</p>}
          </div>
          <Button disabled={busy || !file} onClick={() => void run(false)}>
            Kiểm tra & xem trước
          </Button>
        </CardContent>
      </Card>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {done && (
        <Alert className="status-success" role="status">
          <AlertDescription>{done}</AlertDescription>
        </Alert>
      )}
      {preview && (
        <Card>
          <CardHeader>
            <CardTitle role="heading" aria-level={2}>
              Kết quả kiểm tra · {preview.items.length} dòng hợp lệ · {preview.errors.length} lỗi
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm">
              Chưa ghi dữ liệu.{' '}
              {preview.canCommit
                ? 'Bạn có thể xác nhận nhập toàn bộ.'
                : 'Sửa các dòng lỗi và tải lại tệp; không nhập một phần.'}
            </p>
            <div className="max-h-96 overflow-auto">
              <Table
                containerProps={{ tabIndex: 0, role: 'region', 'aria-label': 'Kết quả nhập Excel' }}
              >
                <TableHeader>
                  <TableRow>
                    <TableHead>Sheet</TableHead>
                    <TableHead>Dòng</TableHead>
                    <TableHead>Kết quả</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {preview.errors.map((e, i) => (
                    <TableRow key={'error' + i}>
                      <TableCell>{e.sheet}</TableCell>
                      <TableCell>{e.row || '—'}</TableCell>
                      <TableCell className="text-destructive">
                        {e.column ? e.column + ': ' : ''}
                        {e.message}
                      </TableCell>
                    </TableRow>
                  ))}
                  {preview.items.map((item, i) => (
                    <TableRow key={'ok' + i}>
                      <TableCell>{item.sheet}</TableCell>
                      <TableCell>{item.row}</TableCell>
                      <TableCell>Hợp lệ · {item.name}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="space-y-2">
              <Label htmlFor="import-reason">Lý do nhập dữ liệu</Label>
              <Input
                id="import-reason"
                disabled={busy}
                value={reason}
                maxLength={240}
                onChange={(e) => {
                  setReason(e.target.value);
                  setKey(crypto.randomUUID());
                }}
              />
            </div>
            <Button
              disabled={busy || !preview.canCommit || reason.trim().length < 5}
              onClick={() => void run(true)}
            >
              Xác nhận nhập toàn bộ
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
