# Trạng thái triển khai Foundation

Cập nhật: 11/11/2026. Foundation MVP local đã đạt toàn bộ gate nghiệm thu trên nhánh local feat/foundation-mvp; thay đổi chưa commit/push. [Đối chiếu nghiệm thu](FOUNDATION_ACCEPTANCE.md) ghi đủ mười tiêu chí và giới hạn. Chưa triển khai hạ tầng remote hoặc production.

Mốc workspace tổ chức ban đầu: tạm giữ trạng thái LMS và xây phần **Cơ cấu tổ chức / user / role / chức danh / vị trí công việc**. Đã triển khai và kiểm chứng local [workspace quản trị tập trung](ORGANIZATION_WORKSPACE.md): cây đơn vị, thống kê người không đếm lặp khi kiêm nhiệm, hồ sơ công tác/tài khoản và ma trận quyền. API và journals hiện có giữ nguyên. Hồi quy ngày 10/11/2026 đạt **139 unit/integration tests**, tám lệnh pass; 8 axe scans E2E và 6 scans local không violations, đã xem ảnh desktop/mobile. `org.admin` đã sẵn sàng để người dùng tự thiết lập MFA/đổi mật khẩu lần đầu. [Nghiệm thu](../roadmap/ORGANIZATION_WORKSPACE.md) ghi receipt, provenance, audit và giới hạn; các số kiểm thử Foundation ban đầu phía dưới là lịch sử.

Đợt vận hành tiếp theo đã triển khai [bốn mục tổ chức/nhân sự/Quy trình/Excel](ORGANIZATION_OPERATIONS.md), thêm Foundation 006 và Workflows 003. Hồi quy tám lệnh đạt 150 tests; follow-up UI và 10 axe scans nghiệp vụ mới đều pass. Provenance và giới hạn ở [goal vận hành](../roadmap/GOAL_ORGANIZATION_OPERATIONS.md).

Sau goal Forms/LMS, người dùng giao module Quy trình kiểu AMIS và tái sử dụng BOS. [WORKFLOWS_ACCEPTANCE](WORKFLOWS_ACCEPTANCE.md) giữ bằng chứng bản đầu và đợt nâng cấp nhóm/người xử lý: tại mốc đó **103 tests**, hồi quy Quy trình/Foundation/Forms/LMS pass, thêm 4 scans UI assignment không có violations. [Nhóm, chọn người khi gửi và người đã xử lý bước trước](WORKFLOWS_ASSIGNMENTS.md) đã chạy local. Đây là module riêng aio-workflows 4105, không phải một trường trạng thái duyệt gắn vào Forms.

Mốc LMS 10/11/2026 11:19Z: [LMS đầy đủ](LMS_ACCEPTANCE.md) đã có quản lý/phát hành khóa học, media, học/checkpoint/thi/chứng nhận, ngân hàng/Excel, báo cáo và học viên SSO-only. Hồi quy tích hợp 19 lệnh (check, LMS, Foundation, Forms, Quy trình) đều pass với source hashes ổn định. Đã kiểm phân trang trên 500 dòng, backup/restore D1/R2 và bảo trì. Ngày 11/11/2026, Edge phát lại được video Vimeo thật, lưu điểm dừng, lưu mốc cuối sau khi sửa và giữ tiến độ khi tải lại. [Roadmap và bằng chứng LMS](../roadmap/GOAL_LMS_COMPLETE.md).

Mốc 11/11/2026: triển khai [Trung tâm công việc](WORK_CENTER.md), chỉ nguồn Quy trình trong đợt đầu. Workflows 004 lưu thông báo giao dịch, trạng thái đọc, cấu hình và trạng thái worker; không thêm nghiệp vụ vào DB IAM. E2E mới đã kiểm SSO deep link, UI và thu hồi quyền; [goal](../roadmap/GOAL_WORK_CENTER.md) đang ghi hồi quy cuối.

## Đã xây

