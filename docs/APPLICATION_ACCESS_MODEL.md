# Mô hình truy cập ứng dụng

Ngày: 09/11/2026. Trạng thái: **đã có API/UI local cho catalog, roles, bindings và grants**, scope tenant/đơn vị, delegation, MFA quản trị, revision/idempotency và audit. Scope theo form thuộc giai đoạn Forms; UI còn cần nghiệm thu toàn bộ workflow. Xem [trạng thái](IMPLEMENTATION_STATUS.md).

## Quyết định cho phép

Một request chỉ được cho phép khi: account hoạt động, phiên hợp lệ, ứng dụng hoạt động, có grant ứng dụng còn hiệu lực, có permission đúng action và scope bao phủ đối tượng. Điều kiện nghiệp vụ của ứng dụng vẫn phải thỏa mãn.

Mặc định từ chối. Portal chỉ hiển thị ứng dụng được cấp; gọi API trực tiếp vẫn phải qua cùng kiểm tra.

| Đối tượng | Nội dung |
| --- | --- |
| Application | appId, code, owner, trạng thái |
| ApplicationGrant | accountId, appId, hiệu lực, trạng thái |
| AppRole | Local: tenantId + appCode + roleCode; không dùng role global tùy tiện |
| Permission | Local: appCode + permissionCode; namespace/action, mô tả. schemaVersion là phần hợp đồng mở rộng |
| RolePermission | roleId → permissionCode |
| RoleBinding | accountId, appId, roleId, scope, hiệu lực, người cấp, lý do |
| DataScope | tenant bắt buộc khi app có tenant; legalEntity/orgUnit/self/formId theo loại quyền |
| AccessAudit | actor, subject, app, action, scope, before/after tối thiểu, thời gian, lý do |

## Vai trò đề xuất cho giai đoạn đầu

| Ứng dụng | Vai trò | Ví dụ phạm vi |
| --- | --- | --- |
| Foundation | identity_operator | Quản lý vòng đời account; không mặc nhiên cấp quyền dữ liệu |
| Foundation | organization_admin | Pháp nhân/đơn vị cụ thể |
| Foundation | access_admin | Cấp quyền trong ứng dụng/phạm vi được ủy quyền |
| Forms | designer | Tạo/sửa bản nháp trong workspace được cấp |
| Forms | publisher | Xuất bản/đóng biểu mẫu được giao |
| Forms | respondent | Trả lời form được giao, xem phiếu của mình |
| Forms | reviewer | Xem phiếu trong form/đơn vị được cấp |
| Forms | analyst | Tổng hợp/export trong phạm vi riêng được cấp |
| LMS | learner | Khóa học/kết quả của chính mình |
| LMS | instructor | Chỉ là vai trò mục tiêu; chưa thấy triển khai trong source khảo sát |
| LMS | training_manager | Nhóm học viên/đơn vị được cấp |
| LMS | app_admin | Cấu hình LMS trong phạm vi được cấp |

LMS hiện khai báo learner/admin/manager; API admin đã đọc yêu cầu admin, chưa thấy phân quyền training_manager riêng ở đó. Cần mapping cụ thể, không đổi tên manager thành admin để vượt qua guard.

## Scope và quyền quản trị

- Scope là dữ liệu có cấu trúc, không phải chuỗi SQL/JavaScript do người dùng nhập.
- Cây tổ chức có hiệu lực thời gian; quyền theo descendants phải được định nghĩa rõ có bao gồm đơn vị mới hay không.
- Admin chỉ cấp quyền nằm trong tập có thể ủy quyền; không tự nâng quyền hoặc gán role bảo vệ.
- Khi một grant bị thu hồi, mọi binding của app đó không còn hiệu lực cho request mới.
- Role ứng dụng này không được suy diễn thành role cùng tên của ứng dụng khác.
- Chính sách deny/khóa account có ưu tiên cao hơn allow.
- Permission kiểm tra online/cache theo mục tiêu trong [thiết kế SSO](IAM_SSO_INTEGRATION.md).
- Token không chứa toàn bộ quyền dài hạn. Backend resolve phiên bản policy hiện hành.
- Khách hàng/đối tác chưa thuộc MVP; dữ liệu tương lai phải scope theo membership và đối tượng cụ thể.

## Hợp đồng đề xuất

Foundation cung cấp read API cho actor hiện tại: hồ sơ tối thiểu, org memberships, ứng dụng được cấp và effective permissions theo app/scope. Client nghiệp vụ không được đọc toàn bộ quyền của người khác.

API quản trị có action tách biệt create/update/grant/revoke và optimistic concurrency. App gọi API với client credential/scope riêng khi cần; không phát credential chung cho tất cả ứng dụng.

Trong local hiện tại, /api/v1/manage/grants và hai alias /api/v1/access/grants, /revoke dùng chung GovernanceService, revision, idempotency receipt và audit before/after. Alias cũng bắt buộc expectedRevision/Idempotency-Key; không tự xóa validUntil khi cấp lại nếu caller không yêu cầu. Danh mục ứng dụng thử bổ sung được cấp quyền tường minh, không nhận blanket grants từ db:setup. [Hướng dẫn local](LOCAL_DEVELOPMENT.md).

Response nên chứa policyVersion, evaluatedAt và expiresAt. Lỗi xác thực trả 401; đã xác thực nhưng không được phép trả 403 hoặc 404 khi cần giấu tồn tại đối tượng.

## Ma trận test âm tối thiểu

| Kịch bản | Kết quả mong đợi |
| --- | --- |
| Có SSO nhưng thiếu ApplicationGrant | Không vào được API app |
| Designer gọi publish không có permission | Từ chối |
| Respondent đọc phiếu của người khác | Từ chối |
| Analyst export ngoài form/đơn vị được giao | Từ chối |
| Learner sửa kết quả hoặc gọi API admin LMS | Từ chối |
| Quản lý đơn vị A đọc kết quả đơn vị B | Từ chối |
| Sửa tenantId trong body/header | Không thay quyền thực tế |
| Đổi chức danh, không cấp role | Không có quyền mới |
| Thu hồi role khi đang mở trang | API từ chối trong mục tiêu thu hồi |
| Access service lỗi/cache hết hạn | Không cấp quyền bằng dữ liệu stale |
