import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyArtifact } from '../infrastructure/release/verify-artifact.mjs';

const root = await realpath(fileURLToPath(new URL('../', import.meta.url)));
const [release, artifactDigest, ...receiptsArgs] = process.argv.slice(2);
const stagingReceipt = receiptsArgs[0]?.startsWith('enterprise-e5-staging-rollback-')
  ? receiptsArgs.shift()
  : undefined;
const [namedHostsFlag, namedHostsReceipt] = receiptsArgs;
assert.ok(
  /^[a-z0-9][a-z0-9-]{0,39}$/.test(release ?? '') &&
    /^[a-f0-9]{64}$/.test(artifactDigest ?? '') &&
    (stagingReceipt === undefined ||
      /^enterprise-e5-staging-rollback-[a-f0-9]{8}\.json$/.test(stagingReceipt)) &&
    (!receiptsArgs.length ||
      (receiptsArgs.length === 2 &&
        namedHostsFlag === '--named-hosts' &&
        /^enterprise-e3-staging-telemetry-[a-f0-9]{8}\.json$/.test(namedHostsReceipt))),
  'Use enterprise-asvs-ledger.mjs <release-name> <artifact-sha256> [rollback-receipt.json] [--named-hosts telemetry-receipt.json].',
);
const local = join(root, '.local');
const evidence = join(local, 'evidence');
const target = join(local, 'releases', release);
const artifact = join(target, 'artifact');
for (const path of [local, evidence, target, artifact]) assert.equal(await realpath(path), path);
const verifiedFiles = await verifyArtifact(artifact, artifactDigest);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = async (file) => JSON.parse(await readFile(file, 'utf8'));
const manifest = await json(join(artifact, 'release-manifest.json'));
const catalogueFile = 'asvs-5.0.0-owasp.json';
const catalogueUrl =
  'https://raw.githubusercontent.com/OWASP/ASVS/v5.0.0/5.0/docs_en/OWASP_Application_Security_Verification_Standard_5.0.0_en.flat.json';
const catalogueDigest = '8201b20eec2908c3380ac600c91c8ba746346fbb808859366abb232027532311';
const catalogueBytes = await readFile(join(evidence, catalogueFile));
assert.equal(sha(catalogueBytes), catalogueDigest, 'Unexpected OWASP catalogue digest.');
const catalogue = JSON.parse(catalogueBytes).requirements.filter(({ L }) => L === '1' || L === '2');
assert.equal(new Set(catalogue.map(({ req_id }) => req_id)).size, 253);
assert.equal(catalogue.length, 253);
assert.equal(catalogue.filter(({ L }) => L === '1').length, 70);

