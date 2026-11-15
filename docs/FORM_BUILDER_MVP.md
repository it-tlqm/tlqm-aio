# AIO Forms — Form Builder MVP

Ngày: 09/11/2026. Trạng thái: **đã đạt baseline MVP local**; [đối chiếu nghiệm thu](FORMS_ACCEPTANCE.md) ghi bằng chứng và giới hạn. Chưa production.

## Mục tiêu giai đoạn đầu

Cho phép người được cấp quyền tự tạo biểu mẫu nội bộ, xuất bản cho nhóm nhân viên, thu thập phiếu và tổng hợp kết quả bằng cùng danh tính AIO. Kịch bản đề xuất đầu tiên: khảo sát hiện trạng số hóa theo phòng ban.

Form Builder và tích hợp LMS là hai ưu tiên ứng dụng sau Foundation; LIMS để sau. Forms không chờ các phân hệ nghiệp vụ BOS hoàn thiện.

## Phạm vi MVP đề xuất

| Nhóm | Có trong MVP |
| --- | --- |
| Thiết kế | Tạo form, section, thêm/sắp xếp field, label, mô tả và preview |
| Loại field | Text ngắn/dài, số, ngày, một lựa chọn, nhiều lựa chọn, yes/no |
| Validation | Bắt buộc, giới hạn độ dài/khoảng số, kiểu dữ liệu; kiểm tra lại phía server |
| Điều kiện | Hiện/ẩn và required-if bằng tập operator hữu hạn; không chạy JavaScript tùy ý |
| Phiên bản | Draft, publish phiên bản bất biến, tạo draft mới, close/archive |
| Phân phối | Giao form cho đơn vị/nhóm/người; login SSO nội bộ |
| Phiếu | Lưu nháp, gửi, đọc lại, trạng thái rõ; mặc định không sửa phiếu đã gửi |
| Quản trị | Phân biệt designer, publisher, respondent, reviewer, analyst |
| Báo cáo | Danh sách, số đã gửi theo đơn vị, tổng hợp câu hỏi và export CSV theo quyền |
| Audit | Ai tạo/sửa/publish/close, ai gửi và ai export |

Đã có DSL/storage/service/API, client SSO Forms, role fixtures và UI shadcn trong Master Project. Domain/HTTP/UI và full gate local đã pass. Module [Quy trình](WORKFLOWS_ACCEPTANCE.md) mới tái sử dụng schema/interpreter/designer/renderer như thư viện code, giữ dữ liệu trong database riêng; không đổi trạng thái hoặc lịch sử phiếu Forms đã gửi. Xem [runbook và giới hạn](FORMS_LOCAL_DEVELOPMENT.md), [tiến độ](../roadmap/FORMS_LMS_PROGRESS.md).

Ngoài MVP: public anonymous forms, chữ ký số, thanh toán, upload file, công thức chạy code, workflow duyệt nhiều cấp, marketing automation, dashboard BI và AI tự sinh quy trình. Nếu bổ sung upload về sau cần quy định storage, loại/kích thước file và quyền tải riêng.

## Mô hình dữ liệu logic

| Đối tượng | Nội dung và bất biến |
| --- | --- |
| Form | formId, tenant/workspace, owner, code, trạng thái |
| FormVersion | versionId, formId, version, schema, publishedAt/by, checksum; bất biến sau publish |
| FormAudience | Người/đơn vị/nhóm được giao, cửa sổ thời gian, quy tắc một/nhiều phiếu |
| Submission | submissionId, formId, versionId, actorPersonId, scope, trạng thái, timestamps |
| SubmissionAnswer | fieldId ổn định, giá trị có kiểu, gắn submission/version |
| SubmissionAudit | Actor, action, correlation/idempotency ID, thời gian, lý do |
| FormAccess | Role binding/permission theo form hoặc workspace, tham chiếu AIO Access |

Không nhét schema biểu mẫu vào Directory. Không lưu đáp án khảo sát trong Keycloak. Không dùng tên hiển thị field làm khóa dữ liệu.

## Quy tắc version và gửi phiếu

