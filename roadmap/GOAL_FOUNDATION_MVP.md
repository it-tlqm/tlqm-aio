# Goal — Hoàn thiện TLQM AIO Foundation MVP local

Trạng thái: **đã nghiệm thu Foundation MVP local ngày 10/11/2026** — [đối chiếu mười tiêu chí](../docs/FOUNDATION_ACCEPTANCE.md). Theo dõi tại [FOUNDATION_PROGRESS](FOUNDATION_PROGRESS.md). Phạm vi goal không mở rộng quyền cho remote/production.

## Mục tiêu

Tiếp tục phát triển trong D:/thanhnx/TLQM-AIO cho đến khi TLQM AIO Foundation MVP chạy được end-to-end ở local: SSO/IAM, cơ cấu tổ chức, định danh nhân sự, phân quyền ứng dụng, Application Registry, audit và giao diện quản trị thực tế. Hoàn thành bằng code, kiểm thử và bằng chứng chạy được.

Backend đã chốt TypeScript + Fastify, PostgreSQL và Keycloak. Frontend mới ưu tiên React + TypeScript + Vite, Tailwind CSS v4 và shadcn/ui; dùng [Design System TLQM](../docs/FRONTEND_DESIGN_SYSTEM.md). Giữ kiến trúc gọn, một backend chia module, tận dụng phần đang chạy.

Đây là goal cho Foundation. Form Builder và tích hợp LMS là bước kế tiếp sau gate này; LIMS để sau. Không mở rộng goal sang triển khai nghiệp vụ Forms/LMS hoặc sửa source cũ.

## Đọc trước và xác minh hiện trạng

- [AGENTS.md](../AGENTS.md).
- [Trạng thái triển khai](../docs/IMPLEMENTATION_STATUS.md).
- [Hướng dẫn local](../docs/LOCAL_DEVELOPMENT.md).
- [Phạm vi Foundation](../docs/FOUNDATION_SCOPE.md).
- [Kiến trúc](../docs/TARGET_ARCHITECTURE.md), [SSO](../docs/IAM_SSO_INTEGRATION.md).
- [Mô hình tổ chức](../docs/IDENTITY_ORGANIZATION_MODEL.md), [mô hình quyền](../docs/APPLICATION_ACCESS_MODEL.md).
- [Design System](../docs/FRONTEND_DESIGN_SYSTEM.md), [Sprint 01](SPRINT_01_BACKLOG.md).

Xác minh source, nhánh Git, tiến trình/cổng và Docker project hiện tại. Không xây lại phần đã hoạt động chỉ vì đang bắt đầu một lượt mới. Test baseline được ghi trong tài liệu là bằng chứng lịch sử, cần đối chiếu khi thay đổi liên quan.

## Phạm vi cần hoàn thiện

### 1. SSO và vòng đời tài khoản

- Giữ Authorization Code + PKCE, issuer/audience/state/nonce validation và tách phiên hai ứng dụng.
- Hoàn thiện phiên hết hạn/renewal, đăng xuất từng app/toàn hệ thống, back-channel logout, chống replay.
- Khóa account hoặc thu hồi grant phải có hiệu lực trên cả phiên đang mở; mục tiêu kiểm thử local tối đa 60 giây.
- Bắt buộc MFA cho quản trị trong realm local; có fixture giả lập và quy trình khôi phục để không khóa mất quản trị viên duy nhất.
- Không tự nối tài khoản chỉ vì trùng email/mã nhân viên. Liên kết identity phải có xác minh và audit.
- Hành vi khi IdP/DB/kiểm tra quyền lỗi phải rõ ràng; không cho phép quyền từ dữ liệu đã hết hiệu lực.

### 2. Directory và nhân sự nền tảng

- API và giao diện quản trị pháp nhân, đơn vị/phòng ban, chức danh, vị trí, người, quan hệ công tác, bổ nhiệm chính/kiêm nhiệm.
- Tách Person, Account, Employment, Assignment và quyền ứng dụng.
- Kiểm tra cây đơn vị không chu kỳ, quan hệ cùng pháp nhân/tenant, khoảng hiệu lực và không có hai vị trí chính chồng thời gian.
- Giữ lịch sử thay đổi; không xóa mất actor/audit khi kết thúc quan hệ công tác.
- Dùng tối thiểu hai tenant/pháp nhân, ba đơn vị và người kiêm nhiệm trong fixture giả lập. Chưa kết nối HR/AD hay nhập nhân sự thật.

### 3. Access Management và Application Registry

