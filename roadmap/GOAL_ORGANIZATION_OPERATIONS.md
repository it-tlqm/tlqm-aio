# Goal — Vận hành tổ chức, nhân sự và người duyệt theo cơ cấu

Ngày 10/11/2026. Người dùng đã cho phép triển khai liên tục toàn bộ bốn mục 1→4. Workspace `D:/thanhnx/TLQM-AIO`; baseline `abea705b0937fe164fa9c983700089bec88c82ba`, nhánh `feat/foundation-mvp`, worktree dirty được giữ nguyên. Chỉ source AIO và dữ liệu local giả lập; không commit/push/deploy/production.

## Trạng thái điều phối

**Đã hoàn thành và bàn giao cả bốn mốc trong phạm vi local giả lập.** Stack local đã mở lại và audit cuối pass. Công cụ create_goal từ chối tạo goal mới vì chat còn goal LMS unfinished/blocked tại Vimeo; không đánh dấu goal đó complete sai thực tế. Tài liệu này là goal công việc mới và điểm tiếp tục; chưa có goal tự động mới được kích hoạt. Vimeo vẫn ghi riêng trong [goal LMS](GOAL_LMS_COMPLETE.md).

## Phạm vi và mốc nghiệm thu

| Mốc | Kết quả phải có | Trạng thái |
| --- | --- | --- |
| 1 | Quản lý trực tiếp, trưởng đơn vị, người thay thế có thời hạn; tạo/sửa/kết thúc, lịch sử, chống tự quản lý/vòng lặp/chồng hiệu lực/sai tenant; UI và API được kiểm | Đạt API/UI và E2E |
| 2 | Tiếp nhận, điều chuyển, nghỉ việc: preview thay đổi và quyền liên quan, commit nguyên tử/idempotent/revision, lịch sử và thu hồi rõ phạm vi; không tự cấp quyền từ chức danh | Đạt API/UI và E2E |
| 3 | Quy trình chọn quản lý trực tiếp/trưởng đơn vị của người gửi; thay thế hiệu lực, thiếu/không rõ người duyệt báo rõ; chặn tự duyệt và người mất quyền; kiểm trọn lượt chạy | Đạt API/UI và E2E |
| 4 | Excel phòng ban/chức danh/vị trí/nhân sự: template, giới hạn file/dòng, preview/lỗi từng dòng, duplicate/reference/permission checks, commit nguyên tử và chống ghi dữ liệu đã thay đổi | Đạt API/UI và E2E |

## Ràng buộc

- Giữ tách person, account, employment, assignment, chức danh và role; issuer + subject là khóa định danh. Không tạo credential IdP từ import Excel.
- Nghiệp vụ Quy trình chỉ dùng hợp đồng Directory do Foundation sở hữu, không mở quyền truy vấn DB định danh cho module.
- MFA, CSRF, tenant/unit/delegation, grant, revocation, audit, revision và idempotency phải được giữ. Preview không thay thế kiểm quyền/quan hệ tại commit.
- Migration mới additive Foundation 006+, Workflows 003+ nếu cần; không sửa các migration đã áp dụng. Source LMS/BOS/YMS cũ chỉ đọc.
- UI React/shadcn/TLQM, Be Vietnam Pro, desktop/mobile, keyboard/focus, loading/empty/error. Không in credentials vào chat/log/ảnh/Git.
- Suites dùng DB/MFA chạy tuần tự. Giữ dữ liệu local và credentials, không xóa volume. Đọc [runbook local](../docs/LOCAL_DEVELOPMENT.md) trước vận hành.

## Hoàn tất khi

Đủ API/UI cho cả bốn mốc, migration/rollback runbook, unit/integration/E2E nghiệp vụ và hồi quy SSO/quyền pass; kiểm UI desktop/mobile/axe và xem ảnh thật, lưu evidence/hash source. Cập nhật docs tiếng Việt và mở bản local dùng thử. Không gọi bản thiết kế/test chưa chạy là đã hoàn thành. Không tự kết thúc sau một mốc.

## Bằng chứng

- Đầu lượt: đã đọc AGENTS, Directory CRUD/mutation guard, migration runner, workspace tổ chức và boundary Quy trình. Bản tổ chức trước đã nghiệm thu riêng tại [Organization Workspace](ORGANIZATION_WORKSPACE.md).

