# Forms local — triển khai và giới hạn hiện tại

Ngày 10/11/2026. Forms MVP local đã nghiệm thu; goal tiếp tục LMS sandbox. Foundation đã có [acceptance riêng](FOUNDATION_ACCEPTANCE.md).

## Database và chạy kiểm tra

Sau các bước Foundation local trong [LOCAL_DEVELOPMENT](LOCAL_DEVELOPMENT.md):

~~~powershell
npm run forms:setup
npm run local:client -- infrastructure/local/clients/aio-forms.json provision
npm run forms:fixtures
npm run check
npm run test:forms-api
npm run test:forms-ui
npm run test:forms-onboarding
~~~

Script chỉ dùng PostgreSQL AIO tại 127.0.0.1:5438 sau kiểm Docker context/container, database Foundation và marker. Tạo aio_forms/aio_forms_test, owner aio_forms_owner, runtime aio_forms_runtime. Chúng có marker instance/purpose riêng, không dùng tables/dữ liệu của Identity; hai role Forms bị từ chối CONNECT vào aio_foundation/aio_foundation_test, aio_runtime không CONNECT vào Forms.

Credentials mới nằm trong .local/forms.json, chỉ chương trình tiêu thụ, không in/commit. Setup lần hai giữ nguyên credential và dữ liệu; role/database tồn tại không đúng owner/instance marker bị từ chối. Không xóa volume/database để khắc phục lỗi. Migrations riêng trong infrastructure/forms có checksum; **001–003 đã áp dụng và bất biến**. Foundation 001–005 giữ nguyên.

forms:setup chỉ dựng storage. Client Forms dùng manifest v2 tại 4103, kind application; onboarding không gán probe role/grant. forms:fixtures tạo năm identity giả lập, hai người thiết kế/xuất bản có MFA, cấp các role và scope rõ ràng qua GovernanceService. Mọi script MFA/E2E/fixture chạy tuần tự. Các API /api/v1/forms đã qua test HTTP với OIDC thật; UI 10 câu đã pass vòng cuối sau phân trang/lịch sử, 13 axe scans zero violations; [nghiệm thu](FORMS_ACCEPTANCE.md).

Forms fixture credentials/creation receipts nằm trong .local/forms-fixtures.json; OTP dùng .local/mfa.json, không in hoặc chụp. Keycloak user profile local khai báo riêng aio.local.instance và aio.local.fixture với view/edit chỉ admin, không mở unmanaged attributes. Subject từ POST Location được lưu rồi kiểm đúng identity/marker; username/email không dùng để tự nối account. Chưa sửa source LMS/BOS.

## Hợp đồng đã triển khai

