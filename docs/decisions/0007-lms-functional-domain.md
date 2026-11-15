# ADR 0007 — Nghiệp vụ LMS đầy đủ trong AIO local

Ngày 10/11/2026. Người dùng xác nhận cần đủ chức năng như dự án LMS và giao goal chạy liên tục. [Goal và nghiệm thu](../../roadmap/GOAL_LMS_COMPLETE.md). Quyết định này mở rộng baseline của ADR 0004; không cấp phép sửa/deploy LMS đang dùng.

## Ranh giới

Giữ Worker/D1 và adapter OIDC đã kiểm chứng. Core Foundation vẫn TypeScript/Fastify/PostgreSQL; nghiệp vụ học không được đưa vào identity. Frontend LMS dùng React/Vite/shadcn và palette TLQM chung. Source LMS gốc đọc chọn lọc để đối chiếu hành vi, không chạy/sửa/cài dependencies hoặc sao chép credentials/dữ liệu thật. [Snapshot nguồn](../LMS_FUNCTIONAL_SOURCE_SNAPSHOT.json).

Các bảng legacy employees/lessons/learning_progress/learning_attempts/learning_notes và mapping/SSO giữ nguyên. Migration 003 tạo lms_courses, lms_course_versions, lms_progress, lms_attempts, lms_notes, lms_media và receipt/guard riêng. Lịch sử cũ vẫn đọc được qua endpoint baseline. Domain mới tham chiếu employee ID hiện hữu, không tạo account/password khi học.

## Nội dung và chấm điểm

Khóa học có tenant, đơn vị sở hữu và audience units. Bản nháp thay đổi theo revision; phát hành tạo version bất biến, gồm metadata, checkpoint, quiz, answer key và checksum. Progress/attempt/note gắn version. Ngừng khóa chặn truy cập nội dung/hành động mới, vẫn cho chủ sở hữu xem snapshot kết quả cũ. Không xóa version/attempt.

Học viên nhận public spec không có answer key. Bài thi chấm tại server, 80/100 là đạt theo baseline nguồn. Multiple-choice cần tập chỉ số duy nhất; text so sánh chuẩn hóa Unicode/khoảng trắng/hoa thường chính xác, bỏ logic substring dễ chấp nhận sai của nguồn. Checkpoint cần chạm mốc và trả lời theo thứ tự. Mốc tiến độ bị giới hạn bởi checkpoint tiếp theo; đây là kiểm tra thứ tự, chưa phải chứng minh chống gian lận thời gian xem.

Mutations cần Origin/CSRF, Idempotency-Key và reason. Worker xác thực quyền AIO hiện hành, service kiểm lại trước batch. D1 guard xác minh session/mapping/employee/adapter và phiên bản khóa học còn hoạt động trong cùng batch; revision tránh ghi đè. Business write, audit và receipt chung transaction; lỗi audit hoặc guard phải rollback toàn bộ. Không ghi nội dung câu trả lời/ghi chú vào audit; attempt riêng giữ snapshot phục vụ xem lại.

## API đang triển khai

- GET /api/lms/courses, /course?versionId=, /history, /attempt?id= cho học viên.
- GET /api/lms/manage/courses cho admin + MFA.
- POST /api/lms/commands nhận action cố định: save-course, publish-course, course-status, progress, checkpoint, submit, create-note, delete-note. Envelope/keys cố định; nội dung course được diễn giải, không biên dịch schema từ người dùng.
- Media/upload và báo cáo được bổ sung trong các mốc tiếp theo; không coi endpoint có tên là đã nghiệm thu chức năng.

## Bằng chứng ban đầu

5 test domain với D1 riêng đã pass; HTTP `test:lms-courses` pass ngày 10/11/2026 qua Worker/SSO thật. Đã kiểm tenant/unit/admin/CSRF, draft isolation, repeat submit, version-pinned review, note ownership, audit rollback/CAS và legacy history byte-equivalent. UI/player/video upload/import Excel/report vẫn còn trong goal, không đánh dấu hoàn thành chung.
