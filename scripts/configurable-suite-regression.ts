import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
const milestone = process.argv[2] ?? 'e2';
if (
  ![
    'e2',
    'e3-policy',
    'e3-training',
    'e4-profile',
    'e4-training',
    'e4-final',
    'w1-business',
    'w1-references',
    'w1-step-input',
    'w1-field-config',
    'w2-reassignment',
    'w2-handoff',
    'w2-return',
    'w2-parallel',
    'w2-recall',
    'w1-attachments',
    'w3-collaboration',
    'w3-workspace',
    'w3-final',
    'w3-scope',
    'w4-links',
    'w4-schedules',
    'w4-step-links',
    'w4-output-templates',
    'w4-personnel-intake',
    'w4-training-intake',
    'w5-performance-report',
    'w5-custom-report',
    'w5-version-history',
    'w5-document-library',
    'w5-product-gate',
    'e5-enterprise',
    'tasks-local',
  ].includes(milestone)
)
  throw new Error('Select a supported regression milestone.');
const sourceFiles = () => {
  const files = execFileSync(
    'rg',
    ['--files', 'src', 'scripts', 'tests', 'frontend/src', 'infrastructure', 'examples'],
    { encoding: 'utf8' },
  )
    .trim()
    .split(/\r?\n/)
    .filter((p) => !p.includes('node_modules'));
  files.push('package.json', 'package-lock.json', 'frontend/package.json', 'tsconfig.json');
  return files.sort();
};
const hashes = async () =>
  Object.fromEntries(
    await Promise.all(
      sourceFiles().map(async (file) => [
        file,
        createHash('sha256')
          .update(await readFile(file))
          .digest('hex'),
      ]),
    ),
  );
const releaseSourceDigest = () =>
  execFileSync(process.execPath, ['scripts/release.mjs', 'source-digest'], {
    encoding: 'utf8',
  }).trim();
const enterpriseDigest = milestone === 'e5-enterprise' ? releaseSourceDigest() : undefined;
const before = await hashes(),
  startedAt = new Date().toISOString();