1. Chỉ publish draft vượt qua validation schema; fieldId duy nhất, không có vòng lặp điều kiện.
2. Phiếu luôn gắn versionId cụ thể. Xuất bản v2 không thay cách đọc đáp án v1.
3. Draft phiếu đang ở v1 tiếp tục theo v1 trong cửa sổ cho phép. Không tự remap sang v2; nếu phiên bản cũ bị đóng thì báo rõ và yêu cầu tạo phiếu mới.
4. Server kiểm tra audience, thời hạn, quyền, version, field whitelist, kiểu và điều kiện trước khi gửi.
5. Trường ẩn do điều kiện không được lén nhận dữ liệu từ client; server loại hoặc từ chối nhất quán theo hợp đồng.
6. Submit có idempotency key và ràng buộc số phiếu; gửi lại do mạng không tạo bản trùng.
7. Close form chặn gửi mới; giữ nguyên lịch sử để đọc trong scope được cấp.
8. CSV export bảo vệ công thức bảng tính và chỉ lấy trường/phiếu actor được phép đọc.
9. Nhãn/mô tả được escape/sanitize; không lưu HTML/biểu thức thực thi tùy ý.
10. MVP là khảo sát có đăng nhập và định danh. Không gắn nhãn “ẩn danh” khi vẫn lưu actor hoặc có thể truy ngược người trả lời.

## Đánh giá tái sử dụng BOS

**Đã kiểm chứng trong source**, chưa chạy runtime:

- backend có form-schema-registry với controller/service/contracts và các lệnh quản lý version;
- schema Prisma có FormSchemaDefinition (dòng 6957), FormSchemaVersion (6986), FormSchemaEvent (7061), FormSchemaCommandReceipt (7085);
- endpoint tạo version có ràng buộc đến published EntityVersion;
- frontend có MetadataFormRuntime và FormPresentationDesigner;
- controller dùng JwtAuthGuard/PermissionsGuard; service truy vấn theo tenant và quyền.

Nguồn gốc: `D:/thanhnx/OpenCode/BOS/bos-workspace`. Đây là thành phần gắn với EntityVersion, Prisma, auth và tenant BOS; chưa thể coi là package standalone.

| Phương án | Đánh giá | Điều kiện quyết định |
| --- | --- | --- |
| Dùng nguyên module trong BOS qua adapter | Tận dụng vận hành sẵn có nhưng phụ thuộc lịch release/auth BOS | Cần API rõ, quyền đúng, không mở toàn BOS để dùng Forms |
| Tách thành package | Có thể dùng renderer/designer chung | Đo dependencies, license, entrypoints, test và ownership trước |
| Xây module Forms tối thiểu theo hợp đồng riêng | Chủ động phạm vi MVP và version contract | Có chi phí triển khai; chỉ tái sử dụng phần đã chứng minh tách được |

**Quyết định sau spike source:** module Forms riêng, không copy code BOS. Dependencies Nest/Prisma/governance/EntityVersion và Ant Design không phù hợp module khảo sát shadcn tối thiểu. Bằng chứng revision/dirty và quyết định tại [ADR 0003](decisions/0003-forms-isolated-module.md).

## Nghiệm thu nghiệp vụ

Người quản trị tạo khảo sát 10 câu, gồm một section và một điều kiện hiển thị; preview desktop/mobile; publish v1 và giao cho hai đơn vị giả lập. Người có quyền gửi một phiếu; gửi lặp không tạo bản trùng. Người ngoài audience bị từ chối dù biết URL.

Xuất bản v2 sau khi đã có phiếu v1; phiếu cũ vẫn hiển thị đúng schema. Reviewer đơn vị A không đọc/export phiếu đơn vị B. Analyst tổng hợp đúng số phiếu trong scope. Designer thiếu publish permission không xuất bản được. Thu hồi quyền có hiệu lực trên tab đang mở.

Bộ test phải có API gọi trực tiếp, sửa payload/fieldId/tenantId, version đóng và lỗi retry, không chỉ kiểm tra nút trên UI.
