# AIO Quy trình — Chạy local

Ngày 11/11/2026. Module Quy trình được yêu cầu theo AMIS, có tái sử dụng BOS. Module đang phát triển và nghiệm thu local; chưa phải toàn bộ tính năng AMIS hoặc triển khai production. [Quyết định và nguồn BOS](decisions/0005-workflows-bos-reuse.md).

## Khởi tạo

Đọc [LOCAL_DEVELOPMENT](LOCAL_DEVELOPMENT.md), giữ đúng Docker context local/project tlqm-aio-local. Foundation và Forms fixtures cần đã có vì bản này dùng lại các identity giả lập, không tạo tài khoản hoặc mật khẩu thứ hai cho cùng người.

~~~powershell
npm run workflows:setup
npm run local:client -- infrastructure/local/clients/aio-workflows.json provision
npm run workflows:fixtures
npm run build
npm run workflows:demo
npm run dev
~~~

AIO Quy trình ở http://127.0.0.1:4105, Portal 4100; dùng cùng Keycloak với client/audience/cookie riêng. Được liệt kê trong Portal nếu có grant. Ctrl+C dừng API dev. Không khởi chạy BOS hoặc LMS hiện hữu. workflows:demo chạy khi cổng 4105 trống, tạo/phát hành mẫu mua sắm local bằng proof MFA designer/publisher thật; chạy lại giữ mẫu đã có, không ghi đè draft/version/trạng thái đã được người dùng đổi. Receipt .local/workflows-demo.json giữ ownership mẫu; lỗi hoặc receipt không khớp thì từ chối.

Database aio_workflows/aio_workflows_test, owner aio_workflows_owner, runtime aio_workflows_runtime. Config nằm trong ignored .local/workflows.json. Scripts giữ credentials khi chạy lại, kiểm host/port/db/role/instance/purpose/checksum. Migrations Workflows 001–020 đã áp dụng local/test và được giữ bất biến. Số tiếp theo là 021. [Trao đổi và bàn làm việc](WORKFLOWS_COLLABORATION.md), [Liên kết, lịch, mẫu đầu ra và chuyển đề nghị](WORKFLOWS_AUTOMATION.md).

[Báo cáo hiệu quả](WORKFLOWS_REPORTS.md) đọc dữ liệu lịch sử sẵn có theo quyền báo cáo hoặc điều phối. Dùng `npm run test:suite-regression -- w5-performance-report` sau khi dừng dev để kiểm API, thống kê, SSO, CSV và chia sẻ theo quyền. Suite `w5-custom-report` kiểm thêm bộ chọn trường, dữ liệu từng vòng và quyền trường. Hai báo cáo dùng các bảng hiện có.

[Lịch sử và khôi phục phiên bản](WORKFLOWS_VERSION_HISTORY.md) dùng snapshot và audit sẵn có. Suite `w5-version-history` kiểm quyền phát hành, so sánh, khôi phục thành phiên bản mới, hồ sơ đang chạy và hồi quy báo cáo theo trường.

[Kho tài liệu Quy trình](WORKFLOWS_DOCUMENT_LIBRARY.md) dùng Workflows 020. Khi cập nhật bản local cũ, dừng dev rồi chạy `npm run workflows:setup`. Suite `w5-document-library` kiểm thư mục, soạn thảo, phát hành, tải tệp theo quyền và liên kết từ hồ sơ.

## Tài khoản giả lập và quyền

| Identity đã có | Quyền Quy trình mới |
| --- | --- |
| forms.designer | Thiết kế, theo dõi hồ sơ được chia sẻ tại đơn vị A; MFA |
| forms.publisher | Phát hành, điều phối và báo cáo; MFA |
| demo.learner | Khởi tạo tại đơn vị công tác có hiệu lực |
| forms.respondent | Khởi tạo tại đơn vị C khi quy trình cho phép |
| forms.reviewer | Xử lý nhiệm vụ được giao trong đơn vị A |
| forms.analyst | Xử lý nhiệm vụ được giao, không mặc nhiên có quản trị |
| workflows.admin | Quản trị dùng thử riêng: thiết kế, phát hành, quản lý nhóm/điều phối và báo cáo; đổi mật khẩu ban đầu, tự đăng ký MFA |

