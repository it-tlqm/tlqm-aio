# Chạy Foundation và SSO local

Ngày: 10/11/2026. Chỉ dành cho môi trường giả lập của repo TLQM AIO.

## Yêu cầu

Node 24.x, npm, Docker Desktop Linux containers chạy trên Windows. Scripts kiểm tra context desktop-linux trỏ tới named pipe local; từ chối DOCKER_HOST/DOCKER_CONTEXT override. Không sử dụng database/IdP đang có của dự án khác.

| Thành phần | Địa chỉ |
| --- | --- |
| Foundation / client A | http://127.0.0.1:4100 |
| Client kiểm chứng B | http://127.0.0.1:4101 |
| Client tích hợp C | http://127.0.0.1:4102; sau local:client |
| AIO Forms | http://127.0.0.1:4103; sau provision/fixtures riêng |
| LMS sandbox Worker | http://127.0.0.1:4104; process workerd riêng |
| AIO Quy trình | http://127.0.0.1:4105; BFF/application với database riêng |
| AIO Công việc | http://127.0.0.1:4106; BFF/application với database riêng |
| Keycloak local | http://127.0.0.1:8180 |
| Issuer | http://127.0.0.1:8180/realms/aio-local |
| Foundation PostgreSQL | 127.0.0.1:5438; aio_foundation |
| Database kiểm thử | Cùng instance mới; aio_foundation_test |
| Identity PostgreSQL | Chỉ trong Docker network, không publish cổng |

Docker project là tlqm-aio-local. Volume identity-data và foundation-data có prefix project; không chia sẻ với BOS/LMS.

## Lần chạy đầu

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

local:prepare sinh credentials ngẫu nhiên, encryption key và import realm trong .local. Chạy lại giữ credentials hiện tại. local:up chỉ dựng project riêng, đợi discovery và đồng bộ hai audience mapper/giới hạn scope của client local. db:setup kiểm tra hostname, port, tên database, marker và checksum migration; chỉ seed dữ liệu giả lập, không khôi phục grants đã thu hồi khi chạy lại.

