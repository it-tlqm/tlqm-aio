# Quy trình — nhóm phê duyệt và lịch làm việc

Ngày 11/11/2026, workspace `D:/thanhnx/TLQM-AIO`, nhánh `feat/foundation-mvp`, baseline `abea705b0937fe164fa9c983700089bec88c82ba`, worktree dirty. Đây là phần E2 của [goal cấu hình mở](../roadmap/GOAL_CONFIGURABLE_SUITE.md), chỉ vận hành local/dữ liệu giả lập. Source chưa commit; bằng chứng không thuộc riêng baseline HEAD.

## Cấu hình bằng giao diện

1. Điều phối viên tạo **Nhóm xử lý**, chọn thành viên có quyền `workflows:act` trong đơn vị. Nhóm không tự cấp quyền ứng dụng.
2. Người thiết kế mở bước phê duyệt, chọn **Nhiều người cùng phê duyệt** và nhóm. Chọn **Tất cả**, **Một người** hoặc **Đủ số người đồng ý** (1–50).
3. Cấu hình thời hạn theo **giờ/phút**, thời gian liên tục hoặc theo lịch làm việc. Tại **Thông tin & đối tượng**, bật lịch riêng: múi giờ cố định, ngày trong tuần, tối đa bốn ca không chồng nhau và ngày nghỉ. Việt Nam dùng UTC+7. Lịch không tự đổi theo giờ mùa hè. Ca kết thúc 00:00 nghĩa là cuối ngày.
4. Bật/tắt **Cho phép trả về người gửi** tại từng bước. Lưu nháp, kiểm tra cấu hình và phát hành bằng tài khoản có quyền/MFA.

Phát hành tạo WorkflowSpec v4 khi dùng tính năng mới. Các bản 1–3 vẫn đọc và chạy theo hợp đồng cũ. Lịch, chính sách và thời hạn được chụp vào version/task; sửa bản nháp/phát hành mới không đổi task đang chạy. Thời lượng tối đa 525.600 phút (8.760 giờ), phép tìm hạn dừng sau 3.660 ngày; lịch quá thưa để đáp ứng hạn sẽ bị từ chối rõ ràng.

## Quy tắc xử lý

- Nhóm được chốt khi lượt chạy đến bước. Chỉ thành viên hiện còn đủ quyền và khác person của người gửi mới tham gia. Nhóm có nhiều tài khoản của cùng một person bị chặn; quorum cao hơn số người độc lập bị chặn, toàn giao dịch lùi lại.
- Mỗi người gửi một quyết định. Tất cả phiếu, dữ liệu biểu mẫu, lý do và thời gian đều lưu bất biến. Phiếu đã hợp lệ không bị xóa khi người đó mất quyền về sau; người mất quyền không được bỏ phiếu mới hoặc đọc dữ liệu ngoài quyền hiện tại.
- Một phiếu từ chối/trả về kết thúc bước; số phiếu đồng ý chỉ hoàn tất khi đủ ngưỡng. Trả về tạo vòng gửi mới, giữ lịch sử vòng cũ. Đây là duyệt đồng thời trong một bước; chưa phải tách/ghép nhánh song song tùy ý hay trả về bất kỳ bước nào.
- Hai người có thể gửi đồng thời. Phiếu trung gian không tăng revision task; thay phân công hoặc kết thúc bước có tăng revision. Transaction/idempotency bảo đảm chỉ một lần chuyển bước, không đếm phiếu lặp.
- Điều phối viên được thay một người **chưa bỏ phiếu** bằng thành viên khác hiện đủ quyền trong cùng nhóm. Lịch sử người cũ giữ lại; không thay người đã bỏ phiếu, không đổi ngưỡng, hạn hoặc phiếu cũ. Nhóm không còn đủ người được hiển thị để điều phối viên xử lý.
- Quy tắc “Người đã xử lý bước trước” lấy người gửi quyết định làm hoàn tất bước trước, kể cả bước duyệt nhóm.

## Công việc và thông báo

Mỗi thành viên chưa quyết định nhận công việc và nhắc hạn riêng; sau bỏ phiếu, công việc/thông báo cần xử lý biến mất khỏi hộp cá nhân, lịch sử vẫn còn. Bảng quản lý đếm một lượt chạy theo đơn vị, đồng thời tổng hợp trách nhiệm của từng thành viên chưa quyết định.

Thông báo phân công dùng phiên bản phân công; A → B → A không làm thông báo cũ của A hiện lại. Nhắc hạn được chống trùng theo phiên bản phân công và loại sắp đến/quá hạn. Hạn task có thể tính theo lịch làm việc; khoảng nhắc trước/sau hạn vẫn là phút thời gian liên tục theo [Work Center](WORK_CENTER.md), không dời thông báo ngoài ca. Chỉ thông báo trong ứng dụng.

## Dữ liệu, kiểm thử và rollback

Workflows migration **005** đã áp dụng local/test; 001–005 từ đây bất biến. Bảng thành viên và phiếu độc lập, policy snapshot không sửa, DB chặn tự duyệt/đếm trùng person và sửa phiếu. Chạy `npm run workflows:setup` qua guard host/database/marker/checksum, không reset hoặc xóa volume.

Tám tests mới trong `tests/workflows-pools.test.ts` đã pass: concurrency, quorum, veto/return, revocation, thay người/A→B→A, person/self-approval, rollback khi quyền mất giữa giao dịch, lịch/version pinning. `npm run test:workflows-pools` đã pass SSO/MFA thật, hai người duyệt, thu hồi nhóm, lịch và sáu axe scans. Sau cải thiện bộ chọn đơn vị, lượt SSO/UI mới đã pass sáu axe scans; đã xem lại ảnh lịch desktop/mobile và màn người duyệt. Hồi quy đang chạy bằng `npm run test:suite-regression -- e2`; chỉ receipt pass và sourceStable mới được coi là nghiệm thu bản cuối. Không gọi số axe là chứng nhận WCAG đầy đủ.

Evidence ignored: `.local/evidence/workflows-pools-e2e.json`, `workflows-pool-*.png`, `configurable-e2-regression.json`, logs từng lệnh. Tắt phát hành để ngừng lượt mới; lượt đang chạy tiếp tục version cũ hoặc hủy có audit. Nếu bỏ UI mới vẫn phải giữ runtime hiểu v4 cho lượt cũ; không downgrade code về bản bỏ qua policy và không xóa journal/phiếu để rollback.

Tham khảo mẫu cấu hình [AMIS nhiều người xử lý](https://helpamis.misa.vn/amis-quy-trinh/kb/huong-dan-thiet-lap-nguoi-thuc-hien-nguoi-phe-duyet-amis-quy-trinh/) và [AMIS lịch làm việc](https://helpamis.misa.vn/amis-quy-trinh/kb/thiet-lap-thoi-gian-lam-viec/). Chính sách snapshot/quorum/quyền bên trên là thiết kế AIO, không khẳng định đó là chi tiết triển khai của MISA. UI dùng shadcn/Radix và bộ nhận diện TLQM.

Checkpoint E2 cuối: `configurable-e2-regression.json` pass 2026-11-10T20:14:53.598Z, 171 tests và 10 lệnh tuần tự, sourceStable=true. Đã xem ảnh lịch desktop/mobile, bảng thiết kế, người duyệt mobile và lịch sử hai phiếu.
