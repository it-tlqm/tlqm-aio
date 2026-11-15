# Cơ cấu tổ chức, nhân sự và phân quyền

Ngày 10/11/2026. Người dùng chuyển ưu tiên từ LMS sang cơ cấu tổ chức, user, role, chức danh và vị trí công việc. Mục Vimeo live của LMS giữ trạng thái blocked riêng; không coi đã nghiệm thu mục đó.

Workspace D:/thanhnx/TLQM-AIO, nhánh feat/foundation-mvp, baseline abea705b0937fe164fa9c983700089bec88c82ba, worktree dirty được giữ nguyên. Chỉ AIO local giả lập, không commit/push/production.

## Phạm vi đợt này

- Cây pháp nhân/đơn vị, tìm kiếm không dấu, đơn vị con, vị trí/chức danh và nhân sự theo phạm vi; không suy một người kiêm nhiệm thành nhiều người.
- Danh bạ và hồ sơ tập trung: quan hệ công tác, bổ nhiệm chính/kiêm nhiệm, lịch sử hiệu lực, tài khoản/SSO và quyền theo ứng dụng.
- Ma trận vai trò–quyền, phân công theo đơn vị/thời hạn và cấp truy cập ứng dụng riêng.
- Dùng lại API quản trị hiện có và các mutation có MFA, CSRF, audit, idempotency, revision, ownership và guards. Không tạo auth riêng hoặc tự cấp quyền từ chức danh.
- Giao diện React/shadcn/TLQM; kiểm desktop/mobile/keyboard, E2E nghiệp vụ và hồi quy SSO/identity/quản trị.

## Hiện trạng

**Đã hoàn thành và kiểm chứng trong phạm vi AIO local giả lập.** API CRUD đã có trước đợt này; màn làm việc tập trung, tài khoản dùng thử, hồi quy và kiểm tra hình ảnh đã hoàn tất. Không có migration mới; journals đã áp dụng giữ bất biến. Phần thiết lập MFA/đổi mật khẩu và đăng nhập sau thiết lập của người dùng còn chờ người dùng tự thực hiện.

## Bằng chứng và diễn biến

- 10/11/2026 12:05Z: E2E mới pass luồng tạo đơn vị con/vị trí có preset, tìm không dấu, hồ sơ → quan hệ công tác → bổ nhiệm chính, xác nhận không tự sinh role; tạo role/gán phạm vi và chặn dữ liệu tổng hợp khi một API đọc trả 403. 8 axe scans không violations; incomplete rules giữ trong artifact. Đã xem ảnh cây tổ chức, hồ sơ mobile và ma trận desktop.
- Hồi quy phát hiện ResourcePanel bị remount sau lưu nên mất thông báo/focus. Đã giữ component ổn định và state hiển thị; không xóa assertion bàn phím.
- Lượt kế tiếp chạm rate limit do tải lặp các danh mục ở App cũ và workspace mới. Đã bỏ các fetch cũ, mỗi tab danh mục chỉ tải các lookup cần thiết. Không tăng rate limit hoặc đổi kiểm tra auth. Ba suite Foundation SSO/identity/admin-ui đã pass ở bản trước bổ sung kiểm thử focus hồ sơ.
- 12:15Z: check pass **139 tests**, format/typecheck/build. Lượt organization tiếp theo bắt được lỗi Escape của Sheet không trả focus về nút mở. Đã sửa explicit focus restoration và tránh giành focus khi chuyển sang dialog chỉnh sửa; giữ assertion.
- 12:18Z: `test:organization` pass **8 scans**, gồm Enter chọn đơn vị, Escape trả focus, hồ sơ hiển thị quyền đúng ứng dụng. Owned fixtures được archive qua API có audit. Receipt `.local/evidence/organization-e2e.json`; receipt thất bại `organization-regression-before-focus-fix.json` giữ nguyên. Đang chạy hồi quy cuối với hashes source trước/sau từng lệnh; tài khoản org.admin local chưa provision ở thời điểm ghi này.

Hướng dẫn vận hành và giới hạn: [Organization Workspace](../docs/ORGANIZATION_WORKSPACE.md).

