# Cấu hình tổ chức và hồ sơ nhân sự

Ngày 11/11/2026. Mốc E1 của [goal bộ ứng dụng cấu hình](../roadmap/GOAL_CONFIGURABLE_SUITE.md). Source mới ở `src/management/metadata.ts`, migration Foundation **007**, UI dùng lại ngôn ngữ dữ liệu Form Builder và components shadcn. Đây là metadata thuộc Directory, không phải trường bổ sung vào tài khoản đăng nhập.

## Cấu hình và sử dụng

Vào **Cơ cấu tổ chức / Nhân sự & tài khoản → Thông tin mở rộng**. Chọn loại hồ sơ: người, đơn vị, chức danh hoặc vị trí. **Thiết kế trường & bố cục** cho phép thêm phần/trường, sắp xếp, bảy kiểu dữ liệu, bắt buộc, giới hạn, lựa chọn và điều kiện. Nhập lý do, lưu nháp, xem trước rồi phát hành bản đã lưu. Nháp không đổi biểu mẫu đang sử dụng. Mỗi lần phát hành tạo một version bất biến.

Có [nhập/xuất cấu hình](CONFIGURATION_TRANSFER.md) với đối chiếu trước/sau, bản sao trước thay đổi và lưu nháp có CAS. Đề xuất người có thể gửi qua [Quy trình rồi HR xác nhận áp dụng](PROFILE_WORKFLOWS.md); đường duyệt trực tiếp bị chặn khi đề xuất đã gắn lượt duyệt.

Trong **Thông tin hồ sơ**, chọn record để nhập thông tin mở rộng. Lưu có revision và version cấu hình; phiên bản sai trả lỗi để tải lại. Khi cấu hình mới bỏ trường, dữ liệu cũ vẫn nằm trong lịch sử. Một field ID đã phát hành không được đổi kiểu; thêm trường mới khi cần kiểu khác. Đổi nhãn/lựa chọn được lưu ở version mới và lịch sử giữ nhãn tại thời điểm ghi.

Đối với hồ sơ người, HR chọn **Nhân viên được xem** và **Được đề xuất sửa** cho từng trường. Tập sửa phải nằm trong tập xem. Điều kiện của một trường nhân viên được xem không được phụ thuộc trường bị giấu khỏi nhân viên. Điều kiện ẩn/hiện là logic biểu mẫu; quyền xem trường do cấu hình selfView quyết định, không suy từ CSS hoặc điều kiện hiển thị.

Nhân viên vào **Hồ sơ của tôi → Thông tin hồ sơ bổ sung**. Trường chỉ xem bị khóa trên UI, trường nội bộ không được trả về API self. Nhân viên sửa các trường được phép và gửi lý do; dữ liệu chính thức chỉ đổi sau HR duyệt. Mỗi người có một đề xuất pending trong tenant; có thể rút đề xuất của chính tài khoản gửi. HR xem thay đổi với nhãn trường và đưa phản hồi gửi nhân viên khi duyệt/từ chối.

Nếu hồ sơ hoặc schema đổi sau lúc gửi, việc duyệt bị chặn; HR từ chối đề xuất cũ và nhân viên tải lại/gửi bản mới. HR không tự duyệt đề xuất của chính mình. Xóa giá trị một trường tùy chọn dùng patch null có kiểm tra; trường chỉ xem và trường không có trong selfEdit bị từ chối ở backend. Trường bắt buộc chưa đủ có thể cần HR bổ sung trước khi nhân viên gửi đề xuất; lỗi self không tiết lộ tên/giá trị trường nội bộ.

## Quyền và lịch sử

- Cấu hình người dùng `people:manage`; cấu hình tổ chức/chức danh/vị trí dùng `directory:manage`. Đọc record tuân theo scope Directory tương ứng.
- Self-service yêu cầu chính person của identity đã xác minh, home tenant đúng, account/membership/grant Portal đang hoạt động. Không dùng account/person ID do client gửi để chọn người khác.
- Mutator dùng quyền tường minh cho HR. Nhánh self-service không yêu cầu quyền HR nhưng bắt buộc callback kiểm ownership; helper từ chối nếu thiếu callback. MFA/CSRF/grant/identity/revocation vẫn qua middleware và principal hiện hành.
- Schema version và metadata history append-only; metadata ownership/revision có DB guard. Proposal bảo toàn người gửi, person, tenant, schema, base revision, patch và reason; trạng thái kết thúc không sửa lại. Audit/receipt và metadata/proposal cùng transaction.
- API lịch sử và danh sách đề xuất phân trang cursor; mỗi trang kiểm quyền lại. UI tải đủ các trang hoặc báo lỗi, không trình bày dữ liệu tải dở như đầy đủ.

Giới hạn ngôn ngữ: tối đa 20 phần, 100 trường (50/phần), schema 64 KiB, payload route 128 KiB; không nhận JS/SQL hoặc schema validator thực thi từ người dùng. Self policy áp dụng cho metadata; không cho sửa issuer, subject, tài khoản, role, grant, cơ cấu công tác hoặc quyền quản trị qua một trường tự đặt tên.

## Vận hành và rollback

Đọc [local runbook](LOCAL_DEVELOPMENT.md), chạy `npm run db:setup` bằng scripts có guard; Foundation 001–006 giữ nguyên, thêm 007 ở local/test. Không có migration LMS/Workflows trong E1. `npm run test:directory-metadata` dùng 4100 và DB test, dừng dev trước và không chạy đồng thời suite DB/MFA khác.

Rollback cấu hình bằng cách lưu cấu hình trước làm nháp rồi phát hành version mới; không sửa version cũ hoặc xóa lịch sử. UI hiện hiển thị danh sách version và history dữ liệu; việc chọn/import version cũ bằng giao diện được mở rộng ở E4. Không tự phục hồi grant đã bị thu hồi hoặc thay identity ownership khi rollback. Quay build cũ có thể bỏ màn metadata, nhưng giữ bảng/journal 007.

## Tham khảo và kiểm chứng

[MISA AMIS trường mở rộng](https://helpamis.misa.vn/amis-thong-tin-nhan-su/kb/tuy-chinh-truong-mo-rong-thong-tin/) và [self-service hồ sơ](https://helpamis.misa.vn/amis-thong-tin-nhan-su/kb/tuy-chinh-nhan-vien-cap-nhat-ho-so/) được đọc ngày 11/11/2026 để tham khảo mẫu sử dụng. AIO thực thi mô hình/schema/quyền riêng, không sao chép mã hoặc nhận diện MISA.

`tests/directory-metadata.test.ts` đã kiểm privacy, field/type policy, revisions, approve/withdraw/reject, history và tenant ownership; `test:directory-metadata` đã pass sáu axe scans cùng SSO/MFA UI thật. Hồi quy toàn hệ thống đang ghi ở `.local/evidence/directory-metadata-regression.json`; [goal](../roadmap/GOAL_CONFIGURABLE_SUITE.md) giữ trạng thái cuối và giới hạn. Các ảnh full-page có sticky header cần chụp từ đầu trang khi chốt visual cuối; không coi số axe là chứng nhận WCAG đầy đủ.
