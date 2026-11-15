# TLQM AIO — All In One

**Một định danh · Một cổng truy cập · Đa ứng dụng**

TLQM AIO là nền tảng dùng chung cho các ứng dụng của Tà Lùng Quang Minh. Ưu tiên xây dựng **SSO/IAM và nền tảng tổ chức, phân quyền, danh mục ứng dụng trước**. Giai đoạn ứng dụng đầu tiên gồm **Form Builder và tích hợp LMS đào tạo**. **LIMS để giai đoạn sau**.

## Trạng thái ngày 11/11/2026

Quy trình đang được nâng cấp theo [goal W1–W5](roadmap/GOAL_WORKFLOWS_COMPLETE.md), sau [đối chiếu sâu AMIS](docs/WORKFLOWS_AMIS_GAP_ANALYSIS.md). [Mốc W1a](docs/WORKFLOWS_BUSINESS_FORMS.md) đã có bảng chi tiết, tiền/công thức tính ở backend, quyền xem từng trường và nháp hồ sơ; đã qua hồi quy local 12/12 lệnh và 218 tests. Thư viện có mẫu **Mua sắm — Bảng chi tiết**, giữ giao diện và nhận diện TLQM. [Mốc W1b](docs/WORKFLOWS_DIRECTORY_FIELDS.md) bổ sung chọn nhân sự/đơn vị từ AIO, tên snapshot do server xác nhận, giữ scope/quyền trường; đã qua hồi quy mới **12/12 lệnh, 223 tests** và 11 axe scans nghiệp vụ. Thư viện và thao tác lưu thiết kế đã giảm các lượt tải không cần thiết. Toàn goal Quy trình chưa hoàn tất.

Đợt nâng cấp cấu hình mở đã có [hồ sơ/tổ chức tùy chỉnh](docs/CONFIGURABLE_DIRECTORY.md), [nhóm duyệt và lịch/SLA](docs/WORKFLOWS_ADVANCED.md), [chính sách học/thi](docs/LMS_POLICIES.md), [lộ trình/đợt đào tạo](docs/LMS_TRAINING.md), [đề xuất hồ sơ qua Quy trình](docs/PROFILE_WORKFLOWS.md), [công việc/nhắc hạn LMS trong Portal](docs/LMS_WORK_CENTER.md) và [nhập/xuất/khôi phục cấu hình](docs/CONFIGURATION_TRANSFER.md). [Bộ mẫu dùng thử](examples/configuration/README.md) gồm các gói JSON và video giả lập. [Goal và bằng chứng mới nhất](roadmap/GOAL_CONFIGURABLE_SUITE.md) ghi riêng các checkpoint; các số kiểm thử bên dưới là lịch sử của những mốc trước.

