# LMS — Quản trị học viên qua AIO

Ngày 10/11/2026. Phạm vi: local giả lập trong AIO. Source LMS cũ không được sửa hoặc chạy. Backend và giao diện đã qua `check` 131 tests và E2E G7/G8 (6 axe scans, desktop/mobile/keyboard, SSO, retry/CAS/CSRF, thu hồi quyền, chuyển đơn vị và giữ bài làm/chứng nhận). Receipt `.local/evidence/lms-provisioning-e2e.json`; ảnh cùng prefix đã xem trực tiếp. Hồi quy toàn chuỗi và tài khoản quản trị riêng còn ghi trong [goal đầy đủ](../roadmap/GOAL_LMS_COMPLETE.md).

## Thao tác

Trong LMS, chọn **Học viên & tài khoản**. Quản trị cần `lms:admin`, `directory:lookup`, `identity:provision` ở cùng tenant, xác thực password + OTP và mapping của chính mình đang hợp lệ.

1. **Thêm từ AIO**: tìm nhân sự theo tên. Danh mục chỉ trả nhân sự/tài khoản còn hoạt động, đang công tác và có grant LMS hiện hành. Tên hoặc mã nhân viên chỉ dùng hiển thị/tìm kiếm; không dùng để tự ghép định danh.
2. Chọn tài khoản và một đơn vị công tác hiện hành, ghi lý do rồi **Thêm học viên**. Backend lấy assertion định danh trực tiếp từ Foundation và tạo hồ sơ SSO-only. Callback đăng nhập không tự tạo học viên.
3. **Cấu hình → Khóa học viên**: khóa mapping LMS, thu hồi phiên của học viên; giữ ID, khóa học, bài làm, ghi chú và chứng nhận.
4. **Mở lại học viên**: kiểm tra lại tài khoản, grant, person, issuer/subject và đơn vị. Không khôi phục quyền IAM hoặc phiên cũ. Học viên phải đăng nhập lại.
5. **Đối soát đơn vị học tập**: chọn đơn vị đang công tác trên AIO. Giữ ownership/history; thu hồi phiên cũ. Nếu mapping đang khóa thì đối soát vẫn giữ trạng thái khóa.

Danh sách mapping có cursor 50 hồ sơ/trang. Danh mục AIO trả 100 nhân sự/trang. Nút trang sau tiếp tục đọc với quyền hiện hành; không dùng 50/100 bản ghi đầu làm toàn bộ danh mục. Khi quyền bị thu hồi, giao diện xóa dữ liệu đang hiển thị. Chỉ quản trị AIO thay đổi hồ sơ nhân sự, quyền, mật khẩu và MFA; LMS không có luồng reset password riêng.

Không thể chuyển một mapping sang account/person/issuer/subject/employee khác, kể cả khi tên hoặc email giống nhau. Không tự gán lịch sử legacy chưa xác định ownership cho một nhân sự trong danh mục. Hồ sơ legacy đã liên kết giữ quyền giao giữa IAM và role legacy; hồ sơ mới SSO-only dùng quyền hiện hành từ IAM, không bị role placeholder trong bảng lịch sử quyết định quyền.

## Hợp đồng và quyền

- `GET /api/lms/learners?cursor=...`: mapping trong tenant quản trị, kèm tên/đơn vị hiện hành nếu còn được Directory trả về; có trạng thái cần kiểm tra quyền, stale unit hoặc khóa. Không trả password hash, issuer/subject, token hoặc payload phiên.
- `GET /api/lms/learner-candidates?search=...&cursor=...`: nhân sự đủ điều kiện AIO; tài khoản đã liên kết được đánh dấu, không gán lại.
- `POST /api/lms/learner-commands`: `provision | enable | disable | reconcile`; data chỉ chứa accountId, orgUnitId, expectedRevision; reason và Idempotency-Key bắt buộc. Có CSRF, MFA, kiểm quyền lại trước batch, guard phiên trong transaction, CAS, audit và receipt cùng batch.
- `POST /api/v1/integrations/:appCode/identity`: assertion chỉ dành cho confidential adapter. Bearer đúng ứng dụng và HMAC HKDF context **aio-integration-identity-v1** ràng buộc query, app, token và thời gian ±30 giây. Proof Directory/subjects không dùng thay thế được.
- Foundation kiểm quyền `identity:provision` cấp tenant, Directory scope, grant và công tác của target. Chỉ chấp nhận đúng một external identity active của issuer đã cấu hình. Không chọn ngẫu nhiên nếu có nhiều identity; không trả dữ liệu học.
- Để cấp/bật capability `identity:provision`, operator Foundation cần `identity:link`, `directory:read`, `people:read` ở tenant và delegation quản trị ứng dụng. Capability này yêu cầu MFA; không gắn cấp đơn vị. Quản trị ứng dụng thông thường không tự tạo/cấp được capability.

