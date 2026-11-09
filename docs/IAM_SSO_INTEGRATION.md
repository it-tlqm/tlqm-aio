# IAM/SSO — thiết kế dùng chung

Ngày: 09/11/2026. Trạng thái: **thiết kế mục tiêu, đã triển khai lát cắt local**. Hai client thử đã nối Keycloak; auth của LMS/BOS chưa thay đổi. Xem [trạng thái triển khai](IMPLEMENTATION_STATUS.md).

Local hiện introspect access token ở mỗi request và kiểm tra grant trong PostgreSQL, không cache quyền. App session tối đa 5 phút, chưa có refresh tự động. Đã kiểm thử thu hồi grant, khóa user tại IdP, logout từng app và back-channel logout. SLA 60 giây ở phần dưới vẫn là mục tiêu cần đánh giá tải trước production.

## Phân chia trách nhiệm

Identity Provider local là Keycloak; phương án vận hành production còn mở. IdP xác thực, quản lý credential, MFA và phiên SSO. Directory quản lý người/tổ chức. Access quản lý cấp quyền ứng dụng. Mỗi backend kiểm tra quyền trên dữ liệu của mình. MFA chưa được bật bắt buộc trong lát cắt local này.

Đề xuất môi trường dev/test/production có issuer, client và secrets tách biệt. PoC dùng một realm workforce với client riêng cho từng ứng dụng; không tạo realm theo ứng dụng. Mô hình khách hàng/đối tác và realm bên ngoài cần ADR riêng trước khi triển khai CIAM.

## Luồng đăng nhập đề xuất

1. Browser mở Portal, Forms hoặc LMS; server tạo giao dịch đăng nhập một lần.
2. Chuyển đến IdP bằng Authorization Code + PKCE S256, state và nonce gắn với giao dịch.
3. Callback kiểm tra state, issuer và giao dịch; đổi code ở server; kiểm tra ID token bằng thư viện OIDC đã đánh giá.
4. Tra mapping issuer + subject tới account/person; kiểm tra trạng thái và quyền truy cập ứng dụng.
5. Tạo phiên ứng dụng riêng bằng cookie HttpOnly, Secure, SameSite phù hợp; xoay session ID khi đăng nhập.
6. Mở ứng dụng thứ hai: redirect qua IdP sử dụng phiên SSO; ứng dụng thứ hai vẫn kiểm tra quyền riêng.

Đề xuất tắt implicit/password grant cho client mới; redirect URI đăng ký chính xác, không wildcard. API chỉ nhận access token đúng audience hoặc phiên server hợp lệ, không dùng ID token như access token. Các kiểm soát này theo [OAuth Security BCP, RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html).

## Hợp đồng định danh và token

- Cặp issuer + subject là định danh liên kết; email và mã nhân viên không thay thế khóa này. Subject pairwise có thể khác giữa client; liên kết nhiều identity phải được kiểm chứng, không tự gộp theo email. [OpenID Connect Core — Claim Stability](https://openid.net/specs/openid-connect-core-1_0.html#ClaimStability).
- Access token được kiểm tra chữ ký, thuật toán cho phép, issuer, audience, exp và nbf khi có; client thực hiện các kiểm tra ID token/nonce theo thư viện chuẩn.
- Discovery/JWKS chỉ lấy từ issuer được cấu hình tin cậy; không nhận URL tùy ý từ request. Key rotation phải được kiểm thử. [Keycloak OIDC endpoints](https://www.keycloak.org/securing-apps/oidc-layers).
- Claim tùy biến tối thiểu có thể gồm aio_person_id; tránh nhét sơ đồ tổ chức hoặc toàn bộ quyền động vào token.
- Quyền được resolve theo app + scope + phiên bản policy ở server. Tenant do client chọn phải được đối chiếu membership.
- Tài khoản dịch vụ dùng client riêng, scope tối thiểu; không giả làm nhân viên để truy cập API.

## Phiên và mục tiêu thu hồi quyền

Các con số dưới đây là mục tiêu PoC đề xuất, cần đo; không phải SLA đang tồn tại.

| Tình huống | Hành vi và mục tiêu |
| --- | --- |
| Thu hồi grant/chuyển đơn vị | API từ chối quyền cũ trong tối đa 60 giây; cache quyền tối đa 60 giây |
| Khóa account | Vô hiệu hóa quyền vào app và app sessions; thu hồi phiên IdP; xác nhận hoàn tất cả hai phía |
| Thao tác cấp quyền/quản trị | Kiểm tra trạng thái/quyền online, không dùng cache stale để cho phép |
| Access service không dùng được | Không cấp quyền mới; cached read chỉ trong hạn 60 giây; hết hạn thì từ chối |
| IdP không dùng được | Không đăng nhập/refresh mới; phiên app còn hạn vẫn phải kiểm tra trạng thái/quyền |
| Logout ứng dụng | Hủy phiên ứng dụng và cookie của app |
| Logout toàn hệ thống | Hủy phiên IdP, thông báo hủy phiên các app hỗ trợ; fallback kiểm tra trạng thái có hạn |
| Thay đổi account trực tiếp tại IdP | Event/reconciliation cập nhật app gate trong mục tiêu 60 giây; chưa đạt thì chưa nghiệm thu |

JWT tự xác minh không tự biết tài khoản vừa bị khóa. Để đạt mục tiêu trên, cần gate trạng thái và grant tại backend, cơ chế hủy app session, đối soát khi mất event. Back-channel logout chỉ được coi là hỗ trợ sau khi đã test client thực tế. Access token ngắn hạn đề xuất 5 phút là lớp bổ sung, không thay cơ chế thu hồi 60 giây.

## Chuyển đổi tài khoản cũ

Giữ khóa người dùng legacy và lịch sử nghiệp vụ. Tạo mapping đã xác minh; xử lý trùng tài khoản bằng quy trình quản trị có audit. Không copy password vào Directory hoặc tự liên kết chỉ bằng email.

Pilot dùng nhóm tài khoản giả lập trong môi trường riêng. Tùy chọn rollback chỉ áp dụng cho đường đăng nhập; không được khôi phục quyền đã thu hồi hoặc làm sống tài khoản đã khóa. Tài khoản bị thu hồi phải bị chặn ở cả đường cũ lẫn SSO.

## Kiểm thử bắt buộc trước pilot

- Sai issuer/audience, token hết hạn, callback phát lại, state/nonce sai đều bị từ chối.
- Token client A không dùng được tại API B.
- Không có grant thì không vào được API dù login thành công.
- Một người nhiều đơn vị: đổi scope hợp lệ thành công; sửa tenant/header không mở quyền.
- Khóa user, thu hồi role và mất sự kiện vẫn hội tụ đúng trong mục tiêu.
- Logout local và toàn hệ thống được báo đúng phạm vi, không hứa hiệu lực tức thời khi chưa kiểm chứng.
- Secret/token không vào log, URL, localStorage hoặc tài liệu xuất ra.
