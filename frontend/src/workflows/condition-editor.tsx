import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Choice } from '../forms/common';
import type { FormField } from '../../../src/forms/contracts';
import { isNumericField, isTemporalField, temporalInputType } from '../../../src/forms/field-types';
import type {
  ConditionGroupV1,
  NestedConditionGroupV1,
  ConditionRuleV1,
  ConditionOperator,
} from '../../../src/workflows/bos/condition-engine';
const labels: Record<ConditionOperator, string> = {
  EQUALS: 'Bằng',
  NOT_EQUALS: 'Khác',
  GREATER_THAN: 'Lớn hơn',
  GREATER_THAN_OR_EQUAL: 'Lớn hơn hoặc bằng',
  LESS_THAN: 'Nhỏ hơn',
  LESS_THAN_OR_EQUAL: 'Nhỏ hơn hoặc bằng',
  IN: 'Thuộc danh sách',
  NOT_IN: 'Ngoài danh sách',
  CONTAINS: 'Có chứa',
  NOT_CONTAINS: 'Không chứa',
  STARTS_WITH: 'Bắt đầu bằng',
  ENDS_WITH: 'Kết thúc bằng',
  IS_EMPTY: 'Chưa nhập',
  IS_NOT_EMPTY: 'Có dữ liệu',
};
const count = (group: NestedConditionGroupV1): number =>
  group.rules.reduce((sum, rule) => sum + ('rules' in rule ? count(rule) : 1), 0);
