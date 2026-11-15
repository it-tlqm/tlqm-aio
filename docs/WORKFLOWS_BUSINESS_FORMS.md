# Quy trình — Bảng chi tiết, quyền trường và nháp hồ sơ

Ngày 11/11/2026. Phần W1a của [goal Quy trình](../roadmap/GOAL_WORKFLOWS_COMPLETE.md) đã nghiệm thu local; chưa phải toàn bộ W1–W5. Chỉ AIO local giả lập. Giữ các phiên bản WorkflowSpec 1–4; các tính năng mới dùng v5 và biểu mẫu v2 được bật riêng cho Workflows. Forms độc lập/Directory chưa nhận biểu mẫu v2.

## Thiết kế và sử dụng

Tại **Thiết kế → Biểu mẫu**, thêm câu hỏi kiểu **Số tiền** hoặc **Bảng chi tiết**. Bảng có cột văn bản, số lượng, số tiền và tích hai cột số; cấu hình nhãn, bắt buộc, tổng cột, tiền tệ VND/USD và số dòng tối đa. Mẫu cột mặc định gồm nội dung, số lượng, đơn giá, thành tiền. Người nhập được thêm, nhân bản và xóa dòng; ID dòng giữ ổn định khi lưu/gửi lại.

Có thể bắt đầu từ **Thư viện quy trình → Mua sắm — Bảng chi tiết**. Mẫu này dùng tổng thành tiền để phân cấp duyệt, không có ô tổng tiền nhập tay; cần chọn người xử lý và đối tượng trước khi phát hành. Các mẫu cũ vẫn giữ nguyên hợp đồng.

Trong **Luồng xử lý**, điều kiện có thể chọn các trường tổng cột, ví dụ `Chi tiết mua sắm · Tổng Thành tiền`, để phân cấp duyệt theo tiền đã tính. Backend kiểm lại dữ liệu và tự tính thành tiền/tổng; không dùng kết quả tính do trình duyệt gửi. Bản nháp cấu hình được lưu/phát hành theo revision và quyền hiện hành. Import/export dùng cùng parser v5.

Tại **Quyền dữ liệu**, chọn trường cần hạn chế và người được xem thêm: người khởi tạo, điều phối viên hoặc người thực sự được phân công ở các bước. Người nhập/người được giao bước luôn xem dữ liệu ở bước của mình. Quyền này chỉ thu hẹp quyền xem hồ sơ hiện có, không cấp quyền vào ứng dụng. Cả bảng được bảo vệ như một trường; chưa có quyền từng cột. Câu hỏi phụ thuộc điều kiện không được có phạm vi người xem rộng hơn trường nguồn.

Khi khởi chạy, bấm **Lưu nháp hồ sơ** để lưu dù chưa điền đủ trường bắt buộc. Nháp lưu ở backend và chỉ người tạo, còn đúng person/account/quyền/đơn vị, được đọc hoặc sửa. Vào **Nháp của tôi → Tiếp tục nhập** để mở lại. Gửi sẽ lưu lần sửa hiện tại rồi chuyển nháp thành lượt chạy; chuyển trạng thái, tạo run/tasks, lịch sử, audit và receipt nằm trong cùng transaction. Hai lần gửi đồng thời không tạo hai run.

Đổi phiên bản phát hành không tự chuyển nháp cũ sang bản mới. Nháp cũ vẫn đọc/lưu được; khi phiên bản đã ngừng nhận lượt mới, nút gửi bị chặn và người dùng cần tạo hồ sơ theo bản đang phát hành. Giữ nháp cũ để đối chiếu; chưa có giao diện rebase dữ liệu giữa hai schema.

## Dữ liệu khởi tạo tại từng bước

Trong **Thiết kế → Quyền dữ liệu → Dữ liệu khởi tạo tại từng bước**, chọn bước phê duyệt hoặc thực hiện, rồi chọn chế độ cho từng trường khởi tạo:

| Chế độ | Khi xử lý hồ sơ |
| --- | --- |
| Chỉ ở hồ sơ gốc | Trường hiển thị trong phần hồ sơ gốc theo quyền xem hiện hành |
| Chỉ xem | Giá trị của lần gửi hiện tại xuất hiện ngay cạnh phần xử lý để đối chiếu |
| Cho sửa | Điền sẵn giá trị đã gửi và lưu nội dung người xử lý nhập cùng kết quả bước |
| Bắt buộc điền | Cho sửa và yêu cầu có giá trị hợp lệ khi phê duyệt hoặc hoàn tất. Từ chối và trả về vẫn có thể thực hiện với dữ liệu chưa đủ |

Nếu trường giới hạn người xem, cấp quyền cho người xử lý của bước ở phần bên dưới trước khi đưa vào bước. Máy chủ kiểm cấu hình, quyền thực hiện và câu trả lời. Quyền xem của trường gốc cũng áp dụng cho giá trị người xử lý sửa trong kết quả và phiếu đồng duyệt. Dữ liệu bước nằm trong **Lịch sử**, còn giá trị và điều kiện rẽ nhánh của đề nghị tiếp tục dùng hồ sơ khởi tạo. Khi gửi lại, bước nhận dữ liệu của lần gửi mới.

