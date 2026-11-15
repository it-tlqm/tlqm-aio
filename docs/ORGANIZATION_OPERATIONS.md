# Vận hành tổ chức, nhân sự và người duyệt theo cơ cấu

Ngày 10/11/2026. Phạm vi AIO local giả lập; React/shadcn và palette TLQM. Theo [goal 1→4](../roadmap/GOAL_ORGANIZATION_OPERATIONS.md). Đã nghiệm thu API/UI trong phạm vi local: 150 tests, tám lệnh hồi quy và follow-up UI pass; 10 axe scans E2E mới không violations, đã xem ảnh desktop/mobile. Goal ghi receipt, provenance và giới hạn, không coi axe là chứng nhận WCAG toàn bộ.

## Người phụ trách và thời hạn

**Nhân sự & tài khoản → Quản lý trực tiếp / Người thay thế**, **Cơ cấu tổ chức → Trưởng đơn vị**. Các trường chọn từ danh mục có quyền xem; ghi lý do khi tạo/sửa/ngừng phân công. Pháp nhân và đối tượng liên kết không đổi trên một bản ghi; kết thúc phân công cũ trước khi thêm người mới, giữ lịch sử.

Quan hệ quản lý gắn vào **quan hệ công tác**, không gắn trực tiếp email hoặc tài khoản. Trưởng đơn vị và người thay thế là các phân công riêng. Cùng pháp nhân; thời gian hiệu lực phải nằm trong công tác của những người liên quan. Khoảng thời gian là `[từ, đến)`; trùng ranh giới không bị tính chồng. Mỗi công tác có tối đa một quản lý/một người thay thế và mỗi đơn vị có tối đa một trưởng đơn vị trong cùng thời điểm. Không tự tham chiếu, không tạo vòng lặp đồng thời; đảo quan hệ ở hai giai đoạn không chồng nhau vẫn hợp lệ. Ngừng phân công vẫn được phép khi người liên quan đã kết thúc công tác.

Quyền quản trị là `people:manage` toàn tenant; đọc `people:read` theo scope. Khi chỉ có quyền xem một đơn vị, backend chỉ trả quan hệ nếu các đầu mối đều nằm trong phạm vi được xem. Chức danh, quản lý và thay thế không tạo role/grant.

## Tiếp nhận, điều chuyển, nghỉ việc

Vào **Nhân sự & tài khoản → Tiếp nhận / Điều chuyển / Nghỉ việc**. Chọn thao tác, điền dữ liệu, **Xem trước thay đổi**, rà soát các vai trò/truy cập và nhập lý do trước **Xác nhận thực hiện**.

- Tiếp nhận tạo hồ sơ mới, quan hệ công tác và vị trí chính trong một transaction. API cũng nhận `personId` đã đối soát nếu bổ sung công tác cho người hiện có. UI đợt này dùng luồng hồ sơ mới; thêm công tác người hiện có vẫn có tại hồ sơ nhân sự. Không tạo mật khẩu hay tự cấp truy cập.
- Điều chuyển kết thúc các bổ nhiệm chính cũ và tạo bổ nhiệm chính mới cùng pháp nhân. Bổ nhiệm kiêm nhiệm và trách nhiệm quản lý giữ nguyên để quản trị rà soát riêng. Danh sách vai trò hiện có được hiển thị; chỉ những vai trò được chọn mới bị thu hồi. Không tự di chuyển scope vai trò sang đơn vị mới.
- Nghỉ việc kết thúc công tác/bổ nhiệm của người trong tenant, đóng hoặc ngừng các trách nhiệm liên quan, khóa các tài khoản của người và thu hồi grant/role thuộc tenant; session được thu hồi qua security boundary hiện có. Giữ hồ sơ, identity ownership, lịch sử nghiệp vụ và audit. Tài khoản bảo vệ, tài khoản đang thao tác hoặc có membership hoạt động ở tenant khác không được vô hiệu hóa ngầm.

Luồng này **thực hiện ngay**, không có scheduler cho quyết định nhân sự tương lai. Bản xem trước có thời điểm trong 15 phút; dữ liệu/các quan hệ/quyền thay đổi thì commit từ chối và yêu cầu xem trước lại. Công tác hoặc bổ nhiệm chưa bắt đầu cần được xử lý riêng trước điều chuyển/nghỉ việc, tránh sửa/xóa lịch sử để ép kết thúc. Chưa có điều chuyển khác pháp nhân trong một lệnh; dùng kết thúc công tác và tiếp nhận tại pháp nhân mới theo quyền được cấp.

Máy chủ kiểm MFA, CSRF, permission, delegation theo ứng dụng và revision; thay đổi nhiều bản ghi, audit và idempotency receipt cùng transaction. Lần gửi lặp không tạo thêm hiệu ứng. Không thể dùng snapshot xem trước như chứng thư cấp quyền.

## Quy trình lấy người duyệt theo cơ cấu

Trong trình thiết kế, chọn bước → **Cách giao nhiệm vụ: Theo cơ cấu tổ chức** → **Quản lý trực tiếp của người gửi** hoặc **Trưởng đơn vị của người gửi**. Quy tắc mới dùng schema version 3; version 1/2 và những lượt chạy đã phát hành tiếp tục được đọc, không viết lại snapshot cũ.

