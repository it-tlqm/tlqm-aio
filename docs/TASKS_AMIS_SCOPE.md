# Phạm vi AIO Công việc

Ngày 12/11/2026. Bắt đầu sau [nghiệm thu AIO Quy trình](WORKFLOWS_PRODUCT_ACCEPTANCE.md). Ứng dụng local `aio-tasks` dùng SSO, IAM và Directory của Foundation, với dữ liệu nghiệp vụ trong PostgreSQL riêng.

| Nhóm | Phạm vi triển khai | Cách nghiệm thu |
| --- | --- | --- |
| Dự án và quyền | Dự án theo đơn vị, quản trị viên, thành viên, người xem, trạng thái hoạt động/lưu trữ. Người thực hiện thông thường xem việc mình giao, được giao hoặc tham gia. Người xem được chỉ định đọc dự án. | Chặn dự án khác tenant/đơn vị, thay đổi vai trò và thu hồi truy cập trong phiên hiện hành. [Tạo dự án](https://helpamis.misa.vn/amis-cong-viec/kb/tao-moi-du-an-nhom-tren-amis-cong-viec/), [Phân quyền](https://helpamis.misa.vn/amis-cong-viec/kb/phan-quyen-trong-du-an/) |
| Giao và thực hiện | Công việc và một cấp việc con. Một người chịu trách nhiệm, nhiều người liên quan, mô tả, hạn Việt Nam, ba trạng thái, tiến độ, bàn giao và lịch sử. | Hai tài khoản cập nhật và bàn giao, thử lại lệnh, xung đột revision, bảo toàn lịch sử. [Tạo và giao việc](https://helpamis.misa.vn/amis-cong-viec/kb/tao-va-giao-viec-cho-nguoi-khac-thuc-hien/), [Thực hiện](https://helpamis.misa.vn/amis-cong-viec/kb/tiep-nhan-va-thuc-hien-cong-viec/) |
| Phối hợp | Trao đổi theo công việc, nhắc trong ứng dụng trước hạn hoặc khi quá hạn. Worker đối chiếu người nhận, quyền và trạng thái hiện hành. | Hai worker tạo một nhắc hạn, bàn giao/thu hồi quyền làm nhắc cũ hết hiệu lực. [Tiến độ và nhắc việc](https://helpamis.misa.vn/amis-cong-viec/kb/tiep-nhan-va-thuc-hien-cong-viec/) |
| Bảng, danh sách và báo cáo | Danh sách và bảng Kanban dùng cùng dữ liệu, lọc người xử lý/trạng thái/hạn, chuyển trạng thái trên bảng và dùng bàn phím. Báo cáo theo dự án gồm tổng số, tỷ lệ hoàn thành, việc quá hạn và số việc theo người trong phạm vi. | Đối chiếu cùng tập dữ liệu, người đọc thiếu quyền báo cáo, kiểm desktop/390 px, bàn phím và axe. [Bảng Kanban](https://helpamis.misa.vn/amis-cong-viec/kb/quan-ly-cong-viec-dang-bang/), [Báo cáo dự án](https://helpamis.misa.vn/amis-cong-viec/kb/de-dang-quan-ly-danh-gia-chat-luong-cong-viec-voi-bao-cao-du-an-nhom/) |

Phạm vi trong ma trận đã đạt [nghiệm thu local](TASKS_ACCEPTANCE.md) lúc 17:05:32 ngày 12/11/2026 (UTC+7). [Chạy thử và rollback](TASKS_LOCAL_DEVELOPMENT.md).