- Rà soát thao tác tải lại phát hiện nút tải lại workspace chưa truyền tín hiệu cho bảng danh mục đang mở. Bổ sung refreshVersion giữ nguyên component/focus; E2E sửa chức danh qua API rồi tải lại UI xác nhận dữ liệu mới. Luồng mới 8 scans đã pass sau sửa; receipt trước sửa được giữ riêng.
- Hồi quy trên mã đã cố định đạt check 139 tests và organization E2E, nhưng identity lifecycle timeout cuối offboard. Diagnostic chỉ ghi pathname/status xác định `identity-targets` và callback bị 429; giới hạn app giữ nguyên 300 request/phút. Harness nay đọc remaining/reset từ health trước các chuỗi UI/SSO để chờ đúng cửa sổ, không bỏ kiểm tra 401/403 hoặc phục hồi quyền. Identity suite riêng đã pass với thay đổi này.
- Lượt phục hồi dùng lại check/organization đã pass vì **chỉ scripts/identity-e2e.ts thay đổi** (diagnostic và điều phối rate window), các hash runtime/UI/model giữ nguyên. Script recovery kiểm điều kiện đó trước chạy format/typecheck, toàn bộ Foundation E2E và các suite Forms UI/LMS/Quy trình; kết quả hiện hành ở `.local/evidence/organization-regression.json`. Tại thời điểm bắt đầu lượt phục hồi chưa nghiệm thu tài khoản hoặc toàn hồi quy; kết quả cuối được ghi dưới đây.

## Kết quả nghiệm thu cuối ngày 10/11/2026

- Receipt hồi quy lúc **13:13:28Z**: `result: pass`, `sourceStable: true`, **139 unit/integration tests**. Tám lệnh pass: `check`, `test:organization`, `format:check`, `typecheck`, `test:e2e`, `test:forms-ui`, `test:lms`, `test:workflows-assignments`. `check` gồm build; `test:e2e` gồm Foundation SSO, identity lifecycle và quản trị UI. Provenance dùng lại hai kết quả đầu được lưu rõ trong receipt; không mô tả chúng là chạy lại sau thay đổi harness identity.
- Organization E2E có **8 axe scans không violations**, cùng API/MFA thật, CRUD có context, tìm không dấu, phân công rõ phạm vi, không tự cấp role từ bổ nhiệm, Enter/Escape/focus và tải lại danh mục sau cập nhật thật qua API. Phép thử chèn 403 chỉ chứng minh xóa tập dữ liệu tổng hợp khi đọc lỗi; không thay bằng chứng thu hồi quyền thật của Foundation E2E.
- `npm run organization:review-admin` đã provision **org.admin**. Receipt `.local/evidence/organization-local-review.json` lúc **13:43:34Z** xác nhận grant Foundation, role `organization-admin`, delegation Foundation/Forms/LMS/Quy trình và **6 axe scans không violations** khi duyệt UI bằng operator MFA. Chạy lại script giữ credentials/required actions. Người dùng chưa hoàn tất `CONFIGURE_TOTP` và `UPDATE_PASSWORD`; chưa tuyên bố đã kiểm đăng nhập của org.admin sau bước tự thiết lập này.
- Đã xem trực tiếp sáu ảnh local `organization-local-{tree-desktop,tree-mobile,people-desktop,profile-mobile,matrix-desktop,matrix-mobile}.png`: logo/palette TLQM, cây tổ chức, danh bạ, hồ sơ và ma trận desktop/mobile. Bảng rộng nằm trong vùng cuộn riêng trên mobile; nhãn đầu trang dài được rút gọn. Các mục axe incomplete vẫn giữ để đánh giá thủ công; đây không phải chứng nhận WCAG toàn bộ.
- `.local/evidence/organization-final-audit.json` là audit tổng hợp cuối, được tạo lại sau khi cập nhật tài liệu: đối chiếu **257 source hashes**, **17 hashes source LMS gốc**, receipt, liên kết file tài liệu, ảnh và build; kiểm readiness Foundation **4100** và LMS **4104**. Source LMS gốc không thay đổi. Thời điểm audit và danh sách hash cụ thể nằm trong receipt.
- Portal dùng thử: http://127.0.0.1:4100/#organization. Đã mở tab Portal ở màn bắt đầu SSO; không nhập hoặc hiển thị credentials. Hướng dẫn không có secrets: `.local/ORGANIZATION-TRY.md`. Foundation chạy bằng `npm run dev`, LMS bằng `npm run lms:dev`; dùng [runbook local](../docs/LOCAL_DEVELOPMENT.md) trước khi vận hành lại.

Các receipt thất bại trước sửa focus/refresh/identity diagnostics được giữ nguyên làm lịch sử. Giới hạn còn lại: chưa có reporting line/quản lý trực tiếp, định biên, đồng bộ HR/AD, tạo tài khoản IdP hàng loạt hoặc điều chuyển nhiều bản ghi nguyên tử. Những hạng mục này không được trình bày như tính năng đã hoàn thành. Không commit/push/deploy; goal Vimeo của LMS giữ trạng thái blocked riêng.