db:setup hiện chạy các migration có thứ tự (001–009), giữ checksum đã áp dụng và tạo role aio_runtime riêng. Config databaseUrl vẫn dành cho owner provisioning aio_foundation; API và test application dùng credentials databaseRuntime để kết nối bằng aio_runtime. Runtime không được sửa schema/journal/marker hoặc update/delete audit. Không sửa migration đã áp dụng; bổ sung migration mới. Migration 004 giữ nguyên hạn tối đa của phiên cũ; migration 005 thêm proof định danh, ownership bất biến và auth_not_before. [Vòng đời định danh](IDENTITY_LIFECYCLE.md). Migration 008 liên kết đề xuất hồ sơ với Quy trình. Migration 009 lưu đề nghị tiếp nhận do Quy trình chuyển và kết quả xác nhận trong Nhân sự. [Đề xuất hồ sơ](PROFILE_WORKFLOWS.md), [Chuyển đề nghị tiếp nhận](WORKFLOWS_AUTOMATION.md#chuyển-đề-nghị-tiếp-nhận-sang-nhân-sự).

npm run build dựng frontend React/shadcn và backend; npm run dev chỉ theo dõi backend. Khi sửa UI, chạy npm run build:ui rồi tải lại trang 4100. Cổng 5173 là Vite dev tùy chọn, chưa nghiệm thu trọn luồng SSO/logout; dùng 4100 để kiểm chứng auth và CSP. npm start cần bản build tồn tại.

Không xóa .local rồi giữ volume cũ: credentials/encryption key sẽ không còn khớp. Bản này không cung cấp lệnh reset hoặc xóa volume.

Trang đăng nhập/OTP dùng [theme SSO TLQM](SSO_THEME.md), mount source chỉ đọc. local:up chọn theme lần đầu; lần sau giữ lựa chọn hiện hành. `npm run local:sso-theme -- status` kiểm tra, `-- apply` áp dụng rõ ràng, `-- rollback` phục hồi bốn cài đặt giao diện đã lưu. Chạy test:sso-theme tuần tự với các suite MFA/E2E; không chụp credential/OTP/enrollment hoặc ghi credentials. Kiểm tra giao diện chỉ chụp login trống trong context mới theo guard của runbook theme. Tắt cache theme chỉ phục vụ phát triển local.

## Tài khoản thử

| Username | Trạng thái trong Foundation |
| --- | --- |
| demo.admin | Đọc Directory, xem audit, cấp/thu hồi app grant cho tenant A và hai app thử |
| demo.recovery-admin | Quản trị dự phòng giả lập, MFA độc lập; dùng cho diễn tập mất OTP của demo.admin |
| demo.learner | Đọc tenant A, có hai assignment chính/kiêm nhiệm |
| demo.other | Chỉ tenant B |
| demo.no-access | Identity hợp lệ, chưa được cấp ứng dụng |
| demo.blocked | Có identity tại IdP, account Foundation bị khóa |

Mật khẩu là giá trị ngẫu nhiên trong .local/runtime.json, mục users. Người vận hành có thể mở file trực tiếp trên máy để đăng nhập. Agent/script không in giá trị vào chat, log hoặc báo cáo. Tài khoản quản trị Keycloak nằm ở mục keycloakAdmin. Các file này bị Git ignore; không đưa vào bản chia sẻ source.

Để dùng thử cơ cấu tổ chức/nhân sự/vai trò bằng tài khoản riêng, xem [Organization Workspace](ORGANIZATION_WORKSPACE.md). Lệnh `npm run organization:review-admin` tạo `org.admin` trong AIO local với role/delegation tường minh, không đổi tài khoản LMS hiện có. Hướng dẫn không chứa secrets ở `.local/ORGANIZATION-TRY.md`; người dùng tự hoàn thành MFA/đổi mật khẩu rồi đăng nhập mới.

Bấm “Đăng nhập SSO” ở client A, sau đó mở client B và bấm đăng nhập. Client B dùng phiên IdP; mỗi app có cookie/session riêng. Session mới có hạn tuyệt đối 60 phút và hạn không hoạt động 15 phút. Request thành công gia hạn hạn không hoạt động trong giới hạn ban đầu. Khi access token còn tối đa 30 giây hoặc đã hết hạn, BFF dùng refresh token được mã hóa trong DB để xin token mới, kiểm tra chữ ký/issuer/audience/subject/sid và introspection; không gửi token cho frontend. Keycloak bật rotation, không cho tái dùng refresh token. Khóa từng session trong transaction tránh hai request dùng lại cùng refresh token. Logout/expiry không thể bị renewal tạo lại; IdP lỗi thì từ chối truy cập và không kéo dài phiên.

Quản trị yêu cầu AMR pwd và otp từ access token đã xác minh; header hoặc role phía giao diện không thay thế MFA. accounts.mfa_required hoặc quyền quản trị hiện hành đều kích hoạt kiểm tra tại backend trên mỗi request và trong mutation transaction. local:mfa tạo flow aio-local-mfa trong realm aio-local, bắt buộc OTP/enrollment cho hai quản trị giả lập, thêm AMR mapper và kiểm chứng bằng Chromium. Quyền realm aio-mfa-required chỉ điều khiển bước đăng nhập, không cấp quyền ứng dụng.

local:mfa giữ password/OTP đã có, seed OTP chỉ lưu .local/mfa.json; không ghi trace/screenshot IdP. Nếu vừa tạo tài khoản qua Admin REST, subject được lấy từ Location trả về và ghi trong runtime, độc lập accountId. Không dò email rồi tự nối account. Chạy local:mfa trước db:setup trên workspace cũ để seed đúng subject quản trị dự phòng. Không chạy các script MFA/E2E đồng thời: OTP một lần cần chờ bước 30 giây tiếp theo nếu vừa dùng.

Chi tiết fixture, mất thiết bị và diễn tập: [MFA và khôi phục local](LOCAL_MFA_RECOVERY.md). Tài khoản mới được cấp quyền quản trị mà chưa có OTP sẽ nhận MFA_REQUIRED; cấu hình ứng dụng xác thực trong tài khoản Keycloak rồi đăng nhập lại bằng /auth/login?reauth=1. Việc tự đồng bộ required action cho mọi nhân sự mới vẫn cần hoàn thiện cùng vòng đời định danh.

Đăng xuất ứng dụng chỉ hủy session của app đó. Đăng xuất SSO mở màn hình xác nhận tại Keycloak; sau xác nhận, back-channel logout xóa session của cả ba client A/B/C đã kiểm thử. Không truyền token trong URL logout.

Lượt đăng nhập OIDC tạm có hạn 5 phút, tách khỏi session ứng dụng. Với các BFF AIO (Foundation, Forms, Quy trình và client thử), nếu quay về callback khi cookie tạm đã mất hoặc transaction đã hết hạn/được sử dụng, browser được chuyển sang màn hình **Cần bắt đầu lại đăng nhập** với nút **Đăng nhập lại**. Nút này đi qua /auth/login để tạo state/nonce/PKCE mới; không tự lặp redirect hoặc chấp nhận code cũ. Không giữ query callback trong URL màn phục hồi. Các request API vẫn nhận HTTP 401 và mã LOGIN_TRANSACTION_MISSING/EXPIRED; callback sai state/nonce vẫn bị từ chối. Khi gặp lỗi, bắt đầu từ ứng dụng, dùng cùng trình duyệt/tab và không mở lại URL Keycloak/callback đã lưu. Worker LMS có handler riêng, đã bổ sung cùng màn phục hồi cho callback GET nhận HTML; API của Worker vẫn giữ HTTP 400/LOGIN_TRANSACTION_INVALID. Xem [phục hồi đăng nhập LMS](LMS_LOCAL_DEVELOPMENT.md#phục-hồi-đăng-nhập).

Đợt sửa 10/11/2026 đã kiểm chứng browser thiếu cookie, transaction hết hạn sau khi nhập mật khẩu, nút phục hồi qua SSO bằng transaction mới, JSON API vẫn 401, sai state/replay bị chặn và session hợp lệ không bị xóa bởi callback cũ. `check` qua 103 tests; ba suite Foundation và E2E Quy trình đều pass, kết thúc 2026-11-10T01:54:20Z. Evidence ignored: `.local/evidence/login-recovery-regression.json`, ảnh màn phục hồi mobile; không ghi credential hoặc query callback.

## Vận hành tổ chức bổ sung

Foundation 006 thêm quản lý/trưởng đơn vị/người thay thế; Workflows 003 lưu quy tắc người nhận theo cơ cấu. Chạy `npm run db:setup` và `npm run workflows:setup` tuần tự sau preflight local. [Hướng dẫn và rollback](ORGANIZATION_OPERATIONS.md). Suite `npm run test:organization-operations` dùng 4100/4105 và database test; dừng API dev trước, không chạy cùng suite DB/MFA khác. Giữ nguyên credentials và journals cũ.

## Trung tâm công việc

[Hướng dẫn và rollback](WORK_CENTER.md): Workflows 004, chạy `npm run workflows:setup` trước bản mới. `npm run dev` chạy worker nhắc hạn mỗi 30 giây; nếu dùng `npm start`, mở thêm `npm run work-center:worker`. Chính sách đơn vị chưa cấu hình mặc định tắt. `npm run work-center:review` chuẩn bị Portal cá nhân cho workflows.admin, không thêm quyền quản trị Foundation/đổi credentials/MFA. E2E `test:work-center` dùng 4100/4105 và DB test; không chạy đồng thời MFA/E2E khác.

## Kiểm tra

Dừng API dev bằng Ctrl+C trước E2E vì E2E tự mở các client trong runtime (hiện 4100/4101/4102). Docker vẫn cần chạy. [Onboarding client local](LOCAL_CLIENT_ONBOARDING.md) mô tả provision/verify/disable/activate và bảo toàn credentials/quyền.

~~~powershell
npm run check
npm run test:e2e
npm run test:onboarding
npm run test:bootstrap
npm run test:resilience
npm run test:restore
npm run measure:local
~~~

Chạy các lệnh trên tuần tự. check gồm Prettier, TypeScript, unit/integration và build cả frontend/backend. Unit/integration test dùng aio_foundation_test. test:e2e chạy ba suite SSO chung, identity-lifecycle và admin-ui theo thứ tự, mỗi suite dùng Chromium headless/ba BFF instance với database test. Test khôi phục grant/user cũ mà nó thay đổi; user mới tạo riêng cho identity suite được vô hiệu hóa sau test, giữ lịch sử/audit. Riêng diễn tập recovery chủ động đổi OTP fixture demo.admin, nâng auth_not_before, thu hồi phiên cũ và ghi audit ở cả hai database AIO local/test vì cùng realm. Password và quản trị dự phòng giữ nguyên. Không chạy test trên realm có người thật.

test:bootstrap tạo database trống riêng aio_foundation_bootstrap_<suffix>, chạy toàn bộ migration và fixture, kiểm chứng ánh xạ MFA admin, quyền runtime, client được bảo vệ và lần setup thứ hai giữ quyền đã thu hồi. Database thử được giữ lại nhưng aio_runtime bị thu hồi CONNECT sau test; runtime.json không đổi. Câu seed assignment chỉ xử lý trùng primary key id, không bỏ qua ràng buộc chống chồng lịch. Không sửa migration 001–005.

test:resilience chủ động dừng/khởi động DB/IdP local; test:restore chỉ restore vào database mới riêng. measure:local cần bản build mới và cổng 4100/4101/4102 trống. Chi tiết: [diễn tập và rollback](RESILIENCE_AND_RESTORE.md), [đo tài nguyên](LOCAL_MEASUREMENTS.md).

E2E không ghi trace/cookie/token; failure chỉ nêu giai đoạn và loại lỗi. Ảnh bằng chứng, nếu có, nằm trong .local/evidence và chỉ chứa dữ liệu giả lập.

Chạy bản build bằng npm start từ thư mục gốc repo. Dừng API bằng Ctrl+C. Dừng hạ tầng, giữ dữ liệu:

~~~powershell
npm run local:stop
~~~

LMS sandbox: [runbook riêng](LMS_LOCAL_DEVELOPMENT.md). Chạy lms:dev ở terminal thứ hai sau build; Foundation dev bỏ qua external-application. Migrations D1 001–002 riêng, không dùng PostgreSQL để lưu dữ liệu học. Không chạy test:lms-resilience cùng bất kỳ suite cần DB/IdP nào.

AIO Quy trình: [runbook](WORKFLOWS_LOCAL_DEVELOPMENT.md). Client application 4105 được dev/start chạy cùng các BFF; migrate/fixtures riêng, không đọc dữ liệu Forms/Identity từ domain. Dừng toàn bộ API dev trước E2E. Foundation/LMS/Workflows migrations là các journal riêng; không dùng số migration của module này suy ra module khác đã cập nhật.

AIO Công việc dùng client application 4106 và PostgreSQL Tasks riêng. Chạy `npm run tasks:setup`, provision client và quyền giả lập theo [runbook Công việc](TASKS_LOCAL_DEVELOPMENT.md). `test:tasks` dùng cổng 4100/4106 và database test.

## API của lát cắt đầu

| Method / path | Quyền |
| --- | --- |
| GET /health/live | Không yêu cầu login |
| GET /health/ready | Kiểm tra marker database local/test |
| GET /auth/login, /auth/callback | Giao dịch OIDC một lần, PKCE/state/nonce |
| POST /auth/logout | Session cookie và CSRF; global=true để đến IdP |
| POST /auth/backchannel-logout | Logout token đã ký, đúng issuer/client, chống replay |
| GET /api/v1/me | Account hoạt động và app grant hợp lệ |
| GET /api/v1/applications | Chỉ ứng dụng đã được cấp, đang active |
| GET /api/v1/directory?tenantId=... | directory:read trong tenant tương ứng |
| POST /api/v1/access/grants | access:manage trong tenant và đúng app được ủy quyền |
| POST /api/v1/access/grants/revoke | Cùng điều kiện cấp grant |
| GET /api/v1/audit?tenantId=... | audit:read trong tenant |
| GET /api/v1/manage/{resource}?tenantId=... | Quyền đọc resource; lọc scope tenant/đơn vị |
| POST /api/v1/manage/{resource} | Quyền quản trị tenant, body có data/reason/tenantId, header Idempotency-Key |
| PATCH /api/v1/manage/{resource}/{id} | Như create, thêm expectedRevision để chặn ghi đè dữ liệu mới |

Resources hiện có: legal-entities, org-units, job-titles, positions, people, accounts, employments, assignments; applications, permissions, roles, bindings, grants. Resource theo app cần appCode khi list. Registry tạo app trạng thái planned; CLI local:client xác minh provisioning OIDC trước khi kích hoạt. Client C đã onboarding qua cơ chế này. Archive danh mục/người/tài khoản dùng PATCH active=false khi quan hệ phụ thuộc cho phép; employment/assignment kết thúc bằng validUntil và giữ lịch sử. API không xóa cứng record. Account quản trị bootstrap được bảo vệ khỏi tự vô hiệu hóa. Ba suite E2E bao phủ các workflow quản trị Foundation; xem phạm vi và giới hạn tại [nghiệm thu](FOUNDATION_ACCEPTANCE.md).

Directory (legal-entities/org-units/job-titles/positions/people/accounts/employments/assignments) và `identity-targets` trả tối đa 500 bản ghi mỗi trang kèm `nextCursor`. Truyền cursor đó ở query `cursor` để lấy trang kế; mỗi request kiểm quyền và tenant/unit lại. Giao diện quản trị và các lựa chọn quan hệ tải đầy đủ các trang trước khi hiển thị, không âm thầm cắt mất hồ sơ mới sau bản ghi thứ 500. Trang Directory sắp theo UUID; identity-targets dùng cặp tên + UUID để không mất các tài khoản trùng tên. Nếu trang sau lỗi/thu hồi quyền, không hiển thị tập dữ liệu chưa tải đủ. Quyền không được gói trong cursor. Governance (applications/roles/bindings/grants) chưa dùng contract cursor này.

Hai đường /api/v1/access/grants và /revoke hiện là alias của GovernanceService. Body gồm accountId, tenantId, appCode, reason, expectedRevision; header Idempotency-Key bắt buộc. Lấy revision hiện tại qua GET /api/v1/manage/grants; dùng 0 khi chưa có bản ghi. Payload cũ thiếu revision/key bị từ chối 400, phiên bản cũ trả 409. Cả hai đường cũ/mới dùng chung receipt, delegation, audit before/after và revision; không còn SQL cấp quyền riêng bỏ qua quản lý đồng thời. Không có field role hoặc quyền quản trị tùy ý. Cookie mutations cần Origin đúng base URL và x-csrf-token lấy từ /api/v1/me. API cũng kiểm tra bearer access token đúng audience; ID token không thay thế access token.

## Lưu ý cấu hình đã kiểm chứng

Keycloak hiện kiểm tra client introspection có nằm trong audience. Hai mapper riêng thêm API audience và client audience; không tắt audience validation. [Keycloak upgrading guide](https://www.keycloak.org/docs/latest/upgrading/#token-introspection-now-validates-audience-claim).

Ứng dụng introspect mỗi request và đọc quyền từ DB mỗi request: dễ kiểm chứng thu hồi tức thời, nhưng chưa tối ưu tải. Khi IdP không trả lời, request cần xác thực trả 503; không cho phép bằng dữ liệu quyền cũ.

HTTP, credentials trong local files và database test cùng instance chỉ phục vụ phát triển. Runtime đã tách khỏi database owner; MFA và backup/restore giả lập đã được diễn tập. Secret store, TLS, backup/restore production, MFA thiết bị thật và vận hành production vẫn cần bước riêng.

## Quy trình cấu hình nâng cao

[Nhóm duyệt, lịch làm việc và SLA phút](WORKFLOWS_ADVANCED.md): migration Workflows 005 đã áp dụng local/test. Chạy `npm run test:workflows-pools` tuần tự với các suite MFA/DB. Giữ code hỗ trợ WorkflowSpec v4 khi có lượt đang chạy; không quay về runtime chỉ biết một người duyệt.
