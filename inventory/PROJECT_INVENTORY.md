# Kiểm kê dự án hiện hữu

Ngày khảo sát: **09/11/2026**, múi giờ làm việc Asia/Bangkok. Chế độ: **chỉ đọc source/metadata**, không chạy ứng dụng hoặc truy vấn database.

Đây là snapshot kiểm kê trước khi xây code AIO. Trạng thái hiện tại của Master Project nằm ở [IMPLEMENTATION_STATUS](../docs/IMPLEMENTATION_STATUS.md); các source cũ trong snapshot vẫn chỉ được đọc.

## Phạm vi

Đã tìm tên manifest và AGENTS trong D:/thanhnx/code, OpenCode, CRM, OpenPhieu và các thư mục Web/WebComponents của user. Bỏ qua node_modules, .git, vendor, build/dist và môi trường ảo trong tìm kiếm chính. Một số bản build/worktree lồng nhau xuất hiện khi dò tên file; không coi là dự án độc lập.

Chỉ khảo sát sâu vừa đủ cho Identity, Forms và LMS. Đây không phải danh sách đầy đủ mọi project trên ổ đĩa. Không đọc .env, khóa, cookie, token hay database dump. Phiên bản bên dưới là khai báo package.json, không chứng minh phiên bản runtime.

## Dự án liên quan trực tiếp

| Dự án / đường dẫn | Git được kiểm chứng | Công nghệ/hệ quả |
| --- | --- | --- |
| Master — D:/thanhnx/TLQM-AIO | Remote it-tlqm/tlqm-aio trống lúc kiểm tra; đã clone bằng alias company; nhánh docs/foundation-bootstrap; chưa commit | Chỉ tài liệu |
| LMS — D:/thanhnx/OpenCode/LMS-TLQM/tlqm-learning-mvp | Không phải Git repository tại đường dẫn khảo sát | next 16.3.4, React 19.2.6, Drizzle 0.45.2; source dùng Cloudflare D1; auth local |
| LMS source archive — D:/thanhnx/OpenCode/LMS-TLQM/tlqm-learning-mvp-source | Không phải Git repository; chứa tlqm-learning-mvp-source.zip | Chỉ kiểm tra tên; chưa giải nén/so sánh |
| BOS — D:/thanhnx/OpenCode/BOS | Nhánh codex/crm-app-yms; HEAD 247f7c86b; origin github.com-personal:thanhngx12-qnh/bos.git; 171 mục tracked thay đổi trong snapshot | Next ^15.5.22, Nest ^11.0.1, Prisma ^7.9.1, PostgreSQL; source có tổ chức, quyền và forms |
| CRM — D:/thanhnx/CRM/twenty-crm | Nhánh main; HEAD a4ed561e; origin https://github.com/twentyhq/twenty.git; 5 mục tracked thay đổi | Backend có NestJS, TypeORM, pg và openid-client; chưa kiểm chứng SSO cấu hình thực tế |
| LIMS riêng | Người dùng xác nhận có dự án riêng; chưa có đường dẫn/repo | Giai đoạn sau, chưa kiểm kê |
| D:/thanhnx/OpenCode/BOS-LIUMSS | Thư mục tồn tại, không thấy mục con khi liệt kê | Không có bằng chứng đây là source LIMS |

Số thay đổi trên dùng git status --porcelain -uno: chỉ đếm mục tracked, không khẳng định không có untracked. Source đọc từ working tree có thể khác HEAD và đang được phiên khác chỉnh sửa.

## Metadata các dự án bổ sung

| Đường dẫn dưới D:/thanhnx/OpenCode | Nhánh / HEAD / remote | Manifest quan sát |
| --- | --- | --- |
| YMS-project | main / f8f9ac2 / it-tlqm/SonCang-YMS qua company SSH | son-cang-yms; Next 16.4.5, React 19.3.0, Supabase JS ^2.117.3 |
| YMS-PhuAnh-V1 | codex/full-phu-anh-yms-v1 / cf25973 / không có origin lấy được | phu-anh-yms-v1; Next 16.4.2, Supabase JS ^2.117.3 |
| XNK | Không phải Git repository tại đường dẫn khảo sát | xnk-logistics-platform; Next 16.4.5, Supabase JS 2.119.0 |
| WareTrack | Không phải Git repository tại đường dẫn khảo sát | flowdeck; React ^19.2.8 |
| talung-cus-work | codex/v3-phase-a-planning-2026-10-23 / 9534c6a / it-tlqm/task-cus qua company SSH | Next ^15.1.7, Prisma ^6.4.1; chỉ đọc metadata |

Chưa kiểm tra dirty status, auth, runtime hoặc tính sẵn sàng tích hợp của nhóm bổ sung. Tên package/dependency không đủ chứng minh mô hình nghiệp vụ hay database đang chạy.

Các nhóm khác đã tìm thấy manifest gồm HoaVy, Greentech, VIDEO, scale-reader, quangminh-smart-border và các worktree talung-*. Chưa phân tích trong phạm vi ưu tiên hiện tại.

## Bằng chứng dùng cho kiến trúc

| Mã | Nguồn | Kết luận có giới hạn |
| --- | --- | --- |
| E01 | LMS package.json; db/index.ts:1; db/schema.ts:1 | Next/React/Drizzle; runtime DB dùng D1/SQLite |
| E02 | LMS lib/auth.ts:6, :15, :70, :79, :92 | Roles, cookie và session tự quản; phiên mặc định 30 ngày |
| E03 | LMS app/api/admin/route.ts:20, :160, :283 | API admin yêu cầu admin; input tạo user chỉ learner/admin ở vị trí đã đọc |
| E04 | LMS app/api/learning/route.ts:50, :272 | Endpoint học tập GET/POST; các action ghi chú, checkpoint, tiến độ, submit |
| E05 | LMS app/api/auth/login/route.ts:23 | Login gọi seedDefaultEmployeesIfEmpty; chưa chạy |
| E06 | BOS backend-nestjs/prisma/schema.prisma:7, :547, :587, :1350, :1368, :1387 | PostgreSQL, Department, User, JobTitle, JobPosition, Role |
| E07 | BOS backend-nestjs/src/core/strategies/jwt.strategy.ts:9, :78, :118, :125 | sub số legacy, khóa JWT từ cấu hình, tenant/tokenVersion được kiểm tra |
| E08 | BOS backend-nestjs/prisma/schema.prisma:6957, :6986 | Form definition/version |
| E09 | BOS backend-nestjs/src/modules/form-schema-registry/form-schema-registry.controller.ts:31, :51 | Guards, endpoint version gắn EntityVersion |
| E10 | BOS frontend-nextjs/src/components/LimsAppShell.tsx:76 | LIMS shell tự mô tả là preview, chưa có tác nghiệp vận hành |

Các đường dẫn “LMS” là tương đối với thư mục LMS ở bảng đầu; “BOS backend/frontend” là tương đối với D:/thanhnx/OpenCode/BOS/bos-workspace.

## Giới hạn kiểm chứng

Không chạy test/build, không kiểm tra deploy/production, không đọc dữ liệu người dùng. Không có kết luận hệ thống nào đã an toàn, hoàn thiện hay production-ready. Không kiểm tra toàn bộ mã nguồn về lỗ hổng.

BOS AGENTS có mô tả/test baseline cũ; báo cáo này không coi các con số đó là kết quả test mới. Source hiện tại đã có nhiều module và kiểm soát hơn mô tả tổng quan, nên cần kiểm thử đúng revision khi triển khai sau này.
