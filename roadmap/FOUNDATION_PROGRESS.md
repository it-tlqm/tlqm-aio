# Foundation MVP — Tiến độ goal

Cập nhật 10/11/2026. Foundation đã đạt toàn bộ gate local; người dùng cho phép chạy xuyên đêm. Nhánh local: feat/foundation-mvp. Không commit/push.
Baseline: commit abea705b0937fe164fa9c983700089bec88c82ba; worktree có thay đổi chưa commit, không đại diện riêng HEAD. Migration 001–005 đã áp dụng vào aio_foundation và aio_foundation_test; tất cả đã áp dụng đều bất biến. E2E tự đóng API 4100/4101/4102; chưa khởi động lại API thường trực. .local/api.pid có thể cũ: phải xác minh process/cổng/health trước thao tác. Docker tlqm-aio-local vẫn chạy tại lần kiểm chứng gần nhất.

## Checklist và bằng chứng cần có

| ID | Yêu cầu | Trạng thái | Bằng chứng nghiệm thu |
| --- | --- | --- | --- |
| F01 | SSO A/B/C, PKCE, token/scope isolation | E2E ba client pass | scripts/e2e.ts chạy thật với Keycloak; C không dùng chéo token/cookie/ID token, callback chưa đăng ký bị từ chối |
| F02 | MFA quản trị + recovery fixture | Đã triển khai và E2E recovery pass | Hai quản trị OTP thật; backend bắt buộc AMR pwd+otp, cờ MFA có hiệu lực ngay; recovery thu hồi phiên/audit ở hai DB |
| F03 | Renewal, expiry, logout/replay, disable/revoke | Pass | E2E token hết hạn thật/rotation/idle/absolute và revoke <60s; resilience signed logout/replay A/B/C |
| F04 | Directory CRUD và invariant dữ liệu | Pass API/schema/UI MVP | tests/database.test.ts, management.test.ts, identity/admin-ui E2E bao phủ các resource và invariant |
| F05 | Person/account/employment/kiêm nhiệm | UI/API linking và vòng đời local đã kiểm chứng | identity-e2e: tạo hồ sơ/account/việc làm/bổ nhiệm chính+kiêm nhiệm, khóa/reopen/revoke/relink/offboard, giữ lịch sử |
| F06 | Roles/permissions/bindings có delegation và scope | Pass | tests/governance.test.ts, HTTP governance, UI permission/role/binding/grant và xác nhận thao tác |
| F07 | Registry CRUD, onboarding client C | Đã provision và kiểm chứng C qua manifest v1 | SSO C, revoke/role/registry độc lập, back-channel cả ba; test:onboarding giữ secrets/quyền và disable/activate pass |
| F08 | Frontend React/Vite/Tailwind4/shadcn | Đã dựng và nối API thật | frontend/, components.json; shadcn radix-nova; E2E CRUD thật |
| F09 | TLQM tokens/font, responsive/a11y/states | Pass phạm vi MVP; không chứng nhận WCAG | Computed styles, font loaded, ảnh 1440/390, dialog focus; 17 axe scans không violation, có ghi incomplete rules |
| F10 | Audit nguyên tử, before/after, filter | Transaction + before/after + retry; có list/detail UI, filter còn cơ bản | Test lỗi audit rollback data/receipt, optimistic concurrency và retry pass |
| F11 | Runtime DB role khác migration owner | Đã kiểm chứng local/test | aio_runtime không superuser/createdb/createrole; DDL, marker, audit update/delete bị từ chối |
| F12 | Migration checksum/idempotency/setup không hồi quyền | Pass migration 001–005, fresh bootstrap và onboarding rerun | Empty DB migration/seed, protected MFA admins, runtime privileges, rerun không hồi grant/binding; checksum drift bị từ chối |
| F13 | Outage/recovery IdP/DB và key rotation live | Đã pass diễn tập thật | test:resilience stop/start đúng container; warm/cold-JWKS trả 503, API sống, phục hồi phiên; DB retry đúng một audit; khóa RSA mới tạo sau khi cache ấm, rollback passive, signed logout replay A/B/C và MFA refresh pass |
| F14 | Backup/restore target riêng | Đã pass | Snapshot read-only, pg_dump/pg_restore vào aio_foundation_restore_20261109_4cb19c8f; khớp 27 bảng/data/audit/sequence, owner đúng, runtime không có CONNECT, nguồn không đổi |
| F15 | RAM/CPU/latency đo thực tế | Đã đo | Compiled API process riêng; 100 requests tuần tự sau warmup; docs/LOCAL_MEASUREMENTS.md và evidence/measurements.json; không gọi là SLA production |
| F16 | Tài liệu và acceptance đầy đủ | Pass | FOUNDATION_ACCEPTANCE + README/runbook cập nhật; liên kết và diff check đạt |