Foundation xác định đúng một công tác có bổ nhiệm chính còn hiệu lực của người gửi trong **đơn vị lượt chạy**. Sau đó tìm quản lý/trưởng đơn vị và ưu tiên người thay thế đang hiệu lực. Chỉ một tầng thay thế; chuỗi nhiều tầng, thiếu đầu mối, nhiều tài khoản đủ điều kiện hoặc không có tài khoản hợp lệ đều bị từ chối với lỗi cụ thể. Người nhận phải có tài khoản/identity/membership/grant hoạt động và `workflows:act` ở phạm vi cần thiết. Người gửi không tự duyệt qua tài khoản khác cùng person.

Hợp đồng `WorkflowDirectory.responsible` nằm ở boundary Foundation sở hữu. Domain Quy trình không được cấp quyền đọc database định danh. Audit nhiệm vụ ghi quy tắc và các revision của quan hệ đã dùng. Khi cơ cấu thay đổi sau giao nhiệm vụ, người cũ không thể duyệt tiếp dựa trên snapshot cũ; điều phối viên cần đối soát/giao lại. Giao lại thủ công có kiểm quyền, lý do/audit và đánh dấu việc thay quy tắc tổ chức bằng người được chỉ định.

## Nhập Excel

Chọn **Nhập Excel** ở Cơ cấu tổ chức hoặc Nhân sự & tài khoản; tải tệp mẫu. Nhận `.xlsx` tối đa **2 MB**, tổng **500 dòng dữ liệu** trong bốn sheet:

| Sheet | Cột |
| --- | --- |
| DonVi | Ma, Ten, MaPhapNhan, MaDonViCha |
| ChucDanh | Ma, Ten |
| ViTri | MaNhap, Ten, MaPhapNhan, MaDonVi, MaChucDanh |
| NhanSu | MaNhanSu, HoTen, MaPhapNhan, ViTri, NgayBatDau, NhanSuId |

Pháp nhân phải tồn tại. Đơn vị cha có thể nằm sau đơn vị con trong tệp; backend giải quyết thứ tự phụ thuộc và báo lỗi khi thiếu/vòng lặp. `ViTri.MaNhap` là mã tham chiếu riêng trong tệp, không phải mã vị trí bền vững. `NhanSu.ViTri` nhận mã đó hoặc UUID vị trí hiện có. `NgayBatDau` là ngày hợp lệ `YYYY-MM-DD`, lưu mốc 00:00 UTC. Đặt các mã ở dạng văn bản trong Excel để giữ số 0 đầu.

`NhanSuId` trống tạo person mới; có UUID thì phải là person hoạt động trong tenant và họ tên khớp để đối soát. Không ghép bằng tên/email. Chỉ tạo mới: mã trùng database hoặc trong tệp báo lỗi, không ghi đè âm thầm. Không nhận macro/công thức/liên kết, sheet/cột ngoài mẫu; kiểm cả kích thước ZIP khai báo và dữ liệu giải nén thực tế.

Preview chạy validation và thử các mutation bên trong transaction luôn rollback; báo sheet/dòng/lỗi cụ thể, chưa ghi dữ liệu. Nếu còn bất kỳ lỗi nào, không cho nhập một phần. Commit kiểm lại quyền, nguồn Excel và fingerprint dữ liệu; toàn bộ thay đổi cùng audit/receipt nguyên tử. Cần đủ `directory:read/manage` và `people:read/manage` toàn tenant. Import không tạo tài khoản IdP hoặc cấp role/grant.

## Migration, vận hành và rollback

- Foundation thêm **006-organization-responsibilities.sql**; giữ nguyên 001–005. Workflows thêm **003-organization-assignees.sql**, giữ nguyên 001–002. Không thay migration LMS/Forms.
- Đọc [local runbook](LOCAL_DEVELOPMENT.md), xác minh Docker local project `tlqm-aio-local`. Chạy `npm run db:setup`, `npm run workflows:setup` tuần tự; scripts kiểm marker/owner/checksum và giữ credentials. Build lại trước chạy local.
- `npm run test:organization-operations` tự mở Foundation 4100 và Quy trình 4105 với database test; dừng `npm run dev` trước, không chạy cùng suite DB/MFA khác.
- Rollback giao diện/API: dừng dev, dùng build trước tính năng; giữ các bảng/cột additive và journal. Không sửa migration đã áp dụng hoặc drop dữ liệu. Nếu đã phát hành quy trình version 3, phải giữ runtime đọc version 3 cho các lượt đang chạy; tạm dừng phát hành/khởi chạy mới và xử lý lượt đang mở trước khi quay runtime cũ.
- Sửa dữ liệu vận hành qua các thao tác có audit: kết thúc/ngừng phân công sai rồi thêm bản đúng. Không tự hồi sinh grant/role/session đã thu hồi. Import sai cần rà soát phụ thuộc và ngừng/kết thúc record đã tạo; đây không phải xóa hàng loạt database.

## Bằng chứng

Tests mới: `responsibility-graph`, `responsibilities`, `personnel-operations`, `organization-resolution`, `organization-import`; mở rộng `workflows-assignments` cho version 3, chống tự duyệt và cơ cấu đổi khi nhiệm vụ còn chờ. E2E UI mới `scripts/organization-operations-e2e.ts`. Receipt cuối, ảnh, provenance follow-up UI và giới hạn kiểm chứng đã ghi tại goal.
