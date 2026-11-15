# Lịch sử phiên bản Quy trình

Tại thẻ quy trình, mở **Lịch sử phiên bản** và chọn phiên bản gốc cùng phiên bản đối chiếu. Màn hình hiển thị thay đổi theo thông tin chung, biểu mẫu khởi tạo, bước và đường đi, đối tượng cùng quyền trường. Mỗi mục mở được cấu hình của hai phiên bản. Danh sách sắp xếp theo phiên bản mới nhất và dùng giờ Việt Nam.

Người có quyền thiết kế hoặc phát hành trong đơn vị quản lý có thể xem lịch sử. Để phục hồi, người phát hành chọn phiên bản gốc rồi chọn **Khôi phục** và nhập lý do. Hệ thống kiểm quyền tại đơn vị quản lý và các đơn vị được khởi chạy, tính hợp lệ của cấu hình, lịch và người nhận nhiệm vụ. Nếu đã có thay đổi song song, tải lại lịch sử để lấy revision mới.

Khôi phục tạo bản phát hành mới từ cấu hình đã chọn. Hệ thống ghi phiên bản nguồn, phiên bản mới và checksum vào audit. Hồ sơ đang thực hiện tiếp tục mở theo phiên bản đã ghim. Bản nháp thiết kế là nơi chỉnh sửa cho lần phát hành tiếp theo. Quy tắc tự động hóa ghim phiên bản cần được đối chiếu khi muốn áp dụng cho bản phát hành mới.

## Kiểm tra và rollback

Dùng `npm run test:suite-regression -- w5-version-history` khi các cổng test đã trống. PostgreSQL kiểm scope tenant và đơn vị, quyền thiết kế/phát hành, người nhận không còn hiệu lực, revision cũ, gửi lại cùng lệnh, audit và phiên bản ghim trên hồ sơ. Browser dùng SSO/MFA, kiểm CSRF, bàn phím, desktop và 390 px, rồi khởi chạy một hồ sơ trên bản phục hồi.

Để đưa cấu hình khác vào sử dụng, chọn phiên bản phù hợp và khôi phục qua quyền phát hành. Khi cần lùi giao diện/API, dùng lại bản phát hành trước thay đổi lịch sử. Giữ các snapshot và audit để engine tiếp tục mở hồ sơ theo phiên bản đã ghim. Tính năng dùng bảng phiên bản hiện có. [Runbook local](WORKFLOWS_LOCAL_DEVELOPMENT.md)
