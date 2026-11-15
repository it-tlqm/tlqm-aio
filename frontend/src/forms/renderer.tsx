import { fieldState, schemaFields } from '../../../src/forms/contracts';
import { isNumericField, isTemporalField, temporalInputType } from '../../../src/forms/field-types';
import type { Answers, FormSchema, FormIssue } from '../../../src/forms/contracts';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { issueText } from './common';
import { BusinessTable } from './business-table';
import { ReferencePicker } from './reference-picker';
import type { ReferenceContext } from './reference-picker';
import { isReferenceAnswer } from '../../../src/forms/references';
import { AttachmentLinks, AttachmentPicker } from './attachment-field';
import type { AttachmentContext } from './attachment-field';

export function FormRenderer({
  schema,
  answers,
  onChange,
  issues = [],
  disabled = false,
  readOnlyFields = [],
  referenceContext,
  attachmentContext,
}: {
  schema: FormSchema;
  answers: Answers;
  onChange: (answers: Answers) => void;
  issues?: FormIssue[];
  disabled?: boolean;
  readOnlyFields?: string[];
  referenceContext?: ReferenceContext;
  attachmentContext?: AttachmentContext;
}) {
  const state = fieldState(schema, answers);
  function change(id: string, value: Answers[string] | undefined) {
    const next = { ...answers };
    if (value === undefined) delete next[id];
    else next[id] = value;
    onChange(fieldState(schema, next).answers);
  }
  return (
    <div className="space-y-5">
      {schema.sections.map((section) => (
        <Card key={section.id}>
          <CardHeader>
            <CardTitle>{section.title}</CardTitle>
            {section.description && <CardDescription>{section.description}</CardDescription>}
          </CardHeader>
          <CardContent className="space-y-6">
            {section.fields
              .filter((field) => state.visible[field.id])
              .map((field) => {
                const error = issues.find(
                  (issue) =>
                    issue.path === 'answers.' + field.id ||
                    issue.path.startsWith('answers.' + field.id + '.'),
                );
                const labelId = 'label-' + field.id,
                  controlId = 'answer-' + field.id,
                  helpId = 'help-' + field.id;
                const value = state.answers[field.id];
                const common = {
                  id: controlId,
                  disabled: disabled || readOnlyFields.includes(field.id),
                  'aria-labelledby': labelId,
                  'aria-describedby': helpId,
                  'aria-invalid': !!error,
                };
                return (
                  <div className="space-y-2" key={field.id} data-form-field={field.id}>
                    <Label id={labelId} htmlFor={controlId}>
                      {field.label}
                      {state.required[field.id] && (
                        <span className="ml-1 text-destructive">
                          *<span className="sr-only">Bắt buộc</span>
                        </span>
                      )}
                    </Label>
                    {field.type === 'shortText' && (
                      <Input
                        {...common}
                        value={typeof value === 'string' ? value : ''}
                        maxLength={field.maxLength}
                        onChange={(event) => change(field.id, event.target.value)}
                      />
                    )}
                    {field.type === 'longText' && (
                      <Textarea
                        {...common}
                        value={typeof value === 'string' ? value : ''}
                        maxLength={field.maxLength}
                        onChange={(event) => change(field.id, event.target.value)}
                      />
                    )}
                    {isNumericField(field.type) && (
                      <Input
                        {...common}
                        type="number"
                        step={field.type === 'integer' ? 1 : 'any'}
                        min={field.min}
                        max={field.max}
                        value={typeof value === 'number' ? value : ''}
                        onChange={(event) =>
                          change(
                            field.id,
                            event.target.value === '' ? undefined : Number(event.target.value),
                          )
                        }
                      />
                    )}
                    {isTemporalField(field.type) && (
                      <Input
                        {...common}
                        type={temporalInputType(field.type)}
                        min={field.minDate}
                        max={field.maxDate}
                        value={typeof value === 'string' ? value : ''}
                        onChange={(event) => change(field.id, event.target.value || undefined)}
                      />
                    )}
                    {(field.type === 'singleChoice' || field.type === 'boolean') && (
                      <Select
                        disabled={disabled || readOnlyFields.includes(field.id)}
                        value={value === undefined ? '_empty' : String(value)}
                        onValueChange={(value) =>
                          change(
                            field.id,
                            value === '_empty'
                              ? undefined
                              : field.type === 'boolean'
                                ? value === 'true'
                                : value,
                          )
                        }
                      >
                        <SelectTrigger {...common} className="w-full">
                          <SelectValue placeholder="Chọn câu trả lời" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="_empty">Chưa chọn</SelectItem>
                          {(field.type === 'boolean'
                            ? [
                                { id: 'true', label: 'Có' },
                                { id: 'false', label: 'Không' },
                              ]
                            : (state.options[field.id] ?? [])
                          ).map((option) => (
                            <SelectItem key={option.id} value={option.id}>
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                    {field.type === 'multipleChoice' && (
                      <div
                        role="group"
                        aria-labelledby={labelId}
                        aria-describedby={helpId}
                        className="space-y-1"
                      >
                        {(state.options[field.id] ?? []).map((option) => (
                          <Label
                            key={option.id}
                            className="flex min-h-11 cursor-pointer items-center gap-4 rounded-md border p-3"
                            htmlFor={controlId + '-' + option.id}
                          >
                            <Checkbox
                              id={controlId + '-' + option.id}
                              disabled={disabled || readOnlyFields.includes(field.id)}
                              checked={Array.isArray(value) && value.includes(option.id)}
                              onCheckedChange={(checked) =>
                                change(
                                  field.id,
                                  checked
                                    ? [...(Array.isArray(value) ? value : []), option.id]
                                    : (Array.isArray(value) ? value : []).filter(
                                        (item) => item !== option.id,
                                      ),
                                )
                              }
                            />
                            {option.label}
                          </Label>
                        ))}
                      </div>
                    )}
                    {field.type === 'money' && (
                      <Input
                        {...common}
                        inputMode="decimal"
                        maxLength={20}
                        value={typeof value === 'string' ? value : ''}
                        placeholder={'0.00 ' + field.currency}
                        onChange={(e) => change(field.id, e.target.value || undefined)}
                      />
                    )}
                    {(field.type === 'person' || field.type === 'orgUnit') && (
                      <ReferencePicker
                        {...common}
                        kind={field.type}
                        value={value}
                        context={referenceContext}
                        onChange={(v) => change(field.id, v)}
                      />
                    )}
                    {field.type === 'attachment' && (
                      <AttachmentPicker
                        {...common}
                        field={field}
                        value={value}
                        context={attachmentContext}
                        onChange={(ids) => change(field.id, ids)}
                      />
                    )}
                    {field.type === 'table' && (
                      <BusinessTable
                        field={field}
                        value={value}
                        disabled={disabled || readOnlyFields.includes(field.id)}
                        onChange={(v) => change(field.id, v)}
                      />
                    )}
                    <div
                      id={helpId}
                      className={
                        error ? 'text-sm text-destructive' : 'text-sm text-muted-foreground'
                      }
                    >
                      {error
                        ? issueText(error.code)
                        : (field.description ??
                          (isNumericField(field.type) &&
                          (field.min !== undefined || field.max !== undefined)
                            ? `Giới hạn: ${field.min ?? 'không giới hạn'} đến ${field.max ?? 'không giới hạn'}`
                            : ''))}
                    </div>
                  </div>
                );
              })}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
export function AnswerReadback({
  schema,
  answers,
  attachmentContext,
}: {
  schema: FormSchema;
  answers: Answers;
  attachmentContext?: AttachmentContext;
}) {
  const state = fieldState(schema, answers);
  return (
    <dl className="space-y-4">
      {schemaFields(schema)
        .filter((field) => state.visible[field.id])
        .map((field) => {
          const value = answers[field.id];
          const format = (value: unknown) =>
            field.options?.find((option) => option.id === value)?.label ??
            (field.type === 'percentage' && typeof value === 'number'
              ? value + '%'
              : field.type === 'dateTime' && typeof value === 'string'
                ? value.replace('T', ' ')
                : typeof value === 'boolean'
                  ? value
                    ? 'Có'
                    : 'Không'
                  : String(value ?? 'Chưa trả lời'));
          return (
            <div key={field.id}>
              <dt className="font-medium text-[var(--brand-navy)]">{field.label}</dt>
              <dd className="mt-1 whitespace-pre-wrap break-words text-sm">
                {field.type === 'attachment' ? (
                  Array.isArray(value) && value.length ? (
                    <AttachmentLinks ids={value} context={attachmentContext} />
                  ) : (
                    'Chưa đính kèm'
                  )
                ) : field.type === 'table' ? (
                  <BusinessTable field={field} value={value} />
                ) : isReferenceAnswer(value) ? (
                  <span>
                    {value.label}
                    <span className="ml-2 text-xs text-muted-foreground">{value.id.slice(-8)}</span>
                  </span>
                ) : Array.isArray(value) ? (
                  value.map(format).join(', ') || 'Chưa trả lời'
                ) : (
                  format(value)
                )}
              </dd>
            </div>
          );
        })}
    </dl>
  );
}
