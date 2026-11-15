# AIO Công việc local

AIO Công việc dùng SSO, IAM và Directory của Foundation. Dữ liệu dự án, công việc, trao đổi, nhắc hạn và audit nằm trong PostgreSQL riêng. [Ma trận phạm vi theo MISA AMIS](TASKS_AMIS_SCOPE.md)

## Dựng và chạy

Sau khi đã dựng Foundation, Keycloak, cơ sở dữ liệu và tài khoản Forms giả lập theo [runbook local](LOCAL_DEVELOPMENT.md) và [runbook Biểu mẫu](FORMS_LOCAL_DEVELOPMENT.md), chạy tuần tự:

```powershell
npm run tasks:setup
npm run local:client -- infrastructure/local/clients/aio-tasks.json
npm run tasks:fixtures
npm run build
npm run dev
```

`tasks:setup` kiểm Docker context local và marker Foundation, tạo `aio_tasks` và `aio_tasks_test` với role owner/runtime riêng. Tasks 001 tạo schema nghiệp vụ và quyền runtime. Script ghi checksum vào nhật ký migration. Nếu thêm schema, dùng migration tiếp theo. `tasks:fixtures` dùng MFA đã xác minh của operator để cấp quyền rõ ràng cho tài khoản giả lập. Nếu tài khoản quản lý mẫu chưa có grant Portal, script tạo grant vào Portal cá nhân. Bản ghi quyền đã thu hồi được giữ nguyên.