const receipts = {
  e1: [
    'enterprise-e1-staging-suite-6b316685.json',
    'edbff007548c55758f314b447f53a923a02821e68396ce7f0fa6262b8e5f8391',
    'business',
  ],
  personnel: [
    'enterprise-e2-staging-personnel-dd8c99ed.json',
    '25494bb07f67bda6f3a839f85679c86baf8e8582135a26173b04386990281851',
    'personnel',
  ],
  iam: [
    'enterprise-e2-staging-iam-fe873cee.json',
    'b3b6f21adca23a2416e9924e474022856bf59125396f1fbfbe25773c8adea4cc',
    'iam',
  ],
  audit: [
    'enterprise-e2-staging-infra-audit-d0e73835.json',
    'd8ccd5c43a33a8fe2ea3fc4406fe049bdd77756fa02fcfa0f232f92c300f47ef',
    'audit',
  ],
  access: [
    'enterprise-e2-staging-access-ui-42c09acd.json',
    'dbf4f0a6579ab9849696d605cae480937778329d0cf479113dd7c95a178d21df',
    'business',
  ],
};
const checkedReceipts = {};
for (const [key, [file, digest, field]] of Object.entries(receipts)) {
  const path = join(evidence, file);
  assert.ok((await lstat(path)).isFile());
  const bytes = await readFile(path);
  const receipt = JSON.parse(bytes);
  assert.equal(receipt.status, 'pass');
  assert.equal(receipt.artifactDigest, digest);
  assert.deepEqual(
    receipt.results.map(({ slot }) => slot),
    ['a', 'b'],
  );
  assert.ok(receipt.results.every((row) => row[field] && row.verifiedTls && row.verifiedMfa));
  checkedReceipts[key] = {
    file,
    sha256: sha(bytes),
    artifactDigest: digest,
    scope: digest === artifactDigest ? 'candidate-slice' : 'previous-artifact-slice',
    checkedAtVietnam: receipt.checkedAtVietnam,
  };
}
let stagedControls;
let rollback;
if (stagingReceipt) {
  const path = join(evidence, stagingReceipt);
  assert.ok((await lstat(path)).isFile());
  const bytes = await readFile(path);
  const receipt = JSON.parse(bytes);
  rollback = receipt;
  const apps = [
    'aio-foundation',
    'aio-probe',
    'aio-forms',
    'aio-workflows',
    'aio-tasks',
    'aio-lms-sandbox',
  ];
  assert.equal(receipt.status, 'pass');
  assert.equal(receipt.artifactDigest, artifactDigest);
  assert.equal(receipt.release, release);
  assert.deepEqual(
    receipt.results.map(({ slot }) => slot),
    ['a', 'b'],
  );
  for (const row of receipt.results) {
    assert.ok(
      row.verifiedTls && row.verifiedMfa && row.upgrade?.fullRollback?.candidateRolledForward,
    );
    assert.deepEqual(row.hstsVerifiedFor, apps);
    assert.ok(
      row.databaseTransport.plaintextRejected && row.databaseTransport.untrustedCertificateRejected,
    );
    assert.ok(
      row.databaseTransport.rows.length >= 7 &&
        row.databaseTransport.rows.every(({ version }) => /^TLSv1\.[23]$/.test(version)),
    );
    assert.deepEqual(
      row.iam.emergency.signedBackchannel.map(({ app }) => app),
      apps,
    );
    assert.ok(row.iam.emergency.signedBackchannel.every(({ events }) => events >= 1));
    assert.ok(
      row.business.scopedReports.csvScopeVerified && row.lms.scopedReports.xlsxScopeVerified,
    );
  }
  checkedReceipts.candidate = {
    file: stagingReceipt,
    sha256: sha(bytes),
    artifactDigest,
    scope: 'candidate-slice',
    checkedAtVietnam: receipt.checkedAtVietnam,
  };
  stagedControls = {
    'V3.4.1': 'Kiểm header trên sáu client. Còn cần bao phủ phản hồi lỗi của IdP và hạ tầng.',
    'V12.3.1':
      'PostgreSQL qua TLS theo role đã quan sát và từ chối plaintext/CA sai. Rà tiếp kết nối quản trị và telemetry.',
    'V12.3.3':
      'Đã chạy HTTPS ingress đến BFF và backchannel của Keycloak. Rà tiếp mọi đường HTTP trong topology.',
    'V10.5.5':
      'Hai slot có callback thật ở sáu client. Đối chiếu hồi quy âm và phát lại trên cùng digest khi chốt E2.',
  };
  if (receipt.results.every(({ iam }) => iam.rotation.publishedRsaMinimumBits >= 3072))
    stagedControls['V11.2.3'] =
      'Hai slot xác minh khóa RSA trong JWKS từ 3072 bit trước/sau xoay. Kiểm tiếp độ mạnh mọi primitive và cấu hình Keycloak/TLS.';
  if (receipt.results.every(({ iam }) => iam.realmPolicy?.passwordMinimum >= 15))
    stagedControls['V6.2.1'] =
      'Hai slot xác nhận policy độ dài 15 ký tự trên realm. Kiểm mật khẩu người dùng qua Account Console.';
  if (receipt.results.every(({ iam }) => iam.realmPolicy?.temporaryBruteForceProtection))
    stagedControls['V6.3.1'] =
      'Hai slot xác nhận cấu hình bảo vệ tạm thời ở realm. Kiểm hành vi trong luồng đăng nhập lỗi và hồi phục.';
}