Các mốc cấu hình ngày 11/11/2026 đã nghiệm thu local: [E1 hồ sơ tùy chỉnh](CONFIGURABLE_DIRECTORY.md), [E2 nhóm duyệt/lịch làm việc](WORKFLOWS_ADVANCED.md), [E3 chính sách học/thi](LMS_POLICIES.md), [E3b lộ trình/đợt đào tạo](LMS_TRAINING.md), [liên kết đề xuất hồ sơ → Quy trình → HR áp dụng](PROFILE_WORKFLOWS.md), [công việc/nhắc hạn LMS](LMS_WORK_CENTER.md), [nhập/xuất cấu hình](CONFIGURATION_TRANSFER.md) và [bộ mẫu](../examples/configuration/README.md). Hồi quy E4 kết thúc `2026-11-10T23:20:03.140Z` với **19/19 lệnh, 209 tests, sourceStable=true cho 401 file**. E4c đạt 12 axe scans, đã xem ảnh cuối; stack 4100–4105 mở lại và kiểm readiness lúc 06:20 giờ Việt Nam. Foundation 001–008, Workflows 001–006, LMS 001–009, Forms 001–003 đã áp dụng local/test, giữ bất biến. [Phạm vi và bằng chứng E4](../roadmap/GOAL_CONFIGURABLE_SUITE.md).

| Hạng mục | Phạm vi thực tế |
| --- | --- |
| Stack | TypeScript + Fastify 5; Node 24; npm lockfile |
| Identity local | Keycloak 26.8.2; PostgreSQL riêng; realm aio-local và sáu confidential clients A/B/C/Forms/LMS sandbox/Quy trình |
| OIDC | Authorization Code + PKCE S256, state, nonce, ID token signature validation |
| API authentication | JWT signature/issuer/audience/expiry/authorized party và online introspection |
| Session | Cookie HttpOnly/SameSite; hash và token payload mã hóa AES-GCM; refresh có khóa từng phiên, idle 15 phút/absolute 60 phút, rotation/replay guard |
| MFA local | Hai quản trị giả lập có OTP; AMR pwd+otp từ token đã xác minh được backend thực thi; CLI recovery riêng có audit và thu hồi phiên |
| Logout | Từng app, RP logout có xác nhận tại IdP, back-channel có chữ ký và replay receipt |
| Directory | Schema + API create/update/list 8 resource; revision, guard chu kỳ/quan hệ/khoảng thời gian; archive bằng active=false hoặc kết thúc hiệu lực |
| Identity lifecycle | Proof OIDC mới, preview/xác nhận subject, liên kết một lần có audit; immutable issuer+subject ownership; khóa/mở lại không phục hồi token cũ; revoke/relink và offboard giữ lịch sử |
| Access | CRUD API/UI roles, permissions, bindings, grants; delegation/permission ceiling, tenant/app/unit scope, protected records, revision/idempotency |
| Grant/revoke | Đường cũ/mới cùng GovernanceService: revision, idempotency, delegation và audit before/after nguyên tử; payload cũ thiếu revision/key bị từ chối |
| Registry | Ba app thử active; client C onboarding manifest v1, Forms v2, LMS sandbox v3 external-application riêng. Client tlqm-lms dành cho LMS hiện hữu vẫn planned; không đồng nhất với sandbox. |
| Audit | Login/logout/grants và Directory mutations; before/after, audit cùng transaction, mutation receipts và API đọc tenant audit |
| Frontend | React/TypeScript/Vite/Tailwind v4 và shadcn thật; tiếng Việt, palette TLQM, Be Vietnam Pro local; portal/profile, Directory, registry/access và audit list/detail |
| Hạ tầng | Docker project riêng; runner migration 001–005 có checksum/marker; runtime role aio_runtime riêng với owner migration |

## Bằng chứng kiểm thử

