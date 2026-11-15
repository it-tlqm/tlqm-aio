# Dựng và xác minh gói phát hành TLQM AIO

Chạy từ gốc repo. Dùng cùng phiên bản Node, npm và hệ điều hành khi đối chiếu khả năng tái lập. Lượt E1 dùng Node 24.20.0, npm 11.19.0 và Windows x64.

```powershell
npm run release -- build e1-a
npm run release -- build e1-b
$a = Get-Content -Raw .local/releases/e1-a/receipt.json | ConvertFrom-Json
$b = Get-Content -Raw .local/releases/e1-b/receipt.json | ConvertFrom-Json
if ($a.sourceDigest -ne $b.sourceDigest -or $a.artifactDigest -ne $b.artifactDigest) {
  throw 'Hai lần dựng có kết quả khác nhau.'
}
npm run release -- verify .local/releases/e1-a/artifact $a.artifactDigest
npm run release -- verify .local/releases/e1-b/artifact $a.artifactDigest
```

Mỗi lần dựng tạo snapshot nguồn mới dưới `.local/releases/<tên>/source`. Lệnh dùng danh mục đầu vào trong script, cài dependency theo lockfile với `npm ci`, kiểm định dạng, kiểu dữ liệu và advisory npm, sau đó build frontend, BFF và LMS Worker. Gói `artifact` chứa mã đã dựng, tệp tĩnh, lockfile, migration SQL và SBOM CycloneDX. Kết quả audit ghi trong receipt cạnh gói vì advisory thay đổi theo thời gian. [Script đóng gói](../scripts/release.mjs), [npm ci](https://docs.npmjs.com/cli/v11/commands/npm-ci/), [npm SBOM](https://docs.npmjs.com/cli/v11/commands/npm-sbom/)

`release-manifest.json` ghi hash nguồn, toolchain và SHA-256 từng tệp. Dùng SHA-256 kỳ vọng từ biên bản dựng hoặc kênh phát hành tin cậy để xác minh trước khi dùng. Lệnh phát hiện tệp thêm, thiếu hoặc đổi nội dung. Tên lần dựng là duy nhất. Nếu một lần dựng lỗi, chọn tên mới cho lần chạy lại.

Lượt thử đầu ngày 12/11/2026 kiểm BFF Foundation bằng PostgreSQL test và LMS Worker bằng D1/R2 tạm. Kiểm tra khởi động dùng dependency ở workspace. Hai thư mục artifact là hai lần dựng độc lập trên một máy. [Tiến độ và điều kiện nghiệm thu](../roadmap/GOAL_ENTERPRISE_READINESS.md#tiến-độ-e1)

## Image ứng viên

Tải image scanner chính xác theo digest trong script image. Chạy sau khi dựng artifact có Dockerfile. Lượt này dùng Docker Desktop với image store containerd, Buildx, `tar` và platform `linux/amd64`. [Script image](../scripts/release-image.ts)

```powershell
npm run release:image -- <release> <manifest-sha256>
```

Script dùng Docker Desktop local. Dockerfile chỉ nhận thư mục artifact đã xác minh, kiểm lại toàn bộ manifest trong build và cài production dependencies theo lockfile. Base image Node Alpine và scanner được pin theo digest. Image chạy dưới user không có quyền root. Lượt smoke nạp module BFF và LMS với filesystem chỉ đọc và mạng tắt. Trivy quét archive của image vừa dựng và đối chiếu config digest của manifest theo platform. Cache advisory dùng volume riêng `tlqm-aio-release-trivy-cache`. Receipt ở `.local/releases/<release>/image-<id>/receipt.json`. Cổng từ chối cảnh báo HIGH/CRITICAL hoặc phát hiện secret. Receipt giữ ID cảnh báo, package và số phát hiện secret. [Docker về pin digest](https://docs.docker.com/build/building/best-practices/#pin-base-image-versions), [Trivy về quét image](https://trivy.dev/docs/latest/guide/target/container_image/)

Artifact manifest SHA-256 và digest image được ghi riêng để đối chiếu từng định dạng. [Cấu hình staging và diễn tập rollback](ENTERPRISE_STAGING.md)

Lượt quét ngày 12/11/2026 phát hiện 5 kết quả HIGH ở các gói Alpine OpenSSL, musl và zlib của image ban đầu. Dockerfile pin các bản đã vá có trong kho Alpine 3.24. Khi kho thay thế phiên bản đã pin, cập nhật pin và quét lại trước khi chấp nhận digest mới. [Thông báo bảo mật Alpine 3.24.3](https://alpinelinux.org/posts/alpine-3.21.9-3.22.7-3.23.7-3.24.3-released/)

## Pipeline E1 trên máy thử

Chuẩn bị AIO local với dữ liệu giả lập để chạy unit và integration test, Docker Desktop, Chromium Playwright và các image đã pin. Chạy từ gốc workspace với tên release mới, tối đa 33 ký tự. Pipeline dựng hai snapshot, đối chiếu digest nguồn và artifact, chạy hồi quy, quét image và diễn tập `--suite` trên hai slot. Digest bản trước đi cùng lệnh để xác minh khi rollback.

```powershell
$prior = Get-Content -Raw .local/releases/e1-staging-v1/receipt.json | ConvertFrom-Json
npm run release:e1 -- e1-run-01 e1-staging-v1 $prior.artifactDigest
```

Receipt tổng hợp và log kiểm thử nằm dưới `.local/evidence/enterprise-e1-pipeline-*`. Bài E2E dùng PostgreSQL, Keycloak, D1 và R2 của slot. [Cổng staging](ENTERPRISE_STAGING.md#profile-nghiệp-vụ)

## Tái lập E1 của v37

Snapshot nguồn đã dùng nằm ở `C:/Users/thanhnx/.codex/tlqm-aio-enterprise-v37-source`. Hai bản dựng dùng Node 24.20.0, npm 11.19.0 và Windows x64. Digest nguồn là `f1c0b65a205ce6ad4a6de9d06a20973fbe2d5a1d947e4c91b276b01c7dd13b49`. Manifest v37 ghi 312 tệp và SBOM có 189 thành phần. So với v36, 40 tệp SQL và 10 module migration giữ cùng SHA-256. [Biên bản hai bản dựng](../.local/evidence/enterprise-rc-v37-browser-policy-build-review.json) · [Kiểm kê manifest](../.local/evidence/enterprise-e2-v37-initial-ledger.json)

Chạy từ snapshot v37 đã xác minh để kiểm lại gói và bản lùi đã lưu. Trước lệnh staging, đọc hướng dẫn hạ tầng, xác minh Docker `desktop-linux` trỏ named pipe local và kiểm cổng staging đã trống. `AIO_STAGING_OPENBAO_EXE` trỏ bản OpenBao AIO đúng SHA-256 trong manifest, còn fixture denylist công khai phải khớp hash đã pin. [Cấu hình staging](ENTERPRISE_STAGING.md#profile-nghiệp-vụ) · [Cách dựng OpenBao](ENTERPRISE_STAGING.md#openbao-dựng-riêng-cho-ứng-viên-v34)

```powershell
$release = 'enterprise-rc-v37-staging'
$digest = 'eec6aebd7f0fa1db3e50f950d9559f9f40e1cf622e0dcfc1cf7802e00a0cd09b'
$image = 'sha256:4d9aabd25a519baba4d12e2974b32c847c838f66f3bbe652aaa81e92f2a7577e'
$prior = 'e4-task-work-v2'
$priorDigest = 'e4fd83066be7cb0a2360c32a41daa83c8bd602d2d4e7ddb2e1201dd929bbf12f'

npm run release -- verify ".local/releases/$release/artifact" $digest
npm run release -- verify ".local/releases/$release-repeat/artifact" $digest
npm run release -- verify ".local/releases/$prior/artifact" $priorDigest
npm run test:staging -- --named-hosts $release $digest $image --scoped-reports --telemetry
npm run test:staging -- $release $digest $prior $priorDigest $image --scoped-reports --full-rollback --telemetry
```

Đối chiếu receipt khi mỗi lệnh kết thúc. Gói chính và gói lặp dùng một artifact digest. Image staging có digest riêng lấy từ lượt quét đã đạt. Rollback đã qua cả hai slot với cùng dữ liệu giả lập trong mỗi lượt nâng, lùi và mở lại bản mới. [Receipt image](../.local/evidence/enterprise-rc-v37-image-receipt.json) · [Receipt hostname](../.local/evidence/enterprise-e3-staging-telemetry-c82f1529.json) · [Receipt rollback](../.local/evidence/enterprise-e1-v37-recovery-rollback-review.json)

## Dựng và xác minh v38 r2

Snapshot `C:/Users/thanhnx/.codex/tlqm-aio-enterprise-v38-r2-source` giữ hai lượt dựng theo cùng lockfile. Cả hai cho artifact `8df177efff051352156fa774dfe95939bb3eccf111738e8fe24dda8a7058eb09`. Quét image `sha256:b3326ca0795100dc067193bad4bf2fa4a2187777383251659aa48d65c29742e0` đạt lúc **10:38:42 ngày 14/11/2026, giờ Việt Nam**. Biên bản lúc **10:45:51** xác minh đủ 312 tệp của từng gói, đối chiếu SHA-256 của hai tệp runner IAM và xác nhận payload khớp v37. [Biên bản dựng và quét v38 r2](../.local/evidence/enterprise-e1-v38-r2-build-review.json)

Từ snapshot v38 r2, dùng hai lệnh sau để kiểm bản dựng chính và bản lặp. Dùng tên release mới khi dựng lại để giữ các thư mục bằng chứng đã có. Sau khi profile v37 giải phóng các cổng staging, bộ chạy `.local/run-v38-r2-staging.ps1` xác minh lại source, image, bản lùi và OpenBao trước khi chạy từng profile. Hồi quy E5 chạy riêng trên dữ liệu giả lập của AIO local. [Điều kiện hạ tầng staging](ENTERPRISE_STAGING.md#profile-nghiệp-vụ) · [Runbook nghiệm thu](ENTERPRISE_RELEASE_RUNBOOK.md#đối-chiếu-trước-khi-chốt-ứng-viên)

```powershell
$release = 'enterprise-rc-v38-r2-staging'
$digest = '8df177efff051352156fa774dfe95939bb3eccf111738e8fe24dda8a7058eb09'
npm run release -- verify ".local/releases/$release/artifact" $digest
npm run release -- verify ".local/releases/$release-repeat/artifact" $digest
```

Với snapshot mới, chuẩn bị Foundation và dữ liệu giả lập của LMS trước khi chạy hồi quy E5. `lms:setup` tạo liên kết học viên trong D1 của AIO local và test. Hai lượt hồi quy dùng chung cổng local nên cần chạy tuần tự. Lưu receipt lần trước và log tương ứng trước khi thử lại. [Chuẩn bị AIO local](LOCAL_DEVELOPMENT.md) · [Chuẩn bị LMS](LMS_LOCAL_DEVELOPMENT.md#chuẩn-bị-và-mở-giao-diện)

## Dựng và xác minh v39

Snapshot `C:/Users/thanhnx/.codex/tlqm-aio-enterprise-v39-source` giữ hai gói v39 có cùng digest. Kiểm tra lúc **13:49:04 ngày 14/11/2026, giờ Việt Nam** xác minh 312 tệp mỗi gói, 40 tệp SQL giữ nguyên và 189 thành phần SBOM. Hai tệp JavaScript của LMS Worker là phần payload đã thay đổi so với v38 r2. Image đã qua quét lúc **13:38:00**. [Biên bản dựng v39](../.local/evidence/enterprise-e1-v39-build-review.json)

~~~powershell
$release = 'enterprise-rc-v39-staging'
$digest = 'ca386a02b04a9022a6a23255e463e6aac437f776e55ef4b7276a13dd244a45d0'
npm run release -- verify ".local/releases/$release/artifact" $digest
npm run release -- verify ".local/releases/$release-repeat/artifact" $digest
~~~

Chạy profile từ snapshot sau khi các cổng staging được giải phóng. `.local/run-v39-staging.ps1` xác minh digest bản lùi và dùng các bước hostname, lỗi phụ thuộc, phục hồi, rollback và tải. Bộ chạy workbook/reset giữ một digest nguồn riêng và dùng cùng gói v39 đã xác minh. [Chuỗi staging](../.local/evidence/enterprise-rc-v39-staging-sequence.log) · [Biên bản runner workbook](../.local/evidence/enterprise-e2-v39-workbook-reset-runner.json)

### Tái lập v39 từ kho lưu trữ

Lúc **14:49:44 ngày 14/11/2026, giờ Việt Nam**, phép kiểm ZIP xác minh 1.218 mục theo SHA-256, gồm 588 tệp nguồn, gói ứng viên, gói lùi và image Linux/amd64. SHA-256 của ZIP là `6efad337eccf0a603f000172dafe0259b2f40f2728fb749661825b8810561ec0`. Receipt ghi đường dẫn ZIP và digest của `bundle-manifest.json`. [Biên bản kho lưu trữ](../.local/evidence/enterprise-e5-v39-reproduction-archive-review.json)

Lúc **14:54:13**, lần dựng từ nguồn và lockfile trích từ ZIP tạo lại đúng digest v39. Bộ xác minh kiểm từng tệp trong gói 312 tệp. Lần đầu ở đường dẫn Windows lồng sâu dừng tại bước gọi `tsc`. Lần đạt dùng thư mục gốc ngắn `C:/Users/thanhnx/.codex/aio-r39`. Khi tái lập, dùng một thư mục C: mới có đường dẫn ngắn và tên release riêng. [Biên bản dựng từ ZIP](../.local/evidence/enterprise-e5-v39-rebuild-from-archive-review.json)

Từ snapshot v39, đối chiếu SHA-256 của ZIP trước khi trích nguồn bằng `.local/extract-v39-build-source.py`. Truyền theo thứ tự đường dẫn ZIP, thư mục đích trống, digest `bundle-manifest.json` và số tệp nguồn từ biên bản kho lưu trữ. Sau đó, từ thư mục đích, chạy các lệnh sau.

~~~powershell
$digest = 'ca386a02b04a9022a6a23255e463e6aac437f776e55ef4b7276a13dd244a45d0'
node scripts/release.mjs source-digest
npm run release -- build enterprise-rc-v39-archive-check
node infrastructure/release/verify-artifact.mjs ".local/releases/enterprise-rc-v39-archive-check/artifact" $digest
~~~

Đối chiếu source SHA-256 `6d1bfeac2ac171f94ce6b4af4f4d3a7661310b592bcceefe8eb7f3d7ccc8a5f3`, 312 tệp và 189 thành phần SBOM. Chỉ mục lúc **14:58:48** liên kết hai receipt và giữ E5 ở trạng thái từng phần. Diễn tập nạp image, rollback staging và xác minh lưu giữ ngoài máy vẫn còn mở. [Chỉ mục v39](../.local/evidence/enterprise-rc-v39-gate-index-reproduction.json)

Lúc **15:23:18 ngày 14/11/2026, giờ Việt Nam**, đã nạp lại image v39 từ gói OCI đầy đủ dưới tag local dành riêng cho diễn tập. Bản xuất đầy đủ nằm cạnh ZIP và chứa index ứng viên, manifest Linux/amd64 cùng manifest attestation. Trình xác minh kiểm SHA-256 và kích thước của 14 descriptor rồi tạo gói nạp thử với tag riêng. Docker đọc lại đúng digest index, platform và nhãn artifact. BFF và LMS nạp được trong tiến trình Node không có quyền root, filesystem chỉ đọc và mạng tắt. Docker engine đã có sẵn image nguồn, nên vẫn cần thử trên engine sạch và xác minh lưu giữ ngoài máy. [Biên bản nạp image](../.local/evidence/enterprise-e5-v39-full-image-import-review.json) · [Docker image save](https://docs.docker.com/reference/cli/docker/image/save/) · [Docker image load](https://docs.docker.com/reference/cli/docker/image/load/)

## Tái lập v40 từ ZIP

Lúc **18:02:57 ngày 14/11/2026, giờ Việt Nam**, trình xác minh v40 đối chiếu SHA-256 của **1.206 mục**, gồm **589 tệp nguồn**, gói ứng viên, gói lùi và image OCI. Đồ thị OCI có 14 blob đã kiểm, gồm index và platform đúng digest. Lúc **18:04:17**, bản dựng độc lập từ nguồn trích và lockfile trong ZIP tái lập digest của **313 tệp** và **189 thành phần SBOM**. SHA-256 của ZIP là `fea2d1c0e0af052ed290d62beb9df27c1d1bba5cc7b47c817208010d6ccc2476`. [Biên bản ZIP và OCI](../.local/evidence/enterprise-e5-v40-reproduction-archive-review.json) · [Biên bản dựng từ ZIP](../.local/evidence/enterprise-e5-v40-rebuild-from-archive-review.json)

Để dựng lại, lấy SHA-256 của ZIP và `bundle-manifest.json` từ biên bản trước khi trích nguồn. Chạy `.local/extract-v40-build-source.py <zip> <thư-mục-đích> <sha256-manifest> 589` từ snapshot `C:/Users/thanhnx/.codex/aio-v40-oidc`. Dùng thư mục đích mới có đường dẫn ngắn. Tại đích, chạy `node scripts/release.mjs source-digest` rồi `npm run release -- build enterprise-rc-v40-reproduction-check`. So với digest nguồn `f7878b77f906e8498b6690ba2d0861f05b23a2563c4340551fd255ad43a9a787` và digest gói `854146d8798024fd2192f37bb4071f4f03f814d0c9f515a96d0b799707e5288a`. Cổng E5 vẫn cần hồi quy đầy đủ, ca nạp image trên engine sạch và nghiệm thu staging. [Chỉ mục đóng gói v40](../.local/evidence/enterprise-rc-v40-gate-index-packaging.json)

Lúc **21:04:11 ngày 14/11/2026, giờ Việt Nam**, ZIP bằng chứng staging v40 kiểm lại 55 mục và ghim SHA-256 của ZIP nguồn. Gói gồm các receipt đã đối chiếu, tài liệu vận hành và script của hai lượt workbook/reset và availability/audit. Lượt tải lại và nghiệm thu cuối cần cập nhật khi có biên bản. [Biên bản ZIP bằng chứng](../.local/evidence/enterprise-e5-v40-staging-evidence-archive-review.json)

Lúc **21:08:25 ngày 14/11/2026, giờ Việt Nam**, so sánh 589 tệp nguồn của gói niêm phong với hai snapshot chạy bổ sung. Bộ chạy workbook/reset thay bốn tệp và thêm một fixture. Bộ chạy availability/audit thay một tệp. Ghép các tệp trong ZIP bổ sung với nguồn gốc tái lập đúng cả hai digest runner đã ghi trong receipt. Các bản sao script vận hành và receipt riêng nằm trong ZIP bằng chứng staging. [Biên bản đối chiếu hai runner](../.local/evidence/enterprise-e5-v40-runner-deltas-review.json)
