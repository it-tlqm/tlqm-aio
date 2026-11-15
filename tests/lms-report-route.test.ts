import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isLmsReportRoute,
  lmsReportHash,
  parseLmsReportRoute,
} from '../frontend/src/lib/lms-report-route.js';

test('LMS report route restores bounded filters and page', () => {
  const unit = '10000000-0000-4000-8000-000000000002';
  const course = '40000000-0000-4000-8000-000000000001';
  const hash = lmsReportHash({
    search: '  Nguyễn Văn A  ',
    filters: {
      orgUnitId: unit,
      courseId: course,
      status: 'pending',
      mandatoryOnly: true,
      page: 3,
    },
  });
  assert.deepEqual(parseLmsReportRoute(hash), {
    search: 'Nguyễn Văn A',
    filters: {
      orgUnitId: unit,
      courseId: course,
      search: 'Nguyễn Văn A',
      status: 'pending',
      mandatoryOnly: true,
      page: 3,
    },
  });
});

test('LMS report route rejects unknown or unsafe query values', () => {
  assert.equal(isLmsReportRoute('#lms-report?url=https%3A%2F%2Fevil.invalid'), false);
  assert.equal(isLmsReportRoute('#lms-report?orgUnitId=bad'), false);
  assert.equal(isLmsReportRoute('#lms-report?status=unknown'), false);
  assert.deepEqual(parseLmsReportRoute('#lms-report?page=0'), {
    search: '',
    filters: { status: 'all', page: 1 },
  });
});
