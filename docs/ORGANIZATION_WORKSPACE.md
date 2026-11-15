# Cơ cấu tổ chức, nhân sự và vai trò

Ngày 10/11/2026. Phạm vi AIO local giả lập, React/shadcn và nhận diện TLQM. API Directory/Governance và vòng đời SSO đã có trước; đợt này bổ sung màn làm việc tập trung và tài khoản dùng thử riêng. [Kế hoạch và nghiệm thu](../roadmap/ORGANIZATION_WORKSPACE.md).

Bổ sung cùng ngày: [vận hành tổ chức 1→4](ORGANIZATION_OPERATIONS.md) có quản lý/trưởng đơn vị/thay thế, tiếp nhận–điều chuyển–nghỉ việc, người duyệt theo cơ cấu và nhập Excel. Kết quả mới được theo dõi riêng tại [goal vận hành](../roadmap/GOAL_ORGANIZATION_OPERATIONS.md).

## Sơ đồ tổ chức

Vào **Cơ cấu tổ chức → Sơ đồ tổ chức**. Chọn pháp nhân, tìm tên/mã đơn vị (có hoặc không dấu), mở/thu gọn các nhánh và chọn đơn vị để xem vị trí/nhân sự. Bật **Gồm đơn vị trực thuộc** khi cần tổng hợp cả nhánh. Mỗi người chỉ được đếm một lần dù có nhiều bổ nhiệm.

**Thêm đơn vị con** điền sẵn pháp nhân và đơn vị cha; **Thêm vị trí** điền sẵn đơn vị. Vẫn kiểm tra quan hệ và quyền tại máy chủ. Các tab **Pháp nhân**, **Đơn vị / phòng ban**, **Chức danh**, **Vị trí công tác** giữ các màn tạo/sửa/ngừng hoạt động. Không xóa lịch sử. Máy chủ từ chối chu kỳ, quan hệ sai pháp nhân và ngừng một danh mục đang còn phụ thuộc hoạt động.

Số nhân sự hiện hành lấy từ các quan hệ được phép xem, cùng hiệu lực người/pháp nhân/đơn vị/chức danh/vị trí/công tác/bổ nhiệm tại lần tải. Bổ nhiệm tương lai hoặc đã kết thúc nằm trong lịch sử, không cộng vào hiện tại. Với quyền giới hạn đơn vị, không suy ra tên hoặc dữ liệu của đơn vị cha ngoài phạm vi.

## Hồ sơ nhân sự và tài khoản

Vào **Nhân sự & tài khoản → Danh bạ & hồ sơ**, tìm theo họ tên/mã/vị trí, lọc đơn vị và trạng thái. **Xem hồ sơ** mở quá trình công tác, bổ nhiệm chính/kiêm nhiệm, tài khoản AIO và vai trò/truy cập theo ứng dụng được cấp quyền quản lý.

- **Thêm quan hệ công tác** điền sẵn nhân sự. Mã nhân sự thuộc pháp nhân; một người có thể có nhiều quan hệ.
- **Bổ nhiệm / kiêm nhiệm** điền sẵn quan hệ công tác và pháp nhân. Một quan hệ chỉ có tối đa một vị trí chính tại mỗi thời điểm; khoảng thời gian và quan hệ vẫn do backend kiểm tra.
- Đổi đơn vị/vị trí cần kết thúc bổ nhiệm cũ và tạo bổ nhiệm mới với thời gian phù hợp; không chuyển ownership của bản ghi lịch sử. Luồng [Điều chuyển](ORGANIZATION_OPERATIONS.md) mới gộp kết thúc/tạo bổ nhiệm chính vào một transaction; thao tác riêng vẫn giữ cho quản trị lịch sử.
- **Thêm tài khoản** tạo bản ghi AIO, chưa tạo mật khẩu hay tài khoản IdP. **Định danh & vòng đời** dùng mã xác minh SSO để liên kết đúng issuer + subject; không nối bằng email/tên.
- Khóa/mở tài khoản, kết thúc công tác, thu hồi/liên kết lại và offboard tiếp tục theo [runbook định danh](IDENTITY_LIFECYCLE.md). Không khôi phục phiên hoặc quyền cũ chỉ vì mở tài khoản.

Các trường chưa được cấp quyền đọc không được tải. Nếu một tập dữ liệu liên quan bị từ chối hoặc lỗi, màn tổng hợp xóa dữ liệu và báo lỗi; không hiển thị hồ sơ/thống kê từ tập tải dở. Khi đổi ứng dụng/tenant, không dùng lại dữ liệu của phạm vi trước.

