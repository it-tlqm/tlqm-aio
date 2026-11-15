# Nghiệm thu AIO Quy trình local

Ngày ghi bản đầu 10/11/2026. Module Quy trình chạy xuyên suốt tại local với các phần phù hợp được tái sử dụng từ BOS. [Runbook](WORKFLOWS_LOCAL_DEVELOPMENT.md), [ADR và đối chiếu nguồn](decisions/0005-workflows-bos-reuse.md). Các phần bên dưới giữ bằng chứng lịch sử. [E0–E4 ngày 11/11](../roadmap/GOAL_CONFIGURABLE_SUITE.md) bổ sung đồng duyệt, người xử lý theo cơ cấu, lịch, thông báo và liên kết hồ sơ. [Đối chiếu sâu AMIS](WORKFLOWS_AMIS_GAP_ANALYSIS.md) và [lộ trình tiếp theo](../roadmap/WORKFLOWS_NEXT.md) ghi các phần còn mở.

Sau E0–E4, bản Quy trình local đã bổ sung bảng chi tiết, nháp hồ sơ, tham chiếu nhân sự và đơn vị, cùng cấu hình trường khởi tạo tại từng bước. W1c đạt 224 tests và 12/12 lệnh hồi quy. Lượt browser ghi 12 lượt axe không báo vi phạm, có mục chưa kết luận tự động trong receipt. [Roadmap và bằng chứng Quy trình](../roadmap/GOAL_WORKFLOWS_COMPLETE.md). [Cách cấu hình quyền trường theo bước](WORKFLOWS_BUSINESS_FORMS.md#dữ-liệu-khởi-tạo-tại-từng-bước).

## Phạm vi và nguồn

AIO nhánh feat/foundation-mvp trên baseline abea705b0937fe164fa9c983700089bec88c82ba, worktree dirty/chưa commit. Không commit/push/PR/deploy. Node quan sát 24.20.0, TypeScript + Fastify, React/Vite/Tailwind v4/shadcn. Client aio-workflows tại 4105; database và runtime riêng.

BOS nhánh codex/crm-app-yms, HEAD 818de77907bf6a2067807889afb708d6142c767b, dirty tại thời điểm đọc. [Snapshot nguồn](BOS_WORKFLOW_SOURCE_SNAPSHOT.json) ghi hash từng file đã chọn. Đã trích condition-only engine, condition conformance cases, auto-layout Dagre; áp dụng pattern kiểm graph/version/transaction. Không copy auth, Prisma/Nest, Ant Design hoặc metadata Entities. Năm file nguồn được kiểm lại khớp hash đã chụp; không chạy/sửa/cài packages ở BOS.

## Chức năng đã kiểm chứng

| Phần | Kết quả |
| --- | --- |
| SSO/phân quyền | Client/audience/cookie riêng; Portal → Quy trình cùng browser. Design/publish/manage cần MFA, handler chỉ xử lý nhiệm vụ được giao trong unit hiện hành. Designer không phát hành hoặc đọc hồ sơ chỉ bằng quyền thiết kế. |
| Thư viện và biểu mẫu | Mẫu mua sắm/nghỉ phép/tự thiết kế; dùng lại FormSchema, designer, renderer, validation hữu hạn của AIO Forms. Form khởi tạo và form tại bước tách dữ liệu vào Workflows. |
| Thiết kế sơ đồ | Start/Approval/Task/Condition/End, thêm/xóa bước, kéo vị trí, nối hoặc chọn đích, tự bố trí bằng code layout BOS. Có chọn bước qua control để dùng bàn phím. |
| Điều kiện | Engine BOS thuần TypeScript, conformance parity. UI biên tập VÀ/HOẶC lồng, không làm mất rule khác khi sửa một dòng; publish đọc lại cấu trúc đã lưu. Adapter kiểm thêm ngày lịch thực. |
| Phát hành | Draft tách version append-only. Ngừng/mở phát hành kiểm revision. Hồ sơ v1 không thay khi phát hành v2; không dùng version cũ cho lượt mới sau thay đổi. |
| Thực hiện | Người dùng điền form/đơn vị, gửi đề nghị. Inbox riêng; phê duyệt/từ chối hoặc hoàn tất công việc; form tại bước kiểm tra ở backend. Nhánh dưới/từ 10 triệu đã được thử theo mẫu giả lập. |
| Trả về/gửi lại | Vòng mới theo version gốc; giữ snapshot inputs, quyết định, kết quả và thời điểm vòng trước. Ngừng phát hành không làm mất khả năng hoàn thành lượt đã có. |
| Điều phối và hủy | Phân công lại cần quyền manage và assignee đủ quyền; người cũ mất quyền xử lý task. Hủy dừng task đang chờ, giữ lịch sử. |
| Audit/concurrency | Quyết định/đóng task/chuyển bước/audit/receipt cùng transaction. Retry không sinh task trùng; hai quyết định đồng thời chỉ một được ghi. Kiểm lại quyền trước commit; audit lỗi rollback toàn bộ. |
| Ranh giới | Cấm tự duyệt cùng account/person; deny sai assignee/unit/tenant, designer đọc hồ sơ. Workflows runtime không CONNECT Identity/Forms; runtime các module cũ không CONNECT Workflows. |
| Theo dõi | Lượt tôi gửi/cần xử lý/toàn bộ theo quyền, 100 dòng mỗi trang; sơ đồ bước hiện tại, lịch sử ý kiến, dữ liệu các vòng và báo cáo trạng thái/quá hạn theo scope. Deadline quá hạn không tự duyệt hoặc tự reject. |
| Setup/rollback | Chạy lại setup/fixtures giữ credentials, quyền đã thu hồi và các bảng lịch sử bất biến. Explicit restore của fixture được audit. Mẫu local được tạo/phát hành qua MFA/API thật, giữ receipt ownership. |

## Kết quả chạy

- npm run check: **95 tests, 0 fail/skip**, format/TypeScript và build UI/API pass. Workflows có 11 tests contract/engine/service/PostgreSQL; test conformance BOS dùng fixtures thuần, không chạy app BOS.
- test:workflows cuối pass **2026-11-09T21:46:53Z**: thiết kế và cấu hình AND/OR qua UI, MFA publisher, SSO, high/low branches, form task, return/resubmit, v1 sau v2, CSRF, live grant revoke đo **8 ms** local không tải, retry HTTP.
- Sáu axe scans (compound conditions, designer, task form, history, run mobile, report), 0 violations; incomplete rules giữ trong báo cáo. Đã xem ảnh designer/history/mobile. Sửa nhãn nút để tên truy cập chứa chữ hiển thị và chiều cao TabsList theo số hàng; có kiểm tra geometry để tab không đè panel trên mobile, có đăng xuất mobile. Không chứng nhận WCAG toàn sản phẩm.
- test:workflows-onboarding pass **21:36:30Z**: verified operator MFA, credentials, revoked grant/binding, version/input/result history giữ nguyên qua rerun.
- Hồi quy tuần tự: Foundation ba suites pass kết thúc **21:38:22Z**; Forms API **21:38:31Z**; Forms UI **21:39:03Z**; LMS **21:39:16Z**. Không dùng source mới để suy ra kết quả runtime cũ.
- npm audit sau thêm React Flow/Dagre: **0 advisory** gồm dev dependencies. Không thay container scan.
- workflows:demo đã tạo/phát hành mẫu “Đề nghị mua sắm · Mẫu TLQM” trong database local qua đúng designer/publisher MFA, không dùng dữ liệu khách hàng.

Artifacts ignored .local/evidence: workflows-e2e.json, workflows-rehearsal.json, workflows-regression.json, workflows-npm-audit.json, workflows-bos-verification.json, ảnh workflows-designer/history/run-mobile; snapshot source workflows-revision.json. Các snapshot Foundation/Forms/LMS trước là evidence lịch sử, không đại diện toàn source mới.

## Giới hạn bản đầu

Đây là functional module local, không phải bản sao đầy đủ AMIS. Chưa có parallel/quorum, người duyệt động theo quản lý/nhóm/chức danh, bảo mật từng trường, bình luận/mentions độc lập, attachment/ký số, mail/notification scheduler, mẫu in hoặc connector kế toán. Không có migration dữ liệu BOS thật. Giới hạn graph/điều kiện/danh sách, data sharing và kiểu số ghi tại runbook. Các phần này có backlog riêng, không gắn nhãn đã hoàn thành.

Chưa production/TLS/HA, tải lớn, restore database Workflows hoặc thiết bị MFA thật. Giữ phạm vi local và synthetic data; authority/hosting/secret store của hệ thống thực cần đợt riêng.

## Đối chiếu lại trạng thái source hiện tại

Lượt rà ngày **15/11/2026**, giờ Việt Nam, đọc trực tiếp worktree đang dirty và các test hiện hành. Phần baseline phía trên giữ nguyên lịch sử của các mốc cũ. Source hiện tại đã có thêm các hợp đồng và luồng sau.

| Năng lực | Hiện trạng kiểm chứng trong worktree | Bằng chứng kỹ thuật |
| --- | --- | --- |
| Nhánh và hợp nhánh | WorkflowSpec v5 có nhánh song song, nguồn bắt buộc và join theo round/attempt. Lượt return chỉ mở lại nhánh phụ thuộc. | `src/workflows/execution-graph.ts`, `tests/workflows-business.test.ts`, `tests/workflows-contracts.test.ts` |
| Đồng duyệt | Pool `all`, `any`, `quorum`, veto và thay người chưa bỏ phiếu được kiểm theo person, revision, quyền hiện hành và idempotency. | `src/workflows/pool-approvals.ts`, `tests/workflows-pools.test.ts`, `frontend/src/workflows/pool-progress.tsx` |
| Cộng tác | Follower, bình luận, mention, notification và quyền đọc theo run/task đã có API, audit và UI. Người theo dõi không được thực hiện quyết định. | `src/workflows/collaboration.ts`, `src/workflows/service.ts`, `frontend/src/workflows/discussion.tsx`, `tests/workflows-service.test.ts` |
| Tệp và tài liệu | Attachment theo draft/round/step field, quarantine, quyền tải và document library theo edition đã có boundary và rollback. | `src/workflows/attachments.ts`, `src/workflows/document-library.ts`, `tests/workflows-document-library.test.ts` |
| Liên kết và lịch | Liên kết tạm ứng, linked requests, mapping field, scheduler tạo draft và retry có scope đã có kiểm tra stale source, revoke và chống trùng. | `src/workflows/linked-requests.ts`, `src/workflows/scheduled-requests.ts`, `tests/workflows-linked-requests.test.ts`, `tests/workflows-scheduled-requests.test.ts` |
| Báo cáo | Báo cáo hiệu quả, báo cáo theo field, drill-down, export và scope hiện hành đã có contract/UI. | `src/workflows/performance-reports.ts`, `frontend/src/workflows/performance-report.tsx`, `tests/workflows-performance-report.test.ts` |
| Tham chiếu và quyền trường | Reference snapshot, field access, redaction, workflow-v5 input và kết quả từng attempt được kiểm ở service và contract. | `src/workflows/references.ts`, `src/workflows/field-access.ts`, `tests/workflows-references.test.ts`, `tests/workflows-business-service.test.ts` |

Đối chiếu này không gộp đồng duyệt vào nhánh song song. Hai cơ chế vẫn được kiểm và hiển thị riêng. Acceptance của một module production vẫn cần staging, tải, backup/restore và connector được cấp phạm vi riêng. Những phần còn mở trong roadmap là ký số, connector production, BPMN parity, lịch làm việc đầy đủ theo DST và các yêu cầu vận hành ngoài local.

## Nâng cấp nhóm và người xử lý

Đã nghiệm thu local ngày 10/11/2026 trên cùng nhánh/baseline AIO, worktree chưa commit. [Cách dùng và hợp đồng](WORKFLOWS_ASSIGNMENTS.md), [ADR 0006](decisions/0006-workflow-assignment-policies.md). Source BOS của đợt này được kiểm tại HEAD a17d87a1bfe0176e6319fbc0cf2393d1e85fb5fc, nhánh codex/crm-app-yms, dirty; ba file chọn lọc vẫn khớp [snapshot](BOS_ASSIGNMENT_SOURCE_SNAPSHOT.json). Snapshot bản đầu không bị thay thế.

- Nhóm xử lý theo tenant/unit, quản lý bằng workflows:manage/MFA; membership không tự cấp quyền IAM. Ngừng nhóm hoặc bỏ thành viên chặn nhiệm vụ tương ứng theo quyền hiện hành.
- WorkflowSpec v2: chọn người trong nhóm khi gửi/gửi lại; lưu choices và group revisions bất biến theo round. Giao cho người thực sự hoàn thành một bước chắc chắn đứng trước trên mọi nhánh, trong cùng round. V1 và các versions/runs cũ giữ nguyên.
- Reassign trong đúng pool nhóm, chống tự duyệt cùng account/person, thông báo nhiệm vụ chưa đủ điều kiện. Migrations Workflows 001–002 bất biến; dữ liệu nhóm/assignment thuộc database Workflows.
- npm run check pass **103 tests**, 0 fail/skip, format/TypeScript/build; gồm 8 tests mới và 11 tests Quy trình trước đó. Không tắt kiểm tra auth hoặc kiểm tương phản để đạt pass.

| Hồi quy tuần tự | Hoàn tất UTC ngày 09/11/2026 | Kết quả |
| --- | --- | --- |
| check | 23:45:03 | Pass |
| test:workflows | 23:45:26 | Pass |
| test:workflows-assignments | 23:45:48 | Pass |
| test:workflows-onboarding | 23:45:51 | Pass; giữ cả assignment snapshots/groups/members khi rerun |
| test:e2e | 23:47:53 | Cả ba suite Foundation pass |
| test:forms-api | 23:48:01 | Pass |
| test:forms-ui | 23:48:34 | Pass |
| test:lms | 23:48:47 | Pass |

E2E mới kiểm manager MFA/group UI, designer rule v2, chọn người, revoke member khi task pending, deny theo quyền, reassign trong pool, actual actor sau reassign, return/resubmit với lựa chọn mới và bảo toàn round trước. Bốn axe scans của group dialog/designer/requester/resubmit mobile có zero violations; incomplete rules được giữ. Đã xem ảnh designer và mobile. Đây là kiểm tra tự động trong phạm vi đã nêu, không phải chứng nhận WCAG toàn sản phẩm.

Mẫu “Đề nghị mua sắm · Chọn người trong nhóm” đã được tạo/phát hành qua designer/publisher MFA và API thật trong AIO local. Đã đọc lại version v2, group active/hai member, rule review theo nhóm và fulfil theo actual actor của review. Chạy lại cả workflows:demo và workflows:demo-assignments giữ nguyên hash nội dung của 11 bảng Workflows, gồm mẫu cũ, group/member, versions/runs/task/results, inputs/assignments, audit/receipts. Không cập nhật mẫu đã được người dùng chỉnh.

Evidence ignored .local/evidence: workflows-assignment-regression.json, workflows-assignments-e2e.json, workflows-assignment-demo.json, workflows-assignment-bos-verification.json, workflows-assignment-revision.json; ảnh workflows-assignment-designer.png và workflows-assignment-mobile.png. Snapshot workflows-revision.json của bản đầu là lịch sử. Snapshot nâng cấp mới ghi hash source/config/docs được chọn, nhánh/HEAD và trạng thái dirty; không chứa config bí mật.

Giới hạn hiện tại: chọn người cho mọi bước nhóm ở đầu mỗi round, kể cả nhánh có thể được bỏ qua; chưa chọn ở từng lần bàn giao. Chưa có parallel/quorum, quản lý trực tiếp/chức danh, bảo mật từng trường, attachment/ký số hoặc thông báo ngoài ứng dụng. Quyền độc lập của người khởi tạo/điều phối/nhiệm vụ khác có thể vẫn cho phép xem hồ sơ sau khi mất một membership; không tuyên bố thu hồi toàn bộ lịch sử trong trường hợp đó. Chưa triển khai production hoặc tích hợp dữ liệu BOS thật.
