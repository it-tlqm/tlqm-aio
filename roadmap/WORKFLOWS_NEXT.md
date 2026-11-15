# Quy trình — Lộ trình sau đối chiếu AMIS

Ngày 11/11/2026. Người dùng đã đồng ý triển khai; theo dõi trạng thái thực tế tại [goal Quy trình](GOAL_WORKFLOWS_COMPLETE.md). Căn cứ [ma trận AMIS ↔ AIO và source thực tế](../docs/WORKFLOWS_AMIS_GAP_ANALYSIS.md). Các mốc dưới đây là phạm vi nghiệm thu, không thay receipt E0–E4 hoặc đánh dấu goal engine LMS cũ hoàn tất.

## Mục tiêu sản phẩm

Người nghiệp vụ có thể cấu hình và vận hành các hồ sơ mua sắm, tạm ứng, tiếp nhận nhân sự và đề nghị đào tạo bằng giao diện: bảng chi tiết, dữ liệu đi qua nhiều bước, quyền trường, xử lý song song, bàn giao/trả về, hồ sơ liên quan và báo cáo. Người quản trị nhìn được chỗ tắc và xử lý ngoại lệ mà không sửa database hoặc mã nguồn.

## Thứ tự xây dựng đề xuất

Ưu tiên đã điều chỉnh theo phản hồi ngày 11/11/2026. Trình thiết kế cần ưu tiên độ linh hoạt trước khi mở rộng workspace: **danh mục kiểu trường và điều kiện trường → rẽ nhánh theo dữ liệu từng bước → quy tắc chuyển, trả về, bàn giao và phân công lại → xử lý song song**. Tệp đính kèm vẫn thuộc bộ kiểu trường nghiệp vụ. Theo dõi bằng chứng theo [mốc nghiệm thu](GOAL_WORKFLOWS_COMPLETE.md).

| Mốc | Phạm vi | Bằng chứng phải có trước khi chốt |
| --- | --- | --- |
| W1 — Biểu mẫu nghiệp vụ | Nhiều kiểu trường, điều kiện VÀ/HOẶC, lọc danh sách, bảng dòng lặp, tiền/công thức, nhân sự/đơn vị, đính kèm, quyền xem/sửa/bắt buộc theo bước và lưu nháp | Đề nghị mua sắm có bảng tự tính và danh sách thay đổi khi đổi loại; API kiểm giá trị và quyền trường; draft tải lại được; version cũ vẫn chạy |
| W2 — Luồng và bàn giao nâng cao | Điều kiện theo dữ liệu các bước và hành động; trả về bước hợp lệ; chọn người khi bàn giao và cấu hình quyền phân công lại; nhiều bước độc lập cùng chờ, hợp nhánh; thu hồi có điều kiện | Lượt gửi lại rẽ nhánh theo kết quả mới; đổi người xử lý giữ lịch sử và kiểm người nhận; IT và Hành chính nhận task độc lập và hợp nhánh đúng một lần |
| W3 — Phối hợp và theo dõi | Bình luận, nhắc tên, người liên quan; hồ sơ tổng hợp dữ liệu/tệp/lịch sử/các bước; bộ lọc lưu lại, cột tùy chỉnh, phân công lại theo policy | Người theo dõi đọc/bình luận đúng trường nhưng không duyệt; mất quyền không còn đọc dữ liệu; tham chiếu/comment/attachment không mở rộng quyền ngầm |
| W4 — Tự động hóa có cấu hình | Quy trình liên kết, mapping, lịch tạo nháp; outbox và nhật ký chạy/thử lại; mẫu thông báo/in; adapter HR/LMS theo hợp đồng | Một sự kiện lặp hoặc worker khởi động lại không tạo trùng; thiếu dữ liệu tạo nháp cần bổ sung; người được chỉ định mất quyền thì dừng có lý do; dùng email sink/connector giả lập local |
| W5 — Quản trị và đo hiệu quả | Báo cáo thời gian/tỷ lệ trễ theo bước; trình chọn dữ liệu/nhóm/tổng hợp/biểu đồ; version diff/restore; kho tài liệu quy trình sau khi engine ổn định | Drill-down khớp lịch sử thật; phân biệt run/task/person khi đếm; báo cáo chia sẻ và tệp xuất không vượt scope/field permissions; rollback tạo version mới |