- CRUD có kiểm soát cho ứng dụng, vai trò, permission và role binding trong phạm vi cần cho MVP.
- Quản trị chỉ cấp được quyền/ứng dụng/scope được ủy quyền; không tự nâng quyền hoặc vượt tenant/đơn vị.
- Phân biệt quyền được vào app với quyền thực hiện hành động và phạm vi dữ liệu.
- Có giao diện cấp/thu hồi grant, xem quyền hiệu lực và lịch sử thay đổi.
- Hai client thử phải có quyền độc lập cho cùng một người. Không dùng role cùng tên của app này như quyền của app khác.
- Đăng ký một client thử thứ ba qua cơ chế đã tài liệu hóa để chứng minh Foundation không bị hard-code chỉ cho A/B. Không tự dùng LMS/BOS làm client thứ ba.
- Không cho người dùng thường đăng ký issuer, callback URL hoặc credential tùy ý.

### 4. Frontend Foundation với shadcn/ui

- Dựng giao diện tiếng Việt, light mode, responsive, dùng shadcn/ui thật và API Fastify thật.
- Các màn hình: cổng ứng dụng, hồ sơ/quan hệ công tác của tôi, cơ cấu tổ chức, người/tài khoản, ứng dụng, vai trò/quyền, cấp truy cập và audit.
- Có loading, empty, error, no-access, validation, xác nhận thao tác nhạy cảm và phản hồi kết quả.
- CTA #087C3C, hover #076934, brand #0A9444, navy #223873, canvas #F5F8FA; font Be Vietnam Pro; tokens tập trung, không rải màu hard-code theo màn hình.
- Dùng Button, Input, Select, Table/Data Table, Dialog/Alert Dialog, Sheet, Tabs, Badge, Alert và các component shadcn phù hợp; thêm component theo nhu cầu.
- Giữ BFF/server session an toàn khi đổi giao diện; không chuyển secret, refresh token hoặc access token dài hạn sang localStorage.
- Thiết kế nhẹ, rõ dữ liệu; không tự thêm dark mode, gradient trang trí hoặc thư viện UI thứ hai để thay shadcn.

### 5. Audit, dữ liệu và khả năng chạy lại

- Mọi thao tác quản trị thay đổi dữ liệu/quyền phải có actor, subject/scope, thời điểm, lý do và nội dung thay đổi tối thiểu; giao diện lọc theo quyền.
- Dùng transaction, kiểm soát cập nhật đồng thời và xử lý retry phù hợp; không để audit thành công khi thay đổi nghiệp vụ thất bại hoặc ngược lại.
- Tách database role chạy ứng dụng với role migration trong môi trường local; runtime không cần quyền quản trị schema.
- Migration có version/checksum; không sửa migration đã áp dụng để che drift.
- Chạy lại setup không đổi credential, không phục hồi grant đã thu hồi hoặc xóa dữ liệu đang giữ.
- Tạo và thử backup/restore dữ liệu giả lập vào database/volume restore riêng, xác minh ownership và target trước thao tác. Không ghi đè database local hiện tại.
- Đo sơ bộ RAM/CPU của API/Keycloak/PostgreSQL và độ trễ các request chính trong điều kiện ghi rõ; báo số đo, không tự bịa ngưỡng “nhẹ” hoặc SLA production.

## Cách làm việc liên tục

1. Tạo kế hoạch ngắn theo các hạng mục còn thiếu, rồi triển khai ngay hạng mục có tác động lớn nhất.
2. Lặp vòng: đọc hiện trạng → sửa code → chạy kiểm tra liên quan → đọc kết quả → sửa nguyên nhân → cập nhật bằng chứng → chuyển sang việc tiếp theo.
3. Tự quyết các chi tiết triển khai có thể đảo ngược trong phạm vi goal; ghi giả định/ADR khi cần. Không dừng chỉ để xin xác nhận tên file, component, layout hoặc trình tự việc nhỏ.
4. Lỗi test/build là công việc cần giải quyết. Không bỏ test, nới kiểm tra quyền, bỏ validation hoặc đổi acceptance chỉ để đạt pass.
5. Một hạng mục thiếu thông tin không chặn phần độc lập: ghi rõ phần thiếu và tiếp tục các việc có thể làm. Không tự suy đoán dữ liệu doanh nghiệp thật.
6. Khi context bị rút gọn hoặc có yêu cầu resume, tiếp tục từ code và progress đã lưu; không dựng lại project hoặc lặp lại việc đã nghiệm thu.
7. Cập nhật ngắn khi có kết quả, phát hiện quan trọng hoặc cần người dùng xử lý; không kết thúc mỗi lát cắt bằng lời đề nghị “có muốn làm tiếp không”.
8. Tôn trọng giới hạn thực tế của phiên, ngân sách và quyền công cụ. Không tự đặt budget hoặc coi hết budget là hoàn thành.

## Ranh giới được phép