Cấu hình này dùng trường khởi tạo có chế độ hiển thị, bắt buộc và danh sách giá trị cố định. Biểu mẫu riêng của bước vẫn hỗ trợ điều kiện. Xem cách dùng kết quả bước để rẽ nhánh ở phần dưới. Tệp đính kèm được theo dõi trong [roadmap Quy trình](../roadmap/GOAL_WORKFLOWS_COMPLETE.md).

## Dữ liệu và giới hạn

Quy trình v5 có thêm **Số nguyên, Phần trăm, Tháng/năm, Giờ/phút và Ngày và giờ**. Các kiểu thời gian lưu giá trị lịch hoặc giờ nghiệp vụ đã nhập, với giới hạn tối thiểu/tối đa tùy chọn. Phần trăm dùng thang 0–100. Cùng kiểu dữ liệu có thể dùng để so sánh trong điều kiện trường và điều kiện chuyển nhánh.

Trong hộp chỉnh câu hỏi, dùng **Hiện câu hỏi khi**, **Bắt buộc khi** hoặc **Lựa chọn theo điều kiện**. Nhóm VÀ/HOẶC có tối đa ba cấp. Với trường Chọn một/Chọn nhiều, quy tắc đầu tiên thỏa điều kiện quyết định danh sách. Khi đổi câu trả lời nguồn, giao diện bỏ lựa chọn hết hiệu lực, máy chủ kiểm lại cả khi lưu nháp. Nếu không có quy tắc phù hợp, hiện danh sách đầy đủ. Điều kiện xem, bắt buộc và lựa chọn dùng chung kiểm tra vòng phụ thuộc và quyền đọc nguồn.

Tại **Luồng xử lý**, trường rẽ nhánh có thể lấy từ biểu mẫu khởi tạo hoặc biểu mẫu kết quả của một bước chắc chắn chạy trước. Trường kết quả được chọn cần có quyền xem chung trong hồ sơ, và bước nguồn có một kết quả xác định. Sau khi trả về và gửi lại, nhánh chỉ dùng kết quả của lần gửi hiện tại. Cấu hình này dùng WorkflowSpec v5 và lưu cùng bản phát hành; không cần migration.

- Giá trị tiền lưu dạng chuỗi thập phân chuẩn, tối đa 12 chữ số nguyên và 2 số lẻ. Số lượng tối đa 3 số lẻ. Chấp nhận dấu âm để ghi điều chỉnh; không nhận dấu phân nhóm, ký pháp mũ hoặc tự ép kiểu số.
- Phép nhân dùng BigInt theo tỷ lệ cố định; làm tròn từng dòng tới hai số lẻ, nửa đơn vị làm tròn ra xa 0. Tổng cộng từ các dòng đã làm tròn; vượt giới hạn bị từ chối. So sánh ngưỡng chỉ đổi số đã chuẩn hóa trong giới hạn an toàn; không dùng số dấu phẩy động để tính tiền.
- Bảng tối đa 12 cột và 100 dòng; cấu hình từng bảng có thể thấp hơn. Công thức chỉ là tích hai cột money/quantity, chưa là Excel/JS tùy ý. Tổng cột được chọn từ money/calculated. Trường tiền VND cũng giữ hai chữ số theo quy tắc này; chưa cấu hình scale riêng theo doanh nghiệp.
- Payload câu trả lời tối đa 256 KB. Dòng/cột lạ, mã trùng, số sai định dạng hoặc quá giới hạn bị chặn cả khi lưu nháp. Chỉ kiểm thiếu dữ liệu được hoãn tới lúc gửi.
- Dữ liệu bị hạn chế được loại khỏi run detail, các vòng input, câu trả lời và phiếu trong lịch sử, cùng phản hồi mutation/retry. Spec trả cho người đọc cũng bỏ trường bị hạn chế. Checksum dữ liệu không trả qua lịch sử khi có policy trường để tránh dò giá trị thấp entropy. Database vẫn giữ đầy đủ lịch sử bất biến.
- Tên hồ sơ, ý kiến/lý do chung và nội dung nguồn từ adapter hồ sơ nhân sự có quyền và hợp đồng riêng. Quyền trường áp dụng trên giá trị có cấu trúc. Nội dung người dùng tự chép vào ý kiến hoặc suy diễn từ kết quả rẽ nhánh nằm ngoài cơ chế này.

## Tệp đính kèm

Thêm **Tệp đính kèm** trong biểu mẫu khởi tạo hoặc biểu mẫu của bước. Người thiết kế đặt số tệp, dung lượng từng tệp, định dạng và điều kiện bắt buộc. Bản local hỗ trợ PDF, PNG, JPEG, TXT, CSV, DOCX và XLSX. Điều kiện luồng dùng giá trị có hoặc không có tệp. Quy trình lưu ID tệp trong câu trả lời, còn nội dung và tên tệp thuộc kho Quy trình.

