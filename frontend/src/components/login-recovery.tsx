import { ArrowRight, RotateCcw } from 'lucide-react';
import { Brand } from '@/components/brand';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';

export function LoginRecovery() {
  const loginUrl = location.port === '5173' ? 'http://127.0.0.1:4100/auth/login' : '/auth/login';
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-5 py-12">
      <Card className="w-full max-w-lg">
        <CardHeader className="space-y-7">
          <Brand />
          <div className="space-y-3">
            <span className="inline-flex size-12 items-center justify-center rounded-lg bg-secondary text-primary">
              <RotateCcw className="size-6" aria-hidden="true" />
            </span>
            <h1 className="text-2xl font-semibold text-[var(--brand-navy)]">
              Cần bắt đầu lại đăng nhập
            </h1>
            <p className="text-sm leading-6 text-[var(--text-secondary)]">
              Liên kết đăng nhập không còn hiệu lực. Hãy mở lượt đăng nhập mới để tiếp tục vào ứng
              dụng.
            </p>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          <Button className="w-full" asChild>
            <a href={loginUrl}>
              Đăng nhập lại <ArrowRight aria-hidden="true" />
            </a>
          </Button>
          <p className="text-sm leading-6 text-muted-foreground">
            Tiếp tục trong cùng trình duyệt và tab vừa mở. Nếu thông báo này lặp lại, hãy kiểm tra
            trình duyệt có cho phép cookie hay không.
          </p>
          <Button variant="ghost" className="w-full" asChild>
            <a href="/">Về trang ứng dụng</a>
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
