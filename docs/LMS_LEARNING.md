# LMS — Học tập, chứng nhận và xếp hạng

Cập nhật 11/11/2026. Chỉ AIO local và dữ liệu giả lập. Trạng thái nghiệm thu từng mục và giới hạn live provider theo [goal đầy đủ](../roadmap/GOAL_LMS_COMPLETE.md).

## Học và làm bài

Đăng nhập tại http://127.0.0.1:4104/auth/login → **Khóa học** → tìm và mở khóa được phân cho đơn vị hiện hành. Player dừng ở checkpoint, lưu câu trả lời rồi cho tiếp tục. **Lưu tiến độ** hoặc quay về danh mục lưu vị trí. Player tự lưu khoảng năm giây một lần, khi chạm mốc cuối của bài và khi tạm dừng video file/HTTPS. Tải lại trang để tiếp tục đúng phiên bản và vị trí đã lưu. Ghi chú có thời điểm và chỉ chủ sở hữu được xem/xóa.

Sau khi hoàn tất các mốc, mở **Làm bài kiểm tra**. Hỗ trợ chọn một, chọn nhiều và nhập chữ; phải trả lời đủ trước khi nộp. Server chấm, ngưỡng đạt 80/100. Chọn nhiều phải đúng đủ tập lựa chọn, không lặp; nhập chữ chuẩn hóa Unicode/khoảng trắng/hoa thường và khớp toàn đáp án, không dùng substring. Trước khi nộp, API học viên không trả answer key.

Mỗi lần nộp cố ý tạo attempt mới. Retry sau mất response dùng lại key/payload, không nhân đôi. **Kết quả học tập** xem snapshot câu hỏi/đáp án/điểm của phiên bản đã nộp; phát hành lại hoặc ngừng khóa không chấm lại/xóa lịch sử.

## Nguồn video và giới hạn bằng chứng

| Nguồn | Theo dõi và hành vi |
| --- | --- |
| File đã upload | GET có session + version audience, hỗ trợ Range/seek; native player lưu vị trí và checkpoint |
| Video HTTPS | Chỉ URL HTTPS công khai hợp lệ; native player, không fetch qua backend như proxy |
| YouTube | ID/video URL chuẩn hóa; SDK cố định và iframe host cho phép, điều khiển pause/seek/checkpoint |
| Vimeo | ID và hash `h` tùy chọn cho video unlisted; SDK cố định, pause/seek/checkpoint |
| Google Drive | Iframe preview; người học **tự xác nhận** mốc xem. API bắt buộc acknowledged=true; snapshot/audit ghi self-confirmed |

Schema v2 hỗ trợ các nguồn trên; version v1 vẫn đọc được. Không nhận iframe HTML tùy ý. SDK lỗi/timeout 12 giây cho phép thử lại và không tự tăng tiến độ. CSP chỉ thêm host SDK/frame đã định; referrer mặc định no-referrer, YouTube/Vimeo chỉ gửi origin khi cần. Player-reported và self-confirmed đều không phải bằng chứng giám sát độc lập thời gian xem.

`test:lms-providers` dùng SDK/embed fixture có kiểm soát để kiểm controller và lỗi. Kiểm chứng với dịch vụ thật ghi nhận YouTube đạt trên Chromium ngày 10/11/2026 và **Vimeo đạt trên Edge ngày 11/11/2026**. Vimeo đã phát, dừng tại checkpoint, phát tiếp và lưu tiến độ khi chạm mốc cuối do khóa học cấu hình. Google Drive vẫn dùng mốc do học viên tự xác nhận.

## Chứng nhận và xếp hạng

Tại bài làm đạt hoặc bảng kết quả, bấm **Chứng nhận**. Server chỉ cấp từ attempt của chính học viên đã đạt ≥80, cùng tenant. Chứng nhận giữ tên người nhận tại lúc cấp, mã học viên, tiêu đề, phiên bản/checksum nội dung, điểm, ngày nộp và ngày cấp. Một attempt có tối đa một bản; retry/concurrent request không tạo bản thứ hai. Migration **004** thêm bảng và trigger bất biến, không sửa 001–003 hoặc dữ liệu legacy.

