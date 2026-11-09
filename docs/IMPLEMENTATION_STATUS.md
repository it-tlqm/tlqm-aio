# Trạng thái triển khai Foundation

Cập nhật: 09/11/2026. Bản khởi tạo Foundation local, nhánh chính main. Chưa triển khai hạ tầng remote hoặc production.

## Đã xây

| Hạng mục | Phạm vi thực tế |
| --- | --- |
| Stack | TypeScript + Fastify 5; Node 24; npm lockfile |
| Identity local | Keycloak 26.8.2; PostgreSQL riêng; realm aio-local và hai confidential clients |
| OIDC | Authorization Code + PKCE S256, state, nonce, ID token signature validation |
| API authentication | JWT signature/issuer/audience/expiry/authorized party và online introspection |
| Session | Cookie HttpOnly/SameSite, random opaque ID; DB giữ hash, token payload mã hóa AES-GCM có app context |
| Logout | Từng app, RP logout có xác nhận tại IdP, back-channel có chữ ký và replay receipt |
| Directory | Schema people/accounts/identity, tenant membership, legal entities, units, titles, positions, employments, assignments; API đọc theo tenant |
| Access | App grants, roles/permissions bootstrap, bindings theo tenant, giới hạn app có thể quản trị |
| Grant/revoke | Revalidate quyền trong transaction, cấp/thu hồi và audit nguyên tử |
| Registry | Hai app thử active; Forms/LMS chỉ planned |
| Audit | Login/logout/back-channel và cấp/thu hồi app grant; API đọc tenant audit |
| Trang thử | HTML/CSS/JS nhỏ để kiểm chứng SSO, danh tính, app được cấp và Directory |
| Hạ tầng | Docker project riêng, cổng loopback; migration/seed chỉ database mới có guard/marker |

## Bằng chứng kiểm thử

- TypeScript strict: pass.
- 9 unit/integration tests: pass — unknown identity, disabled/no-grant, tenant/permission scope, delegated administration, revocation + audit, assignments, authenticated encryption, token rejection và trusted key rotation.
- Chromium E2E: pass — login thật qua Keycloak, SSO hai client, cookie riêng, tenant/audience isolation, CSRF, grant/revoke, audit, disabled/no-grant, khóa user tại IdP, callback bị sửa, logout app/toàn hệ thống và back-channel xóa session client còn lại.
- Build TypeScript: pass.
- npm audit --omit=dev: không có advisory được registry báo tại thời điểm kiểm tra. Chưa chạy container image scan.

Test key rotation ở mức verifier/trusted key set, chưa phải diễn tập xoay key live toàn Keycloak. Thời gian thu hồi đã đo trong E2E local dưới 60 giây, chưa phải SLA được benchmark dưới tải.

## Phần còn thiếu trước Foundation MVP/production

- UI quản trị Directory/roles/grants và onboarding user thực.
- Cấp/thu hồi vòng đời nhân sự, HR/AD synchronization, account linking có quy trình.
- MFA bắt buộc cho quản trị, quản lý thiết bị/khôi phục tài khoản.
- Scope chi tiết theo orgUnit/form; bindings hiện chủ yếu theo tenant.
- API ghi Directory và các invariant đầy đủ về chu kỳ đơn vị/assignment theo thời gian.
- Refresh/session renewal và chiến lược cache dưới tải; hiện session app tối đa 5 phút và introspect online.
- Rate-limit dùng bộ nhớ của từng instance; chưa thiết kế shared limiter.
- Database role tối thiểu, TLS, secret store, backups và restore rehearsal; local đang dùng bootstrap owner.
- Retention/export audit, vận hành và kiểm thử outage/khôi phục hoàn chỉnh.
- Benchmark tài nguyên, container scanning, production deployment.
- Form Builder và adapter LMS: chưa viết; source cũ giữ nguyên.

## Liên hệ backlog

S1-02 đến S1-06 đã có lát cắt chạy được, nhưng chưa hoàn tất toàn bộ acceptance của Sprint 01. Form Builder/LMS tiếp tục theo roadmap sau khi hoàn thiện gate cần thiết.

Chi tiết chạy và test: [LOCAL_DEVELOPMENT](LOCAL_DEVELOPMENT.md). Quyết định công nghệ: [ADR 0002](decisions/0002-typescript-fastify.md).
