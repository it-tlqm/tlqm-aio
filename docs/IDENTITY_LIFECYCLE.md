# Liên kết SSO và vòng đời tài khoản local

Ngày 09/11/2026. Phạm vi: Foundation local, realm aio-local và dữ liệu giả lập. Migration 005 bổ sung proof xác minh, metadata liên kết và ranh giới thời điểm xác thực; không thay migration đã áp dụng.

## Liên kết có xác minh

Person, Account và ExternalIdentity là ba đối tượng riêng. Email, tên và mã nhân sự không được dùng làm khóa nối. Chủ sở hữu của cặp issuer + subject không được chuyển sang account khác, kể cả sau khi thu hồi liên kết; có trigger PostgreSQL bảo vệ bất biến này.

1. Quản trị tạo hồ sơ Person và Account trong home tenant qua UI. Chưa có liên kết/grant thì tài khoản chưa được vào ứng dụng.
2. Người dùng chọn **Tạo mã xác minh SSO**. Foundation dùng giao dịch OIDC một lần với PKCE/state/nonce và prompt=login. Access token phải có xác thực mật khẩu mới, chữ ký/issuer/audience/azp hợp lệ và introspection đang active.
3. Sau callback, browser nhận cookie HttpOnly riêng và mở màn hình mã xác minh. Mã không nằm trong URL, không vào localStorage. DB giữ hash của mã và access token mã hóa, không giữ refresh token cho proof. TTL tối đa 5 phút và không vượt hạn access token. Mã chỉ hiển thị dạng trường mật khẩu để sao chép.
4. Quản trị có identity:link chọn account đích, nhập mã và xem trước issuer/subject. Backend kiểm tra lại token ở IdP, scope home tenant, trạng thái account/person, quyền quản trị và mốc xác thực của target.
5. Quản trị đối chiếu người thật với hồ sơ đích rồi xác nhận subject, account revision và lý do. Transaction khóa proof/account, nối hoặc kích hoạt lại đúng identity của account đó, tiêu thụ proof, xóa token mã hóa của proof đã dùng và ghi audit. Không tự cấp app grant hoặc role.

Proof sai, hết hạn, đã dùng, token bị thu hồi, subject không khớp, revision cũ, target khác tenant hoặc identity đã thuộc account khác đều bị từ chối. Quản trị không tự nối vào tài khoản đang dùng hoặc tài khoản hệ thống được bảo vệ. Hai yêu cầu đồng thời không thể tiêu thụ một proof hai lần. Retry đúng Idempotency-Key/payload dùng lại receipt sau kiểm tra quyền hiện hành.

Không có API nhập issuer tùy ý hay nối chỉ bằng username/email. Proof chỉ được tạo/xử lý ở BFF Foundation A. Việc xác minh con người ngoài hệ thống là trách nhiệm của quản trị đã có quyền; đây chưa phải quy trình nhập HR/AD production.

## Khóa, mở lại và thu hồi

**Tạm khóa account/person:** giữ hồ sơ, grants và lịch sử; xóa phiên ứng dụng và nâng auth_not_before trong transaction. Mở lại không hạ mốc này. Mỗi request so sánh auth_time đã ký với mốc account; token cũ hoặc token refresh từ lần xác thực cũ vẫn bị từ chối. Người dùng phải xác thực mới (prompt=login); nếu IdP có độ chính xác giây, đăng nhập mới phải ở giây sau mốc khóa.

**Thu hồi liên kết:** đánh dấu ExternalIdentity inactive, giữ nguyên issuer/subject/accountId và lịch sử, thu hồi phiên account và nâng mốc xác thực. Liên kết lại cùng account đòi proof mới sau mốc đó và xác nhận quản trị; không chuyển subject sang người khác.

**Khóa và thu hồi toàn bộ quyền:** account được khóa, các app grants/role bindings đang active trong home tenant bị thu hồi và giữ bản ghi. Actor cần accounts:manage và quyền access:manage được ủy quyền cho từng app bị tác động; thiếu phạm vi thì cả transaction bị từ chối. Tài khoản bootstrap/dự phòng và tài khoản actor được bảo vệ. Mở lại account không khôi phục quyền đã thu hồi; cần cấp lại tường minh.