export function WorkflowConditionEditor({
  value,
  fields,
  onChange,
}: {
  value: ConditionGroupV1;
  fields: FormField[];
  onChange: (value: ConditionGroupV1) => void;
}) {
  const total = count(value);
  const newRule = (): ConditionRuleV1 => ({ fieldCode: fields[0]!.id, operator: 'IS_NOT_EMPTY' });
  function scalar(
    field: FormField | undefined,
    value: unknown,
    change: (value: unknown) => void,
    id: string,
  ) {
    if (field?.type === 'boolean')
      return (
        <Choice
          label={'Giá trị ' + id}
          value={String(value ?? false)}
          onChange={(value) => change(value === 'true')}
          options={[
            { id: 'true', name: 'Có' },
            { id: 'false', name: 'Không' },
          ]}
        />
      );
    if (field?.options?.length)
      return (
        <Choice
          label={'Giá trị ' + id}
          value={typeof value === 'string' ? value : ''}
          onChange={change}
          options={field.options.map((option) => ({ id: option.id, name: option.label }))}
        />
      );
    return (
      <div className="space-y-2">
        <Label htmlFor={'condition-value-' + id}>Giá trị {id}</Label>
        <Input
          id={'condition-value-' + id}
          type={
            field && isTemporalField(field.type)
              ? temporalInputType(field.type)
              : isNumericField(field?.type ?? '')
                ? 'number'
                : 'text'
          }
          value={typeof value === 'string' || typeof value === 'number' ? value : ''}
          onChange={(event) => change(event.target.value)}
        />
      </div>
    );
  }
  function group(
    node: NestedConditionGroupV1,
    change: (group: NestedConditionGroupV1) => void,
    path: string,
    depth: number,
  ) {
    const replace = (index: number, rule: ConditionRuleV1 | NestedConditionGroupV1) =>
      change({ ...node, rules: node.rules.map((old, i) => (i === index ? rule : old)) });
    return (
      <fieldset className="min-w-0 space-y-3 rounded-lg border p-3">
        <legend className="px-1 text-sm font-medium">Nhóm điều kiện {path}</legend>
        <Choice
          label={'Kết hợp ' + path}
          value={node.logicalOperator}
          onChange={(logicalOperator) =>
            change({ ...node, logicalOperator: logicalOperator as 'AND' | 'OR' })
          }
          options={[
            { id: 'AND', name: 'Tất cả (VÀ)' },
            { id: 'OR', name: 'Một trong các (HOẶC)' },
          ]}
        />
        {node.rules.map((rule, index) => {
          const id = path + '.' + (index + 1),
            field =
              'fieldCode' in rule ? fields.find((field) => field.id === rule.fieldCode) : undefined;
          return (
            <div key={id} className="space-y-3 rounded-md bg-secondary/30 p-2">
              {'rules' in rule ? (
                group(rule, (value) => replace(index, value), id, depth + 1)
              ) : (
                <>
                  <Choice
                    label={'Trường ' + id}
                    value={rule.fieldCode}
                    onChange={(fieldCode) =>
                      replace(index, { fieldCode, operator: 'IS_NOT_EMPTY' })
                    }
                    options={fields.map((field) => ({ id: field.id, name: field.label }))}
                  />
                  <Choice
                    label={'Phép so sánh ' + id}
                    value={rule.operator}
                    onChange={(operator) =>
                      replace(index, {
                        fieldCode: rule.fieldCode,
                        operator: operator as ConditionOperator,
                        ...(['IS_EMPTY', 'IS_NOT_EMPTY'].includes(operator)
                          ? {}
                          : {
                              value: ['IN', 'NOT_IN'].includes(operator)
                                ? [
                                    isNumericField(field?.type ?? '')
                                      ? 0
                                      : field?.type === 'boolean'
                                        ? false
                                        : '',
                                  ]
                                : isNumericField(field?.type ?? '')
                                  ? 0
                                  : field?.type === 'boolean'
                                    ? false
                                    : '',
                            }),
                      })
                    }
                    options={Object.entries(labels)
                      .filter(
                        ([operator]) =>
                          operator === rule.operator ||
                          [
                            'IS_EMPTY',
                            'IS_NOT_EMPTY',
                            'EQUALS',
                            'NOT_EQUALS',
                            'IN',
                            'NOT_IN',
                          ].includes(operator) ||
                          ((isNumericField(field?.type ?? '') ||
                            isTemporalField(field?.type ?? '')) &&
                            [
                              'GREATER_THAN',
                              'GREATER_THAN_OR_EQUAL',
                              'LESS_THAN',
                              'LESS_THAN_OR_EQUAL',
                            ].includes(operator)) ||
                          (['shortText', 'longText', 'singleChoice', 'multipleChoice'].includes(
                            field?.type ?? '',
                          ) &&
                            ['CONTAINS', 'NOT_CONTAINS', 'STARTS_WITH', 'ENDS_WITH'].includes(
                              operator,
                            )),
                      )
                      .map(([id, name]) => ({ id, name }))}
                  />
                  {!['IS_EMPTY', 'IS_NOT_EMPTY'].includes(rule.operator) &&
                    (['IN', 'NOT_IN'].includes(rule.operator) ? (
                      <div className="space-y-3">
                        {(Array.isArray(rule.value) ? rule.value : []).map((item, i) => (
                          <div key={i} className="space-y-1">
                            {scalar(
                              field,
                              item,
                              (next) =>
                                replace(index, {
                                  ...rule,
                                  value: (rule.value as unknown[]).map((old, n) =>
                                    i === n ? next : old,
                                  ),
                                }),
                              id + '.' + (i + 1),
                            )}
                            <Button
                              variant="ghost"
                              disabled={(rule.value as unknown[]).length <= 1}
                              onClick={() =>
                                replace(index, {
                                  ...rule,
                                  value: (rule.value as unknown[]).filter((_, n) => n !== i),
                                })
                              }
                              aria-label={'Bỏ giá trị ' + id + '.' + (i + 1)}
                            >
                              <Trash2 />
                              Bỏ giá trị
                            </Button>
                          </div>
                        ))}
                        <Button
                          variant="outline"
                          disabled={Array.isArray(rule.value) && rule.value.length >= 20}
                          onClick={() =>
                            replace(index, {
                              ...rule,
                              value: [...(Array.isArray(rule.value) ? rule.value : []), ''],
                            })
                          }
                        >
                          <Plus />
                          Thêm giá trị
                        </Button>
                      </div>
                    ) : (
                      scalar(field, rule.value, (value) => replace(index, { ...rule, value }), id)
                    ))}
                </>
              )}
              <Button
                variant="ghost"
                className="text-destructive"
                aria-label={'Bỏ điều kiện ' + id}
                disabled={node.rules.length <= 1}
                onClick={() => change({ ...node, rules: node.rules.filter((_, i) => i !== index) })}
              >
                <Trash2 />
                Bỏ điều kiện
              </Button>
            </div>
          );
        })}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={total >= 20 || !fields.length}
            onClick={() => change({ ...node, rules: [...node.rules, newRule()] })}
          >
            <Plus />
            Thêm điều kiện
          </Button>
          <Button
            variant="outline"
            disabled={depth >= 4 || total >= 20 || !fields.length}
            onClick={() =>
              change({
                ...node,
                rules: [...node.rules, { logicalOperator: 'OR', rules: [newRule()] }],
              })
            }
          >
            <Plus />
            Thêm nhóm
          </Button>
        </div>
      </fieldset>
    );
  }
  return (
    <div className="space-y-2">
      {group(value, (group) => onChange({ schemaVersion: 1, ...group }), '1', 1)}
      <p className="text-xs text-muted-foreground">
        Tối đa 20 điều kiện, 4 cấp nhóm. Các điều kiện hiện có được giữ khi sửa từng dòng.
      </p>
    </div>
  );
}
