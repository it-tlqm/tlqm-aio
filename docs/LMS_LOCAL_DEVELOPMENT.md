# LMS trong AIO — Chạy local và vận hành

Ngày 11/11/2026. LMS trong TLQM AIO có domain đào tạo mới, dùng adapter SSO riêng; chưa kết nối dữ liệu thật của LMS hiện hữu. Chỉ dùng dữ liệu giả lập; source/database/auth tại D:/thanhnx/OpenCode/LMS-TLQM/tlqm-learning-mvp giữ nguyên. Đọc [quy tắc hạ tầng](LOCAL_DEVELOPMENT.md) trước khi chạy.

Journal hiện hành đã áp dụng **LMS 001–010 trên local/test**, giữ bất biến. Migration mới tiếp theo là **011**. Các đoạn mô tả 003–006 phía dưới là lịch sử hình thành chức năng. Bản mới có [chính sách học/thi](LMS_POLICIES.md), [lộ trình/đợt đào tạo](LMS_TRAINING.md), [công việc/nhắc hạn trong Portal](LMS_WORK_CENTER.md), [nhập/xuất cấu hình](CONFIGURATION_TRANSFER.md) và [đề nghị đào tạo từ Quy trình](WORKFLOWS_AUTOMATION.md#chuyển-đề-nghị-đào-tạo-sang-lms).

## Chuẩn bị và mở giao diện

Sau Foundation, Forms fixtures và build:

~~~powershell
npm run local:client -- infrastructure/local/clients/aio-lms-sandbox.json provision
npm run lms:setup
npm run lms:directory
npm run lms:provisioning
npm run build
npm run dev
~~~

Trong terminal thứ hai:

~~~powershell
npm run lms:dev
~~~

Phần **Khóa học & nội dung** có editor/upload/preview và phát hành cho admin MFA: [hướng dẫn media và thiết kế](LMS_MEDIA.md). Trang mặc định **Khóa học** là catalogue được phân cho học viên, có player/checkpoint/ghi chú/bài thi. **Kết quả học tập** giữ bài làm và version đã chấm. **Lịch sử của tôi** riêng là dữ liệu legacy được bảo toàn. [Cách học và chứng nhận](LMS_LEARNING.md).

Admin MFA có thêm **Ngân hàng câu hỏi**, nhập preview XLSX/XLS/CSV, copy vào bản nháp và xuất XLSX. [Runbook nhập/xuất và giới hạn](LMS_QUESTIONS.md). Migration 005 bổ sung ngân hàng/phiên bản/preview, đã áp dụng **local/test**; local startup kiểm marker/checksum ngày 10/11/2026 07:18Z. Không sửa 001–005 sau khi đã áp dụng.

Reviewer/admin dùng **Bảng điểm & báo cáo** theo version đang phát hành, tên người/đơn vị AIO, scope hiện hành và xuất XLSX bốn sheet. `lms:directory` xác thực MFA operator, cấp capability Directory một lần và không phục hồi quyền đã thu hồi khi chạy lại. [Hướng dẫn và định nghĩa thống kê](LMS_REPORTING.md). Các tab **Lịch sử đơn vị / Lịch sử quản trị** vẫn chỉ đọc lịch sử legacy.

Admin được cấp capability quản trị định danh có **Học viên & tài khoản**: tìm nhân sự AIO, tạo hồ sơ SSO-only, khóa/mở và đối soát đơn vị; không sinh mật khẩu LMS hoặc gán lại ownership. [Hướng dẫn và quyền](LMS_LEARNER_ADMIN.md). `test:lms-provisioning` đã pass luồng thật và 6 axe scans trong hồi quy cuối ngày 10/11/2026; gồm tài khoản QA SSO-only hoàn thành MFA/đổi mật khẩu rồi đăng nhập mới bằng OTP, có quyền quản trị LMS và Portal cá nhân mà không có quyền Foundation. Migration 006 đã áp dụng local/test và kiểm checksum; 001–006 bất biến, đổi schema dùng 007+. Tài khoản local lms.admin đã có hồ sơ SSO-only; hướng dẫn .local/LMS-TRY.md không chứa secrets. Lần đầu cần tự thiết lập MFA và đổi mật khẩu tạm.

Portal ở http://127.0.0.1:4100, Forms 4103, LMS sandbox 4104. Client LMS là external-application; dev Foundation không chiếm cổng 4104. LMS chạy workerd thật qua Miniflare, không bật nodejs_compat cho code adapter. ASSETS phục vụ frontend/dist, cần build lại khi sửa UI. Ctrl+C trong mỗi terminal dừng process tương ứng. Không có lệnh dừng/xóa các container hay volume dự án khác.

Script lms:setup tạo D1 riêng .local/lms/local/d1 và .local/lms/test/d1; kiểm instance/purpose/checksum trước migration. Migration 001–002 đã áp dụng là bất biến. Thêm phiên bản mới khi đổi schema. .local/lms-adapter.json giữ encryption key, không tái tạo nếu storage đã tồn tại. Chạy lại không hồi grant, binding, mapping hoặc adapter bị khóa. .local/lms-fixtures.json là receipt ánh xạ dữ liệu giả lập; không phải nguồn tự đồng bộ tổ chức.

Goal chức năng mới đã thêm migration 003, tạo các bảng lms_* riêng cho course/version/progress/attempt/note/media/receipt, không sửa các bảng lịch sử legacy. Startup local đã áp dụng 003 lúc 04:58Z ngày 10/11/2026. Migration 004 thêm chứng nhận; 005 thêm ngân hàng câu hỏi; cả hai đã áp dụng local/test. Migration 006 đã thêm hồ sơ SSO-only; 001–006 từ đây bất biến, thay đổi schema dùng 007+. [Kiến trúc nghiệp vụ](decisions/0007-lms-functional-domain.md), [goal liên tục](../roadmap/GOAL_LMS_COMPLETE.md). Các đoạn mô tả giao diện lịch sử chỉ đọc bên dưới là baseline được giữ bên cạnh domain mới.

| Tài khoản giả lập | ID LMS giữ nguyên | Vai trò thử |
| --- | --- | --- |
| demo.learner | legacy-lms-a | Learner đơn vị A |
| forms.respondent | legacy-lms-c | Learner đơn vị C |
| forms.reviewer | legacy-lms-manager | Reviewer đơn vị A |
| forms.publisher | legacy-lms-admin | Admin với MFA |

Mật khẩu/OTP do scripts tiêu thụ từ .local; không in/log/chụp màn hình IdP. Các tab lịch sử legacy chỉ đọc; domain khóa học mới hỗ trợ tạo nội dung, học và chấm điểm server. Mật khẩu legacy là hash của fixture riêng, không phải password giả được sinh khi SSO callback. Callback không tạo employee. Quản trị mapping G7 đã nghiệm thu; hồ sơ SSO mới không có password_hash, chỉ dùng IAM. Xem LMS_LEARNER_ADMIN.md và bằng chứng local 09:46Z.

## Phục hồi đăng nhập

Lượt đăng nhập tạm có hạn 5 phút. Với `/auth/callback`, cookie tạm bị mất hoặc transaction hết hạn/đã sử dụng trả mã `LOGIN_TRANSACTION_INVALID`. Từ bản sửa ngày 10/11/2026, GET của trình duyệt có Accept HTML được chuyển 303 đến `/#login-recovery`, bỏ query callback khỏi URL, không cache và không gửi referrer. Màn phục hồi có nút **Đăng nhập lại**, bắt đầu `/auth/login` với state/nonce/PKCE mới; không tự lặp SSO, đổi timeout hoặc tái dùng code cũ. Phiên ứng dụng hợp lệ đang có được giữ nguyên.

Request API (JSON, wildcard hoặc HTML q=0) vẫn nhận HTTP 400 và mã lỗi cũ. Callback sai state/nonce/PKCE vẫn bị từ chối 401; lỗi dịch vụ/DB hoặc quyền không bị đổi thành phục hồi transaction. Khi gặp lỗi, dùng http://127.0.0.1:4104/auth/login để bắt đầu mới trong cùng trình duyệt/tab; không mở lại URL callback/Keycloak đã lưu. Nếu cookie bị chặn, cần cho phép cookie cho môi trường local.

## Giao diện học tập và theo dõi

Bản nâng giao diện ngày 10/11/2026 dùng shadcn/Radix, logo TLQM, Be Vietnam Pro và palette chung. **Lịch sử của tôi** có số bài đã tham gia/đang học/hoàn thành, lượt kiểm tra, tìm kiếm không phân biệt dấu và lọc trạng thái. Thẻ bài học hiển thị chương trình, thời lượng, hạn học, tỷ lệ thời lượng đã xem và trạng thái hoàn thành do LMS lưu. Xem đủ thời lượng không tự đồng nghĩa đã hoàn thành.

Trong tab lịch sử legacy, nút **Xem chi tiết** mở tiến độ, điểm và ghi chú chỉ của bài đang chọn theo lesson_id. Khối kết quả/ghi chú gần đây hiển thị ba mục mới nhất; chi tiết bài học giữ toàn bộ mục được API trả về. Trình phát và bài kiểm tra mới thuộc tab **Khóa học**, không tự chuyển lịch sử legacy thành kết quả domain mới.

**Tiến độ đơn vị / Quản trị sandbox** có tìm kiếm tên, mã học viên và bài học; lọc trạng thái và phòng ban ghi trong hồ sơ LMS. Phòng ban này là dữ liệu lịch sử để lọc hiển thị, không phải nguồn quyết định phạm vi truy cập. Máy chủ vẫn lọc quyền/đơn vị hiện hành qua Foundation. Mỗi dòng là một học viên–bài học; số học viên đếm ID riêng biệt. API trả cursor 100 dòng/trang; frontend tải đủ các trang được cấp trước khi thống kê và phân trang 10 dòng. Có lỗi/thu hồi quyền ở trang sau thì xóa tập dữ liệu, không hiển thị số liệu nửa chừng. Bảng cuộn ngang có tên vùng, focus và hỗ trợ phím mũi tên.

Các truy vấn lịch sử legacy chỉ bổ sung metadata bài học được chọn rõ ràng (tên, mô tả ngắn, chương trình, thời lượng, hạn, bắt buộc). Không trả đáp án, nội dung câu hỏi, password hash hoặc URL video. Không thay bảng/mapping/quyền hoặc dữ liệu legacy đang có. Tải lại sẽ xóa dữ liệu cũ trước khi kiểm tra quyền; lỗi hoặc thu hồi quyền không giữ bảng/ghi chú cũ trên màn hình. Domain lms_* mới có API nội dung riêng đã mô tả ở đầu tài liệu.

## Ranh giới tích hợp

- Worker giữ issuer+subject → account/person → employee ID qua hai bảng mapping có ownership bất biến. Không nối theo email, mã nhân viên hoặc tên phòng ban.
- Mỗi request cần session opaque, chữ ký/issuer/audience/azp/expiry, online introspection và quyền Foundation hiện hành. Idle 15 phút, absolute 60 phút; refresh có lease/CAS, audit cùng batch D1. Không cache quyền để vượt qua sự cố.
- GET /api/v1/integrations/:appCode/authorize chỉ nhận bearer access token của external client đã đăng ký. Cookie Portal/ID token/token app khác bị từ chối; /api/v1/me của Foundation vẫn giữ audience riêng.
- POST /api/v1/integrations/:appCode/subjects nhận tối đa 100 account IDs, bearer của người gọi và proof từ confidential adapter. Proof HMAC dùng HKDF context riêng, ràng buộc app/token/IDs/timestamp ±30 giây. Đây là API chỉ đọc; retry vẫn kiểm token/grant hiện hành. Browser không có secret để tạo proof. Worker không có credential PostgreSQL hoặc Keycloak admin.
- Subjects chỉ trả account/person/tenant/unit hiện hành của người active, có membership và grant cho cùng app trong tenant người gọi. Không trả tên/email, đáp án hoặc dữ liệu học. Backend LMS áp dụng quyền nghiệp vụ và legacy role trước khi gọi, rồi lọc thêm theo mapping/person/unit đang hiệu lực. Học viên chuyển đơn vị, hết công tác, mất grant hoặc bị khóa không bị lộ qua mapping cũ của reviewer.
- Quyền lms:learn/lms:review/lms:admin giao với role legacy cho hồ sơ legacy-retained. Hồ sơ SSO-only dùng IAM hiện hành. Admin cần pwd+otp. Khóa học, media, lịch sử thi và legacy review dùng cursor; mỗi trang kiểm quyền/scope lại.
- Các endpoint sandbox: GET /api/learning (chỉ mình), /api/review, /api/admin; GET /api/v1/me, /api/v1/runtime-info; các route /auth/* theo hợp đồng OIDC. Password của tài khoản SSO quản lý tại IdP.

## Khóa, mở và đối soát đơn vị

Dừng dev Worker trước lệnh vận hành để không có hai process mở cùng storage. Xem trạng thái/revision, không hiển thị secrets:

~~~powershell
npm run lms:status -- local
npm run lms:status -- test
~~~

Cú pháp lệnh:

~~~text
npm run lms:control -- local|test adapter|mapping enable|disable EXPECTED_REVISION "Lý do tối thiểu 5 ký tự" [accountId] [orgUnitId]
~~~

CLI tự xác thực demo.admin bằng password + OTP fixture, kiểm Foundation identity:link và delegation access:manage cho aio-lms-sandbox. Revision cũ bị từ chối; mutation/audit/receipt cùng batch. Adapter disable xóa session và login transaction, nâng auth_not_before; mapping disable thu hồi session của account. Enable không hồi grants/bindings hoặc phiên cũ. Người dùng phải xác thực lại sau thời điểm thu hồi.

Với mapping, orgUnitId là tùy chọn để đối soát đơn vị mới. CLI chỉ chấp nhận đơn vị công tác đang hiệu lực trong Foundation của đúng person/tenant đã liên kết. ID account/person/employee/issuer/subject không đổi; chuyển đơn vị thu hồi phiên cũ. Lệnh không tự sửa department text hay lịch sử học.

Rollback local: disable adapter bằng revision hiện hành → xác nhận API trả LMS_ADAPTER_DISABLED → giữ mapping/history → sửa nguyên nhân → enable rõ ràng → đăng nhập mới và kiểm tra lại quyền. Không dùng cookie tlqm_session legacy hoặc password local làm đường vòng khi AIO từ chối.

## Kiểm thử

Sao lưu/khôi phục D1 + R2, khóa storage, dọn orphan media và preview Excel hết hạn: [runbook vận hành storage](LMS_STORAGE_OPERATIONS.md). Runtime/CLI dùng khóa độc quyền; chỉ unlock sau khi xác minh process chủ đã thoát. Restore tạo bản tách biệt, khóa mapping/adapter và xóa phiên cũ; không ghi đè nguồn đang dùng.

Dừng API dev/Worker trước tests. Chạy **tuần tự**, kể cả npm test: chung realm/OTP/test DB; resilience chủ động dừng IdP và PostgreSQL local.

~~~powershell
npm run check
npm run test:e2e
npm run test:forms-api
npm run test:forms-ui
npm run test:lms
npm run test:lms-courses
npm run test:lms-media
npm run test:lms-authoring
npm run test:lms-learner
npm run test:lms-providers
npm run test:lms-questions
npm run test:lms-reports
npm run test:lms-provisioning
npm run test:lms-backup
npm run test:lms-maintenance
npm run test:lms-resilience
npm run test:lms-onboarding
~~~

test:lms chạy Chromium với A/Forms/Worker, dữ liệu thật trong sandbox; thay fixtures có audit và khôi phục khi kết thúc. test:lms-resilience dùng proxy harness loopback chỉ để giữ logout token ký thật trong RAM; không ghi token ra artifact. Test dừng/khởi động đúng container đã kiểm chứng project tlqm-aio-local, kiểm warm/cold Worker, expiry và marker D1. Lỗi marker D1 là mô phỏng ở mức schema, không phải diễn tập mất file/ổ đĩa.

test:lms-onboarding kiểm CLI MFA, thu hồi mapping/grant/binding, disable adapter, setup chạy lại và explicit restore. OTP replay counter được tăng như thiết kế; chỉ so sánh seeds/credentials, không yêu cầu byte-identical toàn file MFA. .local/evidence chỉ chứa kết quả, số đo local và ảnh dữ liệu giả lập; không logs request headers, callback query, cookie hoặc token.

Giới hạn: HTTP loopback, D1 cùng filesystem local, Node toolchain và credentials .local không phải cấu hình production. Đã diễn tập backup/restore D1 + R2 trên bản tách biệt và kiểm bảo toàn nguồn; chưa load test/HA, secret rotation production hoặc nối dữ liệu/auth của LMS hiện hữu. [Kế hoạch sửa call sites LMS khi được giao](LMS_SSO_INTEGRATION.md).

## Chính sách học và thi

[Policy v3, khóa tiên quyết và giới hạn nộp bài](LMS_POLICIES.md) dùng migration LMS 007. [Lộ trình và đợt đào tạo](LMS_TRAINING.md) dùng LMS 008, [công việc và nhắc hạn](LMS_WORK_CENTER.md) dùng LMS 009 và [đề nghị đào tạo](WORKFLOWS_AUTOMATION.md#chuyển-đề-nghị-đào-tạo-sang-lms) dùng LMS 010. Đã áp dụng local/test. Chạy suite LMS/SSO tuần tự với một Worker trên mỗi storage. `lms:dev` chạy đối soát nhắc hạn mỗi 30 giây trong cùng process giữ lease.
