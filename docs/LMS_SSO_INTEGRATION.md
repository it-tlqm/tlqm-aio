# Tích hợp LMS vào AIO

Ngày: 10/11/2026. Trạng thái: **adapter sandbox trong AIO đã được triển khai và kiểm thử; LMS hiện hữu chưa sửa/chạy**. [Runbook sandbox](LMS_LOCAL_DEVELOPMENT.md) phân biệt các endpoint thử với LMS thật. Việc thay đổi call sites dưới đây là kế hoạch cho đợt tích hợp được giao riêng.

Cập nhật phạm vi theo yêu cầu mới ngày 10/11/2026: [Goal hoàn thiện LMS](../roadmap/GOAL_LMS_COMPLETE.md) đang triển khai nghiệp vụ LMS đầy đủ **trong AIO local** từ source tham chiếu. Các giới hạn read-only dưới đây mô tả baseline adapter trước goal này; không phải tiêu chí hoàn thành mới. Source/database/auth của LMS hiện hữu vẫn chưa được thay đổi.

## Cơ sở thực tế

Source tại `D:/thanhnx/OpenCode/LMS-TLQM/tlqm-learning-mvp` dùng Next.js, Drizzle và Cloudflare D1. Auth tự quản qua employees/sessions, cookie tlqm_session. Chưa thấy adapter OIDC trong lib/auth.ts và các endpoint auth được liệt kê. Chi tiết: [LMS_CURRENT_STATE](../inventory/LMS_CURRENT_STATE.md).

Giữ stack và D1 trong phương án ban đầu. Foundation mới dùng TypeScript + Fastify/PostgreSQL; việc tích hợp không yêu cầu đổi framework hoặc database của LMS.

## Phương án đề xuất

Bổ sung adapter OIDC phía server phù hợp runtime Cloudflare Workers. Adapter xác thực bằng AIO Identity, mapping vào employees.id hiện có, sau đó cấp phiên LMS đã được điều chỉnh để kiểm tra trạng thái và grant AIO.

Không đưa token dài hạn vào browser. Việc chọn thư viện cần spike kiểm tra Web Crypto, cách đọc headers/cookie, storage giao dịch state/PKCE/nonce và khả năng refresh trên runtime thực tế.

Mapping dự kiến gồm issuer, subject, aioAccountId, aioPersonId, legacyEmployeeId, verifiedAt và source. Chỉ tạo mapping qua nguồn đã xác minh; code nhân viên hoặc email không tự đủ bằng chứng.

## Bảo toàn dữ liệu

- Giữ employees.id vì progress, attempts và notes tham chiếu userId.
- Không tạo employee mới khi đã có mapping hợp lệ; ngăn liên kết trùng.
- Tách trường do Directory quản lý và trường nghiệp vụ LMS sở hữu.
- Map department text sang orgUnitId bằng bảng đối soát, không phỏng đoán tên giống nhau.
- Tiến độ, lần thi, điểm và lịch sử học tập vẫn thuộc LMS.
- Vai trò learner/admin/manager hiện tại cần mapping có quyền tối thiểu. instructor/training_manager chỉ thêm khi API thực sự hỗ trợ.

## Khoảng trống phải xử lý khi triển khai

| Khoảng trống quan sát | Việc cần làm |
| --- | --- |
| Session local mặc định 30 ngày | Thiết kế thời hạn mới và kiểm tra trạng thái/grant định kỳ |
| Login route gọi seedDefaultEmployeesIfEmpty | Tách bootstrap khỏi login ở môi trường pilot; rà soát riêng trước người dùng thật |
| employees chứa passwordHash và yêu cầu notNull | Thiết kế cách phân biệt account SSO/local; không sinh password giả để lách schema |
| Role manager có trong type nhưng API admin yêu cầu admin | Chốt role matrix, kiểm thử từng endpoint; không tuyên bố manager đã hoàn chỉnh |
| Source khảo sát chưa có Git | Xác nhận repo nguồn và backup/versioning trước khi được giao sửa |
| OIDC library trên Workers | workerd/D1 sandbox đã chạy discovery, PKCE/state/nonce, signature, refresh và logout thật; chưa chứng minh build Vinext hiện hữu tương thích khi thêm adapter |

## Rollout tương lai