- TypeScript strict: pass.
- 52 unit/integration tests: pass, 0 skip — gồm proof/replay/expiry/concurrency, identity ownership bất biến, auth_time và offboard; DB/JWKS unavailable; giữ toàn bộ kiểm tra auth/MFA, client contract, DB privilege/scope, audit/retry/revision trước đó.
- Chromium E2E: pass — SSO/logout A/B/C, client C cách ly token/cookie/quyền, callback sai, thu hồi riêng và rollback registry; access token hết hạn thật/renewal/deadline, MFA/recovery, Directory/governance HTTP, UI chức danh/đơn vị/role; keyboard/mobile/font/token/CSP. Kiểm tra alias grant được bổ sung cùng suite.
- test:onboarding: pass — provision rerun giữ secrets và quyền đã thu hồi; disable → db:setup vẫn disabled; provision không tự kích hoạt; activate rõ ràng vẫn giữ grant/role/binding bị thu hồi, sau đó restore fixture có audit. Keycloak PUT phải giữ webOrigins=[] tường minh; đã sửa lỗi tự suy ra CORS origin trong diễn tập.
- Suite identity-e2e: pass — qua UI tạo person/account/grant/binding/employment/bổ nhiệm chính/kiêm nhiệm; proof thật từ Keycloak, xác nhận/thu hồi/nối lại, khóa/mở lại từ chối token cũ và token refresh cũ, kết thúc công tác giữ lịch sử, offboard không tự hồi quyền. Đã kiểm tra dialog keyboard, giao diện 1440/390 và xem ảnh bằng chứng.
- Build frontend và backend TypeScript: pass. Bằng chứng là worktree chưa commit trên baseline abea705, không phải chỉ source tại HEAD.
- npm audit --omit=dev: không có advisory được registry báo tại thời điểm kiểm tra. Chưa chạy container image scan.

- Suite admin-ui: đã pass pháp nhân/vị trí/Registry/permission/role/audit filter và detail, cancel-before-write, no-access; 17 scans WCAG A/AA tự động với zero violations, không exclude/disable rule. Một số kiểm tra cần đánh giá thủ công; không tuyên bố chứng nhận WCAG đầy đủ.
- test:resilience: pass outage DB/IdP thật, cold/warm JWKS, signed logout replay A/B/C, khóa RSA mới live sau cache warm và rollback passive; API không crash, failed write không tạo audit giả, phục hồi đúng phiên và MFA.
- test:restore: pass vào target riêng, khớp 27 bảng/41 audit rows/sequences/checksums, owner đúng, runtime không CONNECT; nguồn/config không đổi. [Runbook](RESILIENCE_AND_RESTORE.md).
- test:bootstrap: pass toàn bộ migrations và fixture trên DB trống, fresh MFA mapping, quyền runtime, rerun giữ credentials/quyền đã thu hồi. Đã sửa seed assignment để ON CONFLICT chỉ xử lý trùng id; giữ nguyên ràng buộc chồng lịch và migration 001–005.
- Đã đo CPU/RAM/latency API compiled và container; [LOCAL_MEASUREMENTS](LOCAL_MEASUREMENTS.md). Các số thu hồi dưới 60 giây là đo local không tải, chưa là SLA production.

## Giới hạn và giai đoạn tiếp theo

- Final gate đã đạt theo [FOUNDATION_ACCEPTANCE](FOUNDATION_ACCEPTANCE.md); chuyển Forms và LMS theo xác nhận người dùng; không coi toàn Sprint 01 đã xong khi hai module này còn thiếu.
- HR/AD synchronization và quy trình xác minh con người/thiết bị production. Liên kết định danh/vòng đời local đã có: [runbook](IDENTITY_LIFECYCLE.md).
- MFA thiết bị thật/production, workflow required action cho nhân sự mới và phân tách quyền vận hành. MFA/recovery fixture local đã có: [runbook](LOCAL_MFA_RECOVERY.md).
- Chưa kiểm chứng mọi writer SQL trực tiếp ngoài API hoặc chứng nhận WCAG đầy đủ. Mutation API đã có serialization/revision và kiểm thử concurrent updates; scope form thuộc giai đoạn Forms.
- Đo chiến lược session/cache dưới tải; renewal local đã có, mỗi request vẫn introspect online.
- Rate-limit dùng bộ nhớ của từng instance; chưa thiết kế shared limiter.
- TLS, secret store, HA, backups/restore và MFA thiết bị thật ở production; runtime DB role, restore/outage/recovery giả lập đã được kiểm chứng local.
- Retention/export audit chuyên dụng, container scanning, capacity benchmark và production deployment.
- Form Builder MVP local đã đạt [FORMS_ACCEPTANCE](FORMS_ACCEPTANCE.md), có database/runtime riêng, API/UI shadcn, 21 domain tests và E2E SSO/HTTP/UI thật. Baseline adapter LMS đã đạt gate Worker/D1/UI, quyền/revocation/rollback/outage/legacy preservation. Tổng kiểm tra tại mốc Forms/LMS là 84 tests; hồi quy Foundation/Forms và ba suite LMS tại mốc đó đều pass. Các số 84/103 là lịch sử trước goal LMS chức năng; trạng thái mới nhất ở đầu tài liệu. Source cũ giữ nguyên.

