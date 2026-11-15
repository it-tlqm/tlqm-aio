# Trung tâm công việc và thông báo

Ngày 13/11/2026. AIO local giả lập. [Goal và nghiệm thu nguồn đầu tiên](../roadmap/GOAL_WORK_CENTER.md). Chọn **Quy trình**, **Công việc**, **Biểu mẫu** hoặc [**Đào tạo**](LMS_WORK_CENTER.md) ở **Nguồn công việc**.

## Sử dụng

Vào Portal → **Công việc & thông báo** hoặc http://127.0.0.1:4100/#work-center. Cần grant Portal và grant của module nguồn cùng tài khoản, cùng tenant; quyền quản trị Foundation không tự cho đọc công việc nguồn. Mỗi module tiếp tục thực thi quyền nghiệp vụ hiện hành.

- **Việc được giao:** nhiệm vụ đang chờ của chính tài khoản, còn đủ quyền và còn thuộc nhóm/người phụ trách theo cơ cấu.
- **Đề nghị đã gửi / Cần bổ sung:** đề nghị sở hữu bởi tài khoản, kiểm quyền khởi tạo trong đơn vị. Giữ trạng thái hoàn thành/từ chối/hủy trong danh sách đã gửi.
- **Quá hạn:** nhiệm vụ được giao có hạn trước thời điểm hiện tại. Hiển thị hạn, thời gian đã chờ, đơn vị và người xử lý. Tìm tên/nhiệm vụ/quy trình bằng nút Tìm kiếm hoặc Enter; lọc đơn vị, phân trang 25 kết quả.
- **Theo dõi đơn vị:** cần `workflows:manage` hoặc `workflows:report` đúng scope. Tổng việc tồn/quá hạn và nhóm theo đơn vị/người xử lý tính trên toàn bộ kết quả lọc trước phân trang; không coi chức danh quản lý là quyền xem.
- **Thông báo:** giao nhiệm vụ, một bước được duyệt, yêu cầu bổ sung, hoàn thành, từ chối, hủy, sắp hạn/quá hạn. Đọc/chưa đọc có revision, idempotency và audit. Không tự đánh đã đọc chỉ vì mở trang.

Nút **Mở hồ sơ** mở đúng lượt chạy ở module nguồn. Khi chưa có phiên Quy trình, đường dẫn UUID được giữ trong sessionStorage của tab tối đa 10 phút qua lần bấm đăng nhập; chỉ chấp nhận hash nội bộ đã định dạng, dùng một lần. Không lưu token/credential hoặc dùng hash làm quyền truy cập. Backend nguồn vẫn quyết định được xem/xử lý hay không.

Giao diện tự tải lại mỗi 60 giây khi tab hiển thị, trừ màn đang cấu hình; có nút Tải lại. Khi API lỗi/thu hồi quyền, không giữ tập dữ liệu hoặc số đếm vừa bị từ chối. Các thẻ thống kê cá nhân là tổng công việc được phép xem; bảng dùng bộ lọc. Màn quản lý thống kê đúng phạm vi lọc.

## Nguồn Công việc

Chọn **Công việc** để xem việc chưa hoàn thành đang giao cho mình trong dự án còn hoạt động. Tìm theo tên việc hoặc dự án. Danh sách tối đa 25 mục mỗi trang, sắp theo hạn rồi ID, các mục chưa có hạn nằm cuối. Tab **Nhắc hạn** dùng danh sách nhắc hiện hành của module Công việc. Nút **Mở công việc** mang tenant, dự án và công việc qua đăng nhập SSO. Hành động cập nhật và bàn giao thực hiện trong module nguồn.

Portal xác thực tài khoản và grant Portal trong tenant yêu cầu. Adapter kiểm lại issuer + subject, grant và quyền Công việc từ Foundation. Dịch vụ Công việc kiểm đơn vị, membership dự án, assignee và trạng thái trên kho của module. Cursor chỉ định vị trong tập đã qua kiểm quyền. Bàn giao, hoàn thành hoặc mất membership làm mục tương ứng rời feed ở lần đọc kế tiếp. Thu hồi grant trả 403 và giao diện bỏ dữ liệu của lần đọc cũ. Phần đọc dùng migration Công việc 001 hiện có. [Adapter](../src/tasks-work-center-boundary.ts), [Dịch vụ nguồn](../src/tasks/service.ts)

### Diễn tập thành phần E4

```powershell
$release = 'e4-task-work-v2'
$build = Get-Content -Raw ".local/releases/$release/receipt.json" | ConvertFrom-Json
& node_modules/.bin/tsx.cmd scripts/enterprise-recovery-postgres.ts $release $build.artifactDigest 'C:/Program Files/PostgreSQL/17/bin' --with-task-work
& node_modules/.bin/tsx.cmd scripts/task-work-ui-drill.ts $release $build.artifactDigest
```