**Tải ảnh PNG** tạo ảnh 1600×1132 từ dữ liệu server; **In / Lưu PDF** dùng bố cục in riêng của trình duyệt. Hai nút đều kiểm quyền lại trước khi xuất. Không có chữ ký người thật, con dấu hoặc tuyên bố chứng thực bịa; bản local ghi rõ dữ liệu giả lập. Bản đã tải xuống là bản sao tại thời điểm xuất, không thể tự bị thu hồi trên máy người nhận.

Trong **Thành tích**, nhập mã để tra cứu. Mã không phải bearer secret và không cấp quyền: học viên xem chứng nhận của mình; reviewer/admin chỉ xem người còn mapping/grant/nhân sự hợp lệ trong phạm vi hiện hành. Khóa bị ngừng không xóa chứng nhận của người có quyền. Thu hồi grant/định danh vẫn chặn xem/tải.

Xếp hạng mặc định trong đơn vị hiện tại, chỉ người có kết quả và định danh AIO còn hoạt động. Mỗi khóa lấy điểm tốt nhất qua các lần thi/phiên bản; đếm khóa đạt, rồi điểm trung bình (làm tròn) của các khóa đã thi. Cùng hai chỉ số được đồng hạng; mã học viên chỉ giữ thứ tự ổn định. Tìm tên/mã không thay thứ hạng. Backend hỗ trợ trang 50 dòng và kiểm đơn vị yêu cầu. Không trả đáp án, bài làm hoặc tên đơn vị lịch sử làm căn cứ quyền.

## Khóa học dùng thử và vận hành

Sau khi mở Foundation và Worker **local**, `npm run lms:demo` kiểm readiness service/environment/instance trước đăng nhập hoặc mutation. Script tạo video WebM 8 giây và khóa `aio-lms-demo-01` với ba dạng câu hỏi; chỉ fixtures. Nếu mã đã tồn tại, giữ nguyên bản nháp/phát hành/lịch sử, không tự ghi đè. Receipt `.local/lms-course-demo.json` không chứa credentials. Chạy thử local/rerun phải có evidence riêng; không suy ra đã tạo từ việc script tồn tại.

Đã chạy ngày 10/11/2026 06:34Z trên local: admin MFA, học viên học đủ hai điểm dừng, làm ba dạng câu hỏi, nhận chứng nhận; rerun giữ nguyên nội dung và kết quả qua so sánh API trước–sau. Receipt `.local/evidence/lms-demo-live.json`, ảnh kết quả/chứng nhận local đã xem. Tài khoản lms.admin local đã tạo với hồ sơ SSO-only; người dùng tự thiết lập MFA/đổi mật khẩu rồi đăng nhập mới bằng OTP. [Hướng dẫn học viên](LMS_LEARNER_ADMIN.md).

Chứng nhận mới dùng migration tiến lên; rollback ứng dụng bằng cách ngừng Worker/disable adapter theo [runbook](LMS_LOCAL_DEVELOPMENT.md), giữ D1/R2/migration journal. Không drop bảng chứng nhận, sửa checksum migration hoặc chuyển về auth legacy. [Backup/restore D1 + R2 và đối soát orphan media](LMS_STORAGE_OPERATIONS.md) đã qua diễn tập tách biệt; không hồi phiên cũ.

## Bằng chứng

`test:lms-learner` kiểm video thật, resume, notes, quiz, retry và snapshot; bổ sung cấp/tra cứu chứng nhận, PNG, print CSS, desktop/mobile/keyboard/axe, grant revocation và guard demo. `tests/lms-courses.test.ts` kiểm audit failure rollback, concurrent receipt, dữ liệu bất biến, quyền chủ sở hữu/tenant, current subjects và xếp hạng không cộng lại retake/version. Chỉ các lượt có receipt pass và ảnh đã xem được ghi nghiệm thu trong goal; source test tồn tại không đồng nghĩa đã pass.

Receipt Vimeo live `.local/evidence/lms-vimeo-live-recheck-2026-11-11T09-26-04-610Z.json` ghi SDK và iframe HTTP 200, tiến độ server tại 2/8 và 8/8 giây, đáp án checkpoint và trạng thái giữ sau khi tải lại. Đã dùng bàn phím cho các nút phát, gửi và tiếp tục. Ảnh 1440px/390px đã xem, hai lượt axe áp dụng cho trang AIO. Các lượt timeout ngày 10/11 và lượt phát hiện lỗi lưu mốc cuối trước sửa vẫn được lưu riêng trong `.local/evidence`.
