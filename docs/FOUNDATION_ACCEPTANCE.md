# Nghiệm thu Foundation MVP local

Ngày 10/11/2026 (Asia/Bangkok); timestamps bằng chứng dùng UTC. **Đạt toàn bộ mười tiêu chí Foundation MVP local**. Ba suite E2E và onboarding sau bản sửa seed đã pass; không còn lỗi chặn trong phạm vi này. Forms và LMS là goal tiếp theo, chưa được tính là hoàn thành.

## Môi trường và revision

- Workspace D:/thanhnx/TLQM-AIO, nhánh feat/foundation-mvp, baseline HEAD abea705b0937fe164fa9c983700089bec88c82ba. Worktree dirty gồm triển khai chưa commit; kết quả không đại diện riêng commit HEAD. Không commit/push/deploy trong đợt nghiệm thu.
- Node quan sát v24.20.0. TypeScript + Fastify; React/Vite/Tailwind v4/shadcn với font Be Vietnam Pro nạp local và palette TLQM.
- Docker context desktop-linux, endpoint named pipe local; chỉ project tlqm-aio-local. Keycloak 26.8.2, PostgreSQL 17.7-alpine. Ba BFF A/B/C ở loopback 4100/4101/4102; IdP 8180; Foundation DB 5438. Không dùng source/database/auth hiện hữu LMS/BOS/YMS.
- Dữ liệu giả lập, database aio_foundation và aio_foundation_test; runtime aio_runtime khác migration owner aio_foundation. Migration 001–005 bất biến, checksum giữ nguyên. Snapshot SHA-256 của 100 file source/config tại .local/evidence/foundation-revision.json: 056c74055c66cd6caad9af8769b6a4213b455c5fc293e392fc0c3e35ab5a5afe; không chứa secrets hoặc dữ liệu runtime.

## Đối chiếu mười tiêu chí bắt buộc

| Tiêu chí goal | Bằng chứng chạy và phạm vi |
| --- | --- |
| 1. MFA admin, UI/API quản trị, người thường chỉ có quyền đã cấp | scripts/e2e.ts kiểm tra OTP thật, AMR pwd+otp, chỉ mật khẩu/OTP sai, recovery độc lập. identity-e2e.ts tạo người/account/grant/binding/việc làm/bổ nhiệm. admin-ui-e2e.ts tạo/archive pháp nhân, đơn vị, chức danh, vị trí, app planned, permission, role; người thường bị từ chối qua UI và HTTP. |
| 2. Nhân sự chính/kiêm nhiệm và invariant | Fixture hai tenant/pháp nhân, ba đơn vị, hai assignment. tests/database.test.ts và management.test.ts từ chối chu kỳ, sai pháp nhân/tenant, chồng vị trí chính, khoảng hiệu lực sai; identity E2E giữ lịch sử sau kết thúc việc làm. |
| 3. SSO A/B, cách ly và client C | SSO ba client; access token, ID token, cookie, role/scope dùng chéo bị từ chối. Client C aio-onboarding qua manifest v1, client/secret/audience riêng; test:onboarding chứng minh rerun/disable/activate theo hợp đồng. Đây là BFF thử do Foundation vận hành, chưa phải LMS adapter. |
| 4. Thu hồi, khóa, hết phiên, logout, truy cập trực tiếp | E2E đo grant revocation và disable A/B dưới 60 giây; access token hết hạn thật/refresh rotation, idle/absolute deadline, invalid refresh fail closed. API trực tiếp và bearer cũ sau mở lại bị từ chối. Resilience kiểm tra logout có chữ ký/replay A/B/C. |
| 5. Audit và chống nâng quyền/mất cập nhật | tests/management.test.ts, governance.test.ts, sessions.test.ts: audit before/after trong transaction, rollback khi audit lỗi, retry một effect, optimistic revision, delegation/permission ceiling, self/protected account guards. Alias grant cũ/mới dùng cùng receipt và revision. |
| 6. Frontend shadcn/TLQM, 1440/390, bàn phím/trạng thái | Các suite kiểm tra computed colors/font nạp thật/radius/44px, dialog focus trap/restore, validation, no-access, mobile và CSP. admin-ui quét 17 trạng thái WCAG A/AA không exclude/disable rule, zero violations trong lượt gần nhất. Có các kiểm tra tự động chưa kết luận, được bổ sung kiểm tra focus/ảnh; không tuyên bố chứng nhận WCAG. |
| 7. Format/TypeScript/unit/integration/E2E/build | npm run check đã đạt Prettier, TypeScript strict, 52 tests (0 skip) và hai build. Ba suite E2E trên revision cuối đều pass lúc 17:54–17:55 UTC; onboarding sau sửa seed cũng pass. |
| 8. Outage/recovery/replay/key rotation/restore | test:resilience đã dừng DB/IdP thật, cả cold/warm JWKS trả 503, API sống và hồi phục; ký bằng khóa RSA mới sau cache warm, giữ MFA khi refresh, rollback passive. test:restore vào target mới, khớp 27 bảng/audit/sequences/checksums, owner đúng/runtime không CONNECT, source/config không đổi. |
| 9. Dựng lại, fixture/secrets/migration/rollback | LOCAL_DEVELOPMENT, LOCAL_MFA_RECOVERY, LOCAL_CLIENT_ONBOARDING, RESILIENCE_AND_RESTORE. test:bootstrap đã chạy 001–005 trên DB trống, map admin bằng proof MFA thật, kiểm quyền runtime và rerun không hồi quyền/đổi credentials. |
| 10. Không còn blocker trong phạm vi Foundation | Đã đạt gate. Liên kết nội bộ tài liệu và git diff --check đều pass; snapshot source và artifacts được lưu để review. Production, HR/AD, Forms/LMS và LIMS không được tính là đã nghiệm thu cùng Foundation. |

