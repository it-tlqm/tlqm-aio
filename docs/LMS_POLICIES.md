# LMS — chính sách học và thi có phiên bản

Ngày 11/11/2026. Phần E3a của [goal cấu hình mở](../roadmap/GOAL_CONFIGURABLE_SUITE.md). Workspace `D:/thanhnx/TLQM-AIO`, nhánh `feat/foundation-mvp`, baseline `abea705b0937fe164fa9c983700089bec88c82ba`, worktree dirty. Chỉ local và dữ liệu giả lập; chưa có triển khai production.

## Cấu hình

Quản trị MFA mở **Khóa học & nội dung → Thiết kế → Chính sách học & thi**. Lưu nháp rồi phát hành phiên bản mới. Chính sách gồm:

| Tùy chọn | Giới hạn / ý nghĩa |
| --- | --- |
| Điểm đạt | 1–100, điểm được máy chủ chấm và làm tròn như trước |
| Số lần nộp tối đa | 0 không giới hạn, hoặc 1–100, tính trên từng học viên và phiên bản |
| Thời gian chờ | 0–10.080 phút kể từ lần nộp gần nhất |
| Hoàn thành video trước khi thi | Có/không; độc lập với yêu cầu tại điểm dừng |
| Điểm dừng | Trả lời tất cả, trả lời đúng tất cả, hoặc không bắt buộc |
| Khóa tiên quyết | Tối đa 20 phiên bản; cần đạt tất cả trước khi mở nội dung |

Bản 1–2 vẫn dùng mặc định: 80 điểm, không giới hạn lần nộp, không chờ, hoàn thành video và trả lời tất cả điểm dừng. Dùng chính sách mới sẽ lưu CourseSpec v3. Đổi video không được làm hạ schema version và mất chính sách.

Phiên bản tiên quyết được chốt lúc phát hành. Nguồn phải đang phát hành, cùng tenant, bao phủ đủ đơn vị được học; không tham chiếu bản cũ của chính khóa hoặc tạo vòng phụ thuộc qua các khóa khác. Đổi phiên bản nguồn không tự sửa các khóa phụ thuộc đang chạy. Khi phát hành lại khóa phụ thuộc, quản trị chọn lại bản nguồn hiện hành nếu bản đã chọn cũ. Thành tích đã đạt ở bản tiên quyết cũ vẫn là bằng chứng cho khóa phụ thuộc đang ghim bản đó.

Học viên thấy lý do chưa mở khóa, số lần đã nộp/còn lại và thời điểm có thể nộp tiếp. Cấu hình “đúng tất cả điểm dừng” cho phép trả lời lại điểm dừng sai; không coi một câu sai đã hoàn tất điều kiện. Không bắt buộc video/điểm dừng không có nghĩa là tự đạt khóa học: vẫn phải nộp bài và đạt điểm.

## Bảo toàn kết quả và quyền

Máy chủ chấm theo policy của đúng version, lưu policy cùng snapshot câu hỏi/kết quả. Catalogue, lịch sử, chứng nhận, bảng điểm và xếp hạng dùng trạng thái đạt đã lưu; không suy ra mọi kết quả từ ngưỡng 80 hiện tại. Bảng điểm vẫn theo bản đang phát hành; xếp hạng giữ cách đếm thành tích lịch sử theo khóa. Chính sách mới không chấm lại bài cũ hoặc tự cấp chứng nhận.

Migration LMS **007** bổ sung guard lúc phát hành khóa tiên quyết, giới hạn lần nộp/cooldown trong transaction và thay trigger cấp chứng nhận để dùng ngưỡng snapshot. Giữ nguyên migration 001–006. Các kiểm tra giới hạn nằm trong batch D1 nên hai request đồng thời không vượt hạn. Retry cùng idempotency key trả receipt đã ghi, không tiêu thêm lần thi; policy không bỏ qua SSO, MFA, CSRF, quyền, mapping, tenant/unit, revocation hay audit.

Điều kiện tiên quyết được kiểm ở API nội dung, media, tiến độ và nộp bài; khóa nút giao diện chỉ là hướng dẫn. Progress revision được kiểm trong transaction nộp bài để tránh kết quả dựa trên tiến độ đã bị đổi đồng thời. Đáp án vẫn không xuất hiện trong nội dung công khai trước chấm.

## Kiểm chứng và phần còn lại

Tám domain tests mới đã pass, gồm điểm 67 đạt ngưỡng 60 xuyên catalogue/history/certificate/report/ranking, concurrency/idempotency, cooldown, checkpoint đúng, tiên quyết, vòng phụ thuộc và quyền. `npm run test:lms-policy` đã pass SSO/MFA thật và 6 axe scans: cấu hình chính sách/tiên quyết qua UI, bài 67 điểm đạt ngưỡng 60, chứng nhận/báo cáo đúng, cooldown và truy cập khóa tiên quyết được kiểm API. Đã xem ảnh cấu hình desktop/mobile, kết quả và cooldown. Hồi quy `test:suite-regression -- e3-policy` hoàn tất 2026-11-10T20:37:33.091Z: **179 tests, 10 lệnh pass, sourceStable=true**, receipt `.local/evidence/configurable-e3-policy-regression.json`. Đây là checkpoint E3a, không chứng minh toàn bộ E3/E4.

E3b [lộ trình có phiên bản và đợt đào tạo](LMS_TRAINING.md) đã đạt hồi quy 186 tests/8 lệnh, sourceStable=true, SSO E2E 7 axe scans. E4 **kết nối quy trình nhân sự, công việc đào tạo và import/export/rollback cấu hình** còn trong goal. Kiểm chứng Vimeo live vẫn là vấn đề riêng của goal LMS cũ; không suy ra đã xử lý từ các test local này.

Vận hành theo [runbook LMS](LMS_LOCAL_DEVELOPMENT.md). Rollback bằng phát hành phiên bản mới từ cấu hình mong muốn; giữ bài làm, chứng nhận và journal. Không quay runtime về bản chỉ hiểu v1–2 khi còn v3 đang dùng; không xóa lịch sử hoặc hồi quyền bị thu hồi.

Tham khảo [Moodle Quiz settings](https://docs.moodle.org/503/en/Quiz_settings) cho điểm đạt, lần thi và thời gian chờ; [Course completion](https://docs.moodle.org/503/en/Course_completion) và [Restrict access](https://docs.moodle.org/503/en/Restrict_access) để tách kết quả hoàn thành với điều kiện truy cập. Chính sách cụ thể bên trên là thiết kế AIO, giữ UI/nhận diện TLQM.

LMS 007 đã áp dụng local/test ngày 11/11/2026; checksum từ đây bất biến. Khi khởi động đã xử lý đúng lock local của process 33312 đã thoát qua `lms:unlock -- local`, không xóa storage/credentials. Lỗi đầu của E2E do script chờ upload trả 201 trong khi hợp đồng hiện hữu trả 200; đã kiểm lại status và media ID, không đổi runtime upload.
