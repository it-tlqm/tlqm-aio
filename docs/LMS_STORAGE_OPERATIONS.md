# LMS — Sao lưu, phục hồi và dọn dữ liệu tạm

Ngày 10/11/2026. Chỉ áp dụng stack **AIO local/test giả lập**, Node 24, Miniflare/D1/R2 hiện có. Không thao tác LMS gốc, Cloudflare remote hoặc production. Migrations **001–006 bất biến**; công cụ kiểm marker, instance và checksum trước khi đọc/sửa dữ liệu.

## Khóa storage và người vận hành

Dừng Worker LMS trước thao tác offline; Foundation API không cần chạy cho các lệnh bên dưới. PostgreSQL/Keycloak AIO local vẫn phải hoạt động để xác thực operator MFA và kiểm quyền `identity:link` cùng delegation `access:manage` cho LMS. Công cụ dùng operator nền tảng giả lập hiện có, không dùng tài khoản lms.admin của người thử.

Runtime và CLI cùng lấy khóa `.local/lms/local/storage.lock.json` hoặc `.local/lms/test/storage.lock.json`. Khóa giữ qua việc đóng Worker và sao chép file; chỉ nhả sau khi thao tác xong. Không suy ra Worker đã dừng chỉ vì cổng 4104 trống: một inspector có thể dùng cổng tạm.

Nếu process bị kết thúc đột ngột, xác minh PID ghi trong khóa đã thoát rồi chạy:

~~~powershell
npm run lms:unlock -- local
~~~

Lệnh từ chối PID còn sống và khóa không đúng định dạng; không tự lấy lại khóa dựa trên tuổi file. Lệnh chỉ xóa file khóa, giữ nguyên D1/R2/config. Chạy unlock/start/bảo trì tuần tự.

## Tạo và kiểm backup

~~~powershell
npm run lms:backup -- local create
~~~

Kết quả in backupId, lưu dưới `.local/lms-backups/<backupId>/`. Có thể truyền lại cùng backupId để kiểm và nhận lại cùng bản backup; không ghi đè một bản đầy đủ hoặc bản còn dang dở.

Công cụ kiểm:

- Schema/marker và ownership của dữ liệu AIO giả lập trong tenant được operator quản trị.
- Foreign keys và toàn bộ media đã đăng ký: kích thước + SHA-256 từ nội dung R2.
- Worker đã dispose và storage vẫn bị khóa trước khi sao chép cả D1/R2.
- Mọi file sao chép có SHA-256/kích thước khớp; từ chối symlink/junction và đường dẫn ra ngoài workspace.
- Chỉ viết `manifest.json` với state complete sau khi sao chép/kiểm tra xong. Manifest có ID, môi trường, schema, người thực hiện, ngày, số lượng và hash; không chứa dòng dữ liệu nghiệp vụ.

Backup là file dữ liệu riêng trong .local, không phải artifact để chia sẻ hoặc đưa lên Git. Công cụ không sao chép runtime.json, lms-adapter.json, mật khẩu/OTP, private keys hay cấu hình IdP. Cần giữ bộ cấu hình gốc bằng cơ chế bảo vệ riêng; không tái tạo encryption key khi đã có storage.

## Phục hồi vào bản tách biệt

~~~powershell
npm run lms:backup -- local restore BACKUP_ID
~~~

Lệnh tạo `.local/lms-restores/<restoreId>/` ở storage riêng. Công cụ kiểm instance, môi trường, hash từng file và khóa storage. D1 và R2 được mở lại trong Miniflare để đối chiếu 23 bảng nghiệp vụ, gồm lộ trình, đợt, ghi danh và đề nghị từ Quy trình, cùng ownership, audit gốc và nội dung media.

Bản phục hồi mặc định **adapter disabled, toàn bộ mapping inactive**; xóa sessions legacy/AIO và login transactions, nâng auth_not_before. Audit phục hồi cùng transaction với các thay đổi khóa quyền. Không phục hồi phiên hoặc tự hồi quyền từ một snapshot cũ. File restore.json chỉ được tạo khi tất cả kiểm tra đạt và Worker bản sao đã đóng.

Đây là bản phục hồi để kiểm chứng trước khi thay dữ liệu đang phục vụ. Khi có yêu cầu phục hồi thực tế, cần giữ nguyên storage nguồn làm bản rollback, kiểm dữ liệu phát sinh sau ngày backup, rồi mới chọn bản phục hồi cho runtime. Sau khi chuyển, operator dùng lms:status/lms:control để mở adapter và từng mapping đã đối soát với IAM hiện hành; người dùng đăng nhập mới. Không dùng cookie, callback hay token cũ để kiểm bản phục hồi.

