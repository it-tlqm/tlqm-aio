# ADR 0002 — TypeScript + Fastify

Ngày: 09/11/2026. Trạng thái: **được người dùng chấp thuận**.

## Quyết định

Backend mới của TLQM AIO dùng TypeScript + Fastify. Bắt đầu với một codebase chia module và một PostgreSQL cho dữ liệu nền tảng. Identity Provider dùng Keycloak riêng với database riêng. Hai listener/client trong bản local chỉ để kiểm chứng SSO và ranh giới ứng dụng, không phải quyết định tách thành hai microservice.

Runtime local Node 24; versions trực tiếp được pin và có package-lock.json. Keycloak 26.8.2, PostgreSQL 17.7 được pin trong Compose. Version của runtime hiện hữu LMS/BOS không bị thay đổi.

## Lý do

Hệ sinh thái hiện có đã sử dụng TypeScript/React. Fastify cho phép giữ backend gọn, chia module và kiểm tra request bằng schema. Có thể tái sử dụng kiến thức/type/hợp đồng khi tích hợp LMS và đánh giá Form Builder BOS; không mặc định có thể sao chép các NestJS module nguyên trạng.

Rust không nằm trong stack khởi đầu. Đây là quyết định phù hợp phạm vi hiện tại, không phải kết luận hiệu năng từ benchmark.

## Ranh giới triển khai

- Foundation: source TypeScript trong src; public chỉ là trang kiểm chứng auth tối thiểu.
- Portal/Form Builder sản phẩm: ưu tiên React + TypeScript + Vite + Tailwind CSS v4 + shadcn/ui, theo [Design System TLQM](../FRONTEND_DESIGN_SYSTEM.md) người dùng xác nhận. Chưa tạo ứng dụng React trong lát cắt SSO này.
- PostgreSQL giữ Directory, grants/roles, registry, session và audit. Không cần Redis/message broker cho lát cắt đầu.
- Keycloak giữ credential/MFA/SSO; app dùng openid-client và jose, không tự viết giao thức xác thực.
- LMS giữ Next/Workers/D1; adapter được triển khai sau khi Foundation đạt gate.
- Chính sách quyền và schema API không nhận code/schema biên dịch trực tiếp từ người dùng cuối.

## Trạng thái thực tế

Xem [hướng dẫn local](../LOCAL_DEVELOPMENT.md) và [trạng thái triển khai](../IMPLEMENTATION_STATUS.md). Không dùng cấu hình dev/HTTP, user database hoặc secret files local cho production.

Các nguồn đã đối chiếu: [Fastify](https://fastify.dev/), [openid-client](https://github.com/panva/openid-client), [Keycloak container](https://www.keycloak.org/server/containers).