const configurableCommands = [
  'w5-product-gate',
  'w5-document-library',
  'w5-version-history',
  'w5-performance-report',
  'w5-custom-report',
].includes(milestone)
  ? milestone === 'w5-product-gate'
    ? [
        'check',
        'test:workflows-assignments',
        'test:workflows-business',
        'test:workflows-step-links',
        'test:workflows-personnel-intake',
        'test:workflows-training-intake',
        'test:workflows-document-library',
        'test:workflows-version-history',
        'test:e2e',
      ]
    : milestone === 'w5-document-library'
      ? [
          'check',
          'test:workflows-document-library',
          'test:workflows-version-history',
          'test:workflows-custom-report',
          'test:workflows-personnel-intake',
          'test:workflows-training-intake',
          'test:e2e',
        ]
      : milestone === 'w5-version-history'
        ? [
            'check',
            'test:workflows-version-history',
            'test:workflows-custom-report',
            'test:workflows-pools',
            'test:workflows-step-links',
            'test:workflows-training-intake',
            'test:e2e',
          ]
        : [
            'check',
            milestone === 'w5-custom-report'
              ? 'test:workflows-custom-report'
              : 'test:workflows-performance-report',
            'test:workflows-pools',
            'test:workflows-business',
            'test:work-center',
            'test:workflows-step-links',
            'test:e2e',
          ]
  : milestone === 'w4-training-intake'
    ? [
        'check',
        'test:workflows-training-intake',
        'test:lms-training',
        'test:lms-work-center',
        'test:workflows-personnel-intake',
        'test:workflows-output-templates',
        'test:workflows-step-links',
        'test:lms-backup',
        'test:e2e',
      ]
    : milestone === 'w4-personnel-intake'
      ? [
          'check',
          'test:workflows-personnel-intake',
          'test:organization-operations',
          'test:profile-workflows',
          'test:workflows-output-templates',
          'test:workflows-step-links',
          'test:workflows-business',
          'test:work-center',
          'test:e2e',
        ]
      : ['w4-output-templates', 'w4-step-links'].includes(milestone)
        ? [
            'check',
            ...(milestone === 'w4-output-templates' ? ['test:workflows-output-templates'] : []),
            'test:workflows-step-links',
            'test:workflows-business',
            'test:work-center',
            'test:e2e',
          ]
        : milestone === 'w4-schedules'
          ? [
              'check',
              'test:workflows-scheduled-requests',
              'test:workflows-business',
              'test:work-center',
              'test:e2e',
            ]
          : milestone === 'w4-links'
            ? [
                'check',
                'test:workflows-linked-requests',
                'test:workflows-business',
                'test:work-center',
                'test:e2e',
              ]
            : ['w3-workspace', 'w3-scope'].includes(milestone)
              ? [
                  'check',
                  'test:workflows-assignments',
                  'test:workflows',
                  'test:workflows-pools',
                  'test:workflows-business',
                  'test:work-center',
                ]
              : [
                    'w2-handoff',
                    'w2-return',
                    'w2-parallel',
                    'w2-recall',
                    'w1-attachments',
                    'w3-collaboration',
                    'w3-final',
                  ].includes(milestone)
                ? [
                    'check',
                    'test:workflows-assignments',
                    'test:workflows',
                    'test:workflows-pools',
                    'test:workflows-business',
                    ...(milestone !== 'w2-handoff' ? ['test:work-center'] : []),
                    'test:profile-workflows',
                    'test:configuration-transfer',
                    ...(milestone === 'w1-attachments'
                      ? ['test:forms-ui', 'test:organization-operations']
                      : []),
                    'test:e2e',
                  ]
                : milestone === 'w2-reassignment'
                  ? [
                      'check',
                      'test:workflows-assignments',
                      'test:workflows',
                      'test:workflows-pools',
                      'test:e2e',
                    ]
                  : milestone === 'w1-field-config'
                    ? [
                        'check',
                        'test:workflows-business',
                        'test:workflows',
                        'test:workflows-assignments',
                        'test:forms-ui',
                        'test:configuration-transfer',
                        'test:e2e',
                      ]
                    : ['w1-business', 'w1-references', 'w1-step-input'].includes(milestone)
                      ? [
                          'check',
                          'test:workflows-business',
                          'test:workflows',
                          'test:workflows-assignments',
                          'test:workflows-pools',
                          'test:work-center',
                          'test:profile-workflows',
                          'test:configuration-transfer',
                          'test:forms-ui',
                          'test:directory-metadata',
                          'test:lms',
                          'test:e2e',
                        ]
                      : milestone === 'e4-final'
                        ? [
                            'check',
                            'test:configuration-transfer',
                            'test:profile-workflows',
                            'test:lms-work-center',
                            'test:directory-metadata',
                            'test:workflows-pools',
                            'test:workflows-assignments',
                            'test:workflows',
                            'test:work-center',
                            'test:lms-training',
                            'test:lms-policy',
                            'test:lms-authoring',
                            'test:lms-learner',
                            'test:lms-questions',
                            'test:lms-reports',
                            'test:lms',
                            'test:forms-ui',
                            'test:organization-operations',
                            'test:e2e',
                          ]
                        : milestone === 'e4-training'
                          ? [
                              'check',
                              'test:lms-work-center',
                              'test:profile-workflows',
                              'test:lms-training',
                              'test:lms-policy',
                              'test:lms-reports',
                              'test:lms',
                              'test:work-center',
                              'test:e2e',
                              'test:lms-resilience',
                              'test:lms-backup',
                            ]
                          : milestone === 'e4-profile'
                            ? [
                                'check',
                                'test:profile-workflows',
                                'test:directory-metadata',
                                'test:workflows-pools',
                                'test:workflows-assignments',
                                'test:work-center',
                                'test:workflows',
                                'test:e2e',
                                'test:organization-operations',
                                'test:lms-training',
                              ]
                            : milestone === 'e3-training'
                              ? [
                                  'check',
                                  'test:lms-training',
                                  'test:lms-policy',
                                  'test:lms-learner',
                                  'test:lms-reports',
                                  'test:lms',
                                  'test:e2e',
                                  'test:directory-metadata',
                                ]
                              : milestone === 'e3-policy'
                                ? [
                                    'check',
                                    'test:lms-policy',
                                    'test:lms-courses',
                                    'test:lms-authoring',
                                    'test:lms-learner',
                                    'test:lms-questions',
                                    'test:lms-reports',
                                    'test:lms',
                                    'test:e2e',
                                    'test:workflows-pools',
                                  ]
                                : [
                                    'check',
                                    'test:workflows-pools',
                                    'test:workflows-assignments',
                                    'test:work-center',
                                    'test:workflows',
                                    'test:e2e',
                                    'test:forms-ui',
                                    'test:lms',
                                    'test:organization-operations',
                                    'test:directory-metadata',
                                  ];
