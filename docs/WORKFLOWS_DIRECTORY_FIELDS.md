# Quy trình — Tham chiếu nhân sự và đơn vị AIO

Ngày 11/11/2026. W1b của [goal Quy trình](../roadmap/GOAL_WORKFLOWS_COMPLETE.md), đã nghiệm thu local. Đây là phần tiếp theo của [bảng/tiền/nháp/quyền đọc W1a](WORKFLOWS_BUSINESS_FORMS.md); chưa hoàn tất W1 hoặc W1–W5.

## Sử dụng

Trong **Thiết kế → Biểu mẫu → Thêm câu hỏi**, chọn **Nhân sự AIO** hoặc **Đơn vị AIO**. Có thể đặt nhãn, mô tả, bắt buộc và quyền xem như các trường khác, ở biểu mẫu đầu vào hoặc biểu mẫu bước xử lý. Mẫu **Mua sắm — Bảng chi tiết** đã có hai trường không bắt buộc: Người nhận vật tư và Đơn vị sử dụng. Các mẫu/phiên bản đã phát hành giữ nguyên.

Khi nhập hồ sơ, bấm trường để tìm theo tên; danh sách hiển thị tên và tám ký tự cuối ID nhằm phân biệt tên trùng, có **Tải thêm** khi còn trang. Có thể chọn bằng bàn phím, Escape đóng danh sách, nút bỏ chọn xóa câu trả lời. Xem trước trong designer không tải danh bạ ngoài ngữ cảnh hồ sơ.

Nhân sự lấy từ người đang có quan hệ công tác và phân công còn hiệu lực tại **đơn vị của hồ sơ**; không bắt buộc có tài khoản đăng nhập. Đơn vị lấy trong phạm vi khởi tạo/xử lý hiện hành của người nhập. Danh sách nhân sự chưa hỗ trợ chọn ngoài đơn vị hồ sơ, chọn nhiều người hoặc chọn nhân sự tương lai; không tự mở rộng scope qua trường cấu hình.

## Hợp đồng và quyền

- Dùng WorkflowSpec **v5** và FormSchema **v2** đã có. Forms độc lập/Directory vẫn không nhận schema v2. Chưa cần migration mới; journal Workflows 007 giữ bất biến, số tiếp theo 008.
- Giá trị `{id, label}`: `id` là **person ID** hoặc **org-unit ID**, không phải account ID/email. `label` gửi từ browser không đáng tin; backend thay bằng tên do Foundation trả về khi lưu/gửi. Không chấp nhận trường tùy ý, chuỗi thay UUID hoặc nhãn quá 240 ký tự.
- Foundation sở hữu projection trong boundary; domain Quy trình chỉ gọi hợp đồng `WorkflowDirectory.references`, không truy cập database định danh. Projection chỉ trả ID/tên, không trả email, mã công tác, lương, tài khoản hoặc quyền của người được chọn.
- Endpoint `GET /api/v1/workflows/references` cần phiên SSO và tenant hợp lệ; query `unitId`, `kind=person|orgUnit`, `search` tối đa 100 ký tự, `after` UUID. Mỗi trang tối đa 50 mục và `nextCursor`; mỗi request kiểm lại quyền, không đóng gói quyền vào cursor.
- Tra cứu tại đơn vị cần `workflows:act` ở đơn vị đó, hoặc `workflows:start` và công tác hiện hành tại đó. Chỉ có design/report/manage không tự được đọc danh bạ. Người chọn một nhân sự/đơn vị không cấp IAM hay biến họ thành người duyệt/người theo dõi. Người xử lý vẫn theo assignment policy riêng.
- Lưu nháp, gửi trực tiếp, gửi nháp, gửi lại và xử lý bước đều kiểm đối tượng còn hoạt động/đúng scope. Kiểm lần nữa trước commit bằng actor hiện hành; khi không còn hợp lệ, rollback mutation, lịch sử/audit/receipt trong database Quy trình. Hai module không có distributed transaction: có thể có thay đổi danh bạ sau lần kiểm cuối; dữ liệu hồ sơ là snapshot tại lúc xác nhận, không phải liên kết đồng bộ vô hạn.
- Hồ sơ/lịch sử đã gửi giữ tên tại thời điểm đó. Đổi tên hoặc ngừng công tác không sửa lịch sử cũ. Retry receipt thành công giữ kết quả cũ, vẫn phải có quyền hiện hành. Nháp mới lưu lại/gửi sẽ lấy tên hiện hành; lựa chọn đã hết hiệu lực phải chọn lại hoặc bỏ chọn. Không tự hồi quyền từ snapshot.
- Quyền đọc trường của W1a che cả ID lẫn tên trong detail/history/votes/mutation retry. Designer chưa dùng tham chiếu làm nguồn điều kiện biểu mẫu/rẽ nhánh. Parser chỉ chấp nhận kiểm “đã trả lời” cho tham chiếu; không so sánh nhãn. Mapping trường tham chiếu thành người xử lý, lọc danh sách theo câu trả lời, lựa chọn nhiều và rule theo đơn vị thuộc phần tiếp theo, chưa được triển khai.

## Kiểm chứng, vận hành và rollback

Tests mới trong `tests/workflows-references.test.ts` và `tests/workflows-business-service.test.ts` kiểm schema gate, dữ liệu giả nhãn, nhân sự không có account, danh sách 55 người trùng tên, khác tenant/unit, ngừng hoạt động, thu hồi scope giữa các trang; nháp/gửi lại/xử lý bước/snapshot/quyền trường/rollback trước commit. Thư viện Quy trình lấy các phiên bản bằng một query chung, ghim cặp definition/version đã đọc; test bổ sung trong `tests/workflows-service.test.ts` bảo toàn nháp riêng, published version và tenant/unit scope. Test browser `npm run test:workflows-business` đã pass: thiết kế hai loại trường, tìm/chọn bằng bàn phím, Escape chỉ đóng picker rồi mở lại bằng Enter, focus trở về trigger, aria-controls trỏ đúng popup, lưu/tải lại/gửi. **11 axe scans không vi phạm**; đã xem ảnh desktop/mobile sau khi chuyển picker sang Popover/Radix. Evidence `.local/evidence/workflows-business-references-e2e.json`, `workflows-business-references-axe.json` và ảnh cùng prefix. Hồi quy cuối `npm run test:suite-regression -- w1-references` **12/12 lệnh pass**, gồm check **223 tests, 0 fail/skip**, kết thúc `2026-11-11T02:20:50.955Z`. **416 source hashes** ổn định và đối chiếu lại không đổi; receipt `.local/evidence/configurable-w1-references-regression.json`. Readiness/home 4100–4105 đều HTTP 200 tại `2026-11-11T02:36:05.209Z`, LMS đúng marker local; receipt `.local/evidence/workflows-references-local-ready.json`.

Không có bước setup/migration/seed mới. Giữ runtime hiểu kiểu `person`/`orgUnit` khi đã có bản phát hành dùng chúng; ngừng nhận lượt mới bằng pause definition nếu cần. Không downgrade parser về bản không biết các kiểu này, sửa snapshot hoặc xóa lịch sử để rollback. Chỉ stack AIO local giả lập; không connector/production hoặc thay đổi source BOS/LMS/YMS gốc.
