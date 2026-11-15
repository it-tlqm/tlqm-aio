# LMS — Ngân hàng câu hỏi và nhập/xuất Excel

Ngày 10/11/2026. Chỉ AIO local/dữ liệu giả lập; [goal LMS](../roadmap/GOAL_LMS_COMPLETE.md) còn active. Source tham chiếu `lib/excel-utils.ts`, `components/admin/ExcelImportModal.tsx`, `components/admin/CourseEditorScreen.tsx` của LMS gốc chỉ đọc, không chạy hoặc thay đổi.

## Cách dùng

Tài khoản LMS admin có MFA mở **Ngân hàng câu hỏi** để tạo, sửa, phân nhóm, tìm kiếm không phân biệt dấu và ngừng/khôi phục câu hỏi. Bộ lọc tách **Bài kiểm tra** và **Điểm dừng video**. Câu hỏi có ba loại single/multiple/text, dùng cùng editor shadcn của khóa học. Các phiên bản ngân hàng được giữ bất biến; thao tác sửa dùng revision để từ chối ghi đè bản đã đổi.

Chọn nhóm nhận câu hỏi → **Tải mẫu Excel** → điền dữ liệu → **Nhập Excel** → **Kiểm tra tệp**. Preview ghi số dòng thật, cột và lỗi. Chỉ cho nhập khi toàn bộ các dòng hợp lệ; không tự bỏ dòng lỗi hay tự điền đáp án. Nhập vào ngân hàng luôn thêm câu hỏi mới; không dùng ID trong file để ghi đè bản đang có. Chọn tối đa 100 câu hỏi rồi **Xuất Excel** để tải XLSX thật, có đầy đủ lựa chọn và đáp án.

Trong **Khóa học & nội dung**, lưu bản nháp trước. Mở tab **Bài kiểm tra** hoặc **Điểm dừng** → **Chọn từ ngân hàng** để sao chép vào bản nháp, hoặc **Nhập Excel** để thêm/thay thế phần đang chọn. Thay thế cần tick xác nhận riêng. Nội dung còn lại của khóa học và bản đã phát hành được giữ nguyên. Sửa ngân hàng sau này không tự cập nhật bản đã sao chép. Phát hành lại khóa học tạo version mới như trước.

## Cấu trúc file

Đọc **trang tính đầu tiên**, theo bố cục mẫu. XLSX, XLS (BIFF) và CSV UTF-8 được hỗ trợ. Tối đa 2 MiB/tệp, 100 dòng sau tiêu đề (kể cả khoảng trống giữa các dòng), 22 cột; một khóa có tối đa 100 câu thi và 30 điểm dừng. Nội dung bản nháp sau nhập tối đa 240 KB JSON để còn chỉnh sửa qua command API.

| Cột | Quy tắc |
| --- | --- |
| Loai_Cau_Hoi | single, multiple, text; chấp nhận nhãn Việt Chọn một/Chọn nhiều/Tự luận |
| Cau_Hoi | Bắt buộc, tối đa 2000 ký tự |
| Phuong_An_A … Phuong_An_L | Chọn một/nhiều có 2–12 lựa chọn, mỗi lựa chọn tối đa 500 ký tự, không trùng và không để trống ở giữa; text để trống tất cả |
| Dap_An_Dung | A–L hoặc chỉ số từ 0; multiple phân cách bằng dấu chấm phẩy/dấu phẩy/khoảng trắng, không lặp; text nhập đáp án chuẩn đầy đủ |
| Giai_Thich | Tùy chọn, tối đa 2000 ký tự; trống được giữ trống |
| Thoi_Gian_Giay | Chỉ điểm dừng: số giây từ 0 đến thời lượng khóa; không tự sắp lại timeline |
| Tieu_De | Chỉ điểm dừng: bắt buộc, tối đa 150 ký tự |
| STT | Chỉ giúp đọc file, không làm khóa định danh |

Tiêu đề cột không phân biệt hoa/thường, dấu tiếng Việt, khoảng trắng/underscore. Mẫu nguồn cũ với bốn lựa chọn A–D vẫn đọc được. AIO bổ sung đến L để xuất đủ 12 lựa chọn đã hỗ trợ trong editor; không cắt mất lựa chọn E–L. Thiếu cột bắt buộc, cột trùng, loại không hợp lệ, đáp án không trỏ tới lựa chọn thật đều phải sửa. Không tự chọn A hoặc điền “chuẩn quy trình” khi dữ liệu sai như một số nhánh parser nguồn.

Ô công thức và macro bị từ chối; parser không tính công thức, chạy VBA hay mở hyperlink. XLSX xuất chuỗi dưới dạng ô văn bản, kể cả chuỗi bắt đầu bằng dấu bằng, giữ số 0 đầu của đáp án text. CSV phải là UTF-8; CSV xuất không nằm trong contract mới, nút xuất luôn tạo XLSX như chức năng export nguồn.

## Ranh giới và dữ liệu

