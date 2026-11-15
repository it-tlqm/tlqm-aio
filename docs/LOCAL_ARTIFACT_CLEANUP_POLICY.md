# Quy tắc dọn artefact cục bộ TLQM AIO

Phạm vi của quy tắc này là dữ liệu giả lập và artefact phát hành trong workspace AIO. Không áp dụng cho source LMS/BOS cũ, database đang dùng, môi trường từ xa hoặc production.

## Giữ lại

- Source worktree, `.git`, migration, snapshot và các thay đổi dirty của người dùng.
- `.local/evidence`, `.local/enterprise-recovery`, receipt, log hồi quy và các release được tài liệu hoặc receipt tham chiếu.
- Candidate hiện hành và archive cần cho việc dựng lại. Trong đợt này candidate v40 nằm ở `C:/Users/thanhnx/.codex/aio-v40-oidc`.
- `C:/Users/thanhnx/.codex/tlqm-aio-nvda-2026.3.1` cho đến khi hoàn tất bằng chứng E4.
- Mã nguồn, receipt và binary tái lập của OpenBao. Chỉ xóa `go-build-cache` khi không có tiến trình đang dùng.
- Credential, key, cookie, database local, lock và cấu hình runtime. Không đọc hoặc đưa nội dung của chúng vào receipt.

## Chỉ xóa khi đủ điều kiện

- Cache dựng lại được như `node_modules`, `dist`, Go build cache và thư mục staging tạm.
- Snapshot source cũ chỉ khi tên thư mục không xuất hiện trong `docs`, `roadmap` hoặc `.local/evidence`, đồng thời không thuộc candidate hiện hành.
- Release cũ chỉ khi không có tài liệu hoặc receipt tham chiếu. Không dùng `git clean`.
- Thư mục rỗng, log hoặc pid stale chỉ sau khi kiểm tra không còn tiến trình AIO sử dụng.

## Quy trình bắt buộc

1. Kiểm tra branch, dirty worktree, Docker endpoint và tiến trình đang mở tệp trong phạm vi dọn dẹp.
2. Lập danh sách đường dẫn tuyệt đối và tính byte trước khi xóa.
3. Chạy bản xem trước với `-WhatIf`, sau đó chỉ xóa các đường dẫn thuộc allowlist đã đối chiếu.
4. Ghi receipt JSON với thời gian `Asia/Ho_Chi_Minh`, đường dẫn, loại artefact, byte trước và trạng thái tồn tại sau khi xóa.
5. Kiểm tra lại source digest, evidence, candidate release và dung lượng ổ đĩa. Không sửa receipt cũ.

## Phạm vi cấm

Không xóa toàn bộ `C:/Users/thanhnx/.codex`. Không xóa `sessions`, `archived_sessions`, `auth`, `sqlite`, `plugins`, `skills`, `attachments`, `automations`, `packages`, worktree source hoặc dữ liệu của ứng dụng khác.