## Liên hệ backlog

Foundation đáp ứng phần nền tảng của S1-02 đến S1-06; các tiêu chí quyền Forms/LMS và integration của Sprint 01 vẫn chuyển tiếp. Bằng chứng/mức nghiệm thu được quản lý ở tài liệu acceptance, không suy ra tính năng chỉ từ backlog.

Chi tiết chạy và test: [LOCAL_DEVELOPMENT](LOCAL_DEVELOPMENT.md). Quyết định công nghệ: [ADR 0002](decisions/0002-typescript-fastify.md).

## Goal nâng cấp chức năng sau enterprise readiness

Cập nhật **15/11/2026**. Candidate enterprise đã được nghiệm thu trước khi mở goal mới. Lát đầu khôi phục trạng thái Trung tâm công việc qua URL cho nguồn, tab, trang, tìm kiếm, đơn vị, người xử lý và bộ lọc thông báo. Các panel Forms, Công việc và LMS giữ thêm view, tìm kiếm và trang riêng. Helper route giới hạn giá trị query trước khi dùng vào request và App Portal tách phần view khỏi query trong hash. TypeScript, formatter và bốn test route đã pass. Theo dõi các lát tiếp theo tại [GOAL_FUNCTIONAL_UPGRADE](../roadmap/GOAL_FUNCTIONAL_UPGRADE.md).

Lát báo cáo LMS thêm route chia sẻ cho bộ lọc đơn vị, khóa học, trạng thái, tìm kiếm, môn bắt buộc và trang. Backend vẫn nhận filter sau kiểm quyền hiện hành, còn frontend khôi phục state qua hash đã giới hạn. TypeScript và 281 test pass. Formatter riêng của các file lát này pass. Formatter toàn repo đang báo ba file CMS mới trong dirty worktree, được giữ nguyên theo phạm vi bảo toàn thay đổi có sẵn.

Forms list đã thêm route tìm kiếm có giới hạn. Tìm kiếm được khôi phục sau reload/deep link, query ngoài hợp đồng bị loại bỏ và không thay đổi quyền Forms.

Forms detail đã thêm route giữ tab nghiệp vụ qua reload/deep link. Tab được đối chiếu lại theo quyền Forms hiện hành trước khi hiển thị.

Danh bạ nhân sự đã thêm route khôi phục tab quản trị, tìm kiếm, đơn vị, trạng thái và trang. Backend vẫn trả dữ liệu theo scope hiện hành của Directory.

Work Center, báo cáo LMS, Forms list và Danh bạ nhân sự đã có thao tác sao chép URL hiện tại để chia sẻ đúng bộ lọc và tab đang mở.

Các màn đã có thao tác xóa nhanh bộ lọc, đưa state và URL về mặc định.

Gate functional upgrade local/staging đã pass theo .local/evidence/functional-upgrade-final-gate-20261115.json, với build, typecheck và 286 bài test pass. Phạm vi production connector, ký số, BPMN parity đầy đủ, lịch DST và vận hành production được tách riêng.
