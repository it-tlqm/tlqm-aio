# Tích hợp LMS vào AIO

Ngày: 09/11/2026. Trạng thái: **đề xuất dựa trên source local, chưa sửa LMS**.

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
| Chưa xác minh OIDC library tương thích Workers | Spike trên bản sao test, không cài vào source đang dùng trong đợt này |

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
