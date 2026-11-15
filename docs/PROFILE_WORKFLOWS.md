# Đề xuất hồ sơ → Quy trình → HR áp dụng

Ngày 11/11/2026. Mốc E4a của [goal bộ ứng dụng có thể cấu hình](../roadmap/GOAL_CONFIGURABLE_SUITE.md), đang nghiệm thu. Workspace `D:/thanhnx/TLQM-AIO`, nhánh `feat/foundation-mvp`, baseline `abea705b0937fe164fa9c983700089bec88c82ba`, worktree dirty. Chỉ dữ liệu AIO local giả lập.

## Luồng sử dụng

1. Nhân viên mở **Hồ sơ của tôi**, đề xuất các trường được HR cho phép tự sửa. Hồ sơ hiện hành chưa thay đổi.
2. HR vào **Nhân sự & tài khoản → Thông tin mở rộng → Duyệt đề xuất nhân viên → Quy trình phê duyệt**. Chọn một quy trình đã phát hành có bước phê duyệt, đơn vị được khởi tạo, điền thông tin bổ sung và chọn người nhận nếu mẫu dùng nhóm lựa chọn. Gửi xét duyệt.
3. Người được giao mở lượt trong Quy trình. Phần **Đề xuất hồ sơ nhân sự** hiển thị người có hồ sơ được sửa và các giá trị trước/sau đã chốt. Xử lý theo mẫu: nhiều bước, nhóm all/any/quorum, lịch và SLA vẫn dùng máy Quy trình hiện hành.
4. HR mở lại dialog hoặc bấm **Kiểm tra trạng thái**. Khi lượt hoàn thành và có ít nhất một bước được phê duyệt độc lập, HR nhập lý do và bấm **Xác nhận áp dụng hồ sơ**. Hệ thống kiểm lại quyền, nội dung, phiên bản cấu hình và revision hồ sơ rồi ghi thay đổi.

Người gửi cần `people:read`/`people:manage` ở Foundation và grant/quyền `workflows:start` tại đơn vị mình đang công tác. Xem/áp dụng đòi quyền đọc lượt nguồn hiện hành; quản trị Foundation không tự có quyền Quy trình. Người duyệt cần quyền xử lý nguồn. Người gửi và chủ hồ sơ không được tự phê duyệt. MFA, CSRF và các kiểm tra nguồn vẫn hoạt động.

## Nội dung, phiên bản và quyền

Foundation sở hữu đề xuất, schema, dữ liệu hồ sơ và trạng thái áp dụng. Workflows sở hữu lượt duyệt, nhiệm vụ, phiếu và quyết định. Adapter BFF gọi API dịch vụ nguồn với actor hiện hành; không thêm quyền kết nối từ database Quy trình sang Identity, không cho module Quy trình ghi hồ sơ.

Bản chụp nguồn gồm ID liên kết/đề xuất/person, tên tại thời điểm gửi, các trường trước/sau và SHA-256 của tenant/person/đề xuất/schema/base revision/patch. Chỉ adapter server tạo bản chụp; HTTP khởi chạy Quy trình không nhận trường nguồn do browser đưa vào. Nguồn, inputs và các phiên bản/phán quyết cũ bất biến. Thông báo không sao chép các giá trị hồ sơ.

Hoàn thành quy trình không tự ghi hồ sơ. Nhánh đi thẳng tới kết thúc mà chưa có quyết định `approve` ở vòng hiện tại không đủ điều kiện áp dụng. Bước xử lý tác vụ `complete` không thay bước duyệt. Người có hồ sơ được sửa bị chặn cả khi điều phối lại; trigger phiếu/kết quả cũng kiểm độc lập này.

Sau khi gắn quy trình, đường duyệt HR trực tiếp cũ bị chặn. Áp dụng giữ việc merge patch, kiểm schema/selfEdit, revision và trạng thái người như trước. Không sửa issuer/subject, account, quan hệ công tác, chức danh hay quyền ứng dụng từ dữ liệu metadata.

## Thử lại và tình huống xung đột