## Bằng chứng và số đo

Artifacts chỉ chứa kết quả/metadata giả lập, lưu trong .local/evidence và bị Git ignore. Không đưa credentials, OTP seeds, session/callback/proof codes hoặc dump vào báo cáo.

| Artifact | Lượt kiểm chứng UTC | Kết quả |
| --- | --- | --- |
| bootstrap.json | 2026-11-09T17:52:30Z | Pass; aio_foundation_bootstrap_7bb96c0a, migrations 001–005, fresh MFA identity, quyền runtime, rerun và credentials giữ nguyên |
| resilience.json | 2026-11-09T17:25:13Z | Pass; back-channel revoke 292 ms, DB recovery 977 ms, IdP recovery 6708 ms |
| restore.json | 2026-11-09T17:30:44Z | Pass; aio_foundation_restore_20261109_4cb19c8f, 27 bảng/41 audit rows, dump 415 ms/restore 429 ms, 86.859 bytes |
| measurements.json | 2026-11-09T17:35:57Z | RSS idle 120,92 MiB, sampled peak 121,92 MiB; 100 requests tuần tự trong 3928,46 ms; p95 authenticated khoảng 52–61 ms |
| security-lifecycle.json, identity-lifecycle.json | 2026-11-09T17:54:00Z / 17:54:49Z | Pass; grant C revoke 79 ms, alias revoke/retry checks 344 ms, ba renewal đồng thời 125 ms; khóa account làm mất phiên A/B 668 ms |
| admin-ui.json, accessibility.json | 2026-11-09T17:55:21Z | Pass; Workflow quản trị, 17 scans, violations/incomplete rules theo từng trạng thái |
| client-rehearsal.json | 2026-11-09T17:57:32.573Z | Pass; Bảo toàn credentials/quyền bị thu hồi, disable/setup/explicit activation |

Đã sửa lỗi bootstrap phát hiện trong nghiệm thu: ON CONFLICT không chỉ định khóa bị PostgreSQL từ chối vì ràng buộc exclusion có thể deferred trên assignments. Seed nay chỉ bỏ qua trùng primary key id; vẫn kiểm tra chồng lịch. Không sửa migration đã áp dụng. Target thất bại và target thành công được giữ, runtime bị thu hồi CONNECT sau diễn tập.

Ảnh kiểm chứng dữ liệu giả lập: foundation-desktop/mobile, admin-directory-desktop, admin-profile-mobile, admin-form-invalid, admin-role-editor, identity-link-confirmation, identity-offboarded-desktop/mobile và audit desktop/mobile. Không chụp IdP hoặc proof chưa che. Danh sách ảnh thực tế ở .local/evidence.

## Giới hạn và chuyển giai đoạn

- Chỉ nghiệm thu local HTTP loopback; chưa chốt topology/hosting/TLS/secret store/HA, retention, RPO/RTO, MFA thiết bị thật hoặc dữ liệu nhân sự thật. Backup và rotation thử local không thay runbook production.
- Số đo là một lượt không tải với concurrency 1, không là SLA/capacity benchmark. Mỗi request introspect online; limiter bộ nhớ từng BFF chưa phù hợp scale nhiều replica.
- Mutation API serialize các thay đổi quản trị và kiểm revision. Chưa tuyên bố kiểm chứng mọi race của các writer SQL trực tiếp ngoài API; ứng dụng khác không được truy cập database định danh.
- Đường review hỗ trợ là frontend build do Fastify phục vụ ở 4100; luồng auth/logout Vite 5173 chưa nghiệm thu.
- Chưa chứng nhận WCAG đầy đủ. Audit UI có filter cơ bản; retention/export chuyên dụng thuộc bước vận hành sau.
- Sau full Foundation gate, theo xác nhận người dùng: xây Form Builder, rồi tích hợp LMS trong môi trường riêng. LIMS để sau. Không tự commit/push/deploy hoặc thay đổi hệ thống cũ.

Nguồn tiêu chí: [Goal Foundation](../roadmap/GOAL_FOUNDATION_MVP.md). Tiến độ: [FOUNDATION_PROGRESS](../roadmap/FOUNDATION_PROGRESS.md). Lệnh tái kiểm chứng: [LOCAL_DEVELOPMENT](LOCAL_DEVELOPMENT.md).