Account do home tenant quản lý. Khóa account là trạng thái định danh toàn cục nên mọi phiên của account kết thúc; offboarding chỉ sửa grant/binding của tenant được quản trị. Không sửa quan hệ công tác ở tenant khác.

## Quan hệ công tác

Kết thúc employment/assignment là thao tác ngày hiệu lực riêng, không suy ra quyền ứng dụng từ chức danh hoặc bổ nhiệm. Kết thúc các assignment trước khi đặt validUntil cho employment bao chứa chúng. Không xóa lịch sử; bộ ràng buộc DB từ chối khoảng thời gian sai, sai pháp nhân, chu kỳ đơn vị và hai bổ nhiệm chính chồng thời gian. Offboarding không tự viết lại lịch sử nhân sự.

UI có Person → Account → Grant/Binding → Employment → Assignment; một employment có một bổ nhiệm chính và nhiều kiêm nhiệm. Nhãn chọn vị trí kèm đơn vị, nhãn quan hệ công tác kèm mã nhân sự/pháp nhân để tránh chọn nhầm bản ghi cùng tên.

## API và giao diện

| Endpoint | Ý nghĩa |
| --- | --- |
| GET /auth/identity-proof | Bắt đầu xác thực mới để tạo proof, không cấp app session |
| GET /api/v1/identity-proof | Đọc proof của chính browser qua cookie HttpOnly |
| GET /api/v1/manage/identity-targets?tenantId=... | Danh sách account trong home tenant theo quyền identity:link hoặc accounts:manage |
| GET /api/v1/manage/identities?tenantId=...&accountId=... | Liên kết hiện tại/lịch sử của account trong scope |
| POST /api/v1/manage/identities/preview | Xem trước proof và account đích, có CSRF cho cookie |
| POST /api/v1/manage/identities/link | Nối proof với account sau xác nhận subject/revision/lý do |
| POST /api/v1/manage/identities/:id/revoke | Thu hồi liên kết, cần revision/lý do/idempotency |
| POST /api/v1/manage/accounts/:id/offboard | Khóa account và thu hồi quyền trong tenant |

Mutation có Origin + CSRF khi dùng cookie, Idempotency-Key và lý do; backend reauthorize trong transaction. UI **Định danh & vòng đời** có xem trước, xác nhận, lỗi/empty/loading/no-access và thao tác bàn phím. Các form roles/permissions/bindings/grants, thay trạng thái account/person hoặc cấu hình ứng dụng đang có cũng có xác nhận trước lưu.

Khi OIDC thành công nhưng Foundation từ chối account/grant/MFA/phiên xác thực cũ, browser về màn hình đăng nhập tiếng Việt và hiển thị mã lỗi phù hợp qua thông báo ngắn hạn HttpOnly. Thông báo chỉ phục vụ UI, không cấp quyền; API /me vẫn từ chối. Callback bị giả mạo state/nonce vẫn bị từ chối trực tiếp, không biến thành phiên hợp lệ.

## Kiểm chứng và secrets

tests/identity.test.ts kiểm tra proof, quyền/scope, replay/concurrency, immutable identity, auth_time sau khóa và offboard. scripts/identity-e2e.ts dùng IdP thật và thao tác UI để tạo người/account/grant/binding/employment/bổ nhiệm chính/kiêm nhiệm, nối/thu hồi/nối lại, khóa/mở lại, kết thúc công tác và offboard.

Suite tạo user giả lập mới cho từng lượt, không tự nối DB với user đó. Credentials chỉ nằm trong .local/identity-fixtures; user IdP và account test được vô hiệu hóa khi kết thúc, giữ audit. Không chụp trang IdP hoặc mã xác minh rõ. Ảnh chỉ có thông tin giả lập và trường mã đã che. Báo cáo: .local/evidence/identity-lifecycle.json.

Chạy tuần tự cùng các kiểm tra khác: npm run check rồi npm run test:e2e. test:e2e gồm suite SSO chung và suite vòng đời riêng, mỗi suite tự sở hữu/đóng cổng A/B/C. Frontend chỉ tải lookup cần cho màn hình hiện tại để tránh tạo quá nhiều request; rate limit runtime không được tắt để test pass.