1. Tạo môi trường test tách biệt, dữ liệu giả lập có đầy đủ lịch sử học.
2. Thêm mapping và adapter theo phạm vi được giao; dry-run liên kết user.
3. Bật SSO cho nhóm thử có grant; kiểm tra LMS và Forms cùng một danh tính.
4. Đối soát tiến độ, kết quả và quyền trước/sau.
5. Mở rộng có kiểm soát; mỗi thay đổi runtime cần kế hoạch rollback.

Rollback giữ nguyên mapping và lịch sử; tắt đường SSO không được khôi phục quyền của account đã bị khóa. Không bỏ auth local của người thật trước khi chuyển đổi được duyệt và kiểm chứng.

## Nghiệm thu

- Từ Portal/Forms mở LMS qua SSO thành công khi có grant.
- User có SSO nhưng không có grant LMS bị từ chối.
- Cùng user vẫn thấy đúng lịch sử học, không nhân đôi employee.
- Learner không xem kết quả người khác hoặc gọi API admin.
- Thu hồi quyền/khóa account có hiệu lực trên cả session LMS đang mở.
- Lỗi IdP/Access không tạo user hoặc cấp role mặc định.
- Không thay câu hỏi, đáp án, chấm điểm hay chương trình học trong nhiệm vụ tích hợp auth.

## Hợp đồng và call sites cho đợt tích hợp LMS thật

Đọc chọn lọc lại ngày 10/11/2026 tại D:/thanhnx/OpenCode/LMS-TLQM/tlqm-learning-mvp: vẫn không có Git root để ghi nhánh/commit/dirty. Chỉ đọc tên hàm/export và đường dẫn sử dụng; không chạy source, không đọc passwords/seed defaults/.env hoặc dữ liệu người thật. Source sandbox mới ở src/lms trong AIO, không copy lớp nghiệp vụ LMS.

| Điểm cần rà soát/sửa khi được giao | Hợp đồng đã thử trong sandbox |
| --- | --- |
| worker/index.ts — Vinext fetch handler và D1 binding | Giữ entry/framework hiện hữu; gắn adapter vào binding/request scope tương ứng. Spike workerd không thay cho build/test Vinext thực tế. |
| lib/auth.ts — getAuthUser, validateSession | Trả cùng employee ID sau xác thực issuer+subject và kiểm quyền trực tuyến. Không tin cookie tlqm_session 30 ngày để vượt AIO. |
| lib/auth.ts — createSession, destroySession, buildSessionCookie | Session SSO riêng, opaque/HttpOnly, mã hóa payload, lease/CAS refresh, idle/absolute, CSRF và logout receipt. |
| app/api/auth/login/route.ts | Tách seed khỏi login; callback không tự tạo employee/password hoặc tự nối email/code. Bootstrap chỉ trong môi trường và thao tác được kiểm soát. |
| app/api/auth/change-password/route.ts | Tài khoản SSO dùng IdP; luồng local cần chính sách riêng khi pilot, không tạo đường vượt quyền đã thu hồi. |
| app/api/admin/route.ts và các endpoint gọi getAuthUser | Kiểm từng endpoint learner/reviewer/admin, tenant/unit và MFA. Menu không cấp quyền. Không coi manager type là chứng minh mọi chức năng manager đã có. |
| db/schema.ts, migration D1 | Bảng mapping bổ sung, ownership bất biến; employees.id và user_id của progress/attempts/notes giữ nguyên. Migration thật phải dựa trên snapshot/versioning và backup đã duyệt. |

Foundation mới trả dữ liệu định danh/tổ chức tối thiểu qua authorize/subjects; Worker không đọc DB Identity. Endpoint subjects cần proof từ confidential backend và token của người gọi; không phải API tra cứu mở cho browser. LMS quyết định quyền nghiệp vụ trước khi đối chiếu đơn vị của từng học viên. Adapter deny khi stale mapping; operator đối soát unit bằng nguồn Foundation có kiểm chứng, nâng auth_not_before và giữ ID/historical rows.

Sandbox không cung cấp quản trị chương trình học, câu hỏi, nội dung video hoặc chấm điểm mới. Không thay đổi các phần đó trong đợt tích hợp auth tương lai nếu chưa được giao. Chỉ chuyển sang pilot sau khi có repo nguồn/versioning, môi trường tách biệt, backup/restore D1, TLS/secret store, kiểm chứng Vinext và phê duyệt phạm vi dữ liệu thực.
