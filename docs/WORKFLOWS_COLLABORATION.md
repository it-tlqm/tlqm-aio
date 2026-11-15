# Trao đổi trong AIO Quy trình

Trong hồ sơ, mở **Trao đổi** để đọc và gửi bình luận. Người khởi tạo hoặc điều phối viên có quyền tại đơn vị có thể tìm người trong Directory, thêm người theo dõi và bỏ theo dõi. Người được thêm cần quyền **Theo dõi hồ sơ được chia sẻ**, quyền ứng dụng và công tác hiện hành tại đơn vị hồ sơ. Danh sách **Theo dõi** mở lại từ địa chỉ `/#workflows/followed`.

Bình luận hiển thị cho người có quyền đọc hồ sơ. Người khởi tạo, người xử lý đủ quyền, điều phối viên và người đang theo dõi có thể gửi. Để nhắc tên, chọn người trong mục **Nhắc tên người theo dõi** trước khi gửi. Người nhận thấy thông báo và đường dẫn tới hồ sơ ở Trung tâm công việc nếu có quyền vào Portal. Nội dung thông báo chỉ gồm tiêu đề hồ sơ và loại sự kiện. Ý kiến quyết định và bình luận là hai lịch sử riêng.

Người theo dõi đọc các trường được phép ở từng lần gửi và kết quả bước. Các tệp áp dụng cùng quyền như trên màn hình hồ sơ. Quyền xử lý, thu hồi và phân công lại tiếp tục do quyền tại nhiệm vụ quyết định. Phạm vi người theo dõi hiện gắn với hồ sơ nghiệp vụ. Đề xuất hồ sơ nhân sự dùng phạm vi đọc của adapter hồ sơ nhân sự.

## Vận hành và rollback local

Áp dụng Workflows 012 bằng `npm run workflows:setup` với API dev đã dừng. `npm run workflows:fixtures` cấp quyền mẫu theo đơn vị cho danh tính giả lập đang có qua MFA quản trị. Phạm vi dữ liệu và điều kiện chạy ở [runbook local](WORKFLOWS_LOCAL_DEVELOPMENT.md).

Thêm, bỏ theo dõi và bình luận dùng transaction và idempotency hiện có. Bỏ theo dõi kiểm revision và thu hồi quyền đọc từ quan hệ này. Mỗi lượt nhắc tên gắn đúng revision của quan hệ, nên thêm lại người cũ tạo quyền cho lượt mới. Nhật ký chỉ ghi định danh và số lượt nhắc, còn nội dung lưu trong bảng bình luận bất biến.

Khi cần thu hồi khả năng theo dõi ở một đơn vị, thu hồi binding Quy trình tương ứng qua IAM. Để thu hồi ở một hồ sơ, dùng **Bỏ theo dõi**. Giữ migration 012 và lịch sử phục vụ kiểm tra. Có thể lùi giao diện về bản trước trong khi giữ runtime đọc dữ liệu và journal hiện hành. Dùng suite `npm run test:suite-regression -- w3-collaboration` để kiểm tra sau khi dừng các listener dev.

## Bàn làm việc cá nhân

**Đã xử lý** hiển thị hồ sơ có quyết định hoặc phiếu của chính bạn. Một phiếu xuất hiện khi đã gửi, kể cả khi nhóm còn đang đợi các phiếu khác. Cột **Đã xử lý lúc** lấy từ lần xử lý gần nhất của bạn trong hồ sơ. Máy chủ kiểm quyền đọc hiện hành khi tải danh sách.

Tìm hồ sơ theo tiêu đề, tên quy trình hoặc mã hồ sơ. Có thể lọc trạng thái, đơn vị và hạn của bước đang chờ. Mở **Bộ lọc đã lưu và cột hiển thị** để chọn cột, đặt tên và lưu. Bộ lọc thuộc tài khoản, người, tenant và danh sách hiện hành. Liên kết danh sách giữ cấu hình đang dùng khi tải lại trang hoặc quay về từ hồ sơ.

Cột nghiệp vụ lấy từ biểu mẫu khởi tạo của phiên bản đã ghim và có thể chọn từ các hồ sơ đang tải trong danh sách. API chỉ gửi nhãn và giá trị được phép xem của hồ sơ tương ứng. Bảng chi tiết hiện số dòng và trường đính kèm hiện số tệp. Mở hồ sơ để đọc đầy đủ dữ liệu hoặc tải tệp theo quyền. Có thể cuộn ngang vùng **Bảng hồ sơ** bằng bàn phím.

Workflows 013 lưu bộ lọc và chỉ mục quyết định. Khi lùi giao diện, giữ journal và bản ghi bộ lọc. Kiểm bằng `npm run test:suite-regression -- w3-workspace` trong môi trường local/test cô lập.

## Người liên quan theo bước

Trong **Trao đổi**, chọn **Phạm vi trao đổi** theo tên bước, lần gửi và lần xử lý. Chủ hồ sơ còn công tác tại đơn vị hoặc điều phối viên có quyền có thể thêm người theo dõi. Người được thêm cần quyền Quy trình và công tác tại đơn vị hồ sơ. Người đang được giao xử lý có thể tham gia trao đổi của bước mình đủ quyền.

Mục **Theo dõi** và thông báo nhắc tên mở đúng lần xử lý đã chia sẻ. Người theo dõi theo bước thấy trạng thái bước, dữ liệu khởi tạo được cấu hình tại bước, kết quả và tệp còn đủ quyền xem. Bình luận và nhắc tên thuộc đúng phạm vi đang chọn. Quyền thao tác nhiệm vụ tiếp tục do phân công và policy của bước quyết định.

Sau bàn giao bình thường, liên kết vẫn mở được lần xử lý đã chia sẻ trong cùng lần gửi. Khi lần xử lý bị thay thế hoặc lần gửi đổi, quyền theo dõi gắn với lần cũ hết hiệu lực, kể cả đường dẫn và thông báo cũ. Chủ hồ sơ và điều phối viên đủ quyền vẫn đọc được trao đổi lưu trữ. Muốn chia sẻ lần mới, chọn lần đó và thêm người theo dõi.

Workflows 014 áp dụng ràng buộc theo khóa nhiệm vụ trên người theo dõi, bình luận và nhắc tên. Dùng `npm run test:suite-regression -- w3-final` cho hồi quy. Khi cần dừng chia sẻ, bỏ theo dõi trong phạm vi bước hoặc thu hồi quyền theo dõi qua IAM. Lùi giao diện phải giữ backend hiểu phạm vi 014 để tiếp tục bảo vệ dữ liệu và lịch sử.
