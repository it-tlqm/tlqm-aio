# LMS — Video, tài liệu và thiết kế khóa học local

Ngày 10/11/2026. Thuộc [goal LMS đầy đủ](../roadmap/GOAL_LMS_COMPLETE.md), không phải triển khai LMS hiện hữu. R2 được mô phỏng bền vững trong Miniflare local, không có thao tác với tài khoản Cloudflare hoặc bucket remote.

## Cách dùng phần quản trị đã nối

Tài khoản có lms:admin và MFA (hồ sơ legacy còn giao với role legacy) mở **Khóa học & nội dung** → **Tạo khóa học**. Điền metadata/đơn vị được học; vào **Video & tài liệu** để chọn file và bấm **Tải file**. Trạng thái File đã lưu chỉ xuất hiện sau khi server lưu và xác minh. Video file có preview; thời lượng được lấy từ metadata nếu trình duyệt đọc được, người quản trị có thể chỉnh lại giá trị theo nội dung.

Thêm điểm dừng theo thời gian tăng dần và câu hỏi cuối bài dạng single/multiple/text, chọn đáp án và giải thích. **Lưu bản nháp** trước **Phát hành**. Thay đổi sau phát hành tiếp tục ở bản nháp; phát hành lại tạo version mới. **Ngừng phát hành** chặn truy cập nội dung mới và giữ kết quả đã nộp. Editor cảnh báo khi rời trang/tab/tải lại mà chưa lưu; hủy cảnh báo giữ nội dung vừa nhập. UI dùng shadcn/TLQM/Be Vietnam Pro.

Trình học cho học viên đã nối catalogue/player/checkpoint/ghi chú và ba dạng câu hỏi: [hướng dẫn học tập](LMS_LEARNING.md). Contract v2 thêm Vimeo, Google Drive và URL video HTTPS; giữ schema v1. YouTube/Vimeo dùng SDK để điều khiển; Drive hiển thị rõ mốc do học viên tự xác nhận. [Ngân hàng và nhập/xuất Excel](LMS_QUESTIONS.md) đã nối G6; [báo cáo G7](LMS_REPORTING.md) đã qua E2E và local review. Lookups đơn vị đã lấy Directory AIO hiện hành qua API có capability/proof; save/publish/media kiểm reference đơn vị ở backend. Không dùng department text legacy làm danh mục hoặc scope cho nội dung mới.

## Storage và API

- Local: `.local/lms/local/r2`; test: `.local/lms/test/r2`. D1 vẫn ở các đường dẫn d1 tương ứng. Bucket binding LMS_MEDIA tách khỏi ASSETS; không phục vụ file dưới public/uploads.
- POST `/api/lms/media`: raw file body, cookie phiên + Origin/CSRF + Idempotency-Key; metadata qua x-file-name (URL encoded), x-file-size, x-file-sha256, x-media-id, x-owner-unit-id và Content-Type. Chỉ admin + MFA.
- GET `/api/lms/media`: danh mục metadata trong tenant của admin; không trả object key.
- GET/HEAD `/api/lms/media/:id`: admin đọc trong tenant. Học viên cần thêm `?versionId=...`; server xác minh file được tham chiếu trong version, khóa đang active và audience chứa đơn vị đang liên kết của học viên. R2 không có URL công khai.
- GET hỗ trợ một byte range, dạng offset-end, offset- hoặc -suffix; invalid range trả 416. If-Range sai ETag trả full body. HEAD trả kích thước và không đọc body. Mỗi request vẫn xác thực; Cache-Control no-store, nosniff, no-referrer. Tài liệu trả dạng tải xuống.

Video MP4/M4V/WebM/OGG/OGV/MOV tối đa 100 MiB; PDF/DOCX/XLSX 20 MiB; ảnh PNG/JPEG/WebP 10 MiB ở API. UI hiện dùng video/tài liệu. Kiểm tra tên/đuôi/MIME, signature container, exact byte length và SHA-256. Đây không phải virus scanner hoặc chứng minh codec bất kỳ đều được trình duyệt phát; chuẩn phát được kiểm trực tiếp bằng fixture WebM thật.

Upload dùng FixedLengthStream và DigestStream để giới hạn/đếm/hash trong khi ghi R2. Không buffer toàn file trong Worker. R2 put nhận checksum kỳ vọng, sau ghi kiểm head/size; sau đó D1 ghi metadata, audit và receipt chung transaction. Storage key mới cho từng lần thử ngăn hai request ghi đè object đã commit. Retry cùng key/payload trả cùng receipt; payload khác bị từ chối. Object không được metadata tham chiếu được dọn khi kết quả D1 xác định; nếu D1 mất kết nối và chưa thể phân biệt commit hay fail, giữ object để không xóa dữ liệu đã commit. Đối soát orphan bằng công cụ vận hành là việc còn lại của G8.

Tài liệu runtime đã đối chiếu: [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/), [FixedLengthStream](https://developers.cloudflare.com/workers/runtime-apis/streams/transformstream/#fixedlengthstream), [DigestStream](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/#digeststream). Implementation đã chạy trên phiên bản workerd/Miniflare được pin trong AIO; không chỉ dựa vào tài liệu.

## Nghiệm thu mốc hiện tại

`test:lms-media` pass 10/11/2026 05:13:35Z: upload **100 MiB thật**, read Range kiểm bytes, checksum/length/MIME negatives, learner/upload/CSRF denials, admin hoặc version audience, HEAD/full/suffix/416, conflict retry không ghi đè, audit failure không để metadata/object mới, restart Worker giữ bytes/session và archive chặn đọc trên session đang mở. Fixture lớn được dọn đúng ID test có audit, không xóa file người dùng.

`test:lms-authoring` pass 05:13:48Z: browser tạo khóa học, upload video sinh từ canvas/MediaRecorder và phát thực tế trong Chromium, thêm tài liệu/điểm dừng/câu hỏi single/text, lưu–phát hành–ngừng; cảnh báo bỏ thay đổi, desktop 1440/mobile 390, 7 axe scans zero violations. Incomplete checks giữ trong artifact; không chứng nhận WCAG đầy đủ. Đã xem trực tiếp ảnh media/editor mobile/danh sách.

Evidence ignored `.local/evidence`: `lms-media-e2e.json`, `lms-authoring-e2e.json`, `lms-authoring-media.png`, `lms-authoring-mobile.png`, `lms-authoring-desktop.png`. Cùng worktree dirty trên baseline abea705b0937fe164fa9c983700089bec88c82ba, nhánh feat/foundation-mvp; chưa commit/push/deploy. Không đổi migration 001–003; bảng lms_media đã có từ 003.

Hồi quy sau phần media/editor: `check` pass 110 tests, TypeScript/format/build; `test:lms-courses`, `test:lms` (9 axe scans) và `test:e2e` (SSO/identity/admin UI) đều pass tuần tự. Receipt `lms-media-authoring-regression.json`; snapshot source/evidence `lms-media-authoring-revision.json`. Goal chưa complete vì player/quiz học viên và các mốc G5–G8 còn việc.

G8 bổ sung cursor 100/trang cho thư viện media và khóa học; frontend tải đủ trang hoặc báo lỗi toàn bộ. Kiểm dữ liệu >500 cùng timestamp đã pass. [Vận hành storage](LMS_STORAGE_OPERATIONS.md) bảo vệ file đã đăng ký và reference của draft/version khi dọn object mồ côi.
