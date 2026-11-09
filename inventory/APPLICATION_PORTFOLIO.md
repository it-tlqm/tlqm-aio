# Danh mục ứng dụng và hướng tích hợp

Ngày: 09/11/2026. Quyết định thứ tự: **Foundation → Form Builder + LMS → các ứng dụng khác**.

| Hệ thống | Hiện trạng có bằng chứng | Đề xuất | Ưu tiên |
| --- | --- | --- | --- |
| AIO Identity | Keycloak local với hai client kiểm chứng | Hoàn thiện MFA, vận hành và vòng đời tài khoản trước production | P0 |
| AIO Organization/Access/Registry | Fastify/PostgreSQL local; API đọc theo tenant, grant/revoke và audit | Bổ sung quản trị và scope chi tiết theo mô hình chung | P0 |
| AIO Forms | Chưa có app AIO; BOS có schema/version/designer/runtime | Form Builder MVP; spike tái sử dụng BOS | P1, giai đoạn ứng dụng đầu |
| TLQM LMS | Source Next/Workers/D1, auth local | Giữ nghiệp vụ/DB, thêm adapter SSO và mapping user | P1, tích hợp đầu |
| BOS | Repo đang thay đổi; có CORE, CRM và nhiều module vận hành | Giữ repo; chuẩn hóa tích hợp sau; tham khảo Forms/Directory | P2 |
| Twenty CRM | Repo upstream + thay đổi local | Đánh giá nghiệp vụ, license, account và SSO trước lựa chọn | P2/P3 |
| YMS / XNK | Tìm thấy nhiều source/biến thể | Kiểm kê riêng để tránh gộp nhầm hệ thống | Sau |
| LIMS riêng | Có xác nhận người dùng, chưa có đường dẫn | Để sau, khảo sát khi đến giai đoạn LIMS | Sau |
| CMS | Chưa định danh source CMS cụ thể | Làm rõ CMS là quản lý nội dung nào; chưa chốt gộp BOS | Sau |
| ERP / HRM | Chưa xác định source/nguồn nhân sự chuẩn | Khảo sát yêu cầu và nguồn chủ | Sau |

## Thành phần có khả năng tái sử dụng

| Nguồn | Thành phần | Giới hạn |
| --- | --- | --- |
| BOS | Department hierarchy, JobTitle/JobPosition, danh mục permissions | Không mặc định schema User/tenant phù hợp toàn doanh nghiệp |
| BOS | FormSchemaRegistry, EntityVersion, designer/renderer | Coupling với auth, tenant, metadata và record runtime; chưa là package tách rời |
| LMS | Khóa/bài học, video/quiz UI, tiến độ, chấm điểm, API học tập | Chưa chạy kiểm thử; giữ khóa user cũ |
| Twenty | Kinh nghiệm cấu hình CRM/SSO | Có dependency OIDC không chứng minh tích hợp sẵn; cần review license/quyền dùng |

Chưa sao chép source từ bất kỳ repo nào. Remote tài khoản cá nhân/công ty là thông tin định tuyến Git, không thay xác minh quyền sở hữu code.

## Ranh giới tiếp tục độc lập

- Dữ liệu học tập thuộc LMS; schema và phiếu trả lời thuộc Forms.
- Directory không trở thành HRM toàn diện, Access không thay workflow nghiệp vụ.
- Các ứng dụng có thể dùng framework/database khác nhau.
- Chưa quyết định gộp source, backend hoặc database BOS/CRM/CMS.
- Không cần đợi LIMS hoặc BOS đầy đủ mới kiểm chứng nền tảng và triển khai Forms/LMS.
