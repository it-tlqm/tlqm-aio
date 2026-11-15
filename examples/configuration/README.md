# Bộ mẫu dùng thử bộ ứng dụng TLQM AIO

Bốn gói cấu hình JSON v1 và video WebM giả lập. Không chứa tài khoản, mật khẩu, hồ sơ người thật hoặc dữ liệu học của hệ thống cũ. Các UUID bắt đầu `ffffffff` là chỗ cần chọn lại bằng giao diện **Đối chiếu đối tượng hiện hành**; không tự cấp quyền hoặc tạo nhân sự khi nhập.

| Tệp | Màn hình nhập | Cần đối chiếu |
| --- | --- | --- |
| [01-ho-so-nhan-su.json](01-ho-so-nhan-su.json) | Nhân sự & tài khoản → Thông tin mở rộng → Thiết kế trường & bố cục | Không có tham chiếu ngoài; xem khác biệt với cấu hình hiện tại |
| [02-duyet-ho-so.json](02-duyet-ho-so.json) | Quy trình → Thiết kế → Nhập cấu hình | Đơn vị và người phê duyệt độc lập |
| [03-khoa-hoi-nhap.json](03-khoa-hoi-nhap.json) | LMS → Khóa học & nội dung → Thiết kế | Đơn vị và video đã upload |
| [04-lo-trinh-hoi-nhap.json](04-lo-trinh-hoi-nhap.json) | LMS → Quản lý đào tạo → Quản lý lộ trình → Thiết kế | Đơn vị và phiên bản khóa học vừa phát hành |
| [tlqm-local-demo.webm](tlqm-local-demo.webm) | LMS → Video & tài liệu → tải lên | Video canvas khoảng hai giây, không có âm thanh; chỉ phục vụ thử player |

## Chạy một vòng nghiệp vụ

1. Tại màn thiết kế, lưu nháp đầu tiên rồi nhập gói đúng loại. Đối chiếu tham chiếu, xem khác biệt, nhập lý do và ghi nháp. Trình duyệt nhận bản sao trước thay đổi; kiểm tra rồi phát hành bằng quyền tương ứng. Nhập gói thay **toàn bộ cấu hình nháp**, nên giữ lại các trường/quy tắc đang cần hoặc dùng trình thiết kế để thêm mẫu vào cấu hình hiện tại.
2. Với mẫu hồ sơ, nhân viên vào **Hồ sơ của tôi**, đề xuất `Địa điểm làm việc đề xuất`. `Ghi chú nội bộ HR` không được gửi về giao diện nhân viên.
3. HR mở hàng đợi đề xuất, chọn **Quy trình phê duyệt**, gửi theo mẫu vừa phát hành. Người phê duyệt khác person của HR và người có hồ sơ được sửa. Sau khi duyệt, HR **Xác nhận áp dụng hồ sơ**; kiểm tra thay đổi và lịch sử.
4. Upload video mẫu, tạo khóa nháp, nhập cấu hình khóa với mapping tới media đó rồi phát hành. Nhập và phát hành mẫu lộ trình với đúng phiên bản khóa. Tạo đợt cho người đã có quyền học và deadline; bật nhắc hạn theo đơn vị nếu muốn thử.
5. Học viên vào Portal → **Công việc & thông báo → Đào tạo**, mở đúng đợt qua SSO, xem video và làm bài. Khi đạt, đợt hoàn thành và việc học/nhắc hạn không còn ở danh sách đang chờ. Kết quả và lịch sử vẫn được giữ.

## Quyền cần có

- HR: quyền quản lý/đọc người tại Foundation, quyền khởi tạo Quy trình trong đơn vị đang công tác; xem/áp dụng cần còn quyền đọc lượt nguồn. Quản trị cấu hình cần MFA.
- Người duyệt: quyền `workflows:act` trong scope và được phân công; chức danh không tự tạo quyền này.
- Quản trị đào tạo: `lms:admin`, các quyền Directory/integration tương ứng và MFA theo vai trò hiện hành.
- Học viên: grant LMS, mapping issuer+subject hợp lệ, công tác và quyền `lms:learn` hiện hành. Grant Portal cần có để dùng Trung tâm công việc.

Tài khoản dùng thử hiện hữu do quản trị AIO cấp; credentials giữ trong `.local`, không nằm trong bộ mẫu. Chạy [hướng dẫn local](../../docs/LOCAL_DEVELOPMENT.md). Cơ chế nhắc nền cần `npm run lms:dev` cùng Foundation.

## Khôi phục và phạm vi

Nhập lại tệp `*-truoc-khi-nhap.json` vừa tải về, xem khác biệt và ghi thành một revision mới. Phát hành là bước riêng; lịch sử/phiên bản/lượt chạy/bài làm đã có không bị viết lại. Các thao tác schema, role/grant, dữ liệu vận hành và media có vòng đời riêng theo [runbook cấu hình](../../docs/CONFIGURATION_TRANSFER.md).

`npm run suite:examples` kiểm/khởi tạo các mẫu, giữ các gói đã tồn tại. Video được tạo từ mã của AIO; [manifest](media-manifest.json) ghi SHA-256 và kích thước. Đây là bộ dữ liệu giả lập để thử tính năng, không phải nội dung đào tạo/chứng nhận nghiệp vụ chính thức.
