import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { chromium } from '@playwright/test';
import { recordedLmsVideo } from './lms-video-fixture.js';
import {
  makeConfigurationPackage,
  emptyReferenceOptions,
  parseConfigurationPackage,
} from '../src/configuration-package.js';
import type { ConfigurationKind } from '../src/configuration-package.js';
import { parseDirectoryConfiguration } from '../src/management/metadata.js';
import { workflowTemplate } from '../src/workflows/templates.js';
import { parseWorkflow } from '../src/workflows/contracts.js';
import { parseCourse } from '../src/lms/course-contracts.js';
import { parseTrainingPath } from '../src/lms/training-contracts.js';
import { defaultLearningPolicy } from '../src/lms/learning-policy.js';
const unit = 'ffffffff-ffff-4fff-8fff-000000000001',
  account = 'ffffffff-ffff-4fff-8fff-000000000002',
  media = 'ffffffff-ffff-4fff-8fff-000000000003',
  courseVersion = 'ffffffff-ffff-4fff-8fff-000000000004',
  options = {
    ...emptyReferenceOptions(),
    unit: [{ id: unit, name: 'Đơn vị áp dụng mẫu' }],
    account: [{ id: account, name: 'Người phê duyệt độc lập' }],
    media: [{ id: media, name: 'Video minh họa TLQM đã tải lên' }],
    courseVersion: [{ id: courseVersion, name: 'Phiên bản khóa hội nhập đã phát hành' }],
  };
const directory = parseDirectoryConfiguration(
  {
    schema: {
      schemaVersion: 1,
      title: 'Hồ sơ hội nhập TLQM — mẫu',
      sections: [
        {
          id: 'suite_profile',
          title: 'Thông tin hội nhập',
          fields: [
            {
              id: 'suite_work_location',
              type: 'shortText',
              label: 'Địa điểm làm việc đề xuất',
              required: false,
              maxLength: 200,
            },
            {
              id: 'suite_skills',
              type: 'multipleChoice',
              label: 'Kỹ năng đã được hướng dẫn',
              required: false,
              options: [
                { id: 'safety', label: 'An toàn' },
                { id: 'digital', label: 'Ứng dụng số' },
                { id: 'teamwork', label: 'Phối hợp công việc' },
              ],
            },
            {
              id: 'suite_note',
              type: 'longText',
              label: 'Ghi chú của nhân viên',
              required: false,
              maxLength: 2000,
            },
            {
              id: 'suite_hr_note',
              type: 'longText',
              label: 'Ghi chú nội bộ HR',
              required: false,
              maxLength: 2000,
            },
          ],
        },
      ],
    },
    selfView: ['suite_work_location', 'suite_skills', 'suite_note'],
    selfEdit: ['suite_work_location', 'suite_skills', 'suite_note'],
  },
  'people',
);
const workflow = workflowTemplate('blank');
workflow.name = 'Duyệt cập nhật hồ sơ — mẫu TLQM';
workflow.description =
  'HR gửi đề xuất, người độc lập phê duyệt; HR kiểm tra lại và xác nhận áp dụng hồ sơ.';
workflow.category = 'Nhân sự';
workflow.audienceUnits = [unit];
workflow.nodes = [
  { id: 'start', label: 'HR gửi đề xuất', kind: 'start', next: 'review' },
  {
    id: 'review',
    label: 'Phê duyệt thay đổi',
    kind: 'approval',
    assignee: account,
    dueHours: 24,
    next: 'end',
    form: null,
  },
  { id: 'end', label: 'Sẵn sàng HR áp dụng', kind: 'end' },
];
const course = parseCourse({
  schemaVersion: 3,
  title: 'Hội nhập TLQM AIO — mẫu thử',
  subtitle:
    'Nội dung giả lập để thử video và bài thi. Hồ sơ chỉ thay đổi sau khi HR xác nhận áp dụng; hoàn thành quy trình không tự cấp quyền ứng dụng.',
  series: 'Hội nhập TLQM',
  duration: 2,
  video: { kind: 'file', id: media },
  deadline: '',
  isMandatory: true,
  audienceUnits: [unit],
  checkpoints: [],
  questions: [
    {
      id: 'q1',
      type: 'single',
      question: 'Sau khi quy trình cập nhật hồ sơ được duyệt, bước tiếp theo là gì?',
      options: ['HR kiểm tra và xác nhận áp dụng', 'Tự cấp vai trò ứng dụng', 'Xóa hồ sơ cũ'],
    },
  ],
  answerKey: {
    q1: {
      answer: 0,
      explanation: 'HR đối soát phiên bản và quyền hiện hành rồi xác nhận áp dụng.',
    },
  },
  attachments: [],
  policy: {
    ...defaultLearningPolicy,
    passScore: 80,
    maxAttempts: 3,
    cooldownMinutes: 0,
    checkpointPolicy: 'none',
  },
});
const path = parseTrainingPath({
  schemaVersion: 1,
  title: 'Lộ trình hội nhập TLQM — mẫu thử',
  description:
    'Học nội dung giới thiệu AIO và đạt bài kiểm tra. Giao người học và hạn hoàn thành khi tạo đợt.',
  audienceUnits: [unit],
  courseVersionIds: [courseVersion],
});
const files: [string, ConfigurationKind, string, unknown][] = [
  ['01-ho-so-nhan-su.json', 'directory-people', directory.schema.title, directory],
  ['02-duyet-ho-so.json', 'workflow', workflow.name, parseWorkflow(workflow)],
  ['03-khoa-hoi-nhap.json', 'lms-course', course.title, course],
  ['04-lo-trinh-hoi-nhap.json', 'lms-path', path.title, path],
];
await mkdir('examples/configuration', { recursive: true });
for (const [name, kind, label, content] of files) {
  const file = 'examples/configuration/' + name;
  try {
    await writeFile(
      file,
      JSON.stringify(makeConfigurationPackage(kind, label, content, options), null, 2) + '\n',
      { flag: 'wx' },
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    parseConfigurationPackage(JSON.parse(await readFile(file, 'utf8')), kind);
  }
}
const mediaPath = 'examples/configuration/tlqm-local-demo.webm';
try {
  await readFile(mediaPath);
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await writeFile(mediaPath, await recordedLmsVideo(page), { flag: 'wx' });
  } finally {
    await browser.close();
  }
}
const bytes = await readFile(mediaPath);
await writeFile(
  'examples/configuration/media-manifest.json',
  JSON.stringify(
    {
      kind: 'generated-synthetic-video',
      file: 'tlqm-local-demo.webm',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: bytes.length,
      description:
        'Video giả lập do mã canvas/MediaRecorder của AIO tạo, không có dữ liệu người dùng hoặc tải từ bên ngoài.',
    },
    null,
    2,
  ) + '\n',
);
console.log(
  'Validated four portable configuration examples and the synthetic local video; existing package files preserved.',
);
