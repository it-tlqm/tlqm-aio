# LMS — Bảng điểm, báo cáo và Directory AIO

Ngày 10/11/2026. Phần báo cáo G7 trong [goal hoàn thiện LMS](../roadmap/GOAL_LMS_COMPLETE.md). Chỉ local/dữ liệu giả lập; quản trị học viên SSO mới và bàn giao tài khoản chưa hoàn tất.

## Sử dụng

Reviewer hoặc admin mở **Bảng điểm & báo cáo**. Lọc theo đơn vị AIO, khóa học, trạng thái, từ khóa và chỉ môn bắt buộc. Bảng có 50 học viên mỗi trang; nút **Chi tiết** xem tỷ lệ xem, số lượt thi và lần nộp cuối của các khóa được phân. Thống kê và bảng tổng hợp đơn vị luôn áp dụng cùng bộ lọc. Các tab **Lịch sử đơn vị / Lịch sử quản trị** vẫn là dữ liệu legacy, không dùng chúng thay gradebook domain mới.

**Xuất báo cáo Excel** tạo tệp XLSX bốn sheet: Tong_quan, Bang_diem, Chi_tiet, Don_vi. Xuất toàn bộ kết quả theo bộ lọc, không chỉ trang đang xem. Tối đa 5000 học viên và 100000 ô học viên–khóa học mỗi tệp; vượt giới hạn phải lọc nhỏ hơn, không cắt bỏ âm thầm. Ô tên/mã/tiêu đề được tạo dạng text, không thực thi chuỗi giống công thức. Không có answer key hoặc nội dung đáp án trong báo cáo.

## Định nghĩa số liệu

- Chỉ **version đang phát hành** của khóa active, và phân công theo đơn vị hiện hành. Version mới chưa học sẽ có điểm trống/0 lượt thi, dù version cũ từng đạt. Bài làm/chứng nhận cũ vẫn giữ trong lịch sử.
- Điểm ô là điểm tốt nhất của học viên trong đúng version; lượt thi đếm tất cả attempt của version, lần nộp cuối dùng timestamp attempt. Tỷ lệ xem từ tiến độ LMS, giới hạn 0–100, không tự đồng nghĩa đã đạt bài thi.
- Chi tiết và Excel phân biệt **Trình phát ghi nhận** với **Người học tự xác nhận** (Google Drive); không gộp xác nhận thủ công thành thời gian xem do player đo.
- Đạt yêu cầu khi mọi môn bắt buộc được phân trong bộ lọc đạt ít nhất 80. Người không có môn bắt buộc có trạng thái riêng, không giả hoàn thành hoặc tỷ lệ 100%. Khi không có ai có yêu cầu, tỷ lệ là không áp dụng/null.
- Trung bình lấy best score của các cặp học viên–version đã có bài thi, không điền 0 cho người chưa thi và không làm tăng trọng số người thi lại nhiều lần.
- Quá hạn là lượt học bắt buộc chưa đạt với hạn trước ngày hiện tại tại Asia/Bangkok; không gọi số này là số người quá hạn.
- Chọn một khóa chỉ giữ người được phân khóa đó. Không chọn khóa riêng: bảng có dấu — cho môn không thuộc phân công của một học viên.

## Directory và quyền

Foundation có POST `/api/v1/integrations/:appCode/directory`, query kind=units/people, tenantId, orgUnitId/accountIds/cursor/search có giới hạn. Mỗi request cần bearer của đúng external app và service proof HMAC riêng directory-v1, gắn toàn bộ query/app/token/timestamp ±30 giây. Proof subjects-v1 không dùng lại được. Response maxAgeSeconds=0, cursor 100; không trả email hoặc subject của người được tra cứu.

Capability **directory:lookup** phải được cấp rõ trong role của ứng dụng. Governance yêu cầu operator có cả **directory:read** và **people:read** Foundation trong phạm vi tương ứng khi cấp role/binding hoặc bật capability; app delegate không thể tự nâng quyền đọc Directory qua một mã permission tùy ý. Backend LMS tiếp tục giao scope này với lms:review/admin và mapping hiện hành. Chỉ người active, có quan hệ công tác/identity/grant cho chính app và mapping đúng account+person+unit mới có trong báo cáo.

Tên người và đơn vị lấy từ Foundation cho request hiện tại, không sửa department/name lịch sử trong employees. Màn danh sách phân công khóa học/owner unit lấy đơn vị AIO active; save/publish kiểm reference ở backend. Header người học dùng tên đơn vị công tác của chính người đăng nhập.

Chuẩn bị một lần sau `lms:setup`:

~~~powershell
npm run lms:directory
~~~

Lệnh chỉ nối hai database AIO local/test có marker đúng, xác thực operator MFA, dùng GovernanceService và audit/revision/idempotency. Cấp directory:lookup cho LMS manager/admin, không đổi grant/binding. Receipt provision giữ để lần chạy sau không phục hồi permission bị thu hồi. Rollback capability qua trang Vai trò & truy cập của Foundation bằng revision hiện hành; không xóa receipt để ép cấp lại. Muốn cấp lại phải là thao tác quản trị rõ ràng.

Export kiểm quyền và đọc dữ liệu hiện hành mỗi lần, kể cả retry. Receipt chỉ lưu digest/count/thời điểm, không lưu bảng điểm hoặc tên người. Nếu dữ liệu/scope đổi giữa hai lần cùng key, từ chối với LMS_REPORT_CHANGED; tải lại để xuất mới. Audit chỉ ghi metadata/digest, không cell contents. Không trả snapshot cũ để vượt việc người học bị thu hồi grant.

## Bằng chứng hiện có

Ngày 10/11/2026 07:51Z, `test:lms-reports` pass 4 axe scans: Directory proof/query/scope, tên AIO, learner bị chặn report, reviewer A không đọc C, số liệu mandatory/optional/best/retake/deadline, XLSX thật bốn sheet, retry/dữ liệu đổi, publish v2 và giữ result v1, target grant/lookup revocation, setup không hồi quyền, desktop/mobile/bàn phím. Ảnh đã xem; incomplete checks giữ trong `.local/evidence/lms-reports-e2e.json`. Test Directory có 105 hồ sơ trùng tên, cursor không mất dữ liệu và rollback fixture test.

Phần báo cáo đã được kiểm lại trong hồi quy G7 và local review. Quản trị học viên SSO-only/mapping và tài khoản dùng thử đã được triển khai, xem [runbook học viên](LMS_LEARNER_ADMIN.md). Migration 006 đã áp dụng local/test, giữ nguyên credentials/lịch sử legacy và cho hồ sơ SSO-only không password; 001–006 bất biến. Toàn goal vẫn chờ hồi quy/đối chiếu cuối G8.
