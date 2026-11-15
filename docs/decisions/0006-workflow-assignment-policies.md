# ADR 0006 — Nhóm và lựa chọn người xử lý trong Quy trình

Ngày 10/11/2026. Người dùng yêu cầu tiếp tục nâng cấp, giữ hướng AMIS và ưu tiên tái sử dụng BOS. Đợt này xử lý mục đầu của backlog, không thay engine bằng source BOS nguyên khối.

## Nguồn BOS đã đối chiếu

Đường dẫn D:/thanhnx/OpenCode/BOS/bos-workspace, nhánh codex/crm-app-yms, HEAD a17d87a1bfe0176e6319fbc0cf2393d1e85fb5fc, worktree dirty tại snapshot 2026-11-09T23:42:09Z. Ba file chọn lọc đã đối chiếu lại và vẫn khớp hash khi chốt nâng cấp. Snapshot mới khác ADR 0005; không ghi đè evidence cũ. [File/hash chọn lọc](../BOS_ASSIGNMENT_SOURCE_SNAPSHOT.json). Hash mô tả nội dung worktree đã đọc, không suy ra toàn bộ nội dung thuộc HEAD.

- governance-approval-selector.registry.ts: candidate phải tường minh, duy nhất, có giới hạn và thứ tự chuẩn; quyền/scope là điều kiện giải quyết selector. workflowCandidateIds trong AIO điều chỉnh mô hình này sang UUID chuẩn hóa chữ thường; cho phép nhóm rỗng để chuẩn bị cấu hình, nhưng không phát hành khi thiếu ứng viên hợp lệ.
- stepAssigneeUtils.ts: phân biệt gán cố định, nhóm và chọn động; giữ cấu hình không bị ghi đè bởi tab chưa chỉnh. AIO dùng kiểu dữ liệu assigneeRule có cấu trúc, không copy expression $role/$record hoặc phụ thuộc @bos/core/Ant Design.
- workflows.service.ts: người thao tác phải thuộc tập cho phép ở bước hiện hành. AIO áp dụng đồng thời app permission, assignment và membership nhóm hiện hành. Không copy Prisma/Nest, Redis, Mailer hay OTP qua email.

Chỉ đọc source, không chạy/sửa/cài package hoặc thao tác dữ liệu BOS. Adapter hiện có condition engine/layout vẫn giữ nguồn ở ADR 0005.

## Quyết định

1. WorkflowSpec v1 giữ gán cố định. Draft đổi cách giao sang nhóm/người bước trước dùng schemaVersion 2; versions/runs đã phát hành không bị đổi hay backfill cấu hình.
2. Nhóm sở hữu bởi Workflows, có tenant và unit hoặc phạm vi toàn workspace; không phải Keycloak group hay role IAM. Quản lý nhóm dùng workflows:manage và MFA, theo phạm vi. Thành viên không tự có app grant/role.
3. Gán nhóm là chọn một người trong nhóm khi khởi tạo hoặc gửi lại. Cần chọn cho mọi bước kiểu nhóm trong definition, kể cả nhánh có thể bị bỏ qua. Candidates giao giữa membership active, group active/unit, account/person/app grant/role hiện hành và chống tự duyệt cùng person.
4. Lựa chọn và group revision lưu append-only theo run/round. Thay đổi nhóm có hiệu lực khi truy cập/thao tác; không hồi lựa chọn hoặc quyền cũ bằng snapshot. Nhóm ngừng không xóa case/task; điều phối viên đối soát rồi phân công trong phạm vi nhóm còn hiệu lực.
5. assigneeRule previous chỉ nhận human step chắc chắn đi qua trước trên mọi nhánh. Resolver lấy actor thực sự hoàn thành bước trong cùng round từ result bất biến, kể cả sau phân công lại; không lấy tên cấu hình hoặc kết quả round trước. Cấm tự duyệt vẫn áp dụng.
6. Điều phối viên vẫn có thể thay người của bước cố định/previous bằng hành động reassign đã có và audit. Bước kiểu group chỉ được đổi trong pool của nhóm đang active; không dùng manage để vượt pool.
7. Mọi mutation nhóm/selection/action dùng chung khóa tenant, revision, idempotency, audit và kiểm lại actor/quyền trước commit. Group changes không thao tác Foundation DB; boundary kiểm candidate bằng API nội bộ có contract.

Migration Workflows 002 bổ sung groups/members, run-assignment snapshots, FK task→group và guards. Audit unit được nullable để biểu diễn nhóm toàn workspace. Migration 001 và tất cả migration đã áp dụng của module khác giữ nguyên.

## Ranh giới còn lại

Chưa chọn người ở từng lần chuyển bước, chưa resolve quản lý trực tiếp/chức danh/vị trí, chưa fan-out/quorum. Một bước vẫn sinh một nhiệm vụ. Global group không có nghĩa là người trong đó được xử lý mọi unit; live app permission của người đó vẫn quyết định. Scope nguồn group không được chuyển bằng update; tạo nhóm khác khi cần đổi phạm vi.
