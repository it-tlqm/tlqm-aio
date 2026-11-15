import { CheckCircle2, XCircle, Award, ArrowLeft } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { AttemptResult } from './course-api';
import { answerText } from './answer-fields';
import { CertificateButton } from './certificate';
export function AttemptReadback({
  result,
  onBack,
  csrfToken,
  onAccessError,
}: {
  result: AttemptResult;
  onBack: () => void;
  csrfToken: string;
  onAccessError: (error: unknown) => void;
}) {
  return (
    <div className="space-y-5">
      <Button variant="ghost" onClick={onBack}>
        <ArrowLeft />
        Quay lại
      </Button>
      <Card>
        <CardHeader>
          <CardTitle role="heading" aria-level={2}>
            Kết quả bài kiểm tra
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center justify-between gap-5">
          <div>
            <p className="text-lg font-semibold">{result.lessonTitle}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Phiên bản {result.version} · {new Date(result.createdAt).toLocaleString('vi-VN')}
            </p>
            {result.tracking === 'self-confirmed' && (
              <p className="mt-2 text-xs text-muted-foreground">
                Mốc học video do học viên tự xác nhận.
              </p>
            )}
            <Badge
              className={'mt-3 ' + (result.passed ? 'status-success' : 'status-warning')}
              variant="outline"
            >
              <Award />
              {result.passed
                ? 'Đạt yêu cầu'
                : `Chưa đạt · Cần từ ${result.policy?.passScore ?? 80} điểm`}
            </Badge>
          </div>
          <p className="text-4xl font-semibold text-[var(--brand-navy)]">
            {result.score}
            <span className="text-base font-normal text-muted-foreground"> / 100</span>
          </p>
          {result.passed && (
            <CertificateButton
              attemptId={result.id}
              csrfToken={csrfToken}
              onAccessError={onAccessError}
            />
          )}
        </CardContent>
      </Card>
      <p className="text-sm text-muted-foreground">
        Bản xem lại giữ nguyên câu hỏi và đáp án tại thời điểm nộp bài.
      </p>
      {result.review.map((question, index) => (
        <Card key={question.id} className="shadow-none">
          <CardHeader>
            <CardTitle role="heading" aria-level={3} className="flex items-start gap-3">
              {question.correct ? (
                <CheckCircle2
                  className="size-5 shrink-0 text-[var(--success)]"
                  aria-hidden="true"
                />
              ) : (
                <XCircle className="size-5 shrink-0 text-destructive" aria-hidden="true" />
              )}
              <span>
                {index + 1}. {question.question}
              </span>
            </CardTitle>
            <Badge
              variant="outline"
              className={question.correct ? 'status-success' : 'status-danger'}
            >
              {question.correct ? 'Đúng' : 'Chưa đúng'}
            </Badge>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p>
              <span className="font-medium">Bạn trả lời: </span>
              {answerText(question, question.selected)}
            </p>
            <p>
              <span className="font-medium">Đáp án đúng: </span>
              {answerText(question, question.correctAnswer)}
            </p>
            {question.explanation && (
              <p className="rounded-lg bg-secondary p-4 leading-6">{question.explanation}</p>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