W1 ưu tiên trước vì bảng dữ liệu, quyền trường và trải nghiệm hồ sơ ảnh hưởng trực tiếp tới mọi quy trình nghiệp vụ. W2 cần thay mô hình thực thi; không ghép nút “song song” vào engine đang chỉ có một pending task. Có thể đưa cải tiến UI vào từng mốc, nhưng không nghiệm thu mốc từ mock hoặc ảnh đẹp.

### Nghiệm thu tệp đính kèm

- Người thiết kế cấu hình trường đính kèm tại khởi tạo hoặc bước xử lý, giới hạn số tệp và loại tệp. Ca mua sắm lưu chứng từ vào nháp, tải lại nháp, gửi và mở chứng từ từ hồ sơ. Khi bổ sung và gửi lại, lịch sử vẫn mở đúng tệp của lần gửi trước theo quyền.
- Upload có phạm vi gắn với nháp, lượt hoặc nhiệm vụ cụ thể. API xác minh kích thước và loại nội dung, lưu trạng thái kiểm tra/cách ly và chặn dùng tệp chưa đạt. Khi ghi câu trả lời, server kiểm tệp đúng trường và đúng phạm vi trong cùng giao dịch.
- Bản xem hồ sơ, lịch sử và API tải xuống dùng cùng quyền trường và quyền hồ sơ. Thử dùng ID của hồ sơ khác, người xử lý mất quyền, tệp bị loại và tệp nằm trong bước đã bị thay thế. Link tải yêu cầu phiên hợp lệ và không dùng cho người ngoài phạm vi.

### Nghiệm thu trả về bước trước