const commands =
  milestone === 'e5-enterprise'
    ? [
        'check',
        'test:e2e',
        'test:forms-ui',
        'test:tasks',
        'test:work-center',
        'test:workflows-assignments',
        'test:workflows-business',
        'test:workflows-step-links',
        'test:workflows-personnel-intake',
        'test:workflows-training-intake',
        'test:workflows-document-library',
        'test:workflows-version-history',
        'test:lms',
        'test:lms-reports',
        'test:resilience',
        'test:lms-resilience',
      ]
    : milestone === 'tasks-local'
      ? ['check', 'test:tasks', 'test:e2e', 'test:workflows-business', 'test:work-center']
      : configurableCommands;
const results: {
  command: string;
  exitCode: number;
  startedAt: string;
  completedAt: string;
  log: string;
}[] = [];
const npm =
  process.env.npm_execpath ?? resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
let stopped = false;
for (const command of commands) {
  const log = `.local/evidence/configurable-${milestone}-${command.replaceAll(':', '-')}.log`,
    start = new Date().toISOString();
  await writeFile(log, '');
  console.log('Running ' + command);
  let writes = Promise.resolve();
  const exitCode = await new Promise<number>((done) => {
    const child = spawn(process.execPath, [npm, 'run', command], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    for (const stream of [child.stdout, child.stderr])
      stream.on('data', (chunk: Buffer) => {
        writes = writes.then(() => appendFile(log, chunk));
      });
    child.on('error', () => done(1));
    child.on('exit', (code) => done(code ?? 1));
  });
  await writes;
  results.push({ command, exitCode, startedAt: start, completedAt: new Date().toISOString(), log });
  console.log((exitCode === 0 ? 'PASS ' : 'FAIL ') + command);
  if (exitCode) {
    stopped = true;
    break;
  }
}
const after = await hashes(),
  sourceStable =
    JSON.stringify(before) === JSON.stringify(after) &&
    (enterpriseDigest === undefined || releaseSourceDigest() === enterpriseDigest);
const result = !stopped && sourceStable ? 'pass' : 'fail';
await writeFile(
  `.local/evidence/configurable-${milestone}-regression.json`,
  JSON.stringify(
    {
      milestone,
      startedAt,
      completedAt: new Date().toISOString(),
      completedAtVietnam: new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }),
      result,
      sourceStable,
      ...(enterpriseDigest && { sourceDigest: enterpriseDigest }),
      results,
      sourceHashes: after,
    },
    null,
    2,
  ) + '\n',
);
console.log(
  `Regression ${result}; ${results.length}/${commands.length} commands; sourceStable=${sourceStable}.`,
);
if (result !== 'pass') process.exitCode = 1;
