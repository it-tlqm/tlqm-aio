# MFA và khôi phục quản trị local

Ngày 09/11/2026. Chỉ áp dụng workspace D:/thanhnx/TLQM-AIO, realm http://127.0.0.1:8180/realms/aio-local và dữ liệu giả lập. Không phải quy trình khôi phục tài khoản doanh nghiệp thật.

## Thiết lập

Chạy npm run local:mfa sau local:up, trước db:setup. Script giữ credentials cũ; tạo demo.recovery-admin nếu chưa có, ghi subject thực tế trả về khi tạo, cấu hình flow aio-local-mfa và AMR mapper. Chromium đăng ký OTP rồi xác minh đăng nhập pwd + otp cho tài khoản dự phòng trước, sau đó tài khoản chính. Password nằm trong .local/runtime.json; OTP seed và bước vừa dùng nằm trong .local/mfa.json. Không đưa các file này vào Git hay ảnh chụp. Chạy các script tuần tự để tránh dùng cùng OTP hai lần.

Flow có cookie SSO và form mật khẩu, nhánh OTP bắt buộc cho quản trị bootstrap, nhánh OTP cho người dùng khác đã đăng ký. Chỉ execution OTP thật được gắn AMR otp; không gắn claim tĩnh theo role hay theo thuộc tính người dùng. Backend kiểm tra chữ ký và introspection trước khi đọc AMR, đồng thời kiểm tra quyền hiện tại trong Foundation. Tài khoản vừa được cấp quyền quản trị phải có cả pwd và otp; phiên mật khẩu cũ bị từ chối ngay. AMR hết hiệu lực sau 60 phút; reauthentication yêu cầu mật khẩu/OTP mới.

Cơ chế AMR được đối chiếu với [Keycloak Authentication flows](https://www.keycloak.org/docs/latest/server_admin/index.html#_authentication-flows) và [AmrProtocolMapper 26.8.2](https://github.com/keycloak/keycloak/blob/26.8.2/services/src/main/java/org/keycloak/protocol/oidc/mappers/AmrProtocolMapper.java). Thời gian lưu phiên BFF: tối đa 60 phút, không hoạt động 15 phút; xem [runbook local](LOCAL_DEVELOPMENT.md).

## Diễn tập mất OTP

~~~powershell
npm run local:recover-admin
~~~

Script chỉ nhận mục tiêu cố định demo.admin và actor cố định demo.recovery-admin. Nó đăng nhập mới bằng mật khẩu + OTP của actor dự phòng; xác minh subject, account, quyền accounts:manage và marker của cả aio_foundation/aio_foundation_test trước khi thay đổi.

1. Ghi account.mfa_recovery_requested với actor/subject/lý do/request ID; giữ bắt buộc MFA và xóa phiên Foundation của quản trị chính trong transaction.
2. Logout phiên IdP của quản trị chính, thêm CONFIGURE_TOTP và xóa chỉ credential OTP có nhãn AIO local synthetic fixture. Không đổi mật khẩu hoặc credential của actor dự phòng.
3. Đăng ký OTP mới bằng luồng browser, cập nhật seed kín trong .local, đăng nhập lại để chứng minh OTP thật.
4. Ghi account.mfa_recovery_completed vào hai database. Mã request chung nối hai sự kiện; không ghi seed/token/mật khẩu.

HTTP runtime không import các helper quản trị Keycloak/Playwright. Đây là CLI của người vận hành local đã có quyền, không phải endpoint reset tùy ý.

## Khi một bước thất bại

Giữ MFA bật. Hai database và IdP không có distributed transaction: requested có thể tồn tại mà chưa có completed. Phiên cũ đã thu hồi vẫn bị từ chối. Khôi phục dịch vụ local rồi chạy lại script; nó xử lý cả trường hợp chưa còn OTP và chưa hoàn tất enrollment. Nếu có credential không do fixture quản lý, script từ chối tự xóa. Nếu mất cả seed của actor dự phòng hoặc subject không khớp manifest, dừng để người vận hành đối chiếu nguồn local; không tự nối bằng username/email hoặc tắt MFA.

Không dùng script để xử lý dữ liệu thật. Production cần quy trình xác minh con người, thiết bị riêng, phân tách quyền vận hành và lưu secrets phù hợp; chưa nằm trong goal local.

## Bằng chứng

local:mfa đã xác minh hai quản trị. tests/mfa.test.ts kiểm tra thiếu AMR/thiếu một yếu tố bị từ chối, tài khoản thường vẫn hoạt động và cờ MFA mới có hiệu lực ngay. scripts/e2e.ts kiểm tra OTP sai/chỉ mật khẩu, MFA trên phiên cũ, recovery bằng quản trị thứ hai, phiên cũ bị vô hiệu và hai sự kiện audit. Bằng chứng tổng hợp mới nhất nằm ở .local/evidence/security-lifecycle.json sau E2E thành công; không thay thế nghiệm thu các phần còn lại của Foundation.