Hai database không có transaction chung. Foundation ghi liên kết **đã chuẩn bị** có audit, sau đó nguồn tạo lượt với key ổn định, cuối cùng Foundation gắn run ID. Unique source key và receipt ngăn tạo trùng. Nếu nguồn lỗi hoặc mất phản hồi, chính HR đã gửi dùng **Gửi lại lượt đã chuẩn bị**. Hệ thống đọc lại nguồn và gắn lượt cũ nếu nó đã được tạo, kể cả khi mẫu đã phát hành phiên bản mới. Quyền hiện hành được kiểm lại trước mỗi lần thử.

Liên kết đã chuẩn bị giữ nguyên cấu hình và lựa chọn. Nếu cần đổi nội dung/mẫu hoặc mẫu cũ không còn khởi tạo được, nhân viên rút đề xuất rồi tạo đề xuất mới; HR hủy lượt cũ nếu nó đã xuất hiện. Rút/từ chối đề xuất không tự hủy lượt ở module khác, nhưng chặn áp dụng. Lượt bị trả về chỉ gửi lại cùng nội dung đã chốt; sửa hồ sơ cần đề xuất mới.

Hồ sơ hoặc cấu hình đổi trong thời gian chờ sẽ báo xung đột, không áp dụng một phần. HR đối soát rồi yêu cầu đề xuất mới. Việc áp dụng metadata, cập nhật đề xuất/liên kết, audit và receipt nằm trong một transaction Foundation; lỗi audit rollback toàn bộ.

## Vận hành và rollback

**Foundation 008** và **Workflows 006** đã áp dụng local/test. Giữ checksum; migration mới bắt đầu Foundation 009 và Workflows 007. LMS hiện 001–009, Forms 001–003. Đọc [runbook local](LOCAL_DEVELOPMENT.md); dừng dev trước khi chạy tuần tự:

~~~powershell
npm run db:setup
npm run workflows:setup
npm run test:profile-workflows
~~~

Rollback nghiệp vụ: hủy lượt chưa kết thúc, rút/từ chối đề xuất chưa áp dụng, hoặc tạo đề xuất bù cho metadata đã ghi. Không xóa lịch sử/nguồn/phiếu và không khôi phục quyền bị thu hồi. Khi có liên kết, không quay về runtime cũ có đường duyệt HR trực tiếp không hiểu kiểm tra nguồn. Tạm ngừng sử dụng mẫu bằng trạng thái paused không thay lượt đã chạy.

## Phạm vi và bằng chứng

Hiện kết nối **đề xuất trường mở rộng hồ sơ người**. Chưa nối các thủ tục tiếp nhận/điều chuyển/nghỉ việc vào workflow này; chưa làm lương, hợp đồng hay ký số. Các loại nghiệp vụ đó cần adapter và kiểm tra riêng.

Bảy domain tests đã pass, gồm rollback audit Foundation: metadata, đề xuất, liên kết và receipt cùng được phục hồi khi ghi audit lỗi. Checkpoint **2026-11-10T22:11:47.614Z** đạt **193 tests, 10/10 lệnh, sourceStable=true**, receipt `.local/evidence/configurable-e4-profile-regression.json`. SSO E2E checkpoint có **7 axe scans**, kiểm keyboard Escape/focus restore, desktop/mobile, thu hồi grant nguồn, CSRF, đường duyệt HR cũ và xác nhận áp dụng. Đã xem ảnh dialog, bản chụp nguồn và hồ sơ sau áp dụng. UI follow-up bổ sung gửi từ mobile và ảnh cuối dialog đã pass trong hồi quy E4b; còn xem ảnh cuối. Chưa chốt toàn E4. Test nguồn `tests/profile-workflows.test.ts`, `scripts/profile-workflows-e2e.ts`; receipt nghiệp vụ `.local/evidence/profile-workflows-e2e.json`.

Tham khảo luồng đề xuất–duyệt–thực hiện thủ tục trong [hướng dẫn chính thức AMIS](https://helpamis.misa.vn/amis-thong-tin-nhan-su/kb/tao-de-xuat-mot-so-thu-tuc-nhan-su/), đọc ngày 11/11/2026. Cơ chế snapshot, kiểm quyền, thử lại và xác nhận áp dụng bên trên là thiết kế AIO, không phải tuyên bố đạt đủ tính năng AMIS.
