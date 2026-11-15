# Forms rồi LMS — Tiến độ goal local

Ngày 10/11/2026. **Goal local đã đạt toàn bộ phạm vi Foundation → Forms → LMS sandbox.** Foundation có [nghiệm thu riêng](../docs/FOUNDATION_ACCEPTANCE.md); người dùng đã cho phép tiếp tục xuyên đêm qua các module. Không commit/push/PR/deploy, không sửa source/database/auth LMS/BOS/YMS.

## Thứ tự và gate

1. Forms: spike BOS/ADR → DSL validation → storage/migrations và quyền → API version/audience/phiếu/report → UI shadcn → nghiệm thu đầy đủ theo FORM_BUILDER_MVP.
2. LMS: adapter sandbox/mapping giữ legacy ID và lịch sử giả lập → kiểm chứng runtime tương thích/SSO/grant/revocation/rollback. Không gọi sandbox là tích hợp LMS đang dùng; source cũ chỉ đọc.
3. LIMS để sau.

## Đã làm

- Foundation goal đã complete trước đó; goal Forms/LMS nay đã đạt acceptance local, không có token budget được đặt.
- Spike read-only BOS và quyết định module riêng: [ADR 0003](../docs/decisions/0003-forms-isolated-module.md). Không copy/import Ant Design, Prisma hoặc code BOS.
- src/forms/contracts.ts, access.ts, service.ts, reporting.ts đã có DSL, phân quyền qua boundary, version/audience/group/submission/cancel, report/CSV và audit. 19 tests Forms domain/PostgreSQL thật pass, TypeScript pass.
- aio_forms/aio_forms_test đã dựng bằng forms:setup; chạy lại giữ credentials. Hai role owner/runtime riêng không CONNECT Identity DB; Foundation runtime không CONNECT Forms. Migrations Forms 001–003 đã áp dụng, bất biến. [Runbook](../docs/FORMS_LOCAL_DEVELOPMENT.md).

## Foundation và Forms đã đạt gate local

- [FORMS_ACCEPTANCE](../docs/FORMS_ACCEPTANCE.md) đối chiếu baseline, giới hạn và source snapshot. 74 tests + format/TypeScript/build pass; Foundation ba E2E suites pass sau extension Forms.
- test:forms-api cuối 2026-11-09T18:58:26Z pass Portal → Forms SSO/MFA, role/scope/CSRF/retry/report/CSV và revoke 134 ms.
- test:forms-ui cuối 2026-11-09T18:59:00Z pass khảo sát 10 câu, 13 axe scans zero violations, desktop/mobile/focus, v1→v2, groups và close. Ảnh designer/response/mobile đã xem. Không chứng nhận WCAG.
- Onboarding C và Forms đều pass sau extension (18:51:32Z / 18:54:32Z), gồm forms:fixtures khi application disabled và quyền respondent đã thu hồi; credentials giữ nguyên, fixture đã restore có audit.
- Client aio-forms ở 4103, kind application, manifest v2. Năm user Forms riêng; designer/publisher MFA thật. Marker user profile chỉ admin view/edit; subject từ creation receipt, không link theo username/email.
- Source snapshot .local/evidence/forms-revision.json gồm file source/config, không secrets; worktree vẫn dirty trên abea705, không commit/push/deploy.

## LMS sandbox đã đạt gate local

Đã kiểm lại source có giới hạn, vẫn không có Git root. Adapter mới ở src/lms chạy workerd/D1 local riêng, client aio-lms-sandbox 4104; migrations 001–002 bất biến. Node BFF không chạy external client. Foundation thêm authorize/subjects boundary với audience và service proof riêng, không cấp credential DB Identity cho Worker.

SSO Portal/Forms → Worker, giữ ID/tiến độ/điểm/ghi chú/password hashes, quyền learner/reviewer/admin/MFA, CSRF, role/unit/grant/account/application revocation, concurrent refresh và rollback đã pass E2E. Five axe scans zero violations, ảnh desktop/mobile đã xem. Signed logout/replay và outage Foundation/DB/IdP warm/cold đã pass. Operator CLI MFA và setup rerun giữ trạng thái revoked đã pass; explicit restore có audit. [Runbook](../docs/LMS_LOCAL_DEVELOPMENT.md), [bảng nghiệm thu](../docs/LMS_ACCEPTANCE.md).

npm run check cuối pass 84 tests/TypeScript/build. Hồi quy Foundation test:e2e ba suites, Forms API/UI, LMS E2E (PKCE/nonce negatives), LMS resilience và onboarding đều pass, kết thúc 2026-11-09T20:02Z. Đã kiểm link/tài liệu và lưu source snapshot .local/evidence/lms-revision.json. Không commit/push/deploy. LMS hiện hữu vẫn chưa tích hợp; việc tiếp theo cần repo nguồn/versioning, môi trường pilot và phạm vi sửa hệ thống thật được giao rõ ràng, không tự triển khai từ thiết kế này.

## Giữ nguyên

Ngày 10/11/2026, theo yêu cầu ưu tiên LMS sau đợt sửa component chung, đã nâng giao diện học viên và bảng theo dõi trong AIO sandbox: tìm/lọc bài học, chi tiết theo lesson_id, tiến độ và kết quả, lọc học viên và phân trang. Phạm vi tích hợp LMS hiện hữu không đổi. Kết quả kiểm chứng đợt mới ghi trong [nghiệm thu LMS](../docs/LMS_ACCEPTANCE.md), tách khỏi nghiệm thu baseline ở trên.

Foundation migrations 001–005 bất biến. Foundation snapshot tại .local/evidence/foundation-revision.json; thay đổi mới phải được kiểm thử lại khi ảnh hưởng auth/quyền. MFA/E2E/onboarding/resilience/restore chạy tuần tự. Cổng A/B/C đóng sau tests; xác minh lại trước khi chạy. Không đọc/in credentials; .local chỉ chương trình tiêu thụ.
