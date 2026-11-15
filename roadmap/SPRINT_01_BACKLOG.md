# Sprint 01 — Foundation và chuẩn bị Forms/LMS

Ngày: 10/11/2026. Trạng thái: **Foundation, Forms MVP và adapter LMS sandbox đã nghiệm thu local**. Chi tiết ở [IMPLEMENTATION_STATUS](../docs/IMPLEMENTATION_STATUS.md). Source/repo LMS hiện hữu vẫn chưa được quản lý phiên bản tại đường dẫn đã khảo sát; không coi toàn bộ việc chuẩn bị pilot/production của Sprint 01 đã xong.

Mục tiêu: có nền tảng xác thực/tổ chức/quyền nhỏ nhưng kiểm chứng được, đồng thời chốt cách xây Form Builder và nối LMS. Không lấy LIMS làm dependency của sprint.

## Backlog ưu tiên

| ID | Hạng mục | Phụ thuộc | Tiêu chí nghiệm thu |
| --- | --- | --- | --- |
| S1-01 | Chốt môi trường test và nguồn chủ | Không | Tài liệu ghi owner, runtime, nguồn identity/tổ chức, version dự kiến, dữ liệu giả lập; xác nhận source/repo LMS; không dùng DB thật |
| S1-02 | PoC AIO Identity | S1-01 | IdP test chạy riêng; client riêng, code/PKCE, MFA admin thử; credentials ngoài repo; không sửa IdP/auth cũ |
| S1-03 | Directory tối thiểu | S1-01 | Hai pháp nhân giả lập, ba đơn vị, một người kiêm nhiệm; ID ổn định; kiểm tra chu kỳ đơn vị và assignment sai pháp nhân |
| S1-04 | Access + Registry tối thiểu | S1-03 | App grant, role binding và scope; mặc định từ chối; admin không tự nâng quyền; cùng người có quyền khác nhau ở Forms/LMS |
| S1-05 | Hai client kiểm chứng SSO | S1-02, S1-04 | Client A/B login bằng một identity; API mỗi client kiểm tra đúng audience/grant; chỉ hiện menu không được coi là đủ |
| S1-06 | Session, revocation và audit | S1-02 đến S1-05 | Thu hồi quyền/khóa account trong mục tiêu 60 giây; thao tác nhạy cảm kiểm tra online; audit có actor, subject, scope, reason; test lỗi IdP/Access |
| S1-07 | Spike tái sử dụng Form Builder BOS | Đọc source, có thể làm song song S1-02 | Dependency map của registry/designer/renderer; bảng so sánh adapter/tách/module nhỏ; kiểm tra ownership; chốt phương án bằng ADR |
| S1-08 | Hợp đồng Form Builder v1 | S1-04, S1-07 | Schema field/condition, version bất biến, audience và submission idempotency; test cases draft/publish/v1→v2/thu hồi quyền; mẫu khảo sát giả lập |
| S1-09 | Spike adapter LMS + mapping | S1-02; source LMS được quản lý phiên bản | Chứng minh thư viện OIDC chạy với Workers/D1 ở sandbox; mapping giữ employees.id; chỉ ra thay đổi session/seed/password schema cần làm |
| S1-10 | Review gate và kế hoạch Sprint 02 | Các mục trên | Evidence test, quyết định còn mở, rủi ro và owner; không ghi pass nếu chỉ đọc code |

S1-07/S1-08 là phần bắt đầu xây dựng thiết kế Form Builder ngay giai đoạn đầu; sản phẩm MVP runtime thuộc Sprint 02A. Nếu sprint có thêm năng lực sau khi Foundation đạt gate, có thể kéo lát cắt Forms đầu tiên bên dưới vào Sprint 01.

## Lát cắt Forms đầu tiên — Sprint 02A

Một designer có quyền tạo form gồm text + choice, preview, publisher publish v1; respondent được giao form đăng nhập SSO và gửi phiếu. Backend lưu versionId + actor/scope, reviewer xem được phiếu trong quyền.

Acceptance: người chưa được giao form bị từ chối; payload sai kiểu/field bị từ chối; submit retry không nhân đôi; v2 không đổi phiếu v1; người có quyền tạo nhưng thiếu publish không xuất bản được. Sau đó bổ sung loại field, conditions, tổng hợp và CSV theo [Form Builder MVP](../docs/FORM_BUILDER_MVP.md).

## Lát cắt LMS đầu tiên — Sprint 02B

Một học viên giả lập có dữ liệu học cũ được mapping vào account AIO; mở LMS từ Portal/Forms qua SSO; vẫn thấy cùng tiến độ và điểm; thiếu grant hoặc bị khóa thì không vào được, kể cả phiên cũ.

Acceptance bổ sung: learner không gọi admin API; người quản lý chỉ truy cập phạm vi được giao; rollback không phục hồi quyền đã thu hồi. Không đổi bài học/chấm điểm trong lát cắt auth.

## Bộ fixture giả lập

- Người A: learner LMS + respondent Forms, đơn vị 1.
- Người B: quản lý đào tạo đơn vị 1 + reviewer một form.
- Người C: designer Forms, chưa có publish permission.
- Người D: publisher Forms, chưa có quyền quản trị Identity.
- Người E: account hợp lệ nhưng chưa cấp ứng dụng.
- Người F: account bị khóa; vẫn có app session cũ để thử revocation.
- Người G: kiêm nhiệm hai đơn vị, scope role không trùng nhau.

Không dùng tên thật, tài khoản production, điểm thi thật hoặc câu trả lời khảo sát thật làm fixture.

## Definition of Done

Code, khi được giao xây, nằm đúng phạm vi source/nhánh được phép; có review diff và kiểm thử liên quan. Bằng chứng gồm môi trường/revision, kết quả thực tế và lỗi còn mở; không chỉ danh sách test dự định chạy.

Các negative tests scope/tenant/token, thu hồi quyền và giữ lịch sử LMS phải có trước pilot. Cấu hình và dữ liệu thử có thể dựng lại; rollback không xóa dữ liệu học/phiếu cũ. Chưa push/deploy khi chưa được phép trong nhiệm vụ tương ứng.

Foundation đã đạt [gate riêng](../docs/FOUNDATION_ACCEPTANCE.md); Forms đã đạt [MVP local](../docs/FORMS_ACCEPTANCE.md). S1-07/08 có ADR và module chạy; S1-09 có adapter Workers/D1 sandbox, mapping/historical fixtures và [bằng chứng](../docs/LMS_ACCEPTANCE.md). Quyền Forms/LMS đã được kiểm thử riêng theo app/unit. Phần còn lại gồm nguồn/repo LMS thật được xác nhận/versioning và các quyết định owner/pilot/production ngoài phạm vi local; không dùng sandbox để tuyên bố những việc đó hoàn thành.