Mở thẻ **AIO Công việc** trong Portal hoặc vào [Công việc local](http://127.0.0.1:4106/) rồi đăng nhập SSO. Tài khoản quản lý mẫu `forms.publisher` cần MFA. `forms.reviewer` có quyền làm việc, `forms.analyst` có thêm quyền báo cáo, `demo.learner` chỉ có quyền xem. Các quyền làm việc và báo cáo của hai thành viên mẫu bị giới hạn theo đơn vị. Quản lý chọn nhân sự đủ điều kiện và cấp vai trò dự án trong tab **Thành viên**.

## Sử dụng và phân quyền

- Tạo dự án theo đơn vị. Một quản lý dự án có thể thêm thành viên, thay đổi vai trò, lưu trữ và mở lại dự án. Lưu trữ khóa thao tác ghi, giữ dữ liệu để tra cứu.
- Giao mỗi công việc cho một người thực hiện và chọn nhiều người liên quan. Một công việc có tối đa một cấp việc con. Dùng danh sách để lọc theo trạng thái, người thực hiện và quá hạn. Dùng **Bảng Kanban** để kéo thẻ. Dùng **Cập nhật tiến độ** để đổi trạng thái bằng bàn phím.
- Người giao hoặc người thực hiện có quyền tương ứng có thể cập nhật tiến độ và bàn giao công việc đang mở. Trao đổi và lịch sử lưu theo công việc. Hạn và thời điểm hiển thị theo giờ Việt Nam.
- Thành viên thông thường thấy công việc mình tạo, được giao hoặc tham gia. Vai trò người xem của dự án có quyền đọc dự án. Báo cáo yêu cầu thêm quyền IAM `tasks:report` và dùng cùng phạm vi hàng với danh sách. Trên màn hình hẹp, bảng số liệu cuộn ngang trong khung có thể nhận tiêu điểm. Mỗi request xác minh lại phiên và quyền.
- `npm run dev` và `npm start` chạy worker nhắc hạn trong BFF Công việc mỗi 30 giây. Worker ghi nhắc trong ứng dụng khi sắp đến hạn hoặc quá hạn. Đổi người thực hiện, hoàn thành, lưu trữ hoặc thu hồi quyền làm nhắc cũ hết hiệu lực. Test dùng tick tường minh.

## Trạng thái và góc nhìn dự án

Quản trị dự án mở **Trạng thái dự án** để đặt tên, thứ tự và thêm cột Kanban. Mỗi cột thuộc nhóm `todo`, `doing` hoặc `done`. Nhóm tiếp tục điều khiển tiến độ, hoàn thành, báo cáo và nhắc hạn. Ba mã mặc định luôn có mặt. Dự án chưa cấu hình giữ ba trạng thái và cách chuyển cũ. [Tham khảo thiết lập Kanban của AMIS](https://helpamis.misa.vn/amis-cong-viec/kb/thiet-lap-quy-trinh-du-an/)

Thiết lập quyền theo từng cặp chuyển và vai trò thành viên hoặc quản trị dự án. Backend kiểm lại quyền sửa tiến độ của người dùng, quy tắc chuyển và revision. Cấu hình và thay đổi trạng thái có idempotency và audit trong cùng transaction. Xóa cột đang có công việc hoặc đổi nhóm của cột đó trả 409. Thành viên có thể chỉnh tiến độ trong cột hiện tại khi vẫn có quyền tiến độ. Dùng **Cập nhật tiến độ** trong chi tiết để chuyển bằng bàn phím.

**Lưu góc nhìn** ghi một chế độ danh sách/Kanban và bộ lọc theo tài khoản, tenant và dự án trong trình duyệt. Bộ lọc được áp dụng lại khi mở dự án. Quyền xem từng dòng vẫn do backend kiểm ở lần đọc mới.

Migration 002 thêm cấu hình và mã cột. Với dự án đã bật cấu hình, DB từ chối lệnh đổi trạng thái từ bản BFF cũ vì bản đó chưa kiểm quy tắc chuyển. Khi diễn tập rollback app, giữ schema 002 và xác nhận ghi tiến độ dự án mặc định, đọc dữ liệu và lịch sử dự án tùy chỉnh. Khôi phục khả năng chuyển cột tùy chỉnh bằng bản BFF có hỗ trợ migration 002. [Migration](../infrastructure/tasks/002-project-workflow.sql)

### Diễn tập nâng từ schema 001

```powershell
$release = 'e4-task-stages-v4'
$baseline = 'e4-task-work-v2'
$candidate = Get-Content -Raw ".local/releases/$release/receipt.json" | ConvertFrom-Json
$prior = Get-Content -Raw ".local/releases/$baseline/receipt.json" | ConvertFrom-Json
& node_modules/.bin/tsx.cmd scripts/enterprise-recovery-postgres.ts $release $candidate.artifactDigest 'C:/Program Files/PostgreSQL/17/bin' --with-task-upgrade $baseline $prior.artifactDigest
& node_modules/.bin/tsx.cmd scripts/task-work-ui-drill.ts $release $candidate.artifactDigest --workflow
```

## Kiểm thử và rollback

Dừng các tiến trình dev chiếm cổng trước E2E. Chạy các suite tuần tự để tránh tranh chấp cổng, DB test và OTP. Bài kiểm thử tạo dự án giả lập có tên duy nhất, giữ audit và lưu trữ dự án sau khi chạy qua.

```powershell
npm run test:tasks
npm run test:suite-regression -- tasks-local
```

Bản xác minh gồm domain tests, Foundation SSO/IAM, Quy trình nghiệp vụ và Trung tâm công việc. Bằng chứng trình duyệt nằm trong `.local/evidence/tasks-*`, dùng dữ liệu giả lập. Sau hồi quy, mở lại API và LMS dev, xác minh `/health/ready` và trang chủ ở cổng 4100–4106.

Để ngừng Công việc trên AIO local, dùng thao tác disable đã có trong [runbook onboarding](LOCAL_CLIENT_ONBOARDING.md). Lệnh đổi trạng thái registry, thu hồi phiên có audit và tắt client Keycloak local. Schema Tasks 001, database, credentials, công việc và nhật ký được giữ để khôi phục.

```powershell
npm run local:client -- infrastructure/local/clients/aio-tasks.json disable
```

Để bật lại, chạy kiểm tra contract và kích hoạt tường minh. Các quyền cá nhân đã thu hồi được giữ nguyên. Khởi động lại dev và thử quyền bằng tài khoản giả lập trước khi dùng tiếp.

```powershell
npm run local:client -- infrastructure/local/clients/aio-tasks.json activate
npm run local:client -- infrastructure/local/clients/aio-tasks.json verify
```