- 14:50Z: check pass 150 tests, typecheck/build. E2E 14:56:20Z pass 8 axe scans và luồng thật manager/unit-head/substitute, onboarding/transfer/offboard, nhập Excel. Đã xem ảnh thật; bổ sung kiểm bàn phím vùng cuộn và cấu hình/lưu người duyệt qua UI.
- Đã sửa semantic headings, vùng cuộn Excel có focus bàn phím. Designer chỉ nâng spec lên v3 khi dùng quy tắc tổ chức hoặc đã ở v3; các rule cũ giữ v2 để không đổi contract không cần thiết. Hồi quy cuối ghi trong `.local/evidence/organization-operations-regression.json`; chưa hoàn tất trước receipt cuối.
- Hướng dẫn và rollback: [Vận hành tổ chức](../docs/ORGANIZATION_OPERATIONS.md).

- Hồi quy mã cố định từ 15:00:36Z: check 150 tests pass; E2E vận hành mới pass 10 axe scans, gồm cấu hình/lưu designer UI và cuộn bảng Excel bằng phím; workspace tổ chức cũ pass; Foundation SSO/identity/admin UI pass lúc 15:06:51Z. Các suite Forms/LMS/Quy trình còn chạy tuần tự.
- Receipt `organization-operations-regression-before-v2-compatibility.json` giữ lượt check exit 0 nhưng sourceStable=false vì chỉnh tương thích v2 trong lúc lượt đang chạy; không dùng lượt đó làm nghiệm thu cuối.

## Nghiệm thu cuối

- Hồi quy kết thúc **15:09:50Z**, cả tám lệnh pass với sourceStable=true: `check` (150 tests, typecheck, format, build), `test:organization-operations`, `test:organization`, `test:e2e`, `test:forms-ui`, `test:lms`, `test:workflows-assignments`, `test:workflows`. Receipt `.local/evidence/organization-operations-regression.json`, 279 source hashes.
- Chốt UI sau đó chỉ đổi `frontend/src/foundation/personnel.tsx`, `frontend/src/components/resource-panel.tsx`, `scripts/organization-operations-e2e.ts`: xóa lý do khi đổi loại thao tác/đối tượng; bảng trách nhiệm rộng, có vùng cuộn/focus bàn phím. Script follow-up xác minh đúng ba file này, toàn bộ backend/migration/auth giữ cùng hash với hồi quy tám lệnh; format/typecheck/build và hai E2E tổ chức đều pass. Receipt `.local/evidence/organization-operations-ui-followup.json` lưu provenance và hash bản cuối.
- E2E vận hành cuối có **10 axe scans không violations**, giữ incomplete rules, không tắt luật. Đã xem ảnh desktop/mobile của form tiếp nhận, nghỉ việc, dialog quản lý, bảng quan hệ, Excel, designer và lượt duyệt. Kiểm thật chọn/lưu rule v3; không tự duyệt; thay thế đúng người; hai quy trình manager/unit-head hoàn thành. Đây không phải chứng nhận WCAG toàn bộ.
- Foundation đã áp dụng 006, Workflows 003 trên local/test bằng scripts có guards; giữ journals cũ và credentials. Không migration LMS/Forms trong goal này.
- Audit cuối `.local/evidence/organization-operations-final-audit.json` đối chiếu source/evidence/build, 17 source hashes LMS gốc, liên kết docs và readiness 4100/4104/4105; chạy lại sau các sửa tài liệu cuối. Không commit/push/deploy.
- Dùng `org.admin` tại http://127.0.0.1:4100/#organization; hướng dẫn `.local/ORGANIZATION-TRY.md` không có secrets. Người dùng tự xử lý MFA/đổi mật khẩu lần đầu nếu chưa làm. Module Quy trình dùng tài khoản/quyền riêng đã cấp, không tự mở rộng grant của org.admin.

Giới hạn đã công bố trong runbook: luồng nhân sự thực hiện ngay, chưa có scheduler/điều chuyển khác pháp nhân nguyên tử; chỉ một tầng thay thế; nhập `.xlsx` tạo mới tối đa 500 dòng/2 MB, không upsert/IdP provisioning. Source LMS/BOS/YMS gốc không bị sửa. Goal engine của chat vẫn giữ LMS blocked; việc bốn mốc đã hoàn tất được ghi tại tài liệu này, không đánh dấu goal LMS complete.

- Bàn giao 15:14Z: đã xem ảnh chốt mobile/desktop sau follow-up, mở lại Portal ở màn bắt đầu SSO và giữ tab dùng thử. Foundation/Forms/Quy trình chạy `npm run dev`; LMS chạy `npm run lms:dev`. Readiness 4100/4104/4105 đều 200. Khi khởi động lại LMS, guarded unlock xác nhận PID 1880 đã thoát và chỉ gỡ khóa cũ, giữ storage/credentials. Audit cuối được tạo lại sau dòng bàn giao này.
