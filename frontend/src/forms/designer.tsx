import { useId, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2, Eye } from 'lucide-react';
import {
  parseFormSchema,
  schemaFields,
  fieldTypes,
  requiresBusinessSchema,
} from '../../../src/forms/contracts';
import type {
  FormSchema,
  FormField,
  Condition,
  Answers,
  OptionRule,
} from '../../../src/forms/contracts';
import {
  isBusinessField,
  isNumericField,
  isTemporalField,
  temporalInputType,
} from '../../../src/forms/field-types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Choice, typeLabels, id, formError } from './common';
import { FormRenderer } from './renderer';
import { attachmentFormats, defaultAttachmentField } from '../../../src/forms/attachment-fields';
import { BusinessFieldSettings } from './business-table';
import { purchaseColumns } from '../../../src/forms/business';

function ConditionEditor({
  label,
  value,
  onChange,
  fields,
  advanced = false,
  depth = 1,
}: {
  label: string;
  value: Condition | undefined;
  onChange: (value: Condition | undefined) => void;
  fields: FormField[];
  advanced?: boolean;
  depth?: number;
}) {
  const update = (index: number, rule: Condition['rules'][number]) =>
    onChange({ ...value!, rules: value!.rules.map((item, i) => (i === index ? rule : item)) });
  return (
    <fieldset className="space-y-3 rounded-lg border p-3">
      <legend className="px-1 font-medium">{label}</legend>
      {!value ? (
        <Button
          type="button"
          variant="outline"
          disabled={!fields.length}
          onClick={() =>
            onChange({ mode: 'all', rules: [{ fieldId: fields[0]!.id, operator: 'answered' }] })
          }
        >
          <Plus />
          Thêm điều kiện
        </Button>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
            <Choice
              label={'Cách kết hợp — ' + label}
              value={value.mode}
              onChange={(mode) => onChange({ ...value, mode: mode as 'all' | 'any' })}
              options={[
                { id: 'all', name: 'Tất cả điều kiện' },
                { id: 'any', name: 'Một trong các điều kiện' },
              ]}
            />
            <Button
              type="button"
              variant="ghost"
              className="self-end"
              onClick={() => onChange(undefined)}
            >
              Bỏ điều kiện
            </Button>
          </div>
          {value.rules.map((rule, index) => {
            const source = fields.find((field) => field.id === rule.fieldId);
            const numeric = isNumericField(source?.type ?? '');
            const temporal = source && isTemporalField(source.type) ? source.type : null;
            const operators = [
              { id: 'answered', name: 'Đã trả lời' },
              ...(advanced ? [{ id: 'blank', name: 'Chưa trả lời' }] : []),
              ...(source?.type === 'multipleChoice'
                ? [{ id: 'includes', name: 'Có lựa chọn' }]
                : [
                    { id: 'eq', name: 'Bằng' },
                    { id: 'neq', name: 'Khác' },
                  ]),
              ...(numeric || (advanced && temporal)
                ? [
                    { id: 'gt', name: 'Lớn hơn' },
                    { id: 'gte', name: 'Lớn hơn hoặc bằng' },
                    { id: 'lt', name: 'Nhỏ hơn' },
                    { id: 'lte', name: 'Nhỏ hơn hoặc bằng' },
                  ]
                : []),
            ];
            return (
              <div key={index} className="space-y-3 rounded-md bg-muted p-3">
                <Choice
                  label={label + ' — Câu hỏi ' + (index + 1)}
                  value={rule.fieldId}
                  options={fields.map((field) => ({ id: field.id, name: field.label }))}
                  onChange={(fieldId) => update(index, { fieldId, operator: 'answered' })}
                />
                <Choice
                  label={label + ' — Phép so sánh ' + (index + 1)}
                  value={rule.operator}
                  options={operators}
                  onChange={(operator) =>
                    update(index, {
                      fieldId: rule.fieldId,
                      operator: operator as Condition['rules'][number]['operator'],
                      ...(!['answered', 'blank'].includes(operator)
                        ? {
                            value:
                              source?.type === 'boolean'
                                ? true
                                : numeric
                                  ? 0
                                  : (source?.options?.[0]?.id ?? ''),
                          }
                        : {}),
                    })
                  }
                />
                {!['answered', 'blank'].includes(rule.operator) &&
                  (source?.type === 'boolean' || source?.options ? (
                    <Choice
                      label={label + ' — Giá trị ' + (index + 1)}
                      value={String(rule.value ?? '')}
                      options={
                        source.type === 'boolean'
                          ? [
                              { id: 'true', name: 'Có' },
                              { id: 'false', name: 'Không' },
                            ]
                          : source.options!.map((option) => ({ id: option.id, name: option.label }))
                      }
                      onChange={(value) =>
                        update(index, {
                          ...rule,
                          value: source.type === 'boolean' ? value === 'true' : value,
                        })
                      }
                    />
                  ) : (
                    <div className="space-y-2">
                      <Label htmlFor={label.replaceAll(' ', '-') + '-value-' + index}>
                        Giá trị so sánh
                      </Label>
                      <Input
                        id={label.replaceAll(' ', '-') + '-value-' + index}
                        type={numeric ? 'number' : temporal ? temporalInputType(temporal) : 'text'}
                        value={String(rule.value ?? '')}
                        onChange={(event) =>
                          update(index, {
                            ...rule,
                            value: numeric ? Number(event.target.value) : event.target.value,
                          })
                        }
                      />
                    </div>
                  ))}
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() =>
                    onChange(
                      value.rules.length === 1 && !value.groups?.length
                        ? undefined
                        : { ...value, rules: value.rules.filter((_, i) => i !== index) },
                    )
                  }
                >
                  Xóa điều kiện {index + 1}
                </Button>
              </div>
            );
          })}
          {value.groups?.map((group, index) => (
            <ConditionEditor
              key={index}
              label={label + ' · Nhóm ' + (index + 1)}
              value={group}
              fields={fields}
              advanced={advanced}
              depth={depth + 1}
              onChange={(next) => {
                const groups = value.groups!.flatMap((old, i) =>
                  i !== index ? [old] : next ? [next] : [],
                );
                onChange(
                  groups.length || value.rules.length
                    ? { ...value, groups: groups.length ? groups : undefined }
                    : undefined,
                );
              }}
            />
          ))}
          <Button
            type="button"
            variant="outline"
            disabled={value.rules.length >= 10}
            onClick={() =>
              onChange({
                ...value,
                rules: [...value.rules, { fieldId: fields[0]!.id, operator: 'answered' }],
              })
            }
          >
            <Plus />
            Thêm dòng điều kiện
          </Button>
          {advanced && depth < 3 && (
            <Button
              type="button"
              variant="outline"
              disabled={!fields.length || (value.groups?.length ?? 0) >= 4}
              onClick={() =>
                onChange({
                  ...value,
                  groups: [
                    ...(value.groups ?? []),
                    { mode: 'any', rules: [{ fieldId: fields[0]!.id, operator: 'answered' }] },
                  ],
                })
              }
            >
              <Plus /> Thêm nhóm VÀ / HOẶC
            </Button>
          )}
        </>
      )}
    </fieldset>
  );
}
function OptionRulesEditor({
  options,
  rules,
  fields,
  onChange,
}: {
  options: NonNullable<FormField['options']>;
  rules: OptionRule[];
  fields: FormField[];
  onChange: (rules: OptionRule[]) => void;
}) {
  const prefix = useId();
  const update = (index: number, rule: OptionRule) =>
    onChange(rules.map((old, i) => (i === index ? rule : old)));
  const remove = (index: number) => onChange(rules.filter((_, i) => i !== index));
  const move = (index: number, offset: number) => {
    const next = [...rules];
    [next[index], next[index + offset]] = [next[index + offset]!, next[index]!];
    onChange(next);
  };
  return (
    <fieldset className="min-w-0 space-y-3 rounded-lg border p-3">
      <legend className="px-1 font-medium">Lựa chọn theo điều kiện</legend>
      <p className="text-sm text-muted-foreground">
        Dùng quy tắc đầu tiên thỏa điều kiện. Khi không có quy tắc phù hợp, hiển thị toàn bộ lựa
        chọn.
      </p>
      {rules.map((rule, index) => (
        <div key={index} className="space-y-3 rounded-md border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium">Quy tắc {index + 1}</span>
            <div className="flex gap-1">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={'Đưa quy tắc ' + (index + 1) + ' lên'}
                disabled={index === 0}
                onClick={() => move(index, -1)}
              >
                <ArrowUp />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={'Đưa quy tắc ' + (index + 1) + ' xuống'}
                disabled={index === rules.length - 1}
                onClick={() => move(index, 1)}
              >
                <ArrowDown />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={'Xóa quy tắc ' + (index + 1)}
                onClick={() => remove(index)}
              >
                <Trash2 />
              </Button>
            </div>
          </div>
          <ConditionEditor
            label={'Áp dụng quy tắc ' + (index + 1) + ' khi'}
            value={rule.when}
            fields={fields}
            advanced
            onChange={(when) => (when ? update(index, { ...rule, when }) : remove(index))}
          />
          <fieldset className="grid gap-2 sm:grid-cols-2">
            <legend className="mb-2 text-sm font-medium">Giá trị cho phép</legend>
            {options.map((option) => {
              const control = prefix + index + '-' + option.id;
              return (
                <Label
                  key={option.id}
                  htmlFor={control}
                  className="flex min-h-11 gap-3 rounded-md border px-3 py-2"
                >
                  <Checkbox
                    id={control}
                    checked={rule.optionIds.includes(option.id)}
                    onCheckedChange={(checked) =>
                      update(index, {
                        ...rule,
                        optionIds:
                          checked === true
                            ? [...rule.optionIds, option.id]
                            : rule.optionIds.filter((id) => id !== option.id),
                      })
                    }
                  />
                  {option.label}
                </Label>
              );
            })}
          </fieldset>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        disabled={!fields.length || rules.length >= 10}
        onClick={() =>
          onChange([
            ...rules,
            {
              when: { mode: 'all', rules: [{ fieldId: fields[0]!.id, operator: 'answered' }] },
              optionIds: options.map((option) => option.id),
            },
          ])
        }
      >
        <Plus /> Thêm quy tắc lựa chọn
      </Button>
    </fieldset>
  );
}

export function FormDesigner({
  schema,
  onChange,
  onSave,
  busy,
  business = false,
}: {
  schema: FormSchema;
  onChange: (schema: FormSchema) => void;
  onSave: () => void;
  busy: boolean;
  business?: boolean;
}) {
  const [editing, setEditing] = useState<{
    section: number;
    index: number;
    value: FormField;
  } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [preview, setPreview] = useState(false);
  const [previewAnswers, setPreviewAnswers] = useState<Answers>({});
  const trigger = useRef<HTMLElement | null>(null);
  const [previewSchema, setPreviewSchema] = useState<FormSchema | null>(null);
  const conditionSources = schemaFields(schema).filter(
    (field) =>
      field.id !== editing?.value.id &&
      !['table', 'money', 'person', 'orgUnit', 'attachment'].includes(field.type),
  );
  function start(section: number, index: number) {
    trigger.current = document.activeElement as HTMLElement;
    setError(null);
    setEditing({
      section,
      index,
      value: structuredClone(
        index < 0
          ? { id: id('field'), type: 'shortText', label: '', required: false }
          : schema.sections[section]!.fields[index]!,
      ),
    });
  }
  function fieldPatch(patch: Partial<FormField>) {
    setEditing((old) => old && { ...old, value: { ...old.value, ...patch } });
  }
  function patchSection(index: number, patch: Partial<FormSchema['sections'][number]>) {
    onChange({
      ...schema,
      sections: schema.sections.map((section, i) =>
        i === index ? { ...section, ...patch } : section,
      ),
    });
  }
  function saveField() {
    if (!editing) return;
    try {
      const next = structuredClone(schema),
        fields = next.sections[editing.section]!.fields;
      if (editing.index < 0) fields.push(editing.value);
      else fields[editing.index] = editing.value;
      if (schemaFields(next).some(requiresBusinessSchema)) next.schemaVersion = 2;
      onChange(parseFormSchema(next, business));
      setEditing(null);
      setError(null);
    } catch (error) {
      setError(error);
    }
  }
  function moveField(sectionIndex: number, index: number, direction: number) {
    const fields = [...schema.sections[sectionIndex]!.fields];
    [fields[index], fields[index + direction]] = [fields[index + direction]!, fields[index]!];
    patchSection(sectionIndex, { fields });
  }
  return (
    <div className="space-y-5" aria-label="Trình thiết kế biểu mẫu">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="schema-title">Tên biểu mẫu</Label>
          <Input
            id="schema-title"
            value={schema.title}
            maxLength={200}
            onChange={(event) => onChange({ ...schema, title: event.target.value })}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="schema-description">Mô tả</Label>
          <Textarea
            id="schema-description"
            value={schema.description ?? ''}
            maxLength={2000}
            onChange={(event) => onChange({ ...schema, description: event.target.value })}
          />
        </div>
      </div>
      {schema.sections.map((section, sectionIndex) => (
        <Card key={section.id}>
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle>Phần {sectionIndex + 1}</CardTitle>
              <div className="flex gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={'Đưa phần ' + (sectionIndex + 1) + ' lên'}
                  disabled={!sectionIndex}
                  onClick={() => {
                    const sections = [...schema.sections];
                    [sections[sectionIndex - 1], sections[sectionIndex]] = [
                      sections[sectionIndex]!,
                      sections[sectionIndex - 1]!,
                    ];
                    onChange({ ...schema, sections });
                  }}
                >
                  <ArrowUp />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={schema.sections.length === 1}
                  onClick={() =>
                    onChange({
                      ...schema,
                      sections: schema.sections.filter((_, index) => index !== sectionIndex),
                    })
                  }
                >
                  Xóa phần
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor={'section-title-' + section.id}>Tên phần {sectionIndex + 1}</Label>
              <Input
                id={'section-title-' + section.id}
                value={section.title}
                maxLength={200}
                onChange={(event) => patchSection(sectionIndex, { title: event.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={'section-description-' + section.id}>
                Mô tả phần {sectionIndex + 1}
              </Label>
              <Textarea
                id={'section-description-' + section.id}
                value={section.description ?? ''}
                maxLength={2000}
                onChange={(event) =>
                  patchSection(sectionIndex, { description: event.target.value })
                }
              />
            </div>
            <ol className="space-y-2">
              {section.fields.map((field, fieldIndex) => (
                <li
                  key={field.id}
                  className="flex flex-wrap items-center gap-3 rounded-lg border bg-background p-3"
                >
                  <div className="min-w-32 flex-1">
                    <p className="font-medium">
                      {fieldIndex + 1}. {field.label}
                    </p>
                    <div className="mt-1 flex flex-wrap gap-2">
                      <Badge variant="secondary">{typeLabels[field.type]}</Badge>
                      {field.required && <Badge variant="outline">Bắt buộc</Badge>}
                      {field.visibleWhen && <Badge variant="outline">Có điều kiện</Badge>}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => start(sectionIndex, fieldIndex)}
                      aria-label={'Sửa câu hỏi ' + field.label}
                    >
                      <Pencil />
                      Sửa
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={'Đưa câu hỏi ' + field.label + ' lên'}
                      disabled={!fieldIndex}
                      onClick={() => moveField(sectionIndex, fieldIndex, -1)}
                    >
                      <ArrowUp />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={'Đưa câu hỏi ' + field.label + ' xuống'}
                      disabled={fieldIndex === section.fields.length - 1}
                      onClick={() => moveField(sectionIndex, fieldIndex, 1)}
                    >
                      <ArrowDown />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={'Xóa câu hỏi ' + field.label}
                      disabled={section.fields.length === 1}
                      onClick={() =>
                        patchSection(sectionIndex, {
                          fields: section.fields.filter((_, i) => i !== fieldIndex),
                        })
                      }
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </li>
              ))}
            </ol>
            <Button
              type="button"
              variant="outline"
              disabled={schemaFields(schema).length >= 100 || section.fields.length >= 50}
              onClick={() => start(sectionIndex, -1)}
            >
              <Plus />
              Thêm câu hỏi
            </Button>
          </CardContent>
        </Card>
      ))}
      {error !== null && !editing && (
        <Alert variant="destructive">
          <AlertDescription>{formError(error)}</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap gap-3">
        <Button
          type="button"
          variant="outline"
          disabled={schema.sections.length >= 20}
          onClick={() =>
            onChange({
              ...schema,
              sections: [
                ...schema.sections,
                {
                  id: id('section'),
                  title: 'Phần mới',
                  fields: [
                    { id: id('field'), label: 'Câu hỏi mới', type: 'shortText', required: false },
                  ],
                },
              ],
            })
          }
        >
          <Plus />
          Thêm phần
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            try {
              setPreviewSchema(parseFormSchema(schema, business));
              setPreviewAnswers({});
              trigger.current = document.activeElement as HTMLElement;
              setPreview(true);
            } catch (error) {
              setError(error);
            }
          }}
        >
          <Eye />
          Xem trước
        </Button>
        <Button type="button" disabled={busy} onClick={onSave}>
          Lưu bản nháp
        </Button>
      </div>
      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      >
        <DialogContent
          className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            trigger.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {editing?.index === -1 ? 'Thêm câu hỏi' : 'Chỉnh sửa câu hỏi'}
            </DialogTitle>
            <DialogDescription>Đặt nội dung, giới hạn và điều kiện của câu hỏi.</DialogDescription>
          </DialogHeader>
          {editing && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="question-label">Nhãn câu hỏi</Label>
                <Input
                  id="question-label"
                  value={editing.value.label}
                  maxLength={200}
                  onChange={(event) => fieldPatch({ label: event.target.value })}
                />
              </div>
              <Choice
                label="Loại câu hỏi"
                name="question-type"
                value={editing.value.type}
                options={fieldTypes
                  .filter((type) => business || !isBusinessField(type))
                  .map((type) => ({ id: type, name: typeLabels[type] }))}
                onChange={(type) => {
                  const { id, label, description, required, visibleWhen, requiredWhen } =
                    editing.value;
                  setEditing({
                    ...editing,
                    value: {
                      id,
                      label,
                      description,
                      required,
                      visibleWhen,
                      requiredWhen,
                      type: type as FormField['type'],
                      ...(['table', 'money'].includes(type) ? { currency: 'VND' as const } : {}),
                      ...(type === 'table' ? { columns: purchaseColumns(), maxRows: 50 } : {}),
                      ...(type === 'attachment' ? { attachments: defaultAttachmentField() } : {}),
                      ...(['singleChoice', 'multipleChoice'].includes(type)
                        ? {
                            options: [
                              { id: 'option_a', label: 'Lựa chọn A' },
                              { id: 'option_b', label: 'Lựa chọn B' },
                            ],
                          }
                        : {}),
                    },
                  });
                }}
              />
              <div className="space-y-2">
                <Label htmlFor="question-description">Hướng dẫn trả lời</Label>
                <Textarea
                  id="question-description"
                  maxLength={2000}
                  value={editing.value.description ?? ''}
                  onChange={(event) => fieldPatch({ description: event.target.value })}
                />
              </div>
              <Label className="flex min-h-11 items-center gap-4" htmlFor="question-required">
                <Checkbox
                  id="question-required"
                  checked={editing.value.required}
                  onCheckedChange={(checked) => fieldPatch({ required: checked === true })}
                />
                Bắt buộc trả lời
              </Label>
              {editing.value.type === 'attachment' && editing.value.attachments && (
                <fieldset className="space-y-3 rounded-md border p-3">
                  <legend className="px-1 text-sm font-medium">Giới hạn đính kèm</legend>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="attachment-max-files">Số tệp tối đa</Label>
                      <Input
                        id="attachment-max-files"
                        type="number"
                        min={1}
                        max={10}
                        value={editing.value.attachments.maxFiles}
                        onChange={(event) =>
                          fieldPatch({
                            attachments: {
                              ...editing.value.attachments!,
                              maxFiles: Number(event.target.value),
                            },
                          })
                        }
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="attachment-max-bytes">MiB mỗi tệp</Label>
                      <Input
                        id="attachment-max-bytes"
                        type="number"
                        min={0.5}
                        max={10}
                        step={0.5}
                        value={editing.value.attachments.maxBytes / 1048576}
                        onChange={(event) =>
                          fieldPatch({
                            attachments: {
                              ...editing.value.attachments!,
                              maxBytes: Math.round(Number(event.target.value) * 1048576),
                            },
                          })
                        }
                      />
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-x-4">
                    {attachmentFormats.map((format) => (
                      <Label key={format} className="flex min-h-11 items-center gap-2">
                        <Checkbox
                          checked={editing.value.attachments!.formats.includes(format)}
                          onCheckedChange={(checked) => {
                            const current = editing.value.attachments!;
                            fieldPatch({
                              attachments: {
                                ...current,
                                formats: checked
                                  ? [...current.formats, format]
                                  : current.formats.filter((value) => value !== format),
                              },
                            });
                          }}
                        />
                        {format.toUpperCase()}
                      </Label>
                    ))}
                  </div>
                </fieldset>
              )}
              {(['shortText', 'longText'].includes(editing.value.type) ||
                isNumericField(editing.value.type) ||
                isTemporalField(editing.value.type)) && (
                <div className="grid gap-3 sm:grid-cols-2">
                  {(isTemporalField(editing.value.type)
                    ? ['minDate', 'maxDate']
                    : isNumericField(editing.value.type)
                      ? ['min', 'max']
                      : ['minLength', 'maxLength']
                  ).map((key, index) => (
                    <div key={key} className="space-y-2">
                      <Label htmlFor={'bound-' + key}>
                        {index === 0 ? 'Giới hạn tối thiểu' : 'Giới hạn tối đa'}
                      </Label>
                      <Input
                        id={'bound-' + key}
                        type={
                          isTemporalField(editing.value.type)
                            ? temporalInputType(editing.value.type)
                            : 'number'
                        }
                        value={String(editing.value[key as keyof FormField] ?? '')}
                        onChange={(event) =>
                          fieldPatch({
                            [key]:
                              event.target.value === ''
                                ? undefined
                                : isTemporalField(editing.value.type)
                                  ? event.target.value
                                  : Number(event.target.value),
                          })
                        }
                      />
                    </div>
                  ))}
                </div>
              )}
              {editing.value.options && (
                <fieldset className="space-y-2">
                  <legend className="mb-2 font-medium">Các lựa chọn</legend>
                  {editing.value.options.map((option, index) => (
                    <div key={option.id} className="flex items-center gap-2">
                      <Input
                        aria-label={'Lựa chọn ' + (index + 1)}
                        value={option.label}
                        maxLength={200}
                        onChange={(event) =>
                          fieldPatch({
                            options: editing.value.options!.map((item, i) =>
                              i === index ? { ...item, label: event.target.value } : item,
                            ),
                          })
                        }
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={'Xóa lựa chọn ' + (index + 1)}
                        disabled={editing.value.options!.length === 1}
                        onClick={() =>
                          fieldPatch({
                            options: editing.value.options!.filter((_, i) => i !== index),
                            optionRules: editing.value.optionRules?.map((rule) => ({
                              ...rule,
                              optionIds: rule.optionIds.filter((id) => id !== option.id),
                            })),
                          })
                        }
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  ))}
                  <Button
                    type="button"
                    variant="outline"
                    disabled={editing.value.options.length >= 50}
                    onClick={() =>
                      fieldPatch({
                        options: [
                          ...editing.value.options!,
                          { id: id('option'), label: 'Lựa chọn mới' },
                        ],
                      })
                    }
                  >
                    <Plus />
                    Thêm lựa chọn
                  </Button>
                </fieldset>
              )}
              {business && editing.value.options && (
                <OptionRulesEditor
                  options={editing.value.options}
                  rules={editing.value.optionRules ?? []}
                  fields={conditionSources}
                  onChange={(rules) =>
                    fieldPatch({ optionRules: rules.length ? rules : undefined })
                  }
                />
              )}
              {['money', 'table'].includes(editing.value.type) && (
                <BusinessFieldSettings field={editing.value} onChange={fieldPatch} />
              )}
              <ConditionEditor
                label="Hiện câu hỏi khi"
                value={editing.value.visibleWhen}
                fields={conditionSources}
                advanced={business}
                onChange={(visibleWhen) => fieldPatch({ visibleWhen })}
              />
              <ConditionEditor
                label="Bắt buộc khi"
                value={editing.value.requiredWhen}
                fields={conditionSources}
                advanced={business}
                onChange={(requiredWhen) => fieldPatch({ requiredWhen })}
              />
              {error !== null && (
                <Alert variant="destructive">
                  <AlertDescription>{formError(error)}</AlertDescription>
                </Alert>
              )}
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setEditing(null)}>
                  Hủy
                </Button>
                <Button type="button" onClick={saveField}>
                  Lưu câu hỏi
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
      <Dialog open={preview} onOpenChange={setPreview}>
        <DialogContent
          className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            trigger.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>{previewSchema?.title}</DialogTitle>
            <DialogDescription>
              Bản xem trước — câu trả lời tại đây không được lưu.
            </DialogDescription>
          </DialogHeader>
          {previewSchema && (
            <FormRenderer
              schema={previewSchema}
              answers={previewAnswers}
              onChange={setPreviewAnswers}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