Backup này chỉ bao phủ dữ liệu LMS. Identity/Keycloak/Foundation thuộc owner riêng; quyền ứng dụng và công tác vẫn lấy từ IAM hiện hành. Công cụ hiện chặn storage có tenant khác ngoài phạm vi operator, không xuất toàn bộ dữ liệu nhiều tenant dưới quyền một tenant.

## Dọn media mồ côi và preview Excel hết hạn

Tạo kế hoạch trước:

~~~powershell
npm run lms:maintenance -- local plan
~~~

Mặc định chỉ chọn object chưa đăng ký, đủ một giờ tuổi. Có thể truyền minAgeSeconds (0 đến 604800) sau plan; zero dùng cho diễn tập fake fixtures. Plan lưu trong `.local/lms-maintenance/<planId>.json`, có checksum, instance/environment/tenant/actor, danh sách chính xác và số tổng. Mỗi đợt tối đa 500 object và 500 preview; kết quả ghi cả số đã chọn/tổng để tiếp tục đợt sau, không âm thầm cắt.

~~~powershell
npm run lms:maintenance -- local apply PLAN_ID
~~~

Trước khi áp dụng, công cụ tạo một backup riêng của plan. Khi chạy lại cùng plan, dùng cùng backup và intent/idempotency receipt.

Quy tắc chọn/dọn:

- Không xóa key đang được lms_media tham chiếu, kể cả key được đăng ký sau khi tạo plan.
- Key không đúng namespace/UUID được bỏ qua. Nếu chưa có registry nhưng course draft/version còn tham chiếu mediaId, giữ object như một ứng viên phục hồi.
- Một object của lần upload thua cuộc có cùng mediaId nhưng khác key registry có thể được dọn; key chính thức vẫn được giữ.
- Recheck đăng ký, tham chiếu, etag, kích thước và thời điểm upload trước khi xóa. Dừng nếu dữ liệu đổi.
- Missing/size-mismatch của media đã đăng ký chặn cleanup để đối soát/phục hồi trước. Backup kiểm thêm SHA-256 nội dung.
- Preview chỉ bị xóa nếu nằm trong danh sách plan, đúng tenant và đã hết hạn tại thời điểm lập plan. Preview còn hạn, ngân hàng câu hỏi, bản nháp/published copies và receipt nhập thành công được giữ.

D1 và R2 không có transaction chung. Công cụ ghi intent + receipt **trước** xóa R2; từng object có audit kết quả. Nếu file đã xóa nhưng ghi audit lỗi, cùng plan có thể tiếp tục, không báo hoàn tất sớm hoặc xóa lại một key mới được đăng ký. Xóa preview và audit của bước đó nằm cùng một D1 batch; audit lỗi rollback việc xóa preview. Chỉ ghi sự kiện complete sau khi tất cả bước đạt. Không xóa audit hoặc receipt cũ để làm test xanh.

## Bằng chứng

- `tests/lms-storage-lock.test.ts`: Worker thật lấy khóa độc quyền, từ chối mở/unlock khi owner sống; dispose cũ không xóa khóa mới; offline inspection giữ khóa đến hết copy.
- `npm run test:lms-backup`: MFA operator, backup D1/R2 thật, replay ID, từ chối sai môi trường/đường dẫn/hash và khóa đang giữ, phục hồi tách biệt. Receipt `.local/evidence/lms-backup-restore-e2e.json` lúc 12:41 ngày 12/11/2026 (UTC+7) đối chiếu 23 bảng, giữ nguồn và sessions, vô hiệu hóa truy cập ở bản phục hồi.
- `npm run test:lms-maintenance`: retention/scope, bảo vệ key đăng ký và tham chiếu thiếu registry, unknown keys, preview còn hạn; intent sống qua lỗi audit R2, retry một lần; lỗi audit preview rollback delete; stale plan không xóa key vừa đăng ký. Receipt `.local/evidence/lms-maintenance-e2e.json` (bản mới có previewDeleteAndAuditAtomic=true).
- Unit question bank đã kiểm retry nhập sau khi preview bị xóa, vẫn giữ idempotency và kiểm quyền hiện hành.

Đây là kiểm chứng local với dữ liệu giả lập. Không thay thế diễn tập cho topology production chưa được chọn.