Tài khoản quản trị dùng thử được tạo theo yêu cầu ngày 10/11/2026 bằng `npm run workflows:review-admin`. Chỉ database `aio_foundation` local, tenant A, app `aio-workflows`; không có quyền quản trị IAM/Keycloak/ứng dụng khác, không thay tài khoản designer/publisher dùng trong kiểm thử. Script xác minh operator bằng MFA thật, gắn issuer/subject theo receipt tạo Keycloak, ghi audit và cấp ba role có sẵn qua GovernanceService. Rerun giữ mật khẩu đã đổi, MFA và quyền đã thu hồi; không tự mở lại tài khoản. Credentials/receipt nằm trong ignored `.local/workflows-admin.json`, không in vào chat/log/Git.

Người dùng mở file trên máy, lấy trường `password` để đăng nhập `workflows.admin` tại http://127.0.0.1:4105/auth/login?reauth=1. Lần đầu đổi mật khẩu và quét QR đăng ký ứng dụng xác thực của mình. Nếu sau đăng ký OTP ứng dụng yêu cầu xác thực lại, bấm Đăng nhập SSO và dùng mật khẩu mới cùng OTP để có đủ proof pwd+otp. Mật khẩu trong file chỉ là mật khẩu ban đầu, script không cập nhật hoặc đặt lại mật khẩu do người dùng chọn. Agent đã kiểm tra mật khẩu ban đầu được chấp nhận và chưa có session ứng dụng trước khi hoàn tất onboarding; việc đăng ký MFA và đăng nhập hoàn chỉnh của tài khoản này do người dùng thực hiện.

Quyền theo app code aio-workflows, không phát sinh từ chức danh hoặc role Forms. Thao tác thực tế cần account/person/app grant/role binding/scope còn hiệu lực. Designer không tự phát hành; có quyền xử lý chưa đủ để xử lý nhiệm vụ của người khác. Người khởi tạo không tự phê duyệt bằng cùng account hoặc account khác của cùng person. Điều phối viên có thể phân công lại cho người đủ quyền, có lý do/audit; không được gán phê duyệt về chính người đề nghị.

workflows:fixtures chỉ tạo grant/binding/catalog/role còn thiếu. Không hồi các bản ghi đã bị thu hồi. Mật khẩu/OTP nằm trong các file .local hiện có và chỉ chương trình tiêu thụ; không log/chụp màn hình IdP. .local/workflows-fixtures.json chỉ ghi receipt ID/role, không thêm credentials.

Nâng cấp [nhóm/người xử lý động](WORKFLOWS_ASSIGNMENTS.md): quản lý nhóm dùng workflows:manage với MFA; gán theo nhóm hoặc actor của bước trước dùng WorkflowSpec v2. V1 vẫn giữ nguyên. Có thể chạy npm run workflows:demo-assignments khi cổng 4105 trống để tạo mẫu v2 riêng; mẫu v1 cũ không bị đổi. Receipt mới .local/workflows-assignments-demo.json giữ group/definition ownership, chạy lại không hồi nhóm/quyền hoặc ghi đè cấu hình đã sửa.

