# Chạy Foundation và SSO local

Ngày: 09/11/2026. Chỉ dành cho môi trường giả lập của repo TLQM AIO.

## Yêu cầu

Node 24.x, npm, Docker Desktop Linux containers chạy trên Windows. Scripts kiểm tra context desktop-linux trỏ tới named pipe local; từ chối DOCKER_HOST/DOCKER_CONTEXT override. Không sử dụng database/IdP đang có của dự án khác.

| Thành phần | Địa chỉ |
| --- | --- |
| Foundation / client A | http://127.0.0.1:4100 |
| Client kiểm chứng B | http://127.0.0.1:4101 |
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
npm run db:setup
npm run dev
~~~

local:prepare sinh credentials ngẫu nhiên, encryption key và import realm trong .local. Chạy lại giữ credentials hiện tại. local:up chỉ dựng project riêng, đợi discovery và đồng bộ hai audience mapper/giới hạn scope của client local. db:setup kiểm tra hostname, port, tên database, marker và checksum migration; chỉ seed dữ liệu giả lập, không khôi phục grants đã thu hồi khi chạy lại.

Không xóa .local rồi giữ volume cũ: credentials/encryption key sẽ không còn khớp. Bản này không cung cấp lệnh reset hoặc xóa volume.

## Tài khoản thử

| Username | Trạng thái trong Foundation |
| --- | --- |
| demo.admin | Đọc Directory, xem audit, cấp/thu hồi app grant cho tenant A và hai app thử |
| demo.learner | Đọc tenant A, có hai assignment chính/kiêm nhiệm |
| demo.other | Chỉ tenant B |
| demo.no-access | Identity hợp lệ, chưa được cấp ứng dụng |
| demo.blocked | Có identity tại IdP, account Foundation bị khóa |

Mật khẩu là giá trị ngẫu nhiên trong .local/runtime.json, mục users. Người vận hành có thể mở file trực tiếp trên máy để đăng nhập. Agent/script không in giá trị vào chat, log hoặc báo cáo. Tài khoản quản trị Keycloak nằm ở mục keycloakAdmin. Các file này bị Git ignore; không đưa vào bản chia sẻ source.

Bấm “Đăng nhập SSO” ở client A, sau đó mở client B và bấm đăng nhập. Client B dùng phiên IdP nên không yêu cầu nhập lại mật khẩu; mỗi app có cookie/session riêng. Session app tối đa 5 phút, chưa có refresh tự động; bấm đăng nhập lại sử dụng phiên SSO nếu còn hiệu lực.

Đăng xuất ứng dụng chỉ hủy session của app đó. Đăng xuất SSO mở màn hình xác nhận tại Keycloak; sau xác nhận, back-channel logout xóa session của cả hai client. Không truyền token trong URL logout.

## Kiểm tra

Dừng API dev bằng Ctrl+C trước E2E vì E2E tự mở 4100/4101. Docker vẫn cần chạy.

~~~powershell
npm run typecheck
npm test
npx playwright install chromium
npm run test:e2e
npm run build
~~~

Unit/integration test dùng aio_foundation_test. E2E dùng Chromium headless, hai API instance với database test và các identity giả lập trong realm local; test khôi phục grant/user mà nó thay đổi. Không chạy test trên realm có người thật.

E2E không ghi trace/cookie/token; failure chỉ nêu giai đoạn và loại lỗi. Ảnh bằng chứng, nếu có, nằm trong .local/evidence và chỉ chứa dữ liệu giả lập.

Chạy bản build bằng npm start từ thư mục gốc repo. Dừng API bằng Ctrl+C. Dừng hạ tầng, giữ dữ liệu:

~~~powershell
npm run local:stop
~~~

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

Body grant/revoke gồm accountId, tenantId, appCode, reason. Không có field role hoặc quyền quản trị tùy ý. Cookie mutations cần Origin đúng base URL và x-csrf-token lấy từ /api/v1/me. API cũng kiểm tra bearer access token đúng audience; ID token không thay thế access token.

## Lưu ý cấu hình đã kiểm chứng

Keycloak hiện kiểm tra client introspection có nằm trong audience. Hai mapper riêng thêm API audience và client audience; không tắt audience validation. [Keycloak upgrading guide](https://www.keycloak.org/docs/latest/upgrading/#token-introspection-now-validates-audience-claim).

Ứng dụng introspect mỗi request và đọc quyền từ DB mỗi request: dễ kiểm chứng thu hồi tức thời, nhưng chưa tối ưu tải. Khi IdP không trả lời, request cần xác thực trả 503; không cho phép bằng dữ liệu quyền cũ.

HTTP, credentials trong local files, bootstrap database owner và database test cùng instance chỉ phục vụ phát triển. Secret store, role database tối thiểu, TLS, MFA, backup/restore và vận hành production cần bước riêng.
