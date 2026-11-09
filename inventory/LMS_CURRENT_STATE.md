# Hiện trạng LMS

Ngày: 09/11/2026. Trạng thái: **đã đọc source local; chưa chạy hoặc kiểm thử runtime**.

## Đường dẫn và công nghệ

Source: `D:/thanhnx/OpenCode/LMS-TLQM/tlqm-learning-mvp`. Git trả về không phải repository; chưa xác định remote/branch. Thư mục bên cạnh tlqm-learning-mvp-source chỉ thấy file ZIP, chưa giải nén hoặc xác nhận là cùng phiên bản.

| Thành phần | Bằng chứng |
| --- | --- |
| Frontend | package.json khai báo Next 16.3.4, React/ReactDOM 19.2.6 |
| Backend | Next route handlers trong app/api; worker/index.ts và cấu hình build riêng |
| Database | db/index.ts dùng cloudflare:workers và drizzle-orm/d1; schema SQLite |
| ORM | Drizzle 0.45.2 khai báo |
| Node | engines >=22.13.0 là yêu cầu tooling, không khẳng định runtime production là Node |
| Auth | PBKDF2 trong lib/auth.ts; employees.passwordHash; sessions + cookie tlqm_session |

## Module và API hiện có trong source

| Khu vực | Điểm vào | Quan sát |
| --- | --- | --- |
| Đăng nhập | /api/auth/login | Tài khoản local; có lời gọi seed khi DB rỗng |
| Hồ sơ phiên | /api/auth/me, logout, change-password | Có route files; cần test hành vi đầy đủ |
| Học tập | /api/learning GET/POST | Bài học, tiến độ, ghi chú, checkpoint, submit và xem lại |
| Quản trị | /api/admin GET/POST | Guard admin; CRUD khóa học, nhân viên và import trong source |
| Video | /api/admin/upload-video | Có route; chưa đánh giá storage/quota hoặc quyền tải |
| UI | components/learning và components/admin | Catalog, video, quiz, result, certificate, dashboard và quản lý nhân viên |

Có component chứng chỉ hoặc giảng viên trong hướng mục tiêu không đồng nghĩa nghiệp vụ cấp chứng chỉ/giảng viên đã được kiểm chứng.

## Dữ liệu và quyền

db/schema.ts có employees, sessions, lessons, learning_progress, learning_attempts và learning_notes. Tiến độ, lần thi và ghi chú gắn userId; đây là ràng buộc quan trọng khi nối SSO.

employees giữ code, name, department dạng text, role, passwordHash, mustChangePassword, isActive. Không thấy cấu trúc person/employment/kiêm nhiệm trong schema này.

AuthUser khai báo learner/admin/manager; API admin đã đọc chỉ chấp nhận admin. Input tạo/import nhân viên ở các vị trí đã kiểm tra dùng learner/admin. Chưa xác minh manager hoàn chỉnh hoặc instructor.

Session cookie có HttpOnly, SameSite=Lax, Secure khi production; thời hạn mặc định 30 ngày. validateSession kiểm tra session hết hạn và employee isActive. Chưa có bằng chứng đồng bộ trạng thái/thu hồi quyền từ IdP ngoài.

## Đánh giá tích hợp

Có thể giữ route/UI và dữ liệu học tập, thêm lớp OIDC adapter với mapping legacy. Cần spike tương thích Workers và quản lý phiên, vì lựa chọn thư viện chỉ hỗ trợ Node có thể không phù hợp.

Chưa phát hiện OIDC/Keycloak trong auth.ts và route auth đã khảo sát. Đây là kết quả tìm kiếm có giới hạn, không khẳng định không tồn tại tích hợp ở môi trường khác.

Rủi ro chính: thiếu version control tại đường dẫn hiện tại, seed trên login, field password bắt buộc, session dài, quyền manager chưa tách rõ, department text và nguy cơ tạo trùng học viên. Đề xuất xử lý trong [LMS_SSO_INTEGRATION](../docs/LMS_SSO_INTEGRATION.md).

Không kết luận mức hoàn thành phần trăm; không có kết quả kiểm thử mới trong đợt này.
