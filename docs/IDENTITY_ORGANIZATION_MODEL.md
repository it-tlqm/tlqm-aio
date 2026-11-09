# Mô hình định danh và cơ cấu tổ chức

Ngày: 09/11/2026. Trạng thái: **mô hình logic mục tiêu**. Migration local đã hiện thực phần lõi person/account/identity, tenant, đơn vị, chức danh, vị trí, employment và assignment. ExternalOrganization, ReportingLine và quản trị vòng đời đầy đủ chưa triển khai; xem [trạng thái](IMPLEMENTATION_STATUS.md).

## Các đối tượng

| Đối tượng | Trường/quan hệ cốt lõi | Ý nghĩa |
| --- | --- | --- |
| Person | personId, tên, trạng thái | Một người, có thể chưa có tài khoản đăng nhập |
| Account | accountId, personId, trạng thái | Tài khoản do AIO theo dõi; credential ở IdP |
| ExternalIdentity | identityId, issuer, subject, accountId, clientContext khi cần | Liên kết identity đã xác minh; duy nhất issuer + subject |
| LegalEntity | legalEntityId, mã, tên | Pháp nhân |
| OrgUnit | orgUnitId, legalEntityId, parentId, loại | Khối/phòng/ban/đơn vị |
| JobTitle | jobTitleId, mã, tên | Chức danh danh mục |
| Position | positionId, orgUnitId, jobTitleId | Vị trí trong một đơn vị |
| Employment | employmentId, personId, legalEntityId, mã nhân sự, trạng thái, hiệu lực | Quan hệ công tác với pháp nhân |
| Assignment | assignmentId, employmentId, positionId, isPrimary, hiệu lực | Bổ nhiệm chính/kiêm nhiệm |
| ReportingLine | assignmentId, managerAssignmentId, loại, hiệu lực | Quan hệ quản lý trực tiếp/chức năng |
| ExternalOrganization | externalOrgId, loại, tên | Doanh nghiệp khách hàng/đối tác về sau |
| ExternalMembership | personId, externalOrgId, trạng thái, hiệu lực | Quan hệ bên ngoài, không phải employment nội bộ |
| SecurityTenant | tenantId, mã, trạng thái | Ranh giới cách ly dữ liệu; cần mapping rõ với nghiệp vụ |
| LegacyIdentityMap | appId, legacyUserId, accountId, verifiedAt, verifiedBy | Nối user cũ với AIO mà giữ lịch sử |

Account không đồng nghĩa employment. Một người có thể làm việc với hai pháp nhân và có nhiều assignment. Với MVP, ưu tiên một account workforce chính mỗi người; nhiều account hoặc subject khác nhau phải có lý do và liên kết có kiểm chứng.

## Bất biến cần kiểm thử

1. ID nội bộ ổn định; mã nhân sự/email có thể đổi. Mã nhân sự duy nhất trong phạm vi pháp nhân đã định nghĩa.
2. Cây đơn vị không có chu kỳ; không gắn parent khác pháp nhân nếu chưa có quan hệ liên pháp nhân riêng.
3. Position thuộc đơn vị của legal entity tương ứng employment.
4. Một employment có tối đa một assignment chính tại mỗi thời điểm; cho phép nhiều assignment kiêm nhiệm có hiệu lực.
5. Thu hồi/chuyển vị trí giữ lịch sử hiệu lực, không ghi đè mất quá khứ.
6. Vai trò ứng dụng cấp riêng; thăng chức không tự cấp quyền quản trị hệ thống.
7. Tenant không tự động bằng legalEntityId hay externalOrgId. Một workspace có thể phục vụ nhiều pháp nhân nếu chính sách cho phép.
8. Tài khoản bị khóa vẫn giữ dấu vết actor lịch sử; không cascade xóa audit.
9. Tất cả ID từ client được kiểm tra trong scope của actor, kể cả API tra cứu danh mục.
10. Liên kết user legacy phải duy nhất theo app + legacyUserId; một người có thể ánh xạ nhiều user legacy theo tenant khi đã xác minh.

## Ví dụ giả lập

Người NV-DEMO-01 công tác tại pháp nhân A; giữ vị trí chuyên viên đào tạo tại đơn vị HR và kiêm nhiệm tổ chuyển đổi số.

- LMS: learner toàn bộ khóa được giao; training_manager chỉ đối với đơn vị được cấp.
- Forms: respondent cho khảo sát được giao; designer chỉ cho không gian biểu mẫu HR.
- Directory: chỉ đọc danh bạ trong phạm vi cấp.
- Chức danh chuyên viên không mặc nhiên cấp các quyền trên.

## Nguồn chủ và đồng bộ

Chưa xác minh doanh nghiệp đang có HR/AD/Microsoft 365 nào làm nguồn chủ. Trước import phải lập ma trận owner theo thuộc tính: tên, mã nhân viên, đơn vị, trạng thái nghỉ việc và thông tin liên hệ.

PoC dùng dữ liệu giả lập. Nếu Directory nhận từ HR, màn hình AIO không được sửa ngầm trường HR sở hữu. Nếu AIO tạm là nguồn chủ, cần xác định người có quyền sửa và quy trình đối soát.

Các sự kiện đề xuất: PersonUpdated, EmploymentEnded, AssignmentChanged, AccountDisabled. Mỗi consumer lưu phiên bản đã xử lý; không để event đến chậm phục hồi assignment đã thu hồi.

## Đối chiếu source hiện hữu

- BOS có Tenant, Department/DepartmentClosure, User, JobTitle, JobPosition và Role. User đang gắn tenant/department/role; chưa đủ cơ sở dùng nguyên schema làm mô hình nhân sự đa quan hệ của AIO.
- LMS lưu nhân viên, department dạng text và role trong cùng bảng employees. Cần mapping đơn vị sau này, không sửa trực tiếp text thành khóa AIO khi chưa đối soát.
- Bằng chứng và đường dẫn nằm ở [kiểm kê](../inventory/PROJECT_INVENTORY.md) và [hiện trạng LMS](../inventory/LMS_CURRENT_STATE.md).