Lượt API `19346f68-171f-4345-8584-944d1596022a` dùng PostgreSQL 17.11 cô lập và quyền runtime của Foundation/Công việc. Đã xác minh trang 25 + 2 mục, cursor trong phạm vi, bộ trường tối thiểu, tìm dự án, từ chối tenant khác, bàn giao, hoàn thành và thu hồi. Lượt Chromium `3ce5e0c2-8d43-49ad-8e13-13e287f80145` đạt lúc **08:27:14 ngày 13/11/2026, giờ Việt Nam**. Lượt này kiểm bàn phím, focus sau khi đóng dialog, tenant đích sau redirect đăng nhập giả lập và 390 px. Axe ghi 0 lỗi trong panel Công việc. Keycloak, hai slot và trình đọc màn hình cần lần nghiệm thu E4 đầy đủ. [WCAG 2.2](https://www.w3.org/TR/WCAG22/)

## Nguồn Biểu mẫu

Chọn **Biểu mẫu** để tìm phiếu đang nhận trả lời. **Điền biểu mẫu** mở phiên bản mới nhất còn mở. **Tiếp tục bản nháp** mở phiên bản đã ghim của bản nháp trong đúng tenant. Portal hiển thị tên đã phát hành, phiên bản và hành động. Lưu, gửi, xác nhận và đọc lại phiếu thực hiện trong Forms. Thiết kế danh sách dùng mẫu nhãn hành động theo trạng thái của GOV.UK. [Complete multiple tasks](https://design-system.service.gov.uk/patterns/complete-multiple-tasks/)

Danh sách kiểm grant Portal và Forms, quyền trả lời, đơn vị hiện hành, đối tượng nhận theo người/đơn vị/nhóm, thời hạn, phiên bản và giới hạn gửi. Phiếu biến mất khi đã gửi đủ lượt hoặc mất quyền. Bản nháp đã đóng hoặc mất quyền theo đơn vị vẫn tra cứu theo hợp đồng lịch sử của Forms. Cursor chỉ dùng trong tập phiếu đủ điều kiện. API Portal trả tối đa 25 mục mỗi trang. [Quyền và lịch sử Forms](FORMS_ACCEPTANCE.md)

```powershell
$release = 'e4-forms-work-v2'
$build = Get-Content -Raw ".local/releases/$release/receipt.json" | ConvertFrom-Json
& node_modules/.bin/tsx.cmd scripts/enterprise-recovery-postgres.ts $release $build.artifactDigest 'C:/Program Files/PostgreSQL/17/bin' --with-forms-work
& node_modules/.bin/tsx.cmd scripts/forms-work-ui-drill.ts $release $build.artifactDigest
```

Lượt API `f80d6092-f363-4cd5-8725-1e9e08f2578c` đạt lúc **08:59:28 ngày 13/11/2026, giờ Việt Nam**. PostgreSQL cô lập xác nhận 25 + 3 mục, đối tượng nhận và thu hồi, ghim bản nháp qua lần phát hành mới, một audit sau gửi và replay. Chromium `4e7528c2-e0a8-4852-bf2c-017af57c207b` dùng HTTP và redirect đăng nhập giả lập, xác nhận mở đúng tenant, gửi bản nháp từ Forms, mất mục ở Portal và 0 lỗi axe trong panel 390 px. Bài staging có luồng mở và gửi phiếu từ Portal, chờ Keycloak trên hai slot.

## Thông báo và quyền Quy trình

Metadata thông báo ở database **Quy trình**, gồm recipient, event key, run/task ID và trạng thái đọc. Tiêu đề/nội dung hiển thị được lấy từ hồ sơ nguồn sau kiểm quyền; không sao chép câu trả lời biểu mẫu vào thông báo. Insert notification chạy cùng transaction nghiệp vụ qua triggers Workflows 004: giao việc/đổi người nhận, duyệt bước và đổi trạng thái lượt chạy. Rollback nghiệp vụ không để lại thông báo; unique event key chặn trùng.

Đọc thông báo và tính số chưa đọc đều kiểm grant/account/membership/role/unit hiện hành. Thông báo giao việc/nhắc hạn còn yêu cầu nhiệm vụ pending, đúng người và đủ điều kiện nhóm/cơ cấu; nhiệm vụ chuyển người, hoàn tất hoặc mất quyền không tiếp tục xuất hiện cho người cũ. Thông báo kết quả của chủ đề nghị tuân thủ quyền xem hồ sơ nguồn. Không dùng recipient ID hoặc cursor như quyền truy cập.

Hợp đồng adapter Portal tại `src/work-center-boundary.ts`: trả source code/base URL, work items, notifications, pagination và cấu hình theo source. Actor được lấy từ identity SSO đã xác minh; module nguồn thực thi luật của nó qua `WorkflowWorkCenter`, không có endpoint cho caller tùy ý chỉ định recipient/actor. Foundation BFF sở hữu các adapter với credentials runtime riêng; role database của Quy trình vẫn không có quyền kết nối database Identity. Thêm nguồn khác phải thêm adapter/phân quyền và kiểm thu hồi riêng.

## Nhắc hạn bền vững

**Cấu hình nhắc hạn** cần `workflows:manage` và MFA. Chọn đơn vị, bật/tắt, số phút trước hạn (0 để tắt trước hạn) và số phút sau khi quá hạn. Mặc định đơn vị chưa cấu hình là tắt. Mỗi loại nhận tối đa một thông báo cho mỗi task/người được giao; thay đổi cấu hình không tự phát lại cùng loại đã gửi. Chuyển người có thể nhắc cho người mới nếu còn đủ điều kiện.

Thời gian tính liên tục theo timestamp UTC, hiển thị theo múi giờ trình duyệt; chưa có lịch làm việc/ngày nghỉ riêng. Tiến trình kiểm mỗi **30 giây**. Sau downtime, nhiệm vụ còn chờ được đối soát lại từ DB; không phát nhắc sắp hạn đã hết hiệu lực, nhắc quá hạn đủ điều kiện vẫn được tạo. Không cần bộ đếm trong RAM để nhớ đã gửi.

Khóa transaction theo tenant dùng chung với các lệnh Quy trình; hai worker hoặc một worker khởi động lại không gửi trùng. Cấu hình, trạng thái nhiệm vụ và quyền nhận được kiểm trước ghi. Lỗi một tenant rollback batch của tenant đó, ghi `REMINDER_FAILED`, cho tenant khác tiếp tục; lần kiểm sau tự thử lại. Nếu database chung không truy cập được thì cả lượt có thể lỗi. Trạng thái worker chỉ hiện thời điểm/lỗi hoạt động, không trả tổng số thông báo tenant khác ngoài scope.

Giới hạn bảo vệ local: tổng hợp tối đa **10.000** work rows hoặc notifications trong tập đọc, và tối đa 10.000 ứng viên nhắc hạn mỗi tenant/lượt. Vượt giới hạn trả lỗi rõ, không hiển thị số liệu hoặc gửi một phần rồi tuyên bố đủ. Đây chưa phải benchmark/thiết kế lưu trữ cho tải production lớn; chưa có retention/archival thông báo hoặc gửi ngoài ứng dụng.

## Chạy local và kiểm thử

Đọc [runbook local](LOCAL_DEVELOPMENT.md), chỉ Docker project `tlqm-aio-local`. Migration additive **Workflows 004-work-center.sql**, giữ nguyên 001–003; Foundation 001–006, Forms và LMS không có migration mới trong đợt này.

```powershell
npm run workflows:setup
npm run build
npm run dev
```

`dev` chạy web apps và worker local, cùng dừng khi Ctrl+C. Nếu chạy bản build `npm start`, mở terminal riêng:

```powershell
npm run work-center:worker
# Hoặc đối soát một lượt có guard local:
npm run work-center:worker -- --once
```

Worker chỉ đọc config `.local` bằng chương trình, xác minh Docker local/DB marker/instance, không in credentials. Không chạy inspector LMS hay thay storage của dự án cũ.

`npm run work-center:review` mở **Portal cá nhân** cho tài khoản local đã có `workflows.admin`, giữ các quyền Quy trình đã cấp. Không cấp vai trò quản trị Foundation; chạy lại không phục hồi một grant Portal đã bị thu hồi. Password/MFA không đổi. Hướng dẫn không có secrets ở `.local/WORK-CENTER-TRY.md`; người dùng tự thiết lập MFA/đổi mật khẩu lần đầu nếu cần.

E2E `npm run test:work-center` dùng Foundation 4100, Quy trình 4105 và DB test; dừng API dev trước và chạy tuần tự với các suite DB/MFA. Test tạm cấp Portal cho các fixture Forms/Quy trình do AIO sở hữu rồi phục hồi grant và cấu hình nhắc hạn. Không dùng người/dữ liệu thật. Unit/integration kiểm rollback, concurrency, restart, quyền chéo/thu hồi, nguồn lỗi, lịch nhắc và phân trang UI.

## Rollback

Tắt nhắc hạn từng đơn vị bằng UI có audit, dừng worker (hoặc dừng dev). Có thể quay frontend/API về build trước, giữ bảng/cột và migration journal; không sửa migration đã áp dụng hoặc xóa volume. Triggers vẫn ghi metadata sự kiện cho nghiệp vụ nguồn dù không mở UI; không tác động quyết định duyệt. Nếu cần dừng việc ghi metadata, chuẩn bị migration mới có review/backup local riêng, không sửa checksum 004. Không khôi phục grant hoặc phiên đã thu hồi để thực hiện rollback.

## Bằng chứng

`tests/work-center.test.ts`, `tests/work-center-navigation.test.ts`, `scripts/work-center-e2e.ts`; receipts `.local/evidence/work-center-*.json` và ảnh desktop/mobile. [Goal](../roadmap/GOAL_WORK_CENTER.md) ghi kết quả chạy, source hashes, giới hạn và trạng thái cuối; không gọi tên file test là bằng chứng đã pass.