## Vai trò và truy cập

Vào **Vai trò & truy cập**, chọn ứng dụng. **Ma trận phân quyền** so sánh quyền cấu hình trong từng vai trò, mặc định chỉ các vai trò hoạt động; có thể hiện vai trò đã ngừng. **Phân công vai trò** ghi người nhận, phạm vi đơn vị/toàn không gian và thời hạn.

**Gán vai trò** và **Cấp truy cập ứng dụng** là hai thao tác riêng. Chức danh hay bổ nhiệm không tự cấp vai trò. Một phân công còn hiệu lực chưa đủ chứng minh đăng nhập được: runtime tiếp tục kiểm grant, account, membership, role/permission, phạm vi, thời hạn và MFA. Ma trận mô tả cấu hình, không giả làm kết quả mô phỏng toàn bộ quyền runtime.

Các thay đổi quyền hiển thị đối tượng/quyền/phạm vi/thời hạn/lý do để xác nhận trước ghi. Backend giữ delegation và permission ceiling, ngăn tự cấp quyền, bảo vệ tài khoản/vai trò hệ thống; mỗi mutation có CSRF, idempotency key, revision và audit nguyên tử.

## Dùng thử local

Sau khi Foundation local sẵn sàng, chạy tuần tự (không cùng MFA/E2E):

~~~powershell
npm run organization:review-admin
~~~

Script chỉ nhận marker/database/Docker AIO local, xác thực operator MFA và kiểm quyền trước tạo tài khoản **org.admin** do AIO sở hữu. Role **organization-admin** quản trị tổ chức/nhân sự/tài khoản/định danh và truy cập trong không gian giả lập A; có delegation cho Foundation, Forms, LMS và Quy trình. Chỉ có grant Foundation, không tự cấp quyền sử dụng các module nghiệp vụ hoặc quyền Keycloak admin. Tài khoản `lms.admin` giữ phạm vi cũ.

Credentials nằm trong `.local/organization-admin.json`; không in vào chat/log/screenshot/Git. Hướng dẫn không có secrets ở `.local/ORGANIZATION-TRY.md`. Người dùng tự thiết lập MFA/đổi mật khẩu lần đầu, rồi đăng nhập mới bằng mật khẩu + OTP. Rerun giữ nguyên credentials, required actions và quyền bị thu hồi; gặp thay đổi không khớp thì từ chối, không âm thầm ghi đè.

Ngày 10/11/2026 đã provision và kiểm quyền `org.admin` tại http://127.0.0.1:4100/#organization. Local review xác nhận challenge đầu tiên `CONFIGURE_TOTP`, còn `UPDATE_PASSWORD`; chưa kiểm đăng nhập sau khi người dùng tự hoàn tất hai bước này. Kiểm UI bằng operator MFA và kiểm script chạy lại đều pass.

Đợt workspace ban đầu không có migration mới. Đợt vận hành bổ sung Foundation 006 và Workflows 003; giữ nguyên các journal đã áp dụng trước đó. Quản lý trực tiếp đã có trong đợt mới; định biên, đồng bộ HR/AD và IdP hàng loạt chưa triển khai. Chỉ dữ liệu giả lập.

## Kiểm thử

- `tests/organization-view.test.ts`: người kiêm nhiệm không bị đếm lặp, mốc hiệu lực, giữ lịch sử, thiếu quan hệ theo scope, ngừng vị trí/người và cây có chu kỳ phòng thủ.
- `npm run test:organization`: API/MFA thật, context tạo đơn vị/vị trí, tìm không dấu, hồ sơ → quan hệ công tác → bổ nhiệm, kiểm không tự sinh role, ma trận/gán scope rõ ràng, desktop/mobile/keyboard/axe. Phép thử lỗi tổng hợp dùng 403 được chèn có kiểm soát, không thay bằng chứng thu hồi quyền thật của Foundation E2E.
- `npm run check`, `npm run test:e2e`: format/typecheck/unit/build và SSO/identity/quản trị hiện hữu, gồm MFA, tenant/scope, revocation, audit/CAS/idempotency và focus bàn phím.
- Kết quả ngày 10/11/2026: **139 unit/integration tests**, tám lệnh hồi quy pass, 8 axe scans E2E và 6 scans local không violations. Đã xem sáu ảnh local desktop/mobile. [Nghiệm thu](../roadmap/ORGANIZATION_WORKSPACE.md) ghi receipt, provenance phục hồi, giới hạn và audit source/build/runtime; không coi kết quả axe là chứng nhận WCAG toàn bộ.
