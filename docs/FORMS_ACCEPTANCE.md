# Nghiệm thu AIO Forms MVP local

Ngày 10/11/2026, timestamps UTC. **Đạt baseline Forms MVP local** sau vòng kiểm chứng cuối gồm phân trang/lịch sử. Goal Forms/LMS vẫn active để tiếp tục adapter LMS sandbox. Tiêu chí gốc: [FORM_BUILDER_MVP](FORM_BUILDER_MVP.md).

## Phạm vi và ranh giới

Nhánh feat/foundation-mvp, HEAD baseline abea705b0937fe164fa9c983700089bec88c82ba với worktree dirty. Foundation đã có [nghiệm thu riêng](FOUNDATION_ACCEPTANCE.md); Forms là phần triển khai mới chưa commit/push. Không sửa source/database/auth BOS/LMS/YMS, không deploy hoặc tác động production.

Node quan sát 24.20.0; Fastify + React/Vite/Tailwind v4/shadcn, Be Vietnam Pro local, palette TLQM. Forms có chunk tải riêng khoảng 62 kB minified theo Vite tại lượt build hiện tại. Đây là kích thước artifact, không là số đo RAM hoặc SLA.

Client aio-forms tại loopback 4103, realm aio-local, audience aio-forms-api. Database aio_forms/aio_forms_test riêng, migration owner aio_forms_owner và runtime aio_forms_runtime riêng. Cả hai role không CONNECT vào database định danh; aio_runtime không CONNECT Forms. Foundation vận hành BFF xác thực/ủy quyền và trả typed context cho Forms; Forms domain không đọc bảng định danh. [ADR 0003](decisions/0003-forms-isolated-module.md).

## Đối chiếu baseline

| Yêu cầu | Bằng chứng đã có |
| --- | --- |
| Tạo section/câu hỏi, sắp xếp, label/description, preview | UI tạo khảo sát 10 câu, đổi thứ tự, preview desktop 1440/mobile 390 và thao tác bàn phím. Điều hướng cùng trang và tải lại sau người khác publish đã được sửa qua E2E. |
| Bảy loại field và validation server | shortText/longText/number/date/singleChoice/multipleChoice/boolean; constraints, ngày thực, false/zero, option IDs, field whitelist; tests/contracts và HTTP malformed/hidden payload. |
| Conditions hữu hạn, không chạy code/schema compiler | all/any, eq/neq/includes/answered/gt/gte/lt/lte; graph không cycle, đúng kiểu operand và reference. Schema người dùng chỉ là dữ liệu qua interpreter, không đưa vào Fastify compiler. |
| Draft/publish/version/close/archive | Version có checksum, append-only DB trigger và runtime privilege; draft mới không đổi v1; phiếu mới phải dùng latest; draft cũ v1 chỉ tiếp tục khi version còn mở; đóng/archive giữ history. |
| Audience người/đơn vị/nhóm và thời gian | Boundary kiểm reference/assignment đang hiệu lực, Forms kiểm audience/group live, thời hạn và scope. UI giao hai đơn vị, cancel trước write, confirm và nhóm người nhận. |
| Draft/submitted, retry, số phiếu | Save/reload/submit/readback UI; receipt theo actor/tenant/key và hash, khóa transaction, revision; một effect cho retry/concurrency; không sửa submitted. Cancel draft giữ record để có thể tạo phiếu theo phiên bản mới. |
| Designer/publisher/respondent/reviewer/analyst | Permissions tách design/publish/respond/review/analyze/export. Designer/publisher MFA thật. Designer không publish hoặc đọc phiếu; reviewer không mặc nhiên export. Reviewer/analyst đơn vị A không thấy phiếu đơn vị C. |
| Báo cáo và CSV | Tổng theo đơn vị/version/field; số/choice/boolean/date, text chỉ số đã trả lời. CSV riêng từng version, scope hiện hành, audit từng download, không cache đáp án trong receipt. Prefix text: cho chuỗi giống công thức, quote/escape/BOM/CRLF. |
| Audit và quyền hiện hành | Actor/tenant/target/reason/request/time và metadata/checksum; không sao chép answers vào audit. Mutation, receipt, audit cùng transaction; audit fail/quyền bị thu hồi trước commit rollback. Grant/role revoke kiểm trên session đang mở. |
| Giữ lịch sử khi audience thay đổi | Có quyền respond hiện hành vẫn đọc được phiếu mình đã có; không được gửi mới khi audience hết hiệu lực. Chỉ trả schema các version đã dùng, không lộ draft title hoặc version chưa được giao. |
| Phân trang không mở scope | Forms và submissions dùng cursor theo created_at + id, giữ thứ tự khi trùng timestamp; mỗi trang kiểm tenant/quyền/audience. UI tải thêm. Unit test trên hơn 100 record không thiếu/lặp và không đưa phiếu ngoài đơn vị vào page. |
| Setup/onboarding chạy lại | forms:setup đã chạy lại giữ credentials và checksums. Onboarding v2 không seed probe grants. Diễn tập C/Forms sau extension đều pass: disable/setup/fixtures/activation không khôi phục quyền đã thu hồi; fixture được khôi phục có audit. |