**Nghiệm thu local E0–E4 hoàn tất lúc 06:20 ngày 11/11/2026:** 209 tests, 19/19 lệnh hồi quy pass và 401 source hashes ổn định. Đã kiểm giao diện desktop/mobile và mở lại [Portal/tổ chức](http://127.0.0.1:4100), [Forms](http://127.0.0.1:4103), [LMS](http://127.0.0.1:4104), [Quy trình](http://127.0.0.1:4105). Kiểm Vimeo live vẫn là phần chưa đạt của goal LMS trước; chưa triển khai production.

- Master repository: [it-tlqm/tlqm-aio](https://github.com/it-tlqm/tlqm-aio).
- Workspace: `D:/thanhnx/TLQM-AIO`.
- Nhánh chính: `main`; triển khai Foundation hiện tại ở `feat/foundation-mvp`, worktree chưa commit trên baseline `abea705`.
- Stack đã chốt: **TypeScript + Fastify**; bộ khung local dùng Keycloak và PostgreSQL.
- Đã dựng sáu client OIDC A/B/C/Forms/LMS/Quy trình, onboarding bằng manifest, renewal/session riêng, MFA và recovery fixture; API/UI Directory, Registry, phân quyền và audit bằng React/shadcn + màu TLQM. [Foundation](docs/FOUNDATION_ACCEPTANCE.md), [Form Builder](docs/FORMS_ACCEPTANCE.md) và [Quy trình](docs/WORKFLOWS_ACCEPTANCE.md) có bằng chứng chạy local.
- [LMS trong AIO](docs/LMS_ACCEPTANCE.md) có quản lý/phát hành khóa học, upload video, học/checkpoint/bài thi, chứng nhận, ngân hàng câu hỏi/Excel, báo cáo và quản trị học viên SSO. Hồi quy tích hợp ngày 10/11/2026 đạt 19 lệnh, gồm check và các suite LMS/Foundation/Forms/Quy trình. Vận hành và bàn giao local đã kiểm tra; [goal đầy đủ](roadmap/GOAL_LMS_COMPLETE.md) còn mở cho kiểm chứng Vimeo live, không coi fixture là bằng chứng dịch vụ Vimeo hoạt động.
- Phạm vi hiện tại là AIO local với dữ liệu giả lập. Source và database LMS/BOS hiện hữu được giữ nguyên.
- Đã tìm thấy LMS tại `D:/thanhnx/OpenCode/LMS-TLQM/tlqm-learning-mvp`; đã đọc schema và auth, chưa chạy ứng dụng.
- LIMS là dự án riêng chưa được cung cấp đường dẫn; không nằm trong giai đoạn đầu.
- Đã bổ sung [AIO Quy trình](docs/WORKFLOWS_ACCEPTANCE.md) theo hướng AMIS và tái sử dụng BOS: sơ đồ/biểu mẫu, điều kiện VÀ/HOẶC, phát hành phiên bản, lượt chạy, nhiệm vụ và lịch sử. Nâng cấp mới có [nhóm xử lý, chọn người khi gửi và giao cho người đã xử lý bước trước](docs/WORKFLOWS_ASSIGNMENTS.md); 103 tests và hồi quy các ứng dụng đã pass. Client riêng ở 4105; [hướng dẫn chạy](docs/WORKFLOWS_LOCAL_DEVELOPMENT.md).
- Theo ưu tiên mới, đã hoàn thành và kiểm chứng local [cơ cấu tổ chức, nhân sự và phân quyền](docs/ORGANIZATION_WORKSPACE.md): cây đơn vị, vị trí/chức danh, hồ sơ công tác/tài khoản và ma trận vai trò theo ứng dụng. Hồi quy đạt 139 unit/integration tests và tám lệnh pass; tài khoản `org.admin` đã sẵn sàng để tự thiết lập MFA/đổi mật khẩu lần đầu. [Nghiệm thu và giới hạn](roadmap/ORGANIZATION_WORKSPACE.md) ghi riêng với goal LMS; dùng chung API/audit/quyền hiện có, không thêm migration.

- Đã nghiệm thu local cả bốn phần: [quản lý trực tiếp/trưởng đơn vị/thay thế, luồng nhân sự, người duyệt theo cơ cấu và nhập Excel](docs/ORGANIZATION_OPERATIONS.md). [Goal 1→4 và nghiệm thu](roadmap/GOAL_ORGANIZATION_OPERATIONS.md) ghi kết quả mới; Foundation 006 và Workflows 003 là migration additive, giữ lịch sử cũ.

- Đợt 11/11/2026: [Trung tâm công việc & thông báo](docs/WORK_CENTER.md) có API/UI cho việc cá nhân, thông báo, nhắc hạn và theo dõi quản lý; nguồn đầu tiên Quy trình, migration Workflows 004. [Goal và nghiệm thu](roadmap/GOAL_WORK_CENTER.md) ghi kết quả chạy cuối.

## Thứ tự thực hiện

1. Chốt trách nhiệm Identity, Organization Directory, Access Management và Application Registry.
2. Xây nền tảng tối thiểu trong môi trường thử riêng, với dữ liệu giả lập.
3. Kiểm chứng SSO/cách ly quyền A/B và onboarding client C bằng hợp đồng dùng chung.
4. Ưu tiên Form Builder MVP và tích hợp LMS vào cùng nền tảng.
5. Mở rộng Portal/Connect, BOS, CRM/CMS, YMS, LIMS, ERP theo nhu cầu.

Đã dựng Foundation, Form Builder, Quy trình và nghiệp vụ LMS trong môi trường local. Đây chưa phải bản production hoặc kết nối dữ liệu của LMS hiện hữu.

## Chạy thử

Đọc [hướng dẫn local](docs/LOCAL_DEVELOPMENT.md) để dựng môi trường, lấy tài khoản giả lập và kiểm thử.

~~~powershell
npm ci --ignore-scripts
npm run local:prepare
npm run local:up
npx playwright install chromium
npm run local:mfa
npm run db:setup
npm run forms:setup
npm run local:client
npm run build
npm run dev
~~~

Foundation tại http://127.0.0.1:4100, client thử B tại http://127.0.0.1:4101, client C tại http://127.0.0.1:4102 và Keycloak tại http://127.0.0.1:8180. HTTP chỉ được cho phép với các địa chỉ loopback này. Cấu hình và credentials sinh tự động trong .local, đã loại khỏi Git. [Onboarding client local](docs/LOCAL_CLIENT_ONBOARDING.md) có các lệnh kiểm chứng và vô hiệu hóa/khôi phục.

[Trạng thái triển khai và bằng chứng](docs/IMPLEMENTATION_STATUS.md) phân biệt phần đã kiểm chứng với công việc tiếp theo.

[MFA và recovery local](docs/LOCAL_MFA_RECOVERY.md) mô tả OTP fixture, quản trị dự phòng và phạm vi diễn tập. Không chạy script MFA/E2E đồng thời.

[Giao diện SSO TLQM](docs/SSO_THEME.md) đồng bộ trang đăng nhập/OTP với màu, Be Vietnam Pro, light mode và controls 44px của AIO; có tiếng Việt/English, kiểm thử responsive và lệnh rollback giao diện riêng.

[Bộ nhận diện TLQM 2026](brand/tlqm-2026/README.md) chứa 24 file logo gốc được người dùng cung cấp, các bản dùng trên web và manifest nguồn. Logo chính thức/favicons được dùng chung trong SSO, Portal, Forms, LMS sandbox và Quy trình.

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

## AIO Quy trình local

Sau Foundation/Forms fixtures: chạy npm run workflows:setup, provision infrastructure/local/clients/aio-workflows.json bằng local:client, rồi npm run workflows:fixtures và npm run build. Có thể chạy npm run workflows:demo để tạo mẫu mua sắm giả lập; npm run workflows:demo-assignments tạo mẫu riêng có chọn người trong nhóm và bước sau dùng người đã xử lý bước trước. Chạy hai lệnh khi cổng 4105 trống, trước npm run dev. Truy cập http://127.0.0.1:4105. [Nghiệm thu và giới hạn](docs/WORKFLOWS_ACCEPTANCE.md), [nguồn BOS](docs/decisions/0005-workflows-bos-reuse.md), [nguồn selector bổ sung](docs/decisions/0006-workflow-assignment-policies.md).

Hướng dẫn cho agent và người triển khai nằm trong [AGENTS.md](AGENTS.md).

## AIO Forms local

Sau setup Foundation, provision client và fixture riêng rồi build/chạy:

~~~powershell
npm run forms:setup
npm run local:client -- infrastructure/local/clients/aio-forms.json provision
npm run forms:fixtures
npm run build
npm run dev
~~~

Forms ở http://127.0.0.1:4103, dùng cùng IdP và quyền ứng dụng riêng. [Runbook Forms](docs/FORMS_LOCAL_DEVELOPMENT.md) mô tả fixture, tests, migration và khôi phục; chỉ dữ liệu giả lập. Nghiệm thu hiện tại không phải triển khai production hoặc tích hợp LMS hiện hữu.

## LMS đào tạo trong AIO

Adapter ở src/lms chạy workerd/Miniflare + D1 riêng, giao diện shadcn dùng palette TLQM. Sau Forms fixtures:

~~~powershell
npm run local:client -- infrastructure/local/clients/aio-lms-sandbox.json provision
npm run lms:setup
npm run lms:directory
npm run lms:provisioning
npm run build
npm run dev
~~~

Mở terminal thứ hai, chạy npm run lms:dev rồi vào http://127.0.0.1:4104. [Runbook LMS](docs/LMS_LOCAL_DEVELOPMENT.md) có lệnh kiểm tra revision, khóa/mở và các suite tuần tự. LMS có quản trị khóa học, media, học/checkpoint/bài thi, chứng nhận/ranking, ngân hàng câu hỏi, Excel, báo cáo và quản trị học viên SSO. [Nghiệm thu](docs/LMS_ACCEPTANCE.md), [học viên](docs/LMS_LEARNER_ADMIN.md), [backup/restore và bảo trì](docs/LMS_STORAGE_OPERATIONS.md). Chỉ dữ liệu AIO giả lập; source/database/auth LMS đang dùng giữ nguyên. Sau khi local chạy, lms:review-admin chuẩn bị lms.admin và hướng dẫn riêng trong .local.
