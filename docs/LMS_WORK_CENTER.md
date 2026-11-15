# Công việc và nhắc hạn đào tạo

Ngày 11/11/2026. E4b của [goal cấu hình mở](../roadmap/GOAL_CONFIGURABLE_SUITE.md), đã đạt checkpoint hồi quy. Chỉ AIO local giả lập; source trên `feat/foundation-mvp`, baseline `abea705b0937fe164fa9c983700089bec88c82ba`, worktree dirty.

## Sử dụng

Trong Portal → **Công việc & thông báo**, chọn nguồn **Đào tạo**. Màn **Việc học & nhắc hạn** liệt kê các đợt chưa hoàn thành, tiến độ, số khóa còn lại, ngày bắt đầu/hạn và các thông báo còn hiệu lực. Tìm tên đợt/lộ trình, phân trang 10 dòng; số tổng quan tính toàn bộ phạm vi cá nhân. Mở đợt chuyển tới đúng hồ sơ tại LMS, giữ đường dẫn qua SSO.

Trong LMS → **Đợt đào tạo của tôi → Việc học & nhắc hạn**, học viên xem cùng dữ liệu và đánh dấu thông báo đã đọc/chưa đọc. Portal chỉ đọc nguồn đào tạo; thao tác học và trạng thái thông báo thực hiện ở LMS. Không cần tạo phiên LMS riêng để đọc bảng tổng hợp ở Portal. Trang tự tải lại mỗi 60 giây khi đang hiển thị; có nút tải lại rõ ràng. Khi nguồn lỗi hoặc mất quyền, dữ liệu/số đếm cũ được xóa khỏi màn.

Quản trị MFA mở **Quản lý đào tạo → Nhắc hạn đào tạo**, chọn đơn vị phụ trách đợt, bật/tắt và nhập phút trước hạn / phút sau khi quá hạn cùng lý do. Đơn vị chưa cấu hình mặc định tắt. Giới hạn 0–10.080 phút trước hạn, 1–10.080 phút sau hạn; 0 trước hạn chỉ dùng nhắc quá hạn.

## Dữ liệu và lịch nhắc

Migration **LMS 009** đã áp dụng local/test. Enrollment tạo thông báo được giao trong cùng giao dịch. Đổi lịch/tên đợt tạo thông báo cập nhật theo revision; lịch sử cũ giữ trong database nhưng không còn hiện như thông báo hiện hành. Hủy đợt hoặc đạt tất cả phiên bản khóa sẽ loại công việc/nhắc hạn khỏi danh sách cá nhân, giữ kết quả học và lịch sử giao nhận.

Mỗi loại sắp hạn/quá hạn được ghi tối đa một lần cho mỗi học viên, đợt và revision lịch. Đổi chính sách không gửi lại cùng loại ở cùng revision. Tiến trình đối soát mỗi 30 giây trong `npm run lms:dev`; sau khởi động lại, truy vấn nguồn và unique key tiếp tục chống trùng. Không gửi thông báo ra email/Slack hoặc dịch vụ ngoài AIO.

Nguồn LMS kiểm trạng thái adapter, mapping, enrollment, audience và kết quả đạt hiện hành; orchestrator Foundation cung cấp danh sách recipient đang có grant, quyền học và công tác hợp lệ. Đây là kiểm điều kiện người nhận nền, không giả lập một phiên đăng nhập. Native/Portal vẫn kiểm quyền khi đọc, nên metadata đã lưu không trở thành quyền xem.

Mỗi tenant được ghi theo batch D1, có guard, unique key và audit. Lỗi audit rollback các thông báo mới; trạng thái worker ghi lỗi để lượt sau thử lại. Quá 1.000 ứng viên/tenant/lượt hoặc 100 tenant đang bật chính sách sẽ báo lỗi rõ. Feed cá nhân giới hạn 1.000 đợt và 10.000 thông báo trong tập đọc, không trả một phần rồi coi là toàn bộ. Chưa đo tải/HA production.

## Đọc liên kết từ Portal

BFF Portal xác thực phiên hiện hành, chuyển access token qua kênh server tới endpoint đọc riêng của LMS cùng proof HMAC có miền riêng, gắn instance/environment, tenant, session hash, token và thời điểm ±30 giây. Callback LMS → Foundation có miền proof khác. Foundation kiểm issuer/audience bằng verifier của Portal, đối chiếu phiên còn tồn tại/chưa hết hạn, quyền Portal và quyền LMS hiện hành. LMS kiểm mapping bằng issuer+subject, tenant/unit và quyền học của chính người đó.

Đọc feed không tạo phiên LMS và không mượn phiên của người khác. Actor đọc liên kết có `sessionHash=null`; mọi lệnh ghi qua Courses bị chặn. LMS kiểm lại quyền sau tổng hợp; Portal đối chiếu account/person/tenant, giới hạn kích thước phản hồi và chỉ trả các trường feed đã định nghĩa. Các endpoint LMS/SSO thông thường giữ audience/session riêng. Token, proof và session hash không đi vào response UI, URL, ảnh hoặc artifacts.

Đăng xuất Portal cục bộ làm callback từ chối ngay cả khi access token vẫn còn thời hạn. Thu hồi grant/role/account/công tác hoặc khóa mapping/adapter được kiểm lại. Endpoint nguồn chỉ nhận POST đọc có proof từ backend; browser không có secret để tự đóng vai adapter. Mã ở `portal-work-proof.ts`, `portal-work-access.ts`, `training-work-center-boundary.ts` và `lms/portal-training-feed.ts`.

## Vận hành và rollback

Đọc [runbook local](LMS_LOCAL_DEVELOPMENT.md), giữ storage lease. `lms:dev` giữ duy nhất Worker/storage và chạy bộ nhắc trong cùng orchestrator; không mở inspector hay Worker thứ hai để nhắc hạn. Orchestrator Node xác minh Docker local/markers trước khi dùng credential Foundation; binding Worker không chứa credential PostgreSQL.

~~~powershell
npm run lms:setup
npm run build
npm run dev
# Terminal riêng, sau khi Foundation sẵn sàng:
npm run lms:dev
~~~

Tắt nhắc ở UI để rollback chính sách, hoặc dừng `lms:dev` để dừng cả nguồn/worker. Các loại nhắc đã tắt không còn hiện; thông báo giao đợt giữ theo trạng thái nguồn. Không sửa checksum 001–009, xóa lịch sử hoặc hồi quyền/phiên đã thu hồi. Migration mới từ LMS 010. SSO/global logout và backup storage theo runbook cũ.

## Bằng chứng

7 domain tests mới đã pass: đọc/chưa đọc và ownership/CAS, đồng thời/restart, đổi lịch/hủy, hoàn thành từ bài đạt, thu hồi điều kiện người nhận, rollback audit, read-only delegation và proof binding/expiry. SSO E2E pass 8 axe scans; đã xem ảnh chính sách desktop/mobile, Portal desktop/mobile, notifications, deep link và native đã đọc. Nguồn ngừng hoạt động/khởi động lại và quyền recipient nền đã kiểm qua HTTP/worker thật.

`npm run test:lms-work-center`; receipt `.local/evidence/lms-work-center-e2e.json`. Hồi quy `test:suite-regression -- e4-training` hoàn tất **2026-11-10T22:38:08Z**: **200 tests, 11/11 lệnh, sourceStable=true cho 380 file**, bao gồm Foundation, LMS, Work Center, liên kết hồ sơ, resilience và backup. Receipt `.local/evidence/configurable-e4-training-regression.json`; chưa dùng checkpoint này để kết luận toàn E4 trước phần import/export.
