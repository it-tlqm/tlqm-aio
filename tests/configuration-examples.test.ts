import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseConfigurationPackage } from '../src/configuration-package.js';
import { parseDirectoryConfiguration } from '../src/management/metadata.js';
import { parseWorkflow } from '../src/workflows/contracts.js';
import { parseCourse } from '../src/lms/course-contracts.js';
import { parseTrainingPath } from '../src/lms/training-contracts.js';
test('portable suite examples validate and generated media matches its manifest without embedding user data', async () => {
  const directory = parseConfigurationPackage(
    JSON.parse(await readFile('examples/configuration/01-ho-so-nhan-su.json', 'utf8')),
    'directory-people',
  );
  const d = parseDirectoryConfiguration(directory.content, 'people');
  assert.equal(d.selfView.includes('suite_hr_note'), false);
  assert.ok(d.selfEdit.includes('suite_work_location'));
  const workflow = parseConfigurationPackage(
    JSON.parse(await readFile('examples/configuration/02-duyet-ho-so.json', 'utf8')),
    'workflow',
  );
  assert.ok(parseWorkflow(workflow.content).nodes.some((n) => n.kind === 'approval'));
  const course = parseConfigurationPackage(
    JSON.parse(await readFile('examples/configuration/03-khoa-hoi-nhap.json', 'utf8')),
    'lms-course',
  );
  assert.equal(parseCourse(course.content, true).policy?.passScore, 80);
  const path = parseConfigurationPackage(
    JSON.parse(await readFile('examples/configuration/04-lo-trinh-hoi-nhap.json', 'utf8')),
    'lms-path',
  );
  assert.equal(parseTrainingPath(path.content, true).courseVersionIds.length, 1);
  const bytes = await readFile('examples/configuration/tlqm-local-demo.webm'),
    manifest = JSON.parse(await readFile('examples/configuration/media-manifest.json', 'utf8'));
  assert.deepEqual([...bytes.subarray(0, 4)], [0x1a, 0x45, 0xdf, 0xa3]);
  assert.equal(bytes.length, manifest.size);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.sha256);
});
