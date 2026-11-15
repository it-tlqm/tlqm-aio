# Nghiệm thu AIO Công việc

Nghiệm thu trên AIO local với dữ liệu giả lập lúc **17:05:32 ngày 12/11/2026 (UTC+7)**. Mã nguồn trên worktree dirty nhánh `feat/foundation-mvp`, baseline `abea705b0937fe164fa9c983700089bec88c82ba`. [Phạm vi theo tài liệu MISA AMIS](TASKS_AMIS_SCOPE.md)

| Tiêu chí | Bằng chứng kiểm thử |
| --- | --- |
| SSO, dự án và quyền | Mở thẻ Công việc từ Portal và dùng lại phiên SSO. Quản lý đăng nhập bằng MFA, tạo dự án theo đơn vị, thêm thành viên và người xem, rồi lưu trữ dự án. API từ chối ghi và báo cáo của người xem, truy cập chéo tenant/đơn vị và request thiếu CSRF hợp lệ. |
| Giao và thực hiện | Giao việc có hạn Việt Nam, người liên quan và việc con. Người xử lý dùng bàn phím để cập nhật trạng thái và tiến độ 35%, gửi trao đổi, sau đó bàn giao. Người nhận thấy nội dung và lịch sử. Người cũ mất quyền đọc ngay trong phiên. |
| Nhắc hạn | Tick hai lần chỉ tạo một nhắc quá hạn cho người xử lý. Sau bàn giao, nhắc biến mất với người cũ và xuất hiện cho người nhận. Hoàn thành trên Kanban làm nhắc hết hiệu lực. |
| Danh sách, Kanban và báo cáo | Kéo thẻ sang Hoàn thành lưu tiến độ 100%. Báo cáo của thành viên chỉ đếm một công việc trong phạm vi, trong khi quản lý thấy cả việc con. Thu hồi vai trò dự án chặn chi tiết và báo cáo trong phiên đang mở. |
| Tính nhất quán | Ca PostgreSQL kiểm quyền, CAS, thử lại lệnh, chống nhắc trùng khi hai worker chạy và rollback khi ghi audit lỗi. |

Hồi quy tổng hợp đạt **5/5 lệnh** và **268 bài kiểm thử**. Foundation SSO/Identity/Admin UI, Quy trình nghiệp vụ và Trung tâm công việc đều qua. Lượt đầu Trung tâm công việc timeout khi đợi danh sách thông báo có nhiều bản ghi giả lập. Lượt chạy lại tăng thời gian chờ tối đa trong kịch bản E2E và qua 9 lượt axe. Đối chiếu 494 hash giữa hai lượt xác nhận chỉ kịch bản E2E Trung tâm công việc đổi. Typecheck và kiểm tra format của thay đổi này đã qua.

Đã xem ảnh Kanban desktop, chi tiết và báo cáo 390 px. Ba lượt axe của Công việc không báo vi phạm. Kiểm thủ công bằng Tab và Shift+Tab giữ tiêu điểm trong hộp thoại. Esc trả tiêu điểm về nút mở hoặc tiêu đề dự án khi đến từ liên kết trực tiếp. Chữ trong ô báo cáo đạt 14,68:1 trên nền trắng và tối thiểu 13,31:1 với nền hover. Cột ngoài khung đọc được bằng cách cuộn bảng ngang.

Mười nhật ký khớp nguồn ở local và test. Foundation 001–009, Forms 001–003, Workflows 001–020, LMS 001–010, Tasks 001. Cả 41 nguồn migration trước Công việc giữ checksum. API và LMS dev đã mở lại. Readiness và trang chủ cổng 4100–4106 đều trả HTTP 200.

Phiên Portal trong E2E dùng tài khoản người xem. Quyền Portal đã thu hồi của tài khoản quản lý trong database test được giữ nguyên. Kiểm MFA và tạo dự án dùng tài khoản quản lý đăng nhập trực tiếp vào Công việc.

Receipt `.local/evidence/tasks-local-ready.json` liên kết hồi quy, journal, kiểm thử UI và ảnh. [Chạy thử, kiểm thử lại và rollback](TASKS_LOCAL_DEVELOPMENT.md)