Identity được xác minh lại ngay trước commit. Đây là hai dịch vụ độc lập, không phải distributed transaction giữa PostgreSQL và D1. Request tiếp theo luôn kiểm quyền và mapping lại, không dùng assertion cũ để giữ quyền khi Foundation/IdP ngừng hoặc grant bị thu hồi.

## Local provisioning

Sau `lms:directory`, chạy tuần tự:

~~~powershell
npm run lms:provisioning
npm run build
~~~

Script xác thực operator MFA, kiểm Docker local/DB marker, cấp capability cho role admin của LMS local/test qua GovernanceService. Receipt provisioning là tombstone: chạy lại không hồi capability đã bị gỡ. Không thay grants/bindings hiện hữu. Script này không tạo tài khoản quản trị dùng thử và không đổi mật khẩu.

`npm run lms:review-admin` chuẩn bị tài khoản **lms.admin** riêng trên **local** sau khi Foundation/LMS local đã chạy. Script kiểm marker local, chứng minh operator MFA/delegation, tạo tài khoản/nhân sự giả lập do AIO sở hữu và mapping qua API được xác minh. Credentials chỉ lưu `.local/lms-admin.json`; hướng dẫn không chứa secrets ở `.local/LMS-TRY.md`. Lần đầu người dùng phải đổi mật khẩu tạm và tự thiết lập MFA. Chạy lại không reset password/OTP hoặc mở lại quyền/mapping đã bị khóa. Script đã chạy local và chạy lại giữ nguyên credential receipt, required actions và mapping. Local review kiểm lại 11:26Z xác minh mật khẩu tạm được IdP chấp nhận và hiện CONFIGURE_TOTP; chưa điền OTP, đổi mật khẩu hoặc chụp màn hình enrollment. Người dùng còn phải tự hoàn thành CONFIGURE_TOTP và UPDATE_PASSWORD. Bản cập nhật đã cấp Portal cá nhân, không thêm role Foundation. Receipt: .local/evidence/lms-g8-local-review.json.

## Migration 006 và rollback

006 đã được kiểm thử trên D1 tách biệt và áp dụng **local/test** ngày 10/11/2026. **001–006 bất biến ở cả hai môi trường**. Guarded startup và journal/checksum local được xác minh lại trong `.local/evidence/lms-g7-runtime-artifacts.json`; thay đổi schema tiếp theo dùng 007+.

006 thay schema employees trong một batch transaction: sao chép nguyên mười cột cũ, guard so sánh hai chiều, khôi phục trigger, kiểm foreign keys rồi kết thúc deferral. Không tắt foreign_keys. Discriminator `legacy-retained` giữ nguyên hash và cờ đổi mật khẩu; `sso-only` bắt buộc hash NULL và must_change_password=0. Trigger chặn sửa loại credential/hash/cờ này qua DML. Migration không tạo password giả hay xóa lịch sử.

Test bao phủ sessions legacy/AIO, links, progress/attempts/notes legacy và domain mới, certificate, audit/receipt; lỗi sau copy/drop/rename/khôi phục guard đều rollback dữ liệu và schema. Các trigger ownership, session revocation và FK tiếp tục hoạt động.

Rollback vận hành: khóa mapping hoặc adapter bằng CLI MFA theo [runbook](LMS_LOCAL_DEVELOPMENT.md), giữ nguyên dữ liệu và journal, sửa bằng migration tiếp theo. Không sửa 001–006, không drop bảng, không tái sinh credentials hoặc khôi phục session cũ. [Diễn tập backup/restore D1 + R2](LMS_STORAGE_OPERATIONS.md) đã pass riêng; phép thử rollback migration không được dùng thay cho bằng chứng restore.


Lượt E2E bổ sung dùng một tài khoản QA riêng đã hoàn tất CONFIGURE_TOTP/UPDATE_PASSWORD, sau đó đăng nhập mới bằng mật khẩu và OTP để xác minh admin SSO-only trên HTTP/UI. Cấu hình OTP lần đầu không tự được coi là OTP authentication. Không thực hiện các bước này thay cho người dùng lms.admin. Script tài khoản dùng thử hiện bổ sung grant Portal cá nhân, không cấp role Foundation; quyền xem Directory/quản trị Foundation vẫn bị chặn. Việc áp dụng local của bổ sung này ghi trong receipt bàn giao cuối.
