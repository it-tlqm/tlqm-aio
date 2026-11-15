# ADR 0003 — Forms độc lập với BOS và lõi định danh

Ngày 10/11/2026. Quyết định triển khai local theo phạm vi người dùng đã cho phép sau khi Foundation đạt gate.

## Spike source chỉ đọc

Đã đọc tại D:/thanhnx/OpenCode/BOS: nhánh codex/crm-app-yms, HEAD 1ea243e49c6e4819f940f43cf1b5ea34a219c8b4, dirty (226 dòng porcelain lúc kiểm tra). Đây là worktree có sửa đổi, không phải snapshot thuần HEAD. Chưa chạy BOS.

| Thành phần | Dependencies trực tiếp quan sát được | Hệ quả |
| --- | --- | --- |
| backend-nestjs/src/modules/form-schema-registry | NestJS, PrismaService, GovernanceModule/SignedContext, EntityVersion, ControlledDocumentVersion, ENTITIES.READ/MANAGE | Registry gắn với mô hình Entity/governance BOS; không phải package survey standalone |
| frontend-nextjs/src/components/forms/MetadataFormRuntime.tsx | Ant Design, @bos/core, FieldRenderer trong records, default/progressive field context | Sao chép nguyên renderer kéo theo UI/auth/domain ngoài phạm vi và khác shadcn |
| frontend-nextjs/src/app/(core)/metadata/[id]/components/FormPresentationDesigner.tsx | Ant Design, @bos/core hooks, EntityVersion/metadata draft, MetadataFormRuntime | Designer chỉnh metadata nghiệp vụ BOS, không trực tiếp đáp ứng schema khảo sát độc lập |

Không thấy license module standalone trong phạm vi tìm kiếm; chưa kết luận quyền chuyển mã. Không copy code, cài dependencies, chạy hoặc sửa source BOS.

## Quyết định

Xây module Forms nhỏ trong Master Project. Tái sử dụng hạ tầng SSO/BFF, giao diện shadcn và nguyên tắc version/idempotency đã kiểm chứng của AIO. Tự triển khai DSL schema v1 hữu hạn; không biên dịch schema người dùng thành Fastify/Ajv route validator, không eval/function/JavaScript tùy ý.

Forms sở hữu database/schema, runtime role, versions, audiences, submissions, receipts và audit nghiệp vụ riêng. Không thêm đáp án/biểu mẫu vào Directory hoặc Keycloak. Boundary BFF do Foundation vận hành xác thực OIDC/session và trả principal/quyền/quan hệ hiện hành cho Forms; Forms service chỉ nhận hợp đồng typed, không truy cập bảng định danh. Khi tách process, thay boundary này bằng API tương đương; không cấp quyền đọc DB Identity cho ứng dụng bên ngoài.

Mỗi request kiểm lại grant/account/permission, backend lọc tenant/form/đơn vị và audience. Scope ghi trên phiếu là snapshot lúc gửi, còn quyền reviewer/analyst được kiểm tra hiện hành. Tên chức danh/đơn vị không tự sinh role. Người kiêm nhiệm chọn một đơn vị có assignment hợp lệ; server không tin unitId từ payload.

Quyền gồm designer, publisher, respondent, reviewer, analyst, khai báo bằng permission catalog của app. Designer không mặc nhiên publish/xem đáp án; reviewer không mặc nhiên export. Audiences theo account/đơn vị/nhóm Forms; nhóm Forms không sửa cây tổ chức và không sinh quyền nền tảng.

Phiên bản published bất biến. Draft mới sao chép nội dung có versionId mới; phiếu v1 vẫn dùng schema v1. Form close chặn ghi phiếu mới; archive giữ lịch sử. Retry mutation cần revision và Idempotency-Key; audit và thay đổi Forms commit cùng transaction.

## Kiểm chứng bắt buộc

Theo [FORM_BUILDER_MVP](../FORM_BUILDER_MVP.md): bảy loại field, cycle/type/option/hidden-answer validation, audience/role/scope, publish v1→v2, retry/concurrency/audit rollback, CSV chống công thức, UI khảo sát 10 câu, SSO/revocation và truy cập chéo. Chỉ nghiệm thu sau khi chạy đủ; ADR này chưa chứng minh module đã hoạt động.
