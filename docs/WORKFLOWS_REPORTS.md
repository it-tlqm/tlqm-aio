# Báo cáo hiệu quả Quy trình

Trong **Báo cáo → Hiệu quả xử lý**, chọn nguồn dữ liệu, nhóm, chỉ số chính và khoảng ngày. Bộ lọc phiên bản lấy từ hồ sơ trong phạm vi hiện hành. Có thể xem bảng, biểu đồ và mở các dòng của một nhóm. Khi chọn một lần đã có kết quả, hồ sơ mở tab **Lịch sử** và đặt tiêu điểm vào đúng lần xử lý.

| Nguồn | Dòng dữ liệu | Mốc lọc ngày | Cách tính thời gian và trễ |
| --- | --- | --- | --- |
| Hồ sơ | Một lượt khởi chạy | Lúc tạo hồ sơ | Thời gian từ khi tạo đến kết thúc với hồ sơ hoàn thành hoặc bị từ chối |
| Lần xử lý | Một nhiệm vụ trong một vòng và lần xử lý | Lúc giao nhiệm vụ | Thời gian từ lúc giao đến kết quả. Tỷ lệ trễ lấy số hoàn thành, từ chối hoặc trả lại sau hạn chia cho toàn bộ lần có một trong ba kết quả. Lần đang chờ quá hạn được đếm riêng |
| Quyết định và phiếu | Một quyết định cá nhân hoặc một phiếu đồng duyệt | Lúc quyết định hoặc bỏ phiếu | Thời gian từ lúc giao đến quyết định của người đó. Phiếu sau hạn tính trễ. Có chỉ số số người, số lần xử lý và số hồ sơ riêng |

Ngày đầu và ngày cuối đều được tính theo giờ Việt Nam. Mặc định báo cáo lần xử lý và quyết định lấy đường xử lý còn hiệu lực. Bộ lọc lịch sử có thể đưa lại những lần bị thay thế hoặc thuộc vòng gửi trước. Bước được nhóm theo ID bước và phiên bản. Số hồ sơ hoặc số người phân biệt có thể xuất hiện ở nhiều nhóm. Tổng trên báo cáo đếm mỗi đối tượng một lần trong phạm vi đang chọn. Nếu số dòng thay đổi trong lúc mở chi tiết, giao diện hiển thị trạng thái cập nhật để người xem tải lại tổng hợp.

**Chia sẻ bộ lọc** tạo liên kết chứa nguồn, nhóm và điều kiện lọc. API lấy quyền báo cáo hoặc điều phối theo tenant và đơn vị của tài khoản người mở. Tải CSV cần lý do và CSRF. Nhật ký giữ bộ lọc, số dòng và checksum. Khi gửi lại cùng lệnh xuất, hệ thống kiểm quyền hiện hành và đối chiếu checksum của tệp. CSV tối đa 2.000 dòng, có bảo vệ dữ liệu văn bản khỏi công thức bảng tính.

## Báo cáo theo trường nghiệp vụ

Chọn một **Phiên bản quy trình** để mở phần **Trường nghiệp vụ**. Có thể nhóm theo một trường, lọc theo giá trị trong phạm vi được xem, thêm tối đa sáu cột vào chi tiết hoặc tính tổng, trung bình, nhỏ nhất và lớn nhất trên một trường số. Các lựa chọn số gồm tiền, số lượng tệp và tổng của cột bảng được khai báo. Lựa chọn tham chiếu hiển thị tên đã lưu cùng câu trả lời. Với tiền và tổng bảng, báo cáo giữ phần thập phân của dữ liệu lưu. Phép trung bình làm tròn đến hai chữ số thập phân cho tiền và sáu chữ số cho các trường số khác.

Mỗi dòng lần xử lý hoặc quyết định dùng biểu mẫu đầu vào của đúng vòng và kết quả của đúng lần xử lý hoặc lá phiếu. Nguồn **Hồ sơ** dùng đầu vào của vòng hiện tại. Khi tổng hợp trường đầu vào trên nguồn lần xử lý hoặc quyết định, một giá trị được tính cho mỗi dòng tương ứng. Chọn nguồn **Hồ sơ** để tính một lần cho mỗi hồ sơ.

Quyền báo cáo xác định hồ sơ thuộc tenant và đơn vị nào. Quyền trường xác định nhãn và giá trị có thể đọc trên từng dòng. Hệ thống bỏ dòng khỏi nhóm, bộ lọc hoặc phép tính nếu trường tương ứng bị ẩn theo điều kiện, không áp dụng cho bước, hoặc người xem thiếu quyền. Một cột tùy chọn ẩn chỉ bị lược khỏi dòng đó. Một trường được phép đọc và chưa có dữ liệu vẫn có thể nằm trong nhóm **Chưa có giá trị**. Quyền xử lý phải còn hiệu lực ở đúng vòng và lần xử lý liên quan.

Liên kết và nhật ký lưu mã trường và mã giá trị lọc. Khi mở, API lấy lại nhãn và giá trị theo quyền hiện hành. Bộ lọc đã hết hiệu lực yêu cầu chọn lại giá trị. Khi đổi quyền trường, lần xuất lại kiểm dữ liệu hiện tại trước khi trả tệp. Báo cáo theo trường xử lý tối đa 5.000 dòng nguồn. Danh sách giá trị lọc hiển thị tối đa 100 lựa chọn, với ô tìm kiếm khi còn kết quả. Giới hạn CSV vẫn là 2.000 dòng.

## Kiểm tra và rollback

Chạy `npm run test:suite-regression -- w5-performance-report` sau khi dừng API/LMS dev. E2E dùng SSO/MFA và dữ liệu giả lập. Bài PostgreSQL dùng thời điểm cố định để kiểm giờ Việt Nam, hạn, trả lại, thay thế và quyền khi xuất. Bài đồng duyệt dùng phiếu thật của hai người trên cùng một nhiệm vụ.

Chạy `npm run test:suite-regression -- w5-custom-report` để kiểm thêm báo cáo theo trường. Bài PostgreSQL đối chiếu đầu vào hai vòng, số tiền tổng hợp, trường có điều kiện, lần thay thế, quyền trường, tenant/đơn vị, hai giá trị phiếu và xuất lại sau thu hồi. E2E kiểm bộ chọn bằng bàn phím, tổng hợp desktop, chi tiết 390 px, CSV và mở lại liên kết chia sẻ.

Khi lùi báo cáo theo trường, đưa API và giao diện báo cáo về bản hiệu quả đã nghiệm thu. Tính năng này đọc các bảng hiện có và không có migration riêng. Giữ audit và receipt. Các liên kết có tham số trường cần được tạo lại từ giao diện sau rollback.

Rollback giao diện bằng cách dùng lại màn tổng hợp trạng thái/quá hạn. Các thống kê hiệu quả đọc từ dữ liệu sẵn có. Giữ nhật ký, phiên bản, lịch sử xử lý và các receipt xuất. Đối chiếu phạm vi tenant và đơn vị sau khi lùi bản. [Runbook local](WORKFLOWS_LOCAL_DEVELOPMENT.md)
