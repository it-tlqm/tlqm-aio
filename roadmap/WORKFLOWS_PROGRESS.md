# Module Quy trình — tiến độ

Ngày 10/11/2026. Người dùng yêu cầu nâng cấp theo AMIS Quy trình, ưu tiên lấy thành phần có thể dùng từ BOS, không hỏi thêm. Đây là nhiệm vụ mới sau goal Foundation/Forms/LMS đã complete; không tự tạo automation hoặc đẩy Git.

## Đợt local đầu đã chạy

- Module/app/DB riêng: aio-workflows, 4105, PostgreSQL aio_workflows/aio_workflows_test, migration 001 immutable.
- Reuse BOS condition engine + conformance fixtures + Dagre layout, reference graph/version/transaction; source cụ thể và hash ở ADR 0005. Không sửa source BOS/LMS/YMS.
- Thư viện mẫu, Form Builder tại bước, sơ đồ, điều kiện AND/OR, publish version, inbox/run/task, approve/reject/return/complete, resubmit, cancel, reassign, timeline/report.
- 95 tests và full hồi quy local pass; 6 axe scans zero violation, incomplete giữ trong evidence. [Nghiệm thu](../docs/WORKFLOWS_ACCEPTANCE.md), [runbook](../docs/WORKFLOWS_LOCAL_DEVELOPMENT.md).

## Nâng cấp nhóm/người xử lý đã nghiệm thu local

Migration 002, WorkflowSpec v2; nhóm ứng dụng, chọn người đầu round, previous actor có kiểm graph và quyền live đã qua domain/E2E. Full check **103 tests** và toàn bộ hồi quy Quy trình/Foundation/Forms/LMS pass, kết thúc 2026-11-09T23:48:47Z. Bốn axe scans của màn hình mới không có violations; incomplete được giữ trong evidence. [Chi tiết](../docs/WORKFLOWS_ASSIGNMENTS.md), [nghiệm thu](../docs/WORKFLOWS_ACCEPTANCE.md#nâng-cấp-nhóm-và-người-xử-lý). Bản v1 và journal migration trước đó giữ nguyên.

Mẫu v2 “Đề nghị mua sắm · Chọn người trong nhóm” đã phát hành ở database local. Chạy lại cả hai lệnh mẫu giữ nguyên nội dung 11 bảng Workflows; evidence workflows-assignment-demo.json. Không commit/push hoặc thao tác production trong đợt này.

## Backlog nâng tiếp theo hướng AMIS

1. Selector mở rộng: nhóm ứng dụng/chọn đầu round/người xử lý trước đã có; còn chọn người bởi người chuyển bước, quản lý trực tiếp/chức danh. Tiêu chí chọn không tự cấp quyền app.
2. Song song và join/quorum: đánh giá tách phần pure graph/threshold/quorum của governance-approval-engine BOS, adapters UUID/AIO authority; negative tests branch/join/revoke/retry trước khi mở UI.
3. Bảo mật trường/từng bước, danh sách người theo dõi, bình luận nội bộ và timeline chi tiết.
4. Inbox chung Portal, thông báo trong app và nhắc hạn qua outbox có retry/idempotency; chỉ gửi kênh ngoài khi được giao rõ.
5. Tệp đính kèm và mẫu in; cần storage tách biệt, quyền download, kiểm loại/kích thước, audit/retention và restore.
6. Connector sang ứng dụng được giao, ký số/tích hợp thật; không tự triển khai hoặc sửa BOS hiện hữu từ bản local này.

Không gọi những mục backlog là đã có. Mỗi đợt phải giữ migration đã áp dụng, snapshot version, quyền backend và audit nguyên tử.
