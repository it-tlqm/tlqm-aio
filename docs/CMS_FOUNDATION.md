# CMS Foundation

Ngày kiểm kê: 16/11/2026. Trạng thái: lát cắt CMS local/test đã hoàn thiện; provider live vẫn cần credential và kiểm thử được cấp riêng.

## Phạm vi lát cắt đầu tiên

- Website thuộc một tenant AIO, có mã, tên, trạng thái và danh sách locale.
- Domain mapping cho local, preview và production.
- Page có path ổn định và loại `landing`, `collection` hoặc `system`.
- Revision bất biến cho từng locale, gồm title, SEO và danh sách block.
- Submit review tạo revision `review`. Publish và rollback đều tạo revision mới.
- Publish trỏ page về revision đã phát hành.
- Audit append-only và receipt idempotency thuộc database CMS riêng.
- Quyền CMS được kiểm tra qua app `aio-cms` và AIO Access Management.
- Structured collections cho dịch vụ, tin tức, tuyển dụng và các loại nội dung mở rộng.
- Media registry lưu metadata, asset scope, alt text theo locale và storage reference.
- Menu draft/publish theo website và locale.
- Channel connection cho Website, Facebook, TikTok và Zalo OA, chỉ lưu token reference.
- Publication queue có lịch, capability, idempotency, worker local, retry attempt và trạng thái lỗi.
- Runtime connector có secret resolver theo reference, payload conversion cho Facebook Graph, TikTok Content Posting và Zalo OA, transport tiêm được để kiểm thử, phân loại lỗi 401/403/429/5xx và remote id. Không lưu hoặc log token.

## Ranh giới dữ liệu

CMS giữ dữ liệu website và nội dung trong database riêng. AIO Foundation giữ identity, organization, grant, role và audit nền tảng. CMS chỉ nhận actor đã được Foundation xác thực và không đọc trực tiếp database định danh.

## Nội dung website Tà Lùng Quang Minh

Website đầu tiên dùng các block homepage như hero, KPI, dịch vụ, quy trình, tin tức, đối tác và CTA. Dịch vụ, tin tức và tuyển dụng đã có content type để nhập dữ liệu. TikTok, Facebook và Zalo OA có local adapter deterministic và runtime connector dùng token reference. Runtime connector chỉ chạy khi resolver cung cấp secret từ môi trường/secret store do vận hành cấu hình; chưa gọi API thật trong local test.

UI `aio-cms` hiện có website/page studio, review/publish, domain mapping, collection type và entry, media metadata, menu draft/publish, channel management và publication queue/retry. Ghi dữ liệu từ UI luôn gửi idempotency key.

## Quy tắc vận hành

- Mọi lệnh ghi cần `reason`, `expectedRevision` và `Idempotency-Key`.
- Bản publish là revision bất biến. Sửa sau publish tạo revision mới.
- Public API chỉ trả revision đã publish.
- Website và page luôn được lọc theo tenant và website.
- Schema Fastify chỉ kiểm tra envelope cố định. Dữ liệu block được parse trong service.

## Bằng chứng local

- `npm run cms:setup` đã áp dụng migrations `001` đến `004` cho `aio_cms` và `aio_cms_test`.
- `npm run cms:import-talung` đã nhập website `talung-logistics`, 8 page, 24 page revisions, 3 content types, 6 entries, 18 content revisions và 4 assets.
- `npm run cms:smoke` đã kiểm page/content publish, review, rollback, menu, channel, publication queue, public read, revision conflict và tenant isolation trên database test.
- `npm run cms:worker -- --test --once` đã xử lý publication local thành công.
- `npm run cms:e2e` đã kiểm SSO UI, website, collections, media registry và axe WCAG với 0 violation.
- `npx tsx --test tests/cms-contracts.test.ts tests/cms-connectors.test.ts` đã pass 7 tests.
- `npm test` đã pass 289 tests trong lần hồi quy ngày 16/11/2026; log tại `.local/evidence/cms-npm-test-resume-20261115.log`.
- Client `aio-cms` đã được provision local và fixture quyền dùng tài khoản synthetic `demo.learner` do self-assignment guard bảo vệ `demo.admin`.