- Sửa code/tài liệu và cài dependencies cần thiết trong Master Project này; giữ lockfile và ghi lý do thêm dependency.
- Chỉ vận hành project Docker local AIO, database/realm giả lập và tài nguyên test/restore được xác minh.
- Có thể dừng/khởi động tiến trình API local thuộc chính repo sau khi kiểm tra PID, command line, cổng và ownership. Không kill theo tên node/docker hoặc theo cổng một cách mù quáng.
- Giữ source LMS/BOS/YMS và database/auth hiện hữu nguyên trạng. Chỉ đọc tham khảo.
- Không đọc/in secrets của dự án khác. Secrets mới sinh phục vụ local phải được chương trình sử dụng kín, không vào Git, chat, screenshot hoặc báo cáo.
- Không tự commit, push, tạo PR, deploy, sửa remote, cloud, IdP thật hoặc production. Chuẩn bị kết quả local để người dùng review.
- Không reset/rebase/xóa thay đổi có sẵn, không xóa volume hoặc dọn dữ liệu dự án khác.

## Điều kiện hoàn thành — tất cả phải có bằng chứng

1. Admin giả lập đăng nhập với MFA, quản lý tổ chức/người/ứng dụng/role/grant qua UI và API; người thường chỉ truy cập phần được cấp.
2. Person có quan hệ công tác chính và kiêm nhiệm; dữ liệu sai pháp nhân, chu kỳ tổ chức hoặc chồng vị trí chính bị backend từ chối.
3. Một người dùng A/B qua SSO; token, cookie, role và scope không dùng chéo trái phép. Client thử thứ ba được onboarding bằng hợp đồng dùng chung.
4. Thu hồi grant/role, khóa account, hết phiên và logout có kết quả đo được; thử gọi API trực tiếp, payload giả mạo và truy cập chéo tenant.
5. Tạo/cập nhật tổ chức, role/binding và grant có audit phù hợp; bảo vệ khỏi tự nâng quyền và cập nhật đồng thời làm mất dữ liệu.
6. Frontend đúng shadcn + TLQM tokens; kiểm tra desktop 1440px và mobile 390px, keyboard/focus, dialog, biểu mẫu, tương phản và trạng thái lỗi/không quyền.
7. Format/lint nếu có, TypeScript, unit/integration, E2E trình duyệt thật và build đều đạt; các kiểm tra hiện có không bị vô hiệu hóa.
8. Đã diễn tập IdP/DB unavailable và phục hồi, replay callback/logout, key rotation live local, và restore giả lập vào target riêng.
9. Có hướng dẫn chạy/dừng, fixture, secret handling, migration/rollback; reviewer có thể dựng lại bằng các lệnh đã kiểm chứng.
10. Các tiêu chí trên không còn lỗi chặn. Phần việc ngoài goal như production, Form Builder, LMS, LIMS được ghi thành bước tiếp theo, không được đánh dấu đã hoàn thành.

## Lưu tiến độ và bàn giao

Duy trì roadmap/FOUNDATION_PROGRESS.md với checklist, việc đang làm, bằng chứng, quyết định, blockers và bước tiếp theo. Không đánh dấu một tiêu chí hoàn thành chỉ vì tài liệu có tên tính năng đó.

Khi nghiệm thu, tạo docs/FOUNDATION_ACCEPTANCE.md ghi môi trường/revision, kịch bản, kết quả, thời điểm đo, giới hạn và liên kết artifact đã loại secrets. Cập nhật IMPLEMENTATION_STATUS, README và LOCAL_DEVELOPMENT.

Chỉ đánh dấu Goal complete khi toàn bộ tiêu chí bắt buộc đã được chứng minh. Nếu không còn hướng làm hợp lệ vì thiếu quyền/thông tin/tài nguyên, nêu blocker cụ thể, những gì đã thử và điều kiện gỡ chặn; không tự nhận hoàn thành.

## Câu lệnh kích hoạt gợi ý

~~~text
/goal Hoàn thiện TLQM AIO Foundation MVP local trong D:/thanhnx/TLQM-AIO theo roadmap/GOAL_FOUNDATION_MVP.md và docs/FRONTEND_DESIGN_SYSTEM.md. Backend TypeScript + Fastify; frontend React + TypeScript + Vite + Tailwind v4 + shadcn/ui theo màu TLQM. Tự triển khai, kiểm thử, sửa lỗi và tiếp tục đến khi đạt toàn bộ tiêu chí nghiệm thu; giữ nguyên hệ thống cũ, không commit/push/deploy hoặc tác động production.
~~~

Cơ chế Goal và điều kiện tiếp tục/dừng: [OpenAI — Using Goals in Codex](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex).
