import { useId } from 'react';
import { RadioGroup as RadioPrimitive } from 'radix-ui';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import type { Question, Answer } from '../../../src/lms/course-contracts';
export function AnswerFields({
  question,
  value,
  onChange,
  disabled = false,
}: {
  question: Question;
  value: Answer | undefined;
  onChange: (answer: Answer) => void;
  disabled?: boolean;
}) {
  const id = useId();
  if (question.type === 'text')
    return (
      <div className="space-y-2">
        <Label htmlFor={id}>Câu trả lời</Label>
        <Textarea
          id={id}
          value={typeof value === 'string' ? value : ''}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          maxLength={2000}
        />
      </div>
    );
  if (question.type === 'multiple')
    return (
      <fieldset className="space-y-2">
        <legend className="mb-2 text-xs text-muted-foreground">Chọn tất cả đáp án phù hợp</legend>
        {question.options.map((option, index) => (
          <label
            key={index}
            className="flex cursor-pointer items-center gap-2 rounded-lg border bg-card p-2"
          >
            <Checkbox
              checked={Array.isArray(value) && value.includes(index)}
              disabled={disabled}
              onCheckedChange={(checked) =>
                onChange(
                  checked
                    ? [...(Array.isArray(value) ? value : []), index]
                    : (Array.isArray(value) ? value : []).filter((item) => item !== index),
                )
              }
            />
            <span>{option}</span>
          </label>
        ))}
      </fieldset>
    );
  return (
    <RadioPrimitive.Root
      aria-label="Chọn một đáp án"
      value={typeof value === 'number' ? String(value) : ''}
      onValueChange={(item) => onChange(Number(item))}
      disabled={disabled}
      className="space-y-2"
    >
      {question.options.map((option, index) => (
        <label
          key={index}
          className="flex cursor-pointer items-center gap-2 rounded-lg border bg-card p-2"
        >
          <RadioPrimitive.Item
            value={String(index)}
            className="group flex size-11 min-w-11 items-center justify-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            <span className="flex size-5 items-center justify-center rounded-full border border-input group-data-[state=checked]:border-primary">
              <RadioPrimitive.Indicator className="size-2.5 rounded-full bg-primary" />
            </span>
          </RadioPrimitive.Item>
          <span>{option}</span>
        </label>
      ))}
    </RadioPrimitive.Root>
  );
}
export function answerText(question: Question, value: Answer | null) {
  return Array.isArray(value)
    ? value.map((index) => question.options[index] ?? String(index)).join(', ')
    : typeof value === 'number'
      ? (question.options[value] ?? String(value))
      : (value ?? 'Chưa trả lời');
}
