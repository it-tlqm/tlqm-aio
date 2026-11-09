# TLQM AIO — All In One

**Một định danh · Một cổng truy cập · Đa ứng dụng**

TLQM AIO là nền tảng dùng chung cho các ứng dụng của Tà Lùng Quang Minh. Ưu tiên xây dựng **SSO/IAM và nền tảng tổ chức, phân quyền, danh mục ứng dụng trước**. Giai đoạn ứng dụng đầu tiên gồm **Form Builder và tích hợp LMS đào tạo**. **LIMS để giai đoạn sau**.

## Trạng thái ngày 09/11/2026

- Master repository: [it-tlqm/tlqm-aio](https://github.com/it-tlqm/tlqm-aio).
- Workspace: `D:/thanhnx/TLQM-AIO`.
- Nhánh chính: `main`.
- Stack đã chốt: **TypeScript + Fastify**; bộ khung local dùng Keycloak và PostgreSQL.
- Đã dựng hai client OIDC, session riêng, Directory/Registry, API cấp/thu hồi quyền và audit; dùng dữ liệu giả lập.
- Phạm vi bản khởi tạo: code Foundation local và bộ tài liệu. Source và database LMS/BOS hiện hữu được giữ nguyên.
- Đã tìm thấy LMS tại `D:/thanhnx/OpenCode/LMS-TLQM/tlqm-learning-mvp`; đã đọc schema và auth, chưa chạy ứng dụng.
- LIMS là dự án riêng chưa được cung cấp đường dẫn; không nằm trong giai đoạn đầu.

## Thứ tự thực hiện

1. Chốt trách nhiệm Identity, Organization Directory, Access Management và Application Registry.
2. Xây nền tảng tối thiểu trong môi trường thử riêng, với dữ liệu giả lập.
3. Kiểm chứng SSO và cách ly quyền bằng hai client thử độc lập.
4. Ưu tiên Form Builder MVP và tích hợp LMS vào cùng nền tảng.
5. Mở rộng Portal/Connect, BOS, CRM/CMS, YMS, LIMS, ERP theo nhu cầu.

Đã bắt đầu bước 2 và kiểm chứng luồng chính của bước 3 ở local. Đây là bộ khung chạy được, chưa phải Foundation MVP đầy đủ hoặc bản production.

## Chạy thử

Đọc [hướng dẫn local](docs/LOCAL_DEVELOPMENT.md) để dựng môi trường, lấy tài khoản giả lập và kiểm thử.

~~~powershell
npm ci --ignore-scripts
npm run local:prepare
npm run local:up
npm run db:setup
npm run dev
~~~

Foundation tại http://127.0.0.1:4100, client thử B tại http://127.0.0.1:4101 và Keycloak tại http://127.0.0.1:8180. HTTP chỉ được cho phép với các địa chỉ loopback này. Cấu hình và credentials sinh tự động trong .local, đã loại khỏi Git.

[Trạng thái triển khai và bằng chứng](docs/IMPLEMENTATION_STATUS.md) phân biệt phần đã kiểm chứng với công việc tiếp theo.

## Bắt đầu đọc

| Tài liệu | Nội dung |
| --- | --- |
| [Phạm vi nền tảng](docs/FOUNDATION_SCOPE.md) | Xây gì trước, ranh giới và tiêu chí hoàn thành |
| [Kiến trúc mục tiêu](docs/TARGET_ARCHITECTURE.md) | Thành phần, sở hữu dữ liệu, hướng tái sử dụng |
| [SSO/IAM](docs/IAM_SSO_INTEGRATION.md) | Luồng đăng nhập, định danh, phiên và chuyển đổi |
| [Mô hình tổ chức](docs/IDENTITY_ORGANIZATION_MODEL.md) | Pháp nhân, phòng ban, chức danh, vị trí, nhân sự, kiêm nhiệm |
| [Mô hình quyền](docs/APPLICATION_ACCESS_MODEL.md) | Vai trò theo ứng dụng và phạm vi dữ liệu |
| [Danh mục ứng dụng](docs/APPLICATION_REGISTRY.md) | Hợp đồng đăng ký và kết nối ứng dụng |
| [Kiểm kê](inventory/PROJECT_INVENTORY.md) | Đường dẫn, Git, công nghệ và giới hạn kiểm chứng |
| [Danh mục hệ thống](inventory/APPLICATION_PORTFOLIO.md) | Tái sử dụng, giữ độc lập và thứ tự tích hợp |
| [Hiện trạng LMS](inventory/LMS_CURRENT_STATE.md) | Stack, tài khoản, vai trò, API và dữ liệu học tập |
| [Tích hợp LMS](docs/LMS_SSO_INTEGRATION.md) | Ánh xạ tài khoản, giữ dữ liệu học tập và kiểm thử |
| [Form Builder](docs/FORM_BUILDER_MVP.md) | Phạm vi MVP, tái sử dụng BOS và nghiệm thu |
| [Lộ trình](roadmap/INTEGRATION_ROADMAP.md) | Giai đoạn và cổng nghiệm thu |
| [Sprint 01](roadmap/SPRINT_01_BACKLOG.md) | Backlog nền tảng và tiêu chí nghiệm thu |
| [Quyết định ban đầu](docs/decisions/0001-foundation-first.md) | Điều đã chốt và đề xuất chưa phê duyệt |
| [Quyết định TypeScript + Fastify](docs/decisions/0002-typescript-fastify.md) | Stack đã chốt và cấu trúc bộ khung |
| [Goal Foundation MVP](roadmap/GOAL_FOUNDATION_MVP.md) | Mục tiêu, phạm vi tự triển khai và tiêu chí nghiệm thu |
| [Frontend Design System](docs/FRONTEND_DESIGN_SYSTEM.md) | shadcn/ui, màu TLQM, typography và accessibility |

## Quy ước

**Đã kiểm chứng** là thông tin từ source/metadata được đọc hoặc xác nhận trực tiếp của người dùng. **Đề xuất** là thiết kế chưa triển khai. **Chưa xác minh** không được coi là tính năng đã tồn tại.

SSO thống nhất không buộc các ứng dụng phải dùng cùng framework, repository hoặc database. Bộ tài liệu này chưa quyết định cách tổ chức toàn bộ source code.

Hướng dẫn cho agent và người triển khai nằm trong [AGENTS.md](AGENTS.md).
