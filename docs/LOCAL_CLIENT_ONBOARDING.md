# Onboarding client SSO thử độc lập

Ngày 09/11/2026. Phạm vi đã triển khai: client aio-onboarding tại http://127.0.0.1:4102, realm aio-local và hai database giả lập của Foundation. Không dùng LMS/BOS/LIMS làm client thử.

## Hợp đồng local v1

Manifest được lưu trong infrastructure/local/clients/. Ví dụ đang dùng: [aio-onboarding.json](../infrastructure/local/clients/aio-onboarding.json).

~~~json
{
  "version": 1,
  "code": "aio-onboarding",
  "name": "Client C — Kiểm chứng tích hợp",
  "port": 4102
}
~~~

Chỉ nhận bốn trường trên. Mã bắt đầu aio-, port số nguyên 4102–4199; code/clientId/audience/port không trùng client khác. Các địa chỉ được suy ra từ loopback 127.0.0.1, không nhận issuer/callback/credential từ API người dùng hay manifest. ClientId bằng code, audience bằng code-api, callback /auth/callback, post-logout /, back-channel /auth/backchannel-logout. Issuer cố định realm aio-local.

Client confidential dùng Authorization Code + PKCE S256, tắt implicit/password/service-account grants và full-scope access. Hai audience mapper riêng cho API và client introspection; AMR mapper lấy phương thức xác thực thực tế. CLI đối chiếu registration đang chạy, marker sở hữu instance, secret của receipt và thử introspection bằng credential trước khi xác nhận provisioning.

## Tạo và kiểm chứng

Sau khi local:mfa và db:setup hoàn tất, chạy từ thư mục gốc:

~~~powershell
npm run local:client
npm run local:client -- infrastructure/local/clients/aio-onboarding.json verify
npm run build
npm start
~~~

Đối với manifest khác, truyền đường dẫn trong infrastructure/local/clients và mode provision. Không cần sửa danh sách code/port trong backend. Runtime giữ hai client lõi A/B cố định và kiểm tra các client thử bổ sung bằng cùng contract.

CLI xác thực demo.admin bằng MFA, kiểm tra quyền hiện tại và marker cả hai DB. Nó tạo app planned cùng delegation qua GovernanceService, tạo client IdP nếu chưa có, ghi bằng chứng provisioning/audit rồi kích hoạt registry. Secret được sinh một lần và lưu riêng trong .local/clients/{code}.json cùng receipt IdP; runtime.json chỉ được thêm client sau khi cấu hình IdP được xác minh. Không ghi secret vào Registry, manifest, audit, báo cáo hay Git.

Fixture của client mới chỉ cấp cho demo.learner thuộc tenant A, với permission integration:read và role integration-reader. Tenant B, tài khoản thường khác và quản trị không tự có grant vào C. Quyền quản trị C được thực hiện từ Foundation A bằng delegation. Client C không có directory:read chỉ vì người đó đang có quyền này ở A/B.

Chạy lại provision không đổi credentials, không kích hoạt app đã disabled và không bật lại grant/role/binding đã bị thu hồi. db:setup không seed quyền chung vào các integration-probe; client disabled hợp lệ vẫn được giữ disabled. Nếu receipt/subject/client/instance không khớp, script từ chối thay vì chiếm lại hoặc tạo credential khác.

## Vô hiệu hóa và khôi phục

~~~powershell
npm run local:client -- infrastructure/local/clients/aio-onboarding.json disable
npm run local:client -- infrastructure/local/clients/aio-onboarding.json activate
~~~

disable đổi registry sang disabled, thu hồi BFF sessions có audit rồi tắt client IdP. Giữ bản ghi, credentials và lịch sử. activate là hành động rõ ràng: kiểm tra lại contract, bật IdP/registry; các quyền đã thu hồi vẫn không tự hồi. Muốn cấp lại quyền, dùng UI/API governance có revision, lý do và audit.

Đây là chuỗi thao tác trên hai DB và IdP, không phải distributed transaction. Nếu lỗi giữa chừng, giữ trạng thái từ chối truy cập và chạy lại đúng mode sau khi khôi phục dependency. Không xóa client, receipt hay volume để che lỗi.

Keycloak 26.8.2 có thể tự suy ra webOrigins từ redirectUris khi PUT bỏ trống trường này. CLI luôn gửi webOrigins rỗng khi đổi enabled và kiểm tra lại registration; không nới contract để bỏ qua thay đổi CORS. local:up cũng giữ trường này rõ ràng.

## Bằng chứng và giới hạn

~~~powershell
npm run test:onboarding
npm run check
npm run test:e2e
~~~