- Schema data v1 gồm bảy loại field, section, min/max, lựa chọn ID ổn định và visibleWhen/requiredWhen. Giới hạn 64 KiB input schema, 100 field, 20 section, tối đa 50 option/field. Tập operator hữu hạn, không nesting/executable code/regex tùy ý; kiểm kiểu operand, reference và graph không chu kỳ. Không đưa schema vào Fastify/Ajv compiler.
- Draft schema thuộc Forms; publish tạo version/checksum bất biến. V2 không đổi v1. Chỉ draft phiếu đã tồn tại được gửi theo v1; phiếu mới phải chọn version hiện hành. Có close version/form và archive giữ lịch sử.
- Audience theo account/đơn vị/nhóm Forms và cửa sổ thời gian. Server kiểm live permission, membership và đơn vị actor chọn; callback Directory chỉ xác minh reference, Forms không truy cập DB định danh.
- Năm role nghiệp vụ ánh xạ sáu permission: design, publish, respond, review, analyze, export. Designer không tự publish/đọc phiếu; reviewer không tự export. Role theo workspace/đơn vị; chưa có trình cấp role theo từng form.
- Phiếu draft/submitted/cancelled; chỉ draft sửa được, không đổi actor/version/unit. Hủy draft giữ lịch sử và mở đường cho draft mới khi phiên bản cũ đóng. Giới hạn một phiếu đã gửi mặc định, có thể 1–100/form/account; bộ đếm và mutation chạy trong transaction có khóa tenant, revision và receipt idempotency.
- Audit/receipt nguyên tử với mutation. Audit phiếu chỉ giữ checksum và metadata, không sao chép đáp án. Recheck access trước commit; khi audit lỗi hoặc quyền bị thu hồi, dữ liệu/receipt rollback.
- Reviewer lọc đơn vị; báo cáo theo từng version, tổng theo đơn vị và số/choice/boolean/date. Text chỉ thống kê số đã trả lời. Report/export tối đa 10.000 phiếu đã lọc scope mỗi request; vượt giới hạn trả lỗi, không âm thầm cắt số liệu. Danh sách form và phiếu có keyset pagination 100 dòng/lượt tại /pages và /submissions/page; UI có tải thêm, cursor không thay thế kiểm scope. Own-history giữ schema từng version sau hết audience và không mở quyền gửi mới. Danh sách nhóm và lookup tài khoản hiện giới hạn tương ứng 200/500, dành cho fixture local; chưa có tìm kiếm server cho hai lookup này.

## CSV

Mỗi lần download kiểm scope hiện hành và có audit, không cache đáp án/CSV trong receipt để tránh replay sau khi thu hẹp quyền. Chỉ export một version mỗi lần để header/schema nhất quán.

CSV có UTF-8 BOM, CRLF, mọi cell được quote và escape dấu quote. Chuỗi có dấu bắt đầu công thức (kể cả full-width và control/format prefix) được thêm **text: ** hiển thị rõ; số có kiểu number được xuất là số. Đây là biến đổi có chủ đích ở bản xuất, đáp án gốc giữ nguyên. Chọn prefix văn bản rõ ràng để tránh phụ thuộc việc spreadsheet giữ apostrophe khi lưu/mở lại; [OWASP CSV Injection](https://community.owasp.org/attacks/CSV_Injection) nêu rủi ro của các cách escape phụ thuộc ứng dụng. Chưa kiểm thử UI Microsoft Excel/LibreOffice thực tế; không coi unit test encoder là bằng chứng cho mọi spreadsheet consumer.

## Bằng chứng hiện tại

21 test contracts/reporting/service đã pass: kiểu dữ liệu/ngày/cycle/unknown keys/hidden fields, phạm vi role/tenant/đơn vị, publish v1→v2, immutable DB trigger/runtime grants, concurrency/idempotency, audit rollback, thu hồi quyền trước commit, audience/group/window, hủy draft, closed/archive, scoped report/CSV và không lộ đáp án trong audit.

Đây là kiểm thử domain + PostgreSQL thật với actor giả lập tại boundary. test:forms-api đã pass SSO/MFA, role/scope/CSRF/hidden fields, retry, scoped report/CSV và revoke trên phiên đang mở (134 ms ở lượt 2026-11-09T18:58:26Z). UI đã đạt gate local theo [FORMS_ACCEPTANCE](FORMS_ACCEPTANCE.md); tiêu chí gốc tại [FORM_BUILDER_MVP](FORM_BUILDER_MVP.md). Quyết định tách module: [ADR 0003](decisions/0003-forms-isolated-module.md).

Onboarding rehearsal Forms dùng cùng scripts/client-rehearsal.ts với mode forms. Chạy lại provision/fixture/setup khi grant, respondent role và binding đã bị thu hồi phải giữ nguyên trạng thái đó; application disabled không tự active. Kết thúc test khôi phục fixture đã xác minh active ở preflight bằng governance có audit. Nếu bị ngắt sau khi revoke, kiểm tra trạng thái và dùng `npm run test:forms-onboarding -- restore` để khôi phục đúng fixture local; không xóa DB/volume/receipts.