- Chỉ lms:admin tenant-wide, role LMS admin và MFA mới xem/nhập/xuất đáp án. Learner/reviewer không vào các API ngân hàng, mẫu hoặc export. Câu hỏi được công bố cho học viên vẫn qua public course spec loại answer key.
- Mọi POST cần cookie phiên, Origin, CSRF và Idempotency-Key; actor/quyền được kiểm lại trước batch. Import/export có audit metadata (số câu, kind, hash nguồn/ID), không ghi nội dung câu hỏi/đáp án vào audit.
- Preview lưu theo tenant + actor, bất biến và hết hiệu lực sau 30 phút. Không nhận preview của người khác. Apply chỉ nhận preview ID và lựa chọn đích, server đọc lại nội dung đã kiểm; không tin các dòng preview được browser gửi lại.
- Retry cùng key/payload trả receipt cũ, kể cả preview đã hết hạn sau khi thao tác thành công. Payload đổi với key cũ bị từ chối. Receipt không vượt qua quyền đã thu hồi. Đổi ngân hàng/khóa đồng thời dùng revision và guard trong cùng transaction; lỗi audit rollback toàn bộ thao tác.
- XLSX được kiểm ZIP trước parse: tối đa 128 entry và 16 MiB giải nén; giới hạn cả bytes giải nén thật, so CRC/kích thước và header, không chỉ tin metadata file. Không ghi đường dẫn bên trong ZIP ra filesystem.
- Ngân hàng dùng chung cho admin trong tenant; không tự chuyển câu hỏi/đáp án qua tenant khác. Danh sách API phân trang 50 với cursor; UI tải đủ các trang cho tìm kiếm/bảng, hiển thị 20 dòng mỗi trang, không cắt mất câu hỏi thứ 51.

Migration **005** thêm lms_question_bank, lms_question_versions và lms_question_imports. Đã áp dụng D1 test từ lượt E2E đầu và local qua guarded startup lúc 07:18Z; 001–005 từ đây bất biến. Không đổi bảng legacy hoặc mật khẩu. Không sửa dữ liệu đã phát hành để rollback câu hỏi; sửa bản nháp/phát hành version mới hoặc ngừng dùng câu hỏi ngân hàng.

## Dependency và kiểm chứng

SheetJS CE được pin tarball **0.20.3** theo [hướng dẫn NodeJS chính thức](https://docs.sheetjs.com/docs/getting-started/installation/nodejs/), lockfile giữ integrity. Chỉ cài vào AIO, `--ignore-scripts`; không cài vào source LMS gốc. Parser dùng [read options chính thức](https://docs.sheetjs.com/docs/api/parse-options/) để giới hạn dòng, lấy công thức cho bước từ chối và bỏ HTML/cell formatting. Không phát biểu rằng npm registry là nguồn phiên bản mới nhất.

`tests/lms-spreadsheet.test.ts` kiểm XLSX/XLS/CSV, Unicode, leading zero, 12 lựa chọn, công thức, đáp án thiếu/lặp, ô trống, kích thước và việc ghép bản nháp không thay snapshot. `tests/lms-courses.test.ts` bổ sung quyền/tenant, preview ownership, atomic audit failure, concurrent revision, archive và retry sau expiry.

`npm run test:lms-questions` chạy SSO/MFA + Worker/D1 thật, tải mẫu/file thật qua browser, xem lỗi theo dòng, retry mất response, tạo/sửa/ngừng ngân hàng, copy/replace bản nháp và giữ version đã phát hành; 53 dòng kiểm cursor, XLS/CSV, thu hồi grant và axe desktop/mobile. Receipt `.local/evidence/lms-questions-e2e.json`, ảnh `lms-question-*.png`, file `.xlsx` xuất trong evidence chỉ chứa dữ liệu giả lập. Chỉ lượt test có receipt pass được ghi nghiệm thu trong goal.

Lượt 07:00:59Z ngày 10/11/2026 pass **8 axe scans**, bổ sung nhập/xuất điểm dừng và bài thi nhập được chấm 100 trên server. Đã xem ảnh thật, giữ incomplete checks trong receipt; đây không phải chứng nhận WCAG đầy đủ. Hồi quy sau đó qua course/authoring/learner/providers, nhưng legacy LMS bị ngắt khi Docker Desktop ngừng. Việc phục hồi dependency và các suite còn lại ghi riêng trong goal; không đánh dấu toàn chuỗi pass dựa trên các lượt trước.

Recovery hoàn tất 07:17Z: legacy LMS (9 scans), ba suite Foundation E2E và questions (8 scans) đều pass trên dịch vụ phục hồi; `lms-questions-recovery-regression.json` khép lại lượt bị gián đoạn. Không thay assertions quyền hay protocol để đạt pass. `check`, typecheck/build và format đã pass; 17 source hash tham chiếu gốc vẫn khớp.

Local 07:18Z có nhóm **Dùng thử AIO**, sao chép ba câu single/multiple/text từ khóa demo đã có. Guard kiểm service/environment/instance trước SSO MFA và ghi dữ liệu; retry giữ ba câu, không sửa khóa demo. Đã tải XLSX qua UI local, đọc lại và xem ảnh desktop/mobile. Receipts `.local/evidence/lms-question-local-review.json`, `.local/lms-question-demo.json`; file xuất/ảnh đều là dữ liệu giả lập, không chứa credentials.

G8 còn đối soát/dọn preview hết hạn với audit và kế hoạch giữ receipt; không xóa trực tiếp .local hoặc hạ migration để giải phóng dữ liệu. G7 tiếp tục gradebook/báo cáo/Excel theo scope và quản trị học viên SSO.

G8 có [cleanup preview hết hạn](LMS_STORAGE_OPERATIONS.md): kế hoạch được xác minh, backup riêng, xóa preview và audit cùng transaction; ngân hàng/published copies và idempotency receipt giữ nguyên. Các hồ sơ SSO-only nhận quyền admin từ IAM, không yêu cầu role legacy trong employees.