- Trình thiết kế cấu hình theo hành động. Người xử lý có thể trả về bước liền trước hoặc chọn một bước đã thực sự được xử lý trên đường đi còn hiệu lực. Giữ lựa chọn trả người khởi tạo cho quy trình hiện hành. Thiết lập từ chối có thể kết thúc lượt hoặc chuyển theo cấu hình. [Hành vi tham chiếu từ AMIS](https://helpamis.misa.vn/amis-quy-trinh/kb/thiet-lap-luong-quy-trinh/)
- Ca mua sắm quay về bước nhập hoặc soát xét đã đi qua. Tạo nhiệm vụ mới cho lần xử lý mới, giữ lý do, dữ liệu và phiếu cũ trong lịch sử. Những quyết định bị thay thế từ điểm quay về không được dùng tiếp để lấy người xử lý, dữ liệu rẽ nhánh hoặc chứng minh phê duyệt. Các bước trước điểm quay về vẫn có hiệu lực.
- Một thao tác gửi lại có thể chọn nhánh khác. API phải từ chối bước thuộc nhánh chưa đi, lần gửi cũ hoặc lần xử lý đã bị thay thế. Kiểm hai lệnh cạnh tranh, lặp idempotency key, quyền người nhận hiện hành và rollback khi ghi audit lỗi. Chặn việc dùng một phê duyệt cũ đã bị thay thế để áp dụng hồ sơ nhân sự.
- Đích thu hồi và đích trả về dùng cùng mô hình lần thực hiện. Thu hồi chỉ mở khi bước tiếp theo chưa có quyết định và người chuyển còn đủ quyền. Khi triển khai nhánh độc lập, tập bước bị thay thế phải bám quan hệ phụ thuộc để giữ được kết quả của nhánh không liên quan. [Hành vi thu hồi tham chiếu từ AMIS](https://helpamis.misa.vn/amis-quy-trinh/kb/thu-hoi-quy-trinh/)

### Nghiệm thu xử lý song song và hợp nhánh

- Designer cấu hình điểm tách và điểm hợp, người xử lý, biểu mẫu và thời hạn riêng từng bước. Khi vào cụm, tài chính và kỹ thuật trong ca mua sắm hoặc IT và hành chính trong ca tiếp nhận nhân sự cùng thấy nhiệm vụ đã giao. Lượt chạy tiếp tục sau khi đủ nhánh. Hai thao tác đến đồng thời hoặc gửi lặp chỉ tạo một bước sau điểm hợp. [Hành vi tham chiếu từ AMIS](https://helpamis.misa.vn/amis-quy-trinh/kb/thiet-lap-buoc-song-song/)
- Mỗi lần đi qua điểm tách phải có định danh riêng. Lưu nhánh đang xử lý và nhánh đã tới điểm hợp theo lần đi qua. Thay ràng buộc một nhiệm vụ đang chờ trên toàn lượt bằng ràng buộc theo nhánh. Kiểm thao tác, phiếu đồng duyệt, phân công lại và nhắc hạn theo nhiệm vụ đang mở, đúng lần gửi và đúng nhánh.
- Trả lại trong một nhánh giữ các quyết định còn hiệu lực của nhánh độc lập. Nếu quay về trước điểm tách, các nhánh phụ thuộc phải được xử lý lại. Nếu quay về sau khi đã hợp nhánh, lịch sử thể hiện những lần xử lý đã thay thế và chặn thao tác từ bản xem cũ.
- Inbox và danh sách việc cần mở đúng nhiệm vụ ngay cả khi một người có hai nhiệm vụ trong cùng lượt. Các số tổng hợp phải phân biệt lượt chạy với nhiệm vụ. Điều kiện sau điểm hợp dùng kết quả đã hoàn tất, giữ quyền đọc trường khi hiển thị người nhận bàn giao.

### Nghiệm thu thu hồi

- Người khởi tạo lấy lại hồ sơ vừa gửi để sửa khi các nhiệm vụ trong lần gửi còn chờ quyết định. Người đã chuyển bước lấy lại nhiệm vụ của mình khi các nhiệm vụ phụ thuộc chưa được xử lý. Kiểm quyền hiện hành và phiên bản lượt ngay khi ghi.
- Thu hồi sau khi một nhánh đã đến điểm hợp nhưng các nhánh khác còn đang xử lý cần mở lại nhánh của người thu hồi. Quyết định ở nhánh độc lập vẫn có hiệu lực. Nếu đã hợp nhánh và bước mới còn chờ, đóng nhiệm vụ phụ thuộc và giữ lịch sử.
- Một phiếu đã gửi trong nhiệm vụ đồng duyệt được tính là đã xử lý. Khi thu hồi cạnh tranh với quyết định của người nhận, chỉ lệnh hợp lệ đầu tiên thành công. Thử lặp cùng idempotency key, mất quyền, khác phạm vi, và lỗi ghi audit. [Hành vi thu hồi tham chiếu từ AMIS](https://helpamis.misa.vn/amis-quy-trinh/kb/thu-hoi-quy-trinh/)

## Định hướng giao diện

Thiết kế của AIO, không sao chép giao diện MISA. Dùng React + TypeScript + Vite + Tailwind v4 + shadcn/Radix, logo TLQM, Be Vietnam Pro, CTA `#087C3C`, navy `#223873`, light mode và control 44px theo [Design System](../docs/FRONTEND_DESIGN_SYSTEM.md).

- **Bàn làm việc:** Cần xử lý, Tôi khởi tạo, Đã xử lý, Theo dõi; bảng có bộ lọc, tìm kiếm, cột nghiệp vụ và trạng thái/hạn/người phụ trách. Mỗi view có URL khôi phục được; chỉ hiện chức năng đã có API.
- **Trình thiết kế:** danh sách bước/sơ đồ, vùng biểu mẫu rộng và panel cấu hình bước. Các nhóm Biểu mẫu, Người xử lý, Luồng & hành động, Quyền dữ liệu, Thời hạn, Tự động hóa, Phiên bản có nội dung thực. Kiểm lỗi chỉ rõ bước/trường; xem trước theo vai trò và thiết bị.
- **Hồ sơ:** đầu trang có mã, tiêu đề, trạng thái, hạn và hành động đang được phép; vùng chính là dữ liệu và bảng chi tiết; vùng phụ là tiến trình/người xử lý. Tệp, trao đổi và nhật ký có vị trí ổn định; hành động lưu/gửi/duyệt phân biệt rõ.
- **Điều phối:** thấy task lỗi phân công, hồ sơ quá hạn, job tự động hóa lỗi và lý do; mở đúng bước/hồ sơ để xử lý. Không giấu lỗi dữ liệu dưới thống kê tổng hoặc đánh dấu thành công giả.

## Các quyết định kỹ thuật cần giữ

1. **Tương thích:** chỉ thêm migration sau Workflows 020 (tiếp theo 021), Foundation 009 (010), Forms 003 (004), LMS 010 (011) khi cần. Giữ checksum của các migration đã áp dụng. Runtime đọc WorkflowSpec 1–5, gồm v5 và định dạng import/export từ W1a.
2. **Hồ sơ và quyền trường:** định danh field/row ổn định, phân biệt input với dữ liệu từng lần thực hiện bước. Phép sửa tạo revision/lịch sử mới. Quyền đọc/ghi được kiểm ở server và trước commit; cùng policy cho detail, history/votes, search, báo cáo, template, file và adapter. Điều kiện ẩn không phải quyền bảo mật.
3. **Tính toán:** tiền dùng biểu diễn thập phân xác định, tính và làm tròn ở backend. Công thức/điều kiện là ngôn ngữ hữu hạn có giới hạn độ sâu/tham chiếu; chặn vòng phụ thuộc. Không eval JS/SQL, không biên dịch schema người dùng thành validator Fastify.
4. **Nhánh và lần thực hiện:** cần token/branch/step-attempt hoặc mô hình tương đương; unique và revision theo đúng lần thực hiện. Return/recall phải xác định phần công việc bị thay thế, quyết định nào không còn áp dụng; lịch sử cũ bất biến. Chỉ cho các vòng quay lại được khai báo và có giới hạn, không bật cycle tùy ý.
5. **Quyền và người xử lý:** tiếp tục issuer+subject, person độc lập account; chống tự duyệt/nhân đôi phiếu; nhóm/vị trí/chức danh chỉ lọc ứng viên đã có quyền. Người theo dõi, người nhận thông báo và người thực thi là ba quan hệ riêng. Thay công tác/quyền cần tác động tới cả task, tệp, search, báo cáo và job nền.
6. **Tự động hóa:** principal thực thi rõ ràng, version được ghim, unique event/schedule key, outbox giao dịch, retry có giới hạn và audit. Không dùng token người dùng hết hạn hoặc giả làm người gửi; tạo nháp trước khi đủ dữ liệu/ủy nhiệm. Liên kết có giới hạn độ sâu/số con và phát hiện vòng. Không gửi email hoặc gọi hệ thống thật trong khảo sát/local nghiệm thu.
7. **Tệp và đầu ra:** module sở hữu storage riêng hoặc adapter được phân quyền; tải tệp không công khai theo URL đoán được. Metadata/tệp mẫu có version và guard kích thước/loại nội dung; mô hình scan và trạng thái cách ly phải rõ trước phát hành. Trộn dữ liệu theo quyền, không tự lấy tất cả field rồi chỉ che trên màn hình.
8. **Rollback:** dừng phát hành version mới/automation mới để chặn phát sinh; giữ runtime hỗ trợ lượt cũ, outbox và lịch sử. Không quay code về bản chỉ hiểu một task khi đã có lượt song song; không reset volume để vượt lỗi.

## Bốn kịch bản nghiệm thu sản phẩm

| Kịch bản | Kết quả nghiệp vụ cần quan sát |
| --- | --- |
| Mua sắm | Nhân viên nhập bảng hàng; tổng tiền quyết định cấp duyệt; tài chính và kỹ thuật xử lý độc lập; một bên yêu cầu bổ sung; giữ quyết định và dữ liệu theo từng lần xử lý |
| Tạm ứng → quyết toán | Hồ sơ nguồn được duyệt sinh hồ sơ liên quan có mapping; người nhận bổ sung chứng từ rồi gửi; chống tạo trùng, tra được nguồn và trạng thái đích |
| Tiếp nhận nhân sự | HR giữ trường lương riêng; IT/Hành chính chỉ thấy dữ liệu cần thiết; hai bên bàn giao tài sản độc lập; chỉ hoàn tất khi đủ công việc; không tự cấp IAM từ mẫu |
| Đề nghị đào tạo | Phê duyệt nhu cầu/budget; adapter tạo nháp kế hoạch/đợt LMS; admin đào tạo xác nhận theo quyền; theo dõi người học và trạng thái qua hợp đồng, không ghi trực tiếp DB module khác |

Mỗi kịch bản có ca thành công, thiếu dữ liệu, thu hồi quyền, khác tenant/unit, thao tác đồng thời, retry, audit rollback và bảo toàn phiên bản cũ. Kiểm UI desktop/mobile/bàn phím/axe và xem ảnh thật. Chạy check, E2E SSO/quyền và suite nghiệp vụ tuần tự theo [runbook](../docs/LOCAL_DEVELOPMENT.md). Số tests pass là bằng chứng kỹ thuật đi kèm, không thay việc người nghiệp vụ hoàn thành được các kịch bản trên.

## Chưa kết luận từ đợt khảo sát

Chưa xác nhận toàn bộ BPMN, quy trình con chặn luồng cha, ủy quyền theo thời gian, API chi tiết, ký số, quản lý sự không phù hợp và giá/gói AMIS. Không dựa vào tính năng của AMIS Công việc/Tuyển dụng để ghi thành tính năng Quy trình. Khi mở rộng các phần này cần tài liệu đúng sản phẩm và hợp đồng/tiêu chí riêng. Hosting, dữ liệu thật và connector production không thuộc việc đọc tài liệu này.
