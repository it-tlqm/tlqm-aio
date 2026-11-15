# ADR 0004 — Adapter LMS Worker trong sandbox riêng

Ngày 10/11/2026. Foundation và Forms đã đạt gate local; LMS là bước tiếp theo theo phạm vi người dùng cho phép.

## Hiện trạng kiểm chứng lại, chỉ đọc

Source D:/thanhnx/OpenCode/LMS-TLQM/tlqm-learning-mvp vẫn không có Git root (chưa có branch/commit/dirty để xác minh). Đã đọc db/schema.ts, worker/index.ts và chữ ký hàm/phần validateSession của lib/auth.ts; không đọc phần seed/password mặc định, .env, dumps hoặc dữ liệu khách hàng. Không chạy/cài package/sửa source này.

employees.id là TEXT. learning_progress, learning_attempts, learning_notes giữ user_id; session cũ giữ user_id và hạn 30 ngày trong helper. validateSession đọc employee active và trả role của employee. worker/index.ts dùng vinext/server/fetch-handler và request-scoped connector binding; sự tồn tại của source không chứng minh app/deployment đang hoạt động.

## Quyết định sandbox

1. Adapter mới dùng Web APIs trên workerd/Miniflare + D1 local riêng trong Master Project; không đổi LMS sang Fastify/PostgreSQL. Source mới không import/copy code nghiệp vụ LMS. Dữ liệu giả lập có cùng quan hệ ID/tiến độ/điểm để đối soát trước/sau.
2. Client riêng aio-lms-sandbox, callback loopback 4104, audience riêng. Đây không phải đăng ký/triển khai LMS hiện hữu. Node Foundation không chiếm cổng của external application.
3. Worker tự thực hiện OIDC Code + PKCE/state/nonce, kiểm chữ ký/issuer/audience/expiry, cookie session opaque và token payload mã hóa. Không đưa token dài hạn ra browser hoặc localStorage.
4. Foundation cung cấp endpoint authorization riêng cho external client, chỉ nhận bearer access token đúng client/audience đã đăng ký. Endpoint A /api/v1/me vẫn không chấp nhận token của LMS. Mỗi request Worker kiểm quyền/account/grant hiện hành qua boundary này; lỗi phụ thuộc từ chối truy cập, không dùng snapshot quyền cũ để cho phép. Worker không nhận credential PostgreSQL/Keycloak admin.
5. Mapping explicit issuer+subject → AIO account/person → legacy employee ID; creation/verification receipts và audit. Không tự ghép bằng email/code/department, không tự tạo employee khi callback và không sinh password giả để lách password_hash NOT NULL. Fixture legacy có hash riêng, dữ liệu cũ giữ nguyên.
6. Quyền hiệu lực phải qua AIO permission và ranh giới legacy role/scope. Learner chỉ xem dữ liệu của mình; reviewer/manager chỉ phạm vi được giao; legacy admin role riêng không đủ để vào API admin. Không khẳng định tính năng manager trong LMS cũ đã hoàn chỉnh.
7. Rollback sandbox tắt SSO/adapter có kiểm soát và giữ mapping/business history. Không hồi quyền đã thu hồi hoặc dùng cookie legacy 30 ngày để bỏ qua AIO.

## Spike runtime đã chạy

test:lms-spike đã pass workerd thật, D1 local, Web Crypto AES-GCM/RSA, jose ký/verify, openid-client discovery qua IdP loopback và PKCE. Không bật nodejs_compat. Chưa coi discovery/crypto spike là luồng đăng nhập hoàn chỉnh.

Dependencies dev: Miniflare 4.20260730.0, esbuild 0.28.2. Registry audit ban đầu báo dependency sharp/undici; override riêng dưới Miniflare lên sharp 0.35.5 và undici 7.30.1 (cùng nhánh tương thích), npm audit về 0 advisory tại lần cài. Không dùng audit fix --force hoặc downgrade runtime. Runtime thực tế được kiểm lại bằng spike; package declaration không thay bằng chứng chạy.

Nguồn primary: [Cloudflare Miniflare D1](https://developers.cloudflare.com/workers/testing/miniflare/storage/d1/), [ES modules](https://developers.cloudflare.com/workers/testing/miniflare/core/modules/), [openid-client runtimes](https://github.com/panva/openid-client). Bằng chứng local .local/evidence/lms-runtime-spike.json.

## Gate để hoàn thành adapter sandbox

SSO cùng browser từ Portal/Forms, giữ employee IDs/tiến độ/điểm, unknown identity/no-grant/disabled account deny, learner/admin/unit boundaries, revocation trên phiên đang mở, callback/logout replay, session expiry/refresh, outage fail closed/recovery, mapping immutability và rollback không hồi quyền. Có runbook, integration contract và các call sites cần sửa trong LMS sau này. Chỉ gọi là sandbox đạt kiểm chứng; chưa tích hợp LMS đang dùng khi source/runtime đó chưa được phép đổi và chạy.

## Bổ sung sau kiểm thử Worker thực tế

Luồng hoàn chỉnh và UI đã được kiểm chứng ngoài spike; xem [bảng nghiệm thu](../LMS_ACCEPTANCE.md). Miniflare static-assets router cần has_user_worker cùng invoke_user_worker_ahead_of_assets; Worker luôn chạy trước để giữ CSP/no-store/auth route. Backend gọi Foundation bằng redirect manual và từ chối mọi 3xx, không forward bearer theo redirect. Tham khảo [Cloudflare asset binding](https://developers.cloudflare.com/workers/static-assets/binding/) và implementation phiên bản Miniflare đã pin trong node_modules; không sửa package vendored.

Reviewer phải đối chiếu đơn vị hiện hành của **học viên được xem**, ngoài scope của người gọi. Foundation thêm subjects boundary chỉ đọc, cần bearer cùng service proof từ confidential adapter; không đặt logic học tập trong Directory. Đơn vị stale hoặc account mất quyền bị loại khỏi kết quả ngay cả khi mapping local chưa được operator đối soát. Worker không được cấp credential PostgreSQL.