Trong hồ sơ mới, nhập tiêu đề và chọn đơn vị trước khi đính kèm. Lần tải đầu tạo nháp để gắn tệp đúng hồ sơ. Chọn **Lưu nháp hồ sơ** để lưu các tệp đã chọn và mở lại từ **Nháp của tôi**. Khi bổ sung hoặc xử lý, tải tệp từ đúng trường của lần gửi hoặc bước đang mở. Link trong hồ sơ và lịch sử dùng quyền xem trường hiện hành. Bỏ một tệp khỏi câu trả lời giữ nguyên các bản ghi đã lưu.

Trong hồ sơ đã gửi, tab **Tệp đính kèm** tập hợp tệp bạn được phép xem. Mở **Lịch sử** để xem chứng từ của từng lần gửi hoặc lần xử lý. Tab **Sơ đồ tiến độ** liệt kê người được giao và hạn của các bước đang chờ, kể cả khi nhiều nhánh mở cùng lúc.

API tải lên nằm dưới `/api/v1/workflows/requests/:id/attachments`, `/runs/:id/attachments` và `/tasks/:id/attachments` trong cùng namespace. API tải xuống `GET /api/v1/workflows/attachments/:id?tenantId=…` kiểm quyền hồ sơ và trường, trả file dưới dạng tải xuống và tắt cache. Server kiểm lại số tệp, định dạng, dung lượng và liên kết đúng phạm vi khi lưu kết quả. Người dùng có thể dùng lại tệp từ lịch sử phù hợp của chính lượt và trường đó.

Migration Workflows 011 lưu tệp trong database Quy trình local/test, có checksum và trạng thái kiểm tra. Kiểm tra local dựa trên cấu trúc định dạng và giới hạn giải nén cho tài liệu Office. Tệp không đạt chỉ giữ metadata và checksum, không giữ nội dung. Bước kiểm tra cấu trúc phục vụ môi trường giả lập. Máy quét mã độc cho môi trường phát hành là một lớp riêng.

Khi cần dừng nhận tệp mới, ngừng phát hành phiên bản có trường tệp hoặc phát hành phiên bản mới đã bỏ trường. Giữ migration 011, dữ liệu đã lưu và runtime hiểu kiểu trường này để đọc các hồ sơ đã gửi.

## Vận hành và rollback

Migration **Workflows 007-request-drafts.sql đã áp dụng local/test**, giữ bất biến. Xem số journal hiện hành trong [runbook Quy trình](WORKFLOWS_LOCAL_DEVELOPMENT.md). Không cần migration Foundation/Forms/LMS trong W1a. Script setup kiểm marker, host và database. Nháp và lịch sử thuộc database Quy trình.

Giữ runtime hiểu v5/v2 khi có bản phát hành/lượt dùng chúng. Ngừng phát hành version để chặn hồ sơ mới; không xóa nháp, lịch sử, receipt hoặc downgrade code về bản không hiểu bảng. Tắt UI mới không phải cách rollback dữ liệu đã gửi.

## Kiểm chứng và phần còn lại

Đã có 9 tests domain/service mới: số thập phân/làm tròn, dữ liệu giả mạo, giới hạn/prototype, rule tham chiếu, rẽ nhánh theo tổng, field projection, retry, quyền hiện hành, nháp/CAS/concurrency và rollback audit. Hồi quy `npm run test:suite-regression -- w1-business` **12/12 lệnh pass**, gồm `check` **218 tests**, kết thúc `2026-11-11T00:53:01.582Z`; source ổn định 410 files, receipt `.local/evidence/configurable-w1-business-regression.json`. SSO E2E riêng `npm run test:workflows-business` kiểm designer/bảo mật/nháp/tải lại/gửi/duyệt/nhánh: **9 axe scans không vi phạm**, đã xem ảnh desktop/mobile và sửa tràn dialog. Readiness 4100–4105 HTTP 200 sau khởi động lại, receipt `.local/evidence/workflows-business-local-ready.json`. Suites DB/MFA chạy tuần tự theo [runbook local](LOCAL_DEVELOPMENT.md).

[Tham chiếu nhân sự/đơn vị W1b](WORKFLOWS_DIRECTORY_FIELDS.md) đã nghiệm thu riêng với 12/12 lệnh hồi quy, 223 tests và 11 lượt axe nghiệp vụ. Cấu hình dữ liệu khởi tạo theo bước dùng WorkflowSpec v5 và các bảng kết quả hiện hành. Giữ runtime có hỗ trợ cấu hình này sau khi đã phát hành. Xem trạng thái kiểm chứng và các hạng mục tiếp theo tại [roadmap Quy trình](../roadmap/GOAL_WORKFLOWS_COMPLETE.md).
