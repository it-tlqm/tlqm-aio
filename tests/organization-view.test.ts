import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  childrenOf,
  currentMembers,
  lifecycle,
  normalize,
  personAssignments,
} from '../frontend/src/foundation/model.js';
import type { DirectoryData } from '../frontend/src/foundation/model.js';
function fixture(): DirectoryData {
  return {
    'legal-entities': [{ id: 'entity', active: true }],
    'org-units': [
      { id: 'a', active: true },
      { id: 'b', parentId: 'a', active: true },
      { id: 'c', parentId: 'b', active: true },
    ],
    'job-titles': [{ id: 'title', active: true }],
    positions: ['a', 'b', 'c'].map((id) => ({
      id: 'p-' + id,
      orgUnitId: id,
      legalEntityId: 'entity',
      jobTitleId: 'title',
      active: true,
    })),
    people: [{ id: 'person', displayName: 'Đặng Ánh', active: true }],
    employments: [{ id: 'e', personId: 'person', validFrom: '2020-01-01', validUntil: null }],
    assignments: [
      {
        id: 'main',
        employmentId: 'e',
        positionId: 'p-a',
        isPrimary: true,
        validFrom: '2020-01-01',
      },
      {
        id: 'second',
        employmentId: 'e',
        positionId: 'p-b',
        isPrimary: false,
        validFrom: '2020-01-01',
      },
      {
        id: 'future',
        employmentId: 'e',
        positionId: 'p-c',
        isPrimary: false,
        validFrom: '2999-01-01',
      },
      {
        id: 'past',
        employmentId: 'e',
        positionId: 'p-c',
        isPrimary: true,
        validFrom: '2019-01-01',
        validUntil: '2020-01-01',
      },
    ],
  };
}
test('organization counts people once across main and concurrent assignments and retains their dated history', () => {
  const data = fixture(),
    units = childrenOf(data['org-units']!, 'a'),
    members = currentMembers(data, units);
  assert.deepEqual([...units], ['a', 'b', 'c']);
  assert.equal(members.people.length, 1);
  assert.equal(members.assignments.length, 2);
  assert.equal(personAssignments(data, 'person').length, 4);
  assert.equal(personAssignments(data, 'person', true).length, 2);
  assert.equal(currentMembers(data, new Set(['c'])).people.length, 0);
  data.employments![0]!.validUntil = '2021-01-01';
  assert.equal(currentMembers(data, units).people.length, 0);
  assert.equal(personAssignments(data, 'person').length, 4);
});
test('organization summaries do not reconstruct omitted scoped relations or include disabled positions/people', () => {
  for (const key of [
    'people',
    'employments',
    'positions',
    'org-units',
    'legal-entities',
    'job-titles',
  ]) {
    const data = fixture();
    data[key] = [];
    assert.equal(currentMembers(data, new Set(['a', 'b'])).people.length, 0, key);
  }
  const data = fixture();
  data.positions![0]!.active = false;
  assert.equal(currentMembers(data, new Set(['a'])).people.length, 0);
  data.people![0]!.active = false;
  assert.equal(currentMembers(data, new Set(['b'])).people.length, 0);
});
test('tree traversal terminates on malformed cycles and status uses exact exclusive expiry', () => {
  assert.deepEqual(
    [
      ...childrenOf(
        [
          { id: 'a', parentId: 'b' },
          { id: 'b', parentId: 'a' },
        ],
        'a',
      ),
    ],
    ['a', 'b'],
  );
  const now = Date.parse('2026-11-10T00:00:00Z');
  assert.equal(lifecycle({ validUntil: '2026-11-10T00:00:00Z' }, now), 'ended');
  assert.equal(lifecycle({ validFrom: '2026-11-10T00:00:01Z' }, now), 'future');
  assert.equal(lifecycle({ active: false, validFrom: '2026-11-11T00:00:00Z' }, now), 'ended');
  assert.equal(normalize('Đặng Ánh'), 'dang anh');
});