## Nghiệm thu cuối và chuyển giai đoạn

Ngày 10/11/2026, Foundation đạt tất cả mười tiêu chí; [FOUNDATION_ACCEPTANCE](../docs/FOUNDATION_ACCEPTANCE.md) đối chiếu từng yêu cầu và F01–F16 với bằng chứng. Không suy rộng thành nghiệm thu production hoặc toàn Sprint 01.

- npm run check: Prettier, TypeScript strict, 52 tests (0 skip), build UI/API đều pass.
- npm run test:e2e: cả ba suite SSO, identity-lifecycle và admin-ui pass. Báo cáo mới nhất 2026-11-09T17:54:00Z / 17:54:49Z / 17:55:21Z.
- test:bootstrap: database trống aio_foundation_bootstrap_7bb96c0a chạy toàn bộ migration/fixture, MFA mapping, quyền runtime và idempotent rerun. Đã sửa ON CONFLICT assignment chỉ target id; không đổi migration hoặc nới ràng buộc.
- test:onboarding sau sửa seed: pass provision/disable/setup/implicit activation rejection/explicit activation, giữ credentials và các grant/role/binding đã thu hồi. Fixture đã khôi phục có audit.
- Resilience, restore và đo tài nguyên đã pass trên code liên quan; seed fix không thay auth/runtime/backup. Các artifact/timestamps/số đo và giới hạn nằm trong acceptance/runbook.
- Bản source 100 file được hash vào .local/evidence/foundation-revision.json, baseline abea705 và dirty. Không commit/push/deploy.
- Đã xem ảnh audit desktop/mobile mới; giữ bảng cuộn ngang có chủ đích, focus nhìn rõ. 17 axe scans zero violations; có lưu incomplete rules, không tuyên bố WCAG certification.

Sau Foundation, người dùng cho phép tiếp tục Form Builder rồi LMS trong repo/local này. Cần ADR tái sử dụng BOS, module/schema riêng, quyền/audience/version/submission/CSV và kiểm thử đầy đủ theo docs/FORM_BUILDER_MVP.md. Giữ source/database/auth dự án cũ nguyên trạng; LIMS để sau.

## Quyết định

- Migration 005 thêm proof SSO có TTL/một lần, identity ownership bất biến và auth_not_before. Người dùng xác thực lại ở IdP để lấy proof; quản trị xác nhận đúng subject/hồ sơ trước khi nối. Không auto-link email, không tự cấp grant.
- Khóa account/person xóa phiên và tăng ranh giới auth_time. Mở lại không chấp nhận bearer token hoặc token refresh từ lần xác thực cũ. Offboard khóa account, thu hồi grant/binding trong home tenant, giữ nguyên lịch sử công tác; ngày kết thúc employment/assignment được quản lý riêng.

- Các role định nghĩa theo tenant + app; thay role của tenant A không ảnh hưởng tenant B.
- Ưu tiên ràng buộc dữ liệu ở PostgreSQL và kiểm tra quyền tại service; UI chỉ phản ánh quyền.
- Giữ migration 001 nguyên trạng, bổ sung migration kế tiếp và runner nhiều version.
- Forms/LMS là goal tiếp theo sau Foundation theo xác nhận chạy xuyên đêm; cloud/production chưa được phép.

## Blocker

Không còn blocker Foundation. Mười tiêu chí đã đạt trong phạm vi local; chuyển sang Forms rồi LMS. Các giới hạn production và kiểm chứng bổ sung được ghi tại acceptance, không cần mở rộng quyền remote để bắt đầu Forms.

## Tiếp tục sau resume

Đọc file này, git diff và migration/service mới nhất trước khi tiếp tục. Không cài lại/khởi tạo lại realm hoặc xoay credentials đang có. Xác minh PID/cổng trước khi dừng API để chạy E2E.