## Bộ kiểm tra và artifact

- npm run check cuối: 74 tests, 0 skip, TypeScript strict, Prettier và UI/API build đều pass. Source snapshot 125 file nằm tại .local/evidence/forms-revision.json, SHA-256 manifest 796a67bdd138ab3ba1394f3fd30e251549f5b05b9234afb2a8d75916e9b5c859.
- Foundation test:e2e: ba suite đã pass sau khi nối Forms; identity-lifecycle báo 2026-11-09T18:47:52Z, gồm regression MFA/recovery/renewal/delegation và UI/a11y Foundation.
- test:forms-api: pass lúc 2026-11-09T18:58:26Z, có Portal → Forms SSO cùng browser, MFA và app isolation; grant revoke 134 ms trên phiên đang mở. Số đo local không tải, không là SLA production.
- test:forms-ui: pass lúc 2026-11-09T18:59:00Z, 10 câu/13 scans zero violations, bao gồm field/condition editor, desktop/mobile, draft/submit, scoped report/CSV, v1→v2 và nhóm. Lượt này dùng code có pagination/history mới.
- test:onboarding pass lúc 2026-11-09T18:51:32Z; test:forms-onboarding pass lúc 18:54:32Z, giữ credential và trạng thái quyền qua fixture rerun. Logs “registry preflight failed” tại bước provision trên application disabled là kết quả từ chối mong đợi, chỉ pass khi toàn bộ script kết thúc thành công và khôi phục fixture.

Artifacts bị Git ignore tại .local/evidence: forms-api.json, forms-ui.json, forms-accessibility.json, forms-client-rehearsal.json; ảnh forms-designer-desktop, forms-preview-mobile, forms-response-desktop, forms-submitted-mobile. Đã xem ảnh designer/response/mobile; không có tràn ngang toàn trang, focus rõ và giữ TLQM tokens. CSV nghiệm thu chỉ có câu trả lời giả lập, không chứa credentials.

## Giới hạn được giữ rõ

- Chỉ HTTP loopback/dữ liệu giả lập. Chưa production, HR sync, load test, TLS/secret store/HA/retention Forms hoặc xác minh thiết bị MFA thật.
- Tự động axe A/AA không thay chứng nhận WCAG; incomplete rules được ghi, có kiểm tra focus/keyboard/ảnh bổ sung. CSV chưa kiểm thử UI mọi ứng dụng spreadsheet; tiền tố hiển thị làm thay đổi bản xuất, đáp án gốc giữ nguyên.
- Mỗi schema tối đa 64 KiB, 100 field, 20 section, 50 option/field; report/export tối đa 10.000 phiếu sau lọc scope, vượt giới hạn báo lỗi. Không có anonymous/public form, upload, code/formula tùy ý, ký số hoặc workflow nhiều bước.
- Designer/publisher dùng quyền workspace trong fixture; reviewer/analyst được thu hẹp theo đơn vị. Không có màn hình cấp role riêng từng form. Nhóm Forms không thay đổi chức danh hoặc sinh quyền nền tảng.
- Lookup account tối đa 500, danh sách nhóm tối đa 200 trong bản local; tìm kiếm server cho hai danh mục này còn là phần mở rộng. Forms/submission có phân trang, không bỏ record chỉ vì vượt 100.
- Phiếu có định danh; không gắn nhãn ẩn danh. BFF được Foundation vận hành chung process local; tách service ngoài cần hợp đồng API tương đương, không cấp ứng dụng quyền DB Identity.

Lệnh chạy/khôi phục và secret handling: [FORMS_LOCAL_DEVELOPMENT](FORMS_LOCAL_DEVELOPMENT.md). Sau gate Forms, tiếp tục adapter LMS sandbox; LIMS để sau. Goal chung chỉ complete khi hoàn thành phần LMS đã được cho phép, không lấy Forms pass để thay thế.
