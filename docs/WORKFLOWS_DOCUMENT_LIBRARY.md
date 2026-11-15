# Kho tài liệu Quy trình

Phạm vi W5 gồm thư mục cha/con, soạn dự thảo, người duyệt và ban hành, tệp tham chiếu, lịch sử, ngừng ban hành và khôi phục dự thảo. Tài liệu liên kết đến đúng phiên bản quy trình để tra cứu từ hồ sơ hoặc lúc khởi chạy. [Soạn thảo và ban hành tài liệu](https://helpamis.misa.vn/amis-quy-trinh/kb/soan-thao-va-ban-hanh-tai-lieu-quy-trinh-2/), [Liên kết tài liệu và thực thi](https://helpamis.misa.vn/amis-quy-trinh/kb/bo-sung-tien-ich-phan-he-thiet-ke-quy-trinh-lien-ket-giua-tai-lieu-quy-trinh-va-thuc-thi/)

AIO dùng quyền thiết kế trong đơn vị quản lý để tạo thư mục, soạn và gửi duyệt. Quyền phát hành dùng để phê duyệt, ban hành và ngừng ban hành. Ban hành kiểm quyền tại các đơn vị được xem. Người đọc có quyền khởi tạo hoặc xử lý tại một đơn vị được xem và còn quan hệ công tác tại đó. Quyền áp dụng cả danh sách, nội dung, phiên bản và tải tệp. [Phân quyền tài liệu MISA](https://helpamis.misa.vn/amis-quy-trinh/kb/phan-quyen-tren-phan-he-tai-lieu-quy-trinh/)

## Cách dùng

Mở **Tài liệu quy trình** để tìm theo tên hoặc lọc theo thư mục. Người soạn có thể tạo thư mục con, soạn văn bản, đính kèm tối đa bốn tệp với tổng dung lượng 10 MB và chọn phiên bản quy trình liên kết. Dùng **Dùng mô tả quy trình** để lấy mô tả từ phiên bản hiện hành vào dự thảo. Khi lưu, nội dung, phạm vi xem, liên kết và danh sách tệp được chụp thành phiên bản tài liệu.

Chọn **Gửi duyệt** để người có quyền phát hành xem xét. Người soạn bản đó và tài khoản khác của cùng một nhân sự không thể duyệt. Người phát hành có thể phê duyệt, từ chối hoặc ban hành bản đã duyệt. Trong lúc soạn bản kế tiếp, người đọc tiếp tục tra cứu bản đang ban hành. **Ngừng ban hành** thu hồi quyền đọc và tải tệp từ các liên kết đã mở. Người soạn có thể khôi phục một phiên bản trước thành dự thảo mới để gửi duyệt.

Tệp được kiểm kích thước, phần mở rộng và cấu trúc tại máy chủ. Tệp cách ly cần được thay trước khi gửi duyệt. Tệp hợp lệ tải qua API đã xác thực, trả dạng đính kèm với tên tệp gốc. Hồ sơ có mục **Tài liệu áp dụng** nếu có tài liệu được ban hành cho đúng phiên bản và người dùng có quyền xem.

## Kiểm tra và rollback

Workflows 020 đã áp dụng local/test. Dùng `npm run test:suite-regression -- w5-document-library` theo [runbook](WORKFLOWS_LOCAL_DEVELOPMENT.md) để kiểm SSO/MFA, ảnh desktop/390 px, bàn phím và axe. Ca PostgreSQL đối chiếu lịch sử tệp, quyền khác đơn vị/tenant, phê duyệt, khôi phục, thu hồi, chỉnh sửa đồng thời và audit rollback.

Để dừng hiển thị tài liệu, chọn **Ngừng ban hành** trước khi lùi giao diện/API về bản đã nghiệm thu. Giữ migration 020, các phiên bản, tệp và audit trong database. Để áp dụng một nội dung cũ, khôi phục thành dự thảo rồi đưa qua quy trình phê duyệt và ban hành.
