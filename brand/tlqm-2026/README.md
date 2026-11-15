# Bộ nhận diện Tà Lùng Quang Minh 2026

Nhập ngày 10/11/2026 từ thư mục người dùng cung cấp `D:/TLQM/Logo/TALUNG_BG`. 24 file logo gốc được sao chép nguyên byte, gồm 22 PNG, master Illustrator và PDF 22 artboards. [Manifest nguồn](source-manifest.json) ghi đường dẫn gốc và SHA-256 từng file. Thư mục nguồn bên ngoài không thay đổi.

## Tài nguyên

- [Master Illustrator](source/logo-master.ai), [master PDF](source/logo-master.pdf), các biến thể PNG trong `source/png/`.
- Emblem hai màu: `TA LUNG_2026_logo.png`; emblem trắng: `TA LUNG_2026_logo-13.png`.
- Logo đầy đủ: `-01.png` cho nền sáng, `-05.png` trắng trên nền tối.
- Wordmark có chữ Logistics: `-17.png` cho nền sáng, `-21.png` trắng trên nền tối.
- Các biến thể một màu và mẫu nền được giữ trong thư viện gốc; không dùng thay tùy tiện cho bản hai màu.

`npm run brand:prepare` kiểm checksum nguồn, bỏ phần canvas ngoài hoàn toàn trong suốt rồi resize theo đúng tỷ lệ thành PNG cho web. Không vẽ lại, đổi màu, cắt vào nội dung hoặc dùng filter CSS để tạo phiên bản trắng. Favicon 64px dùng chính emblem hai màu, có khoảng trống bao quanh. [Manifest web](web-manifest.json) ghi bounding box alpha, nguồn và hash đầu ra để tái tạo.

Các bản web nằm ở `frontend/src/assets/brand/` và `infrastructure/keycloak/themes/tlqm/login/resources/img/brand/`. Vite phát hành asset có hash, không nhúng data URI; Keycloak phục vụ nội bộ từ theme. Master AI/PDF và các file thiết kế không nằm trong thư mục public của ứng dụng.

## Sử dụng trong AIO

Component `frontend/src/components/brand.tsx` dùng chung cho Portal/Foundation, Forms, LMS sandbox và Quy trình. Emblem đặt cạnh tên sản phẩm TLQM AIO và nhãn module; không thay biểu tượng công ty bằng icon nghiệp vụ. Trang SSO dùng emblem màu ở đầu trang và wordmark trắng trên panel navy; favicon thống nhất.

Giữ tỷ lệ ảnh với `object-fit: contain`, vùng trống quanh logo được bố trí trong layout. Không kéo giãn, thêm viền trực tiếp vào logo, xoay, đổi opacity hoặc tái tạo chữ logo bằng font giao diện. Kích thước UI đang dùng là lựa chọn triển khai AIO, không được gọi là quy định tối thiểu từ brand manual khi chưa có tài liệu đó.

Màu UI và font Be Vietnam Pro giữ theo [Design System đã chốt](../../docs/FRONTEND_DESIGN_SYSTEM.md). Màu/letterform của logo gốc được giữ nguyên trong asset. Các font thiết kế, danh thiếp và ảnh cá nhân trong gói nguồn không được đưa vào bundle web.

## Kiểm chứng local ngày 10/11/2026

24 bản gốc khớp hash với thư mục người dùng; 7 bản web khớp ở cả frontend và theme SSO. `npm run check` qua 103 tests, format/TypeScript/build; test:sso-theme, ba suite test:e2e, test:workflows, test:forms-ui và test:lms đều pass, kết thúc 2026-11-10T01:34:03Z. Đã kiểm tra ảnh Portal, Quy trình, Forms, LMS và login trống desktop/mobile; logo/favicons thực sự được tải từ local, không nhúng data URI. Sau cùng bỏ dòng phụ lặp ở sidebar Foundation, build UI lại và kiểm tra bản local.

Evidence ignored: `.local/evidence/brand-integration-regression.json`, `brand-login-preview.json`, `brand-sso-revision.json`, `brand-sso-live.json`. Đợt này là worktree local chưa commit; không push/deploy hoặc sửa source BOS/LMS/YMS hiện hữu.