Chạy tuần tự và dừng API thường trực trước E2E: suite sở hữu 4100/4101/4102. test:onboarding tạm thu hồi quyền fixture, diễn tập disable/setup/provision bị từ chối/activate và khôi phục fixture bằng governance; có tác động cả hai database local. Mỗi CLI xác minh MFA mới, có thể đợi sang bước OTP 30 giây kế tiếp.

Nếu diễn tập bị gián đoạn sau khi đã thu hồi fixture, npm run test:onboarding -- restore chỉ khôi phục fixture cố định aio-onboarding/demo.learner bằng governance sau xác thực MFA. Lệnh này không phải provision thường và không báo các kiểm tra chưa chạy là pass; chỉ dùng khi đã xác minh trạng thái dở dang của diễn tập.

E2E đã kiểm chứng SSO A/B/C, từ chối tenant B tại C, dùng token/cookie/ID token sai client, callback chưa đăng ký, quyền độc lập, thu hồi grant C không ảnh hưởng A/B, tắt/bật registry có audit và back-channel logout cả ba client. Báo cáo không chứa secrets: .local/evidence/client-onboarding.json, client-rehearsal.json và security-lifecycle.json.

C là instance BFF kiểm chứng do Foundation vận hành, dùng chung mã adapter Fastify nhưng có clientId/audience/secret/cookie/port và quyền riêng. Đây là bằng chứng mở rộng client qua manifest; chưa phải adapter LMS hoặc triển khai ứng dụng nghiệp vụ độc lập. Ứng dụng bên ngoài phải dùng API/hợp đồng tích hợp, không được nhận database credentials của Foundation. Production/TLS/hosting và rollout ứng dụng thật chưa thuộc phạm vi này.

## Manifest application v2 — Forms

Client aio-forms dùng [manifest v2](../infrastructure/local/clients/aio-forms.json), thêm kind=application và cổng 4103. Các quy tắc issuer/client/audience/PKCE/callback/secret giữ nguyên. V1 vẫn chỉ nhận bốn trường của probe; v2 chỉ thêm kind application, không nhận URL/credential tùy ý.

Onboarding application không tạo permission integration:read hoặc probe grant cho learner. Core bootstrap chỉ seed A/B không có kind. Fixture Forms được tạo riêng bằng forms:fixtures qua operator MFA và GovernanceService; chạy lại không chủ ý khôi phục quyền đã thu hồi.

Placeholder aio-forms do bootstrap giữ trước đây chỉ được claim bằng thao tác local operator khi vẫn planned/protected, chưa có launch URL, client metadata, catalog, roles, grants hoặc delegation; code/name/base URL phải đúng manifest đã chốt. Claim có audit và delegation rõ ràng, không mở API claim protected apps cho người dùng. Evidence riêng .local/evidence/client-onboarding-aio-forms.json giữ bằng chứng C trước đó.

## Manifest external-application v3 — LMS sandbox

Client aio-lms-sandbox dùng [manifest v3](../infrastructure/local/clients/aio-lms-sandbox.json), kind=external-application, cổng 4104 và audience riêng. Provision/verify vẫn kiểm cùng contract OIDC; generic onboarding không cấp probe grant. lms:setup riêng tạo fixtures/roles/mapping qua operator MFA, không làm việc trong source/database LMS hiện hữu.

bffClients() loại external application khỏi Fastify dev/E2E loops; createApp từ chối khởi tạo loại này. Worker LMS tự quản session trong D1, gọi Foundation authorize/subjects bằng HTTP. Runtime config của Worker chỉ có client secret, encryption key, issuer/URL cố định và D1 binding; không nhận PostgreSQL credentials hoặc Keycloak admin.

Registry disable/activate và adapter disable/enable là hai lớp khác nhau. Tắt client/registry chặn quyền trực tuyến; lms:control còn xóa session/login transaction trong D1 và nâng auth_not_before. Không dùng enable ở lớp này để suy ra lớp kia đã mở hoặc grant đã được phục hồi. [Runbook và test:lms-onboarding](LMS_LOCAL_DEVELOPMENT.md) mô tả setup preservation/rollback local.

## Module Quy trình — application v2

aio-workflows ở 4105 dùng cùng manifest v2 application đã kiểm chứng, được BFF local chạy với session/audience riêng. workflows:setup tạo database/role riêng; workflows:fixtures cấp quyền qua operator MFA, không nhận quyền từ role Forms/BOS. [Runbook](WORKFLOWS_LOCAL_DEVELOPMENT.md) mô tả dựng, demo, test và rollback. Không tạo probe grant chung cho client này.