const namedHostControls = {};
if (namedHostsReceipt) {
  const path = join(evidence, namedHostsReceipt);
  assert.ok((await lstat(path)).isFile());
  const bytes = await readFile(path);
  const receipt = JSON.parse(bytes);
  assert.equal(receipt.status, 'pass');
  assert.equal(receipt.release, release);
  assert.equal(receipt.artifactDigest, artifactDigest);
  assert.equal(receipt.candidateRuntime, 'container');
  assert.match(receipt.runnerSha256, /^[a-f0-9]{64}$/);
  assert.match(receipt.imageDigest, /^sha256:[a-f0-9]{64}$/);
  if (rollback) {
    assert.equal(receipt.runnerSha256, rollback.runnerSha256);
    assert.equal(receipt.imageDigest, rollback.imageDigest);
    assert.deepEqual(receipt.infrastructureImages, rollback.infrastructureImages);
  }
  let imageReceipt;
  for (const entry of await readdir(target, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^image-[a-f0-9]{8}$/.test(entry.name)) continue;
    const file = join(target, entry.name, 'receipt.json');
    const scanBytes = await readFile(file).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (!scanBytes) continue;
    const scan = JSON.parse(scanBytes);
    if (
      scan.status === 'pass' &&
      scan.release === release &&
      scan.artifactDigest === artifactDigest &&
      scan.imageDigest === receipt.imageDigest &&
      scan.blockingCount === 0 &&
      scan.secretFindingCount === 0
    ) {
      imageReceipt = { directory: entry.name, sha256: sha(scanBytes) };
      break;
    }
  }
  assert.ok(imageReceipt, 'Named-host receipt must use a scanned candidate image.');
  const apps = [
    'aio-foundation',
    'aio-probe',
    'aio-forms',
    'aio-workflows',
    'aio-tasks',
    'aio-lms-sandbox',
  ];
  assert.deepEqual(
    receipt.results.map(({ slot }) => slot),
    ['a', 'b'],
  );
  for (const row of receipt.results) {
    assert.ok(row.verifiedTls && row.verifiedMfa && row.crossAppSso);
    assert.deepEqual(
      row.iam.cookieIsolation.hosts,
      apps.map((app) => `${app}-${row.slot}.localhost`),
    );
    assert.equal(row.iam.cookieIsolation.hostOnlySessions, apps.length);
    assert.deepEqual(
      row.iam.emergency.signedBackchannel.map(({ app }) => app),
      apps,
    );
    assert.ok(row.iam.emergency.signedBackchannel.every(({ events }) => events >= 1));
  }
  checkedReceipts.namedHosts = {
    file: namedHostsReceipt,
    sha256: sha(bytes),
    artifactDigest,
    imageDigest: receipt.imageDigest,
    runnerSha256: receipt.runnerSha256,
    imageReceipt,
    scope: 'candidate-slice',
    checkedAtVietnam: receipt.checkedAtVietnam,
  };
  namedHostControls['V3.5.4'] = {
    status: 'verified',
    evidence: 'stagingNamedHosts',
    next: 'Hai slot kiểm sáu hostname, sáu cookie host-only và SSO/backchannel trên ứng viên. Chạy lại nếu topology đổi.',
  };
  if (
    receipt.results.every(
      ({ passwordChange }) =>
        passwordChange?.rankedCount >= 3000 &&
        passwordChange.minimumLength >= 15 &&
        /^[a-f0-9]{64}$/.test(passwordChange.corpusSha256) &&
        /^[a-f0-9]{64}$/.test(passwordChange.denylistSha256) &&
        passwordChange.rankedDenied &&
        passwordChange.contextDenied &&
        passwordChange.strongAccepted &&
        passwordChange.userFlow === 'UPDATE_PASSWORD' &&
        passwordChange.registrationEnabled === false,
    )
  ) {
    for (const id of ['V6.2.4', 'V6.2.11', 'V6.2.12'])
      namedHostControls[id] = {
        status: 'partial',
        evidence: 'stagingNamedHosts',
        next: 'Hai slot kiểm từ chối mục denylist và nhận mật khẩu mạnh khi đổi qua MFA. Đối chiếu phạm vi corpus, các biến thể theo ngữ cảnh và các đường cập nhật mật khẩu còn áp dụng.',
      };
  }
}