Với WorkflowSpec v5, designer có thể [chuyển nhánh khi từ chối và chọn người lúc bàn giao](WORKFLOWS_ASSIGNMENTS.md#chuyển-nhánh-khi-từ-chối-và-chọn-người-khi-bàn-giao). Chạy `npm run test:suite-regression -- w2-handoff` sau khi dừng API/LMS dev để kiểm tuần tự các suite Quy trình, hồ sơ nhân sự, nhập/xuất và SSO. Receipt gần nhất nằm ở `.local/evidence/configurable-w2-handoff-regression.json`.

[Trả về bước đã xử lý](WORKFLOWS_ASSIGNMENTS.md#trả-về-bước-đã-xử-lý) cần Workflows 008. Chạy `npm run workflows:setup` khi API dev đã dừng, sau đó chạy hồi quy tuần tự `npm run test:suite-regression -- w2-return`.

[Mở và hợp các nhánh song song](WORKFLOWS_ASSIGNMENTS.md#mở-và-hợp-các-nhánh-song-song) cần Workflows 009. Khi API/LMS dev đã dừng, chạy `npm run workflows:setup` rồi `npm run test:suite-regression -- w2-parallel`. Mở lại API/LMS sau kiểm thử và kiểm readiness cổng 4100–4105.

[Thu hồi hồ sơ và bước đã chuyển](WORKFLOWS_ASSIGNMENTS.md#thu-hồi-hồ-sơ-và-bước-đã-chuyển) cần Workflows 010. Dừng API/LMS dev, chạy `npm run workflows:setup`, sau đó chạy `npm run test:suite-regression -- w2-recall`.

[Tệp đính kèm](WORKFLOWS_BUSINESS_FORMS.md#tệp-đính-kèm) cần Workflows 011. Dừng API/LMS dev, chạy `npm run workflows:setup` rồi `npm run test:suite-regression -- w1-attachments`. Chỉ dùng chứng từ giả lập ở local và test.

## Thử một quy trình

1. Designer chọn Tạo quy trình → mẫu Đề nghị mua sắm. Chọn đơn vị quản lý/được khởi chạy.
2. Trên sơ đồ, chọn bước hoặc dùng ô “Bước đang cấu hình”. Chọn người xử lý: reviewer cho trưởng bộ phận, analyst cho duyệt hạn mức và thực hiện. Có thể kéo bước, nối điểm hoặc chọn bước đích bằng controls.
3. Biểu mẫu khởi tạo và biểu mẫu tại từng bước dùng bộ thiết kế/renderer AIO Forms. Khác ứng dụng về dữ liệu, chỉ dùng chung code thuần.
4. Lưu bản nháp. Publisher xem và phát hành; version bất biến. Ngừng phát hành chặn lượt mới, giữ lượt đang chạy.
5. Learner khởi chạy, điền đề nghị. Giá trị dưới 10 triệu bỏ bước duyệt hạn mức; từ 10 triệu đi qua bước đó theo mẫu. Đây là cấu hình mẫu giả lập, không phải quy định tài chính của công ty.
6. Người được giao vào Cần xử lý. Bước phê duyệt có Phê duyệt/Từ chối/Trả về; bước thực hiện có Hoàn tất/Trả về. Các hành động cần ý kiến tối thiểu 5 ký tự. Thời hạn quá hạn vẫn cho xử lý, không tự duyệt hay tự từ chối.
7. Trả về đưa hồ sơ về người khởi tạo để bổ sung/gửi lại. Vòng xử lý mới vẫn dùng version ban đầu; dữ liệu và quyết định vòng trước giữ trong lịch sử. Hủy lượt chạy dừng nhiệm vụ đang chờ và giữ lịch sử.

Để thử quyền trường theo bước, mở **Thiết kế → Quyền dữ liệu**, chọn bước và đặt một trường thành **Chỉ xem** và một trường khác thành **Bắt buộc điền**. Sau khi phát hành và gửi đề nghị, đăng nhập với người được giao để sửa trường bắt buộc. Đối chiếu giá trị đã sửa trong **Lịch sử** và giá trị ban đầu trong **Hồ sơ**. [Chi tiết cấu hình](WORKFLOWS_BUSINESS_FORMS.md#dữ-liệu-khởi-tạo-tại-từng-bước).

## Hợp đồng dữ liệu và quyền

Definitions/draft → published versions → runs → tasks/results. Graph Start/Approval/Task/Condition/End, tối đa 30 node, có nhánh đúng/sai và chặn cycle/unreachable/target hỏng. Điều kiện là dữ liệu qua engine BOS đã trích, không eval/schema compiler. Các điều kiện biểu mẫu vẫn theo hợp đồng Forms. UI và engine hỗ trợ nhóm VÀ/HOẶC, tối đa 4 cấp/20 điều kiện; chỉnh một dòng không làm mất các điều kiện khác. Giá trị chọn/boolean/date có controls tương ứng, danh sách giá trị là dữ liệu chứ không phải biểu thức chạy code.

Backend Workflows chỉ dùng database riêng. Foundation-owned boundary trả actor/units/candidates; kiểm assignee bằng app grant và workflows:act hiện hành. Không nối hoặc truy cập database BOS/Identity từ domain. Biên bản hành động, audit và idempotency receipt cùng transaction; actor/quyền được kiểm lại sau khi chờ khóa và trước commit. Không xử lý hai quyết định trên cùng task, không tạo nhiệm vụ kế tiếp khi audit lỗi.

Lượt chạy ghim version. Dữ liệu đầu vào từng vòng và kết quả bước được ghi bổ sung vào lịch sử. Audit chứa metadata, checksum và lý do. Quyền đọc hồ sơ đến từ vai trò và đơn vị hiện hành. Với bản v5 có quyền trường, API áp dụng thêm chính sách của trường vào nội dung, lịch sử và kết quả. [Quyền trường và nháp hồ sơ](WORKFLOWS_BUSINESS_FORMS.md).

API prefix /api/v1/workflows: GET /definitions, /runs, /runs/:id, /report, /lookups; POST definitions và bản nháp, publish/status, runs, tasks/:id/action/reassign, runs/:id/resubmit/cancel. Fixed envelopes Fastify được biên dịch; workflow/form schema được diễn giải như dữ liệu. Cookie mutations cần CSRF/Origin, Idempotency-Key, reason và expectedRevision phù hợp. Quyền backend quyết định, menu chỉ hỗ trợ thao tác.

## Kiểm thử và rollback

Dừng API dev, giữ Docker local và chạy tuần tự:

~~~powershell
npm run check
npm run test:workflows
npm run test:workflows-assignments
npm run test:workflows-onboarding
npm run test:e2e
npm run test:forms-api
npm run test:forms-ui
npm run test:lms
~~~

Không chạy đồng thời với MFA/onboarding/resilience vì chia sẻ realm, OTP và database test. test:workflows dùng A và Workflows (4100/4105), Chromium, dữ liệu giả lập; không ghi cookie/token hoặc màn hình credential. test:workflows-onboarding thu hồi grant/binding test rồi rerun setup/fixtures; chỉ explicit restoration có audit mới phục hồi trạng thái trước test.

Rollback nghiệp vụ: ngừng phát hành một quy trình để chặn hồ sơ mới; lượt cũ tiếp tục version gốc. Khi cần dừng toàn ứng dụng, local:client manifest aio-workflows mode disable tắt registry/IdP và thu hồi BFF sessions, giữ DB. Activate là bước rõ ràng, không hồi grant/binding đã thu hồi. Không xóa volume, lịch sử hoặc downgrade migration để rollback.

## Giới hạn cần giữ rõ

Đợt W1 thêm [bảng chi tiết, quyền đọc trường và nháp hồ sơ](WORKFLOWS_BUSINESS_FORMS.md), WorkflowSpec v5 và migration **Workflows 007** đã áp dụng local/test. Các phiên bản 1–4 giữ nguyên. Trạng thái nghiệm thu mới ở [goal Quy trình](../roadmap/GOAL_WORKFLOWS_COMPLETE.md); không suy kết quả của W1 từ receipt bản đầu.

Quy trình hỗ trợ nhóm xử lý, chọn người khi gửi và bàn giao, quản lý trực tiếp/trưởng đơn vị, đồng duyệt all/any/quorum, nhánh song song, deadline theo lịch làm việc và nhắc hạn. Biểu mẫu hỗ trợ bảng, số tiền thập phân cố định và tệp đính kèm theo quyền. Tự động hóa hỗ trợ tạo nháp liên kết, tạo nháp theo lịch, mẫu in HTML và email giả lập local. Báo cáo hiện tại đếm trạng thái/quá hạn, còn Trung tâm công việc tổng hợp tồn theo người và đơn vị. [Đối chiếu AMIS](WORKFLOWS_AMIS_GAP_ANALYSIS.md) ghi phạm vi tham chiếu. [Goal Quy trình](../roadmap/GOAL_WORKFLOWS_COMPLETE.md) ghi trạng thái nghiệm thu và phần còn mở.

Không migrate definition/instance/task thật của BOS. Source adaptation và đối chiếu AMIS ghi trong ADR; các hình ảnh/code thương hiệu MISA không được đưa vào app. UI giữ shadcn, Be Vietnam Pro local và palette TLQM.

## Tham chiếu cơ cấu AIO

[Nhân sự/đơn vị trong biểu mẫu W1b](WORKFLOWS_DIRECTORY_FIELDS.md) bổ sung trường tham chiếu trên schema v5/v2 hiện có, không migration hay seed mới. Dùng `test:workflows-business` để kiểm cả bảng/nháp và lựa chọn danh bạ; chạy tuần tự với các suite SSO/DB. Phạm vi và kết quả cuối ở tài liệu và goal liên kết.
