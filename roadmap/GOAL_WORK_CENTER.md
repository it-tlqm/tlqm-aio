# Goal — Trung tâm công việc và thông báo dùng chung

Ngày 11/11/2026. Người dùng chấp thuận triển khai liên tục cả bốn phần đến khi nghiệm thu. Phạm vi AIO local giả lập, giữ dirty worktree trên feat/foundation-mvp; không commit/push/deploy. Goal engine từ chối tạo goal vì LMS cũ vẫn unfinished/blocked tại Vimeo; không đánh dấu LMS complete sai thực tế. Tài liệu này giữ mục tiêu và bằng chứng của công việc mới.

| Mốc | Tiêu chí | Trạng thái |
| --- | --- | --- |
| 1 | Việc được giao, đề nghị đã gửi, cần bổ sung/chờ duyệt/quá hạn; lọc, phân trang, mở đúng hồ sơ | Đã đạt API/UI/hồi quy |
| 2 | Thông báo giao việc/duyệt/trả về/hoàn thành, đọc/chưa đọc; không lộ dữ liệu và số đếm sau thu hồi quyền | Đã đạt API/UI/hồi quy |
| 3 | Nhắc trước hạn/quá hạn có cấu hình, DB bền vững, idempotency/concurrency/restart; kiểm trạng thái và tắt được | Đã đạt API/UI/hồi quy |
| 4 | Theo dõi tồn theo đơn vị, người xử lý và thời gian chờ; scope backend, quyền quản lý/report riêng | Đã đạt API/UI/hồi quy |

## Ràng buộc và cách triển khai

Portal cung cấp hợp đồng nguồn công việc chung; nguồn đầu tiên là Quy trình, chưa tuyên bố đã tích hợp nhiệm vụ Forms/LMS. Dữ liệu nghiệp vụ/thông báo/SLA thuộc module nguồn, không đưa vào lõi IAM. Actor được kiểm lại trên grant/role/membership nguồn, không dùng quyền Portal thay quyền Quy trình. Badge/count/deep link không thay hàng rào backend. Không tự sinh quyền từ chức danh.

Thông báo chỉ ở trong AIO; không gửi email, SMS, Slack hoặc ra ngoài. Nhắc hạn có khóa/concurrency và khóa duy nhất ở DB; tiến trình chết có thể chạy lại, không mất trạng thái hay phát trùng. Giữ MFA/CSRF/revision/audit/idempotency, tenant/unit/revocation. Migration chỉ thêm Workflows 004+ và Foundation 007+ nếu cần; giữ checksum/journal cũ. Chỉ dữ liệu giả lập, không đọc/in secrets hoặc sửa/chạy LMS/BOS/YMS cũ.

## Nghiệm thu

API/UI hoạt động đầy đủ; tests quyền chéo/thu hồi, transaction rollback, worker đồng thời/chạy lại, cấu hình nhắc hạn, thông báo đúng đối tượng và dữ liệu thật từ Quy trình. Chạy check + E2E nghiệp vụ + hồi quy SSO/Forms/LMS/Quy trình tuần tự. UI shadcn/TLQM/Be Vietnam Pro, desktop/mobile/bàn phím/axe và xem ảnh thật. Lưu source hashes/receipts, hướng dẫn vận hành/rollback; mở stack local khi bàn giao. Chỉ đánh hoàn tất cả bốn sau bằng chứng tương ứng.

## Diễn biến và bằng chứng

- Đã áp dụng Workflows 004 qua scripts có guard local/test và giữ owner/runtime isolation. API/UI/typecheck/build đầu lượt pass.
- E2E đầu phát hiện query string cần schema chuỗi vì Fastify không coerce/useDefaults: sửa endpoint, không nới validation toàn app. Đã sửa selector/markup text thông báo để kiểm chính xác nhãn không gộp badge.
- `test:work-center` pass 8 axe scans và kiểm SSO deep link lần đầu, quyền nguồn, đọc/chưa đọc, nhắc hạn đồng thời, manager và completion. Đã xem ảnh desktop/mobile.
- Backend/navigation có 6 tests mới pass: phân quyền/revocation/idempotency/CAS, trạng thái kết quả, nhắc hạn concurrent/restart/tắt chính sách, overdue/rollback, lỗi tenant không chặn tenant khác, local hash target có hạn và dùng một lần.
- Receipt `.local/evidence/work-center-regression-before-tenant-isolation.json`: check exit 0 nhưng sourceStable=false khi bổ sung cách ly lỗi worker trong lượt, không dùng làm nghiệm thu cuối. Mã đã cố định cho lượt `.local/evidence/work-center-regression.json`.
- [Runbook, giới hạn và rollback](../docs/WORK_CENTER.md). Chỉ thông báo trong AIO, không gửi ngoài ứng dụng.

## Kết quả chốt lát cắt

11/11/2026: hồi quy kết thúc 19:14:49Z ngày 10/11/2026, **156 tests, 8 lệnh pass**, sourceStable=true cho 290 file. Receipt `.local/evidence/work-center-regression.json`. Tài khoản workflows.admin đã có Portal cá nhân và giữ quyền Quy trình/MFA/password; receipt `work-center-review-account.json`, hướng dẫn `.local/WORK-CENTER-TRY.md`. Đã xem ảnh desktop/mobile; 8 axe scans không violations (không phải chứng nhận WCAG đầy đủ).

Người dùng đã mở rộng công việc sang [bộ ứng dụng cấu hình toàn diện](GOAL_CONFIGURABLE_SUITE.md). Chốt lát cắt Work Center không có nghĩa toàn bộ phạm vi mới hoặc Vimeo đã hoàn tất.
