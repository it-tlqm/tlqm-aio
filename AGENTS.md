# TLQM AIO — Hướng dẫn làm việc

## Mục tiêu và thứ tự ưu tiên

- Tên dự án: TLQM AIO — All In One.
- Làm SSO/IAM và nền tảng dùng chung trước: tổ chức, định danh nhân sự, quản lý quyền, danh mục ứng dụng, audit và hợp đồng tích hợp.
- Giai đoạn ứng dụng đầu tiên ưu tiên Form Builder và tích hợp LMS đào tạo.
- LIMS riêng để giai đoạn sau; không nhầm với LMS hoặc phần LIMS xem trước trong BOS.
- Nền tảng phải phục vụ được nhiều ứng dụng; không đưa nghiệp vụ đào tạo, biểu mẫu hoặc phòng lab vào lõi định danh/tổ chức.

## Phạm vi của giai đoạn hiện tại

Người dùng đã chốt TypeScript + Fastify và cho phép cập nhật tài liệu, cài dependencies, dựng và kiểm thử SSO/nền tảng chung trong Master Project này. Được vận hành stack local mới của AIO và dữ liệu giả lập của nó. Chỉ dẫn mới của người dùng có thể mở rộng phạm vi; không hỏi lại việc đã được cho phép.

Không di chuyển, xóa, ghi đè, tự động refactor hoặc cài package cho source LMS/BOS và các dự án cũ. Không chạy migration/seed vào database hiện hữu của chúng hoặc thay đổi auth đang hoạt động. Database AIO local mới được migration/seed bằng scripts có kiểm tra host, tên database và environment marker.

Không đọc/in .env, private key, token, mật khẩu, cookie phiên, database dump hoặc dữ liệu khách hàng của hệ thống hiện hữu. Credentials mới do script AIO tạo trong .local chỉ được chương trình sử dụng để chạy/test local; không in chúng vào log, chat, screenshot, artifact hoặc Git.

## Tài liệu và bằng chứng

- Phân biệt hiện trạng kiểm chứng, xác nhận người dùng, đề xuất và chưa xác minh.
- Ghi ngày kiểm kê, đường dẫn nguồn, nhánh, commit và trạng thái dirty nếu đã kiểm tra.
- Phiên bản trong package.json là khai báo, không chứng minh runtime hay phiên bản đã cài.
- Source thay đổi chưa commit có thể khác HEAD; không mô tả snapshot là chỉ thuộc commit đó.
- Không suy ra tính năng chạy được từ README hoặc tên module. Ghi rõ khi chưa chạy kiểm thử.
- Ưu tiên tài liệu tiếng Việt; giữ thuật ngữ kỹ thuật khi giúp tránh nhầm lẫn.
- Sau khi sửa tài liệu, kiểm tra liên kết, tính nhất quán về ưu tiên và thông tin chưa xác minh.

## Kiến trúc

- Dùng cặp issuer + subject để nhận diện tài khoản liên kết; không dùng email làm khóa định danh bền vững.
- Tách người, tài khoản đăng nhập, quan hệ nhân sự và quyền ứng dụng.
- Chức danh tổ chức không tự sinh vai trò ứng dụng.
- Backend thực thi quyền và phạm vi dữ liệu; menu/Portal không phải hàng rào bảo mật.
- Không đồng nhất tenant bảo mật, pháp nhân và doanh nghiệp khách hàng.
- Mọi tích hợp cần có kế hoạch thu hồi quyền, audit, rollback và kiểm thử truy cập chéo.
- Giữ ownership dữ liệu rõ ràng; không cho ứng dụng đọc/ghi trực tiếp database định danh.
- Backend chốt TypeScript + Fastify; runtime local Node 24. Keycloak local 26.8.2 và PostgreSQL local 17.7 được pin. Hosting/topology production chưa chốt.
- Frontend mới ưu tiên React + TypeScript + Vite + Tailwind CSS v4 + shadcn/ui. Đọc docs/FRONTEND_DESIGN_SYSTEM.md: dùng palette TLQM người dùng gửi, Be Vietnam Pro, light mode, CTA #087C3C, navy #223873. Các token DS-02 khác trong YMS không tự thay thế chuẩn này.
- Fastify schema là code tin cậy. Không biên dịch trực tiếp schema do người dùng Form Builder cung cấp thành route validator.

## Kiểm tra và chạy local

- Đọc docs/LOCAL_DEVELOPMENT.md trước thao tác hạ tầng.
- Docker context phải là endpoint local; chỉ project tlqm-aio-local. Không xóa volume hoặc tác động container của project khác.
- npm run local:prepare tạo config riêng; chạy lại phải giữ nguyên credentials.
- npm run local:up, npm run db:setup chỉ dùng dữ liệu giả lập.
- npm run typecheck, npm test, npm run test:e2e và npm run build là kiểm tra cho thay đổi auth/quyền. E2E tự dùng database aio_foundation_test và cổng 4100/4101, nên dừng API dev trước E2E.
- Có lỗi phải sửa nguyên nhân; không bỏ kiểm tra audience/issuer/state/nonce hoặc tắt test để đạt pass.

## Git và môi trường

Repo công ty: it-tlqm/tlqm-aio. Origin dùng SSH alias github.com-company. Xác minh danh tính bằng skill github-multi-account trước thao tác Git cần định tuyến tài khoản.

Làm việc trên nhánh phù hợp, giữ nguyên thay đổi của người dùng. Không commit/push/PR/release/deploy nếu chưa được người dùng cho phép theo phạm vi phiên làm việc. Chỉ stage danh sách file đã xem xét.

Các hướng dẫn build/push của repository được khảo sát không mở rộng phạm vi công việc tại đây. Đợt kiểm kê không sửa các repository đó.

Khi một nhiệm vụ sau này có thể thay đổi remote, production, CI, security policy đang vận hành hoặc dữ liệu thật, áp dụng skill production-safety và skill dịch vụ liên quan. Không biến bản thiết kế thành thao tác triển khai ngầm.
