# LMS — Lộ trình và đợt đào tạo

Ngày 11/11/2026. Phần E3b của [goal bộ ứng dụng có thể cấu hình](../roadmap/GOAL_CONFIGURABLE_SUITE.md). Workspace `D:/thanhnx/TLQM-AIO`, nhánh `feat/foundation-mvp`, baseline `abea705b0937fe164fa9c983700089bec88c82ba`, worktree dirty. Chỉ AIO local giả lập, chưa kết nối dữ liệu LMS hiện hữu.

## Sử dụng

Quản trị có MFA vào **Quản lý đào tạo → Quản lý lộ trình → Tạo lộ trình**. Nhập tên/hướng dẫn, chọn đơn vị được học, thêm và sắp thứ tự các khóa đang phát hành. Lưu nháp rồi phát hành. Bản nháp không làm thay đổi đợt đã giao.

Chọn **Tạo đợt đào tạo**, chọn phiên bản lộ trình, đơn vị phụ trách, ngày bắt đầu/hạn hoàn thành và người học cụ thể. Danh sách người lấy từ Directory hiện hành giao với mapping và quyền LMS. Tìm tên/đơn vị để chọn; không tự tạo tài khoản hoặc cấp quyền ứng dụng.

Để giao đợt từ một đề nghị đã duyệt, quản trị viên được chỉ định chọn **Tải đề nghị đào tạo** rồi **Mở đề nghị**. Đơn vị đến từ hồ sơ nguồn. Quản trị viên rà soát nội dung, chọn lộ trình, thời hạn và người học rồi giao đợt. Trạng thái đợt cập nhật về Quy trình. [Cấu hình và rollback adapter](WORKFLOWS_AUTOMATION.md#chuyển-đề-nghị-đào-tạo-sang-lms)

Học viên vào **Đợt đào tạo của tôi → Xem tiến độ → Mở khóa học**. Quản trị/người theo dõi mở chi tiết để xem tiến độ trong phạm vi quyền; có tìm học viên và phân trang 10 người. Tổng quan vẫn tính toàn bộ phạm vi được phép xem trước bộ lọc tìm kiếm. Nút tải lại lấy lại chi tiết hiện hành.

## Hợp đồng cấu hình

| Nội dung | Quy tắc |
| --- | --- |
| Lộ trình | Tối đa 50 phiên bản khóa, 200 đơn vị, không trùng; phát hành cần ít nhất một khóa và một đơn vị |
| Phiên bản khóa | Chốt khi phát hành lộ trình; nguồn phải đang phát hành và bao phủ đủ đơn vị của lộ trình |
| Đợt | Tối đa 500 người; mỗi người một enrollment, không chọn hai tài khoản của cùng person |
| Lịch | Ngày nhập theo giờ Việt Nam, hạn là cuối ngày; hạn phải sau thời điểm bắt đầu |
| Tiến độ | Tính từ kết quả đạt đã lưu của đúng phiên bản khóa; kết quả đạt trước khi giao đợt cũng được tính |
| Thứ tự | Hướng dẫn học; ràng buộc tiên quyết được cấu hình tại [chính sách từng khóa](LMS_POLICIES.md) |
| Đổi lịch | Có revision/idempotency/audit; không đổi phiên bản lộ trình hoặc danh sách enrollment |
| Hủy | Không kích hoạt lại; bỏ khỏi công việc cá nhân, giữ enrollment, lịch sử học và báo cáo quản trị |

Lịch đợt không chặn toàn bộ nội dung khóa trong catalogue. Nút mở trong đợt đợi đến ngày bắt đầu; API khóa học tiếp tục thực thi chính sách riêng, audience và quyền hiện hành. Phát hành bản lộ trình/khóa mới không thay các đợt đã giao. Khóa đã lưu trữ không dùng để tạo đợt mới; nếu nguồn bị lưu trữ sau khi giao, giao diện yêu cầu đối soát nội dung và lịch sử đạt vẫn được giữ.

Người theo dõi chỉ thấy học viên còn hợp lệ trong phạm vi `lms:review`; quản trị cần `lms:admin` và MFA. Học viên chỉ thấy enrollment của đúng account/person/employee liên kết. Chuyển đơn vị, khóa mapping, thu hồi grant hoặc hết công tác được kiểm lại; dữ liệu chốt lúc giao không thay quyền đang hiệu lực. Tất cả mutation giữ CSRF, audit và receipt giao dịch. Lỗi audit rollback cả mutation.

## Chạy và rollback

Đọc [runbook local LMS](LMS_LOCAL_DEVELOPMENT.md). Migration **LMS 008** của lộ trình/đợt, [009 cho công việc và nhắc hạn](LMS_WORK_CENTER.md) và [010 cho đề nghị đào tạo](WORKFLOWS_AUTOMATION.md#chuyển-đề-nghị-đào-tạo-sang-lms) đã áp dụng local/test. Giữ checksum 001–010, bổ sung mới từ 011. Chạy tuần tự khi dev đã dừng:

~~~powershell
npm run test:lms-training
npm run test:suite-regression -- e3-training
~~~

Rollback nghiệp vụ bằng đổi lịch/hủy đợt hoặc phát hành lộ trình mới theo quyền. Không xóa enrollment, kết quả, migration journal hoặc volume; không khôi phục quyền đã thu hồi. Runtime cũ không hiểu 008 không được dùng để quản trị các đợt đã tạo. LMS Worker phải giữ khóa độc quyền storage theo runbook.

## Bằng chứng

Checkpoint E3b hoàn tất **2026-11-10T21:50:26Z**: **186 tests, 8/8 lệnh pass, sourceStable=true cho 358 file**. Receipt `.local/evidence/configurable-e3-training-regression.json`; script nghiệp vụ `scripts/lms-training-e2e.ts` pass SSO/MFA thật và **7 axe scans** sau UI follow-up. Đã xem ảnh thiết kế lộ trình desktop/mobile, dialog giao đợt, màn tìm học viên, tiến độ và hoàn thành. Các ảnh dùng dữ liệu giả lập; không phải chứng nhận WCAG đầy đủ. Sau checkpoint bắt đầu E4, receipt này không đại diện mọi thay đổi tương lai.