// Static checks are deliberately scoped to release payload files. They do not attest runtime behavior.
const app = await readFile(join(artifact, 'dist/src/app.js'), 'utf8');
const lms = await readFile(join(artifact, 'dist/lms/worker.mjs'), 'utf8');
const edge = await readFile(join(artifact, 'dist/scripts/staging.js'), 'utf8');
const staging = await readFile(join(artifact, 'dist/src/staging-config.js'), 'utf8');
const findings = {
  bffHstsIncludeSubDomainsExplicitlyConfigured:
    /hsts:\s*staging\s*\?\s*\{[^}]*includeSubDomains:\s*true/.test(app),
  lmsHstsIncludeSubDomainsConfigured:
    /strict-transport-security[^\r\n]{0,120}includeSubDomains/i.test(lms),
  edgeHstsIncludeSubDomainsConfigured:
    /strict-transport-security[^\r\n]{0,120}includeSubDomains/i.test(edge),
  businessPgPoolHasExplicitTlsOptions: /new pg\.Pool\(\{[^}]*\bssl\s*:/s.test(app),
  stagingDatabaseRejectsConnectionOptions: staging.includes('database.search'),
  edgeBffUsesNodeHttp: /from ['"]node:http['"]/.test(edge),
  sourceControlMetadataInManifest: Object.keys(manifest.files).some((path) =>
    /(^|\/)(\.git|\.svn)(\/|$)/.test(path),
  ),
};
const selected = {
  dataProtection: {
    files: [
      'docs/ENTERPRISE_ASVS_5_LEVEL_2.md',
      'docs/ENTERPRISE_IAM_AUDIT.md',
      'docs/RESILIENCE_AND_RESTORE.md',
    ],
    receipts: ['audit'],
  },
  ...(stagedControls && { stagingTransport: { receipts: ['candidate'], files: [] } }),
  ...(namedHostsReceipt && { stagingNamedHosts: { receipts: ['namedHosts'], files: [] } }),
  protocol: { files: ['docs/ENTERPRISE_ASVS_5_LEVEL_2.md'], priorArtifact: 'e2-scoped-reports-v4' },
  encoding: { files: ['tests/forms-reporting.test.ts', 'src/workflows/output-templates.ts'] },
  schema: {
    files: [
      'tests/forms-contracts.test.ts',
      'tests/workflows-contracts.test.ts',
      'src/configuration-package.ts',
    ],
  },
  transactions: {
    receipts: ['e1', 'access'],
    files: ['tests/tasks-service.test.ts', 'tests/forms-service.test.ts'],
  },
  browser: { receipts: ['e1', 'access'], files: ['src/app.ts', 'src/lms/worker.ts'] },
  httpsHeaders: {
    files: ['dist/src/app.js', 'dist/lms/worker.mjs', 'dist/scripts/staging.js'],
    static: true,
  },
  ingress: {
    receipts: ['e1', 'audit'],
    files: ['scripts/staging.ts', 'scripts/staging-infrastructure-audit.ts'],
  },
  internalTransport: {
    files: ['dist/src/app.js', 'dist/src/staging-config.js', 'dist/scripts/staging.js'],
    static: true,
  },
  files: {
    receipts: ['access'],
    files: ['src/workflows/attachment-content.ts', 'src/lms/media.ts', 'src/verified-zip.ts'],
  },
  iam: { receipts: ['iam'], files: ['docs/ENTERPRISE_IAM_AUDIT.md', 'scripts/staging-iam.ts'] },
  mfaRecovery: { files: ['docs/LOCAL_MFA_RECOVERY.md', 'scripts/recover-admin.ts'] },
  tokens: {
    receipts: ['iam'],
    files: ['src/oidc.ts', 'src/lms/oidc.ts', 'tests/security.test.ts'],
    logs: ['enterprise-e2-token-types-v1-snapshot-tests.log'],
  },
  sessionPolicy: {
    files: ['docs/LOCAL_DEVELOPMENT.md', 'docs/IDENTITY_LIFECYCLE.md', 'tests/sessions.test.ts'],
  },
  sessions: {
    receipts: ['e1'],
    files: ['src/sessions.ts', 'src/lms/sessions.ts', 'src/security.ts', 'src/lms/security.ts'],
  },
  personnel: { receipts: ['personnel', 'iam'], files: ['scripts/staging-personnel.ts'] },
  accessMatrix: { files: ['docs/ENTERPRISE_ACCESS_MATRIX.md', 'docs/APPLICATION_ACCESS_MODEL.md'] },
  access: {
    receipts: ['access', 'personnel'],
    files: [
      'scripts/staging-access-ui.ts',
      'scripts/staging-business-e2e.ts',
      'scripts/staging-lms-e2e.ts',
    ],
  },
  oidc: {
    receipts: ['e1', 'iam'],
    files: [
      'scripts/client-contract.ts',
      'tests/client-contract.test.ts',
      'scripts/staging-e2e.ts',
    ],
  },
  crypto: {
    files: [
      'src/security.ts',
      'src/lms/security.ts',
      'tests/security.test.ts',
      'tests/lms.test.ts',
    ],
  },
  topology: { files: ['docs/ENTERPRISE_STAGING.md'] },
  artifact: { files: ['sbom.cdx.json', 'release-manifest.json'], static: true },
  audit: {
    receipts: ['audit', 'iam'],
    files: ['docs/ENTERPRISE_IAM_AUDIT.md', 'scripts/staging-audit.ts'],
  },
  dependencies: {
    files: [
      'tests/dependencies.test.ts',
      'docs/RESILIENCE_AND_RESTORE.md',
      'scripts/lms-resilience.ts',
    ],
  },
};
for (const item of Object.values(selected)) {
  for (const file of item.files)
    assert.ok((await lstat(join(item.static ? artifact : root, file))).isFile(), file);
  for (const file of item.logs ?? []) assert.ok((await lstat(join(evidence, file))).isFile(), file);
}
const review = await json(join(root, 'docs', 'enterprise-asvs-review.json'));
const known = new Set(catalogue.map(({ req_id }) => req_id));
const decisions = new Map();
for (const [group, status] of [
  ['outOfScope', 'historical-not-applicable'],
  ['gaps', 'observed-gap'],
  ['partial', 'partial'],
]) {
  for (const entry of review[group]) {
    assert.ok(selected[entry.evidence] && entry.next.length);
    for (const id of entry.ids.split(' ')) {
      assert.ok(
        known.has(id) && !decisions.has(id),
        'Duplicate or unknown ASVS requirement: ' + id,
      );
      decisions.set(id, { status, evidence: entry.evidence, next: entry.next });
    }
  }
}
const byId = catalogue.map(({ req_id, section_id, L }) => {
  const staged = stagedControls?.[req_id];
  const decision = namedHostControls[req_id] ??
    (staged
      ? { status: 'partial', evidence: 'stagingTransport', next: staged }
      : decisions.get(req_id)) ?? {
      status: 'unreviewed',
      evidence: null,
      next: review.sections[section_id],
    };
  assert.ok(decision.next, 'Missing next verification step: ' + req_id);
  return { id: 'v5.0.0-' + req_id, level: Number(L), ...decision };
});
const counts = Object.fromEntries(
  ['verified', 'partial', 'observed-gap', 'historical-not-applicable', 'unreviewed'].map(
    (status) => [status, byId.filter((row) => row.status === status).length],
  ),
);
const now = new Date();
const id = randomUUID().slice(0, 8);
const path = join(evidence, 'enterprise-e2-asvs-ledger-' + id);
await mkdir(path);
const report = {
  status: 'inventory',
  e2Accepted: false,
  release,
  artifactDigest,
  sourceDigest: manifest.sourceDigest,
  checkedAt: now.toISOString(),
  checkedAtVietnam: now.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }),
  catalogue: {
    version: '5.0.0',
    url: catalogueUrl,
    sha256: catalogueDigest,
    requirements: byId.length,
  },
  verifiedFiles,
  counts,
  findings,
  receipts: checkedReceipts,
  evidence: selected,
  requirements: byId,
};
await writeFile(join(path, 'receipt.json'), JSON.stringify(report, null, 2) + '\n', {
  flag: 'wx',
  mode: 0o600,
});
const lines = [
  '# Ma trận ASVS 5.0.0 mức 2',
  '',
  'Ứng viên `' + release + '`, SHA-256 `' + artifactDigest + '`.',
  '',
  'Kiểm kê lúc ' +
    report.checkedAtVietnam +
    ' (UTC+7). Trạng thái từng phần và quyết định ngoài phạm vi trước đây cần kiểm lại trên ứng viên.',
  '',
  '| ID | Mức | Trạng thái | Bằng chứng | Việc cần xác minh |',
  '| --- | --- | --- | --- | --- |',
  ...byId.map(
    (row) => `| ${row.id} | ${row.level} | ${row.status} | ${row.evidence ?? '—'} | ${row.next} |`,
  ),
  '',
];
await writeFile(join(path, 'matrix.md'), lines.join('\n'), { flag: 'wx', mode: 0o600 });
console.log(
  JSON.stringify({
    path,
    artifactDigest,
    counts,
    findings,
    checkedAtVietnam: report.checkedAtVietnam,
  }),
);
