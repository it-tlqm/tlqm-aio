# ADR 0005 — Module Quy trình, tham khảo AMIS và tái sử dụng BOS

Ngày 10/11/2026. Người dùng yêu cầu module Quy trình theo AMIS, lấy phần tái sử dụng được từ BOS và tự triển khai tiếp, không hỏi thêm. Bản phê duyệt một cấp trong Forms trước đó chỉ là đề xuất, chưa được triển khai; phạm vi được thay bằng module này.

## Nguồn đã đọc, không vận hành

BOS tại D:/thanhnx/OpenCode/BOS/bos-workspace, nhánh codex/crm-app-yms, HEAD 818de77907bf6a2067807889afb708d6142c767b, worktree dirty ngày kiểm kê. Khác snapshot BOS của ADR Forms trước đây. [Snapshot file/hash](../BOS_WORKFLOW_SOURCE_SNAPSHOT.json) ghi các file đã đối chiếu; source chưa commit có thể khác HEAD. Không đọc secrets/dump/dữ liệu khách hàng, không sửa/cài/chạy source BOS.

| Phần BOS | Quyết định thực tế |
| --- | --- |
| core/configuration-rules/configuration-rule-engine.ts | Trích phần normalize/evaluate condition thuần TypeScript sang src/workflows/bos/condition-engine.ts; giữ nguồn, kiểm lại bằng conformance fixtures. Không mang expression/calculation engine hoặc eval vào module. |
| packages/core/src/lib/configuration-rule-conformance.json | Mang conditionCases sang tests/fixtures, kiểm parity cho các điều kiện số/chuỗi/boolean/date/AND/OR. Chỉ fixtures source giả lập. |
| frontend-nextjs/src/utils/workflowLayout.ts | Tái sử dụng auto-layout Dagre/React Flow ở frontend/src/workflows/bos-layout.ts; sửa type-only imports và thu gọn khoảng cách/chiều cao node cho canvas AIO. |
| governance-approval-engine.ts | Áp dụng cùng cách kiểm graph cycle/reachability, phiên bản snapshot, quyết định xác định; tích hợp phù hợp UUID/app quyền của AIO. Không copy registry Nest/governance nguồn chủ. |
| workflows.service.ts / VisualWorkflowCanvas.tsx | Gắn Prisma/Nest/BullMQ/Redis/metadata Entities, Ant Design và @bos/core. Viết adapter/service và controls shadcn riêng; không kéo stack auth/database BOS sang AIO. |

Code BOS là source nội bộ được người dùng cho phép tái sử dụng trong AIO; package backend ghi UNLICENSED. Không gắn nhãn mã BOS là thư viện MIT. Dagre và React Flow là dependencies MIT riêng, đã xác minh metadata npm và pin versions giống nhánh khai báo BOS (3.0.0/12.11.2).

## Kiến trúc

AIO Quy trình là module riêng, client aio-workflows ở loopback 4105. DB aio_workflows/aio_workflows_test và owner/runtime riêng; domain không đọc DB Identity hoặc Forms. Foundation cung cấp context danh tính/quyền và tham chiếu account/unit; chức danh không tự sinh quyền xử lý.

Tái sử dụng FormSchema/interpreter/renderer/designer của AIO Forms như thư viện thuần code. Định nghĩa quy trình và hồ sơ chạy là dữ liệu Workflows; không thêm state xử lý vào lõi định danh hoặc sửa phiếu Forms đã gửi.

Định nghĩa → version phát hành bất biến → lượt chạy pin version; graph có Start/Approval/Task/Condition/End, đầu vào typed, nhánh có true/false rõ ràng, chặn vòng lặp. Trả về người khởi tạo là chuyển trạng thái có audit và vòng bổ sung mới, không thêm edge tạo vòng tùy ý. Mỗi bước có người xử lý, thời hạn; hành động cần quyền app/unit hiện hành và đúng nhiệm vụ. Không tự duyệt đề nghị của cùng account/person.

Thư viện mẫu, thiết kế sơ đồ, phát hành/ngừng phát hành, khởi chạy, cần xử lý/đã gửi, phê duyệt/từ chối/trả về/chuyển tiếp, bổ sung/gửi lại, hủy, phân công lại có quyền, lịch sử và thống kê cơ bản là lát cắt local đầu. Chưa tuyên bố đầy đủ mọi chức năng AMIS: nhánh song song/quorum, phân quyền từng trường, thông báo email, ký số, lịch tự chạy và tích hợp kế toán có gate riêng.

## Tài liệu AMIS đã đối chiếu

- [Thiết kế và phát hành](https://helpamis.misa.vn/amis-quy-trinh/kb/tao-moi-quy-trinh/): mô hình mẫu, bước, biểu mẫu, người xử lý và thời hạn.
- [Chạy/xử lý](https://helpamis.misa.vn/amis-quy-trinh/kb/chay-va-thuc-hien-quy-trinh/): tách lượt chạy và công việc cần thực hiện.
- [Bước phê duyệt](https://helpamis.misa.vn/amis-quy-trinh/kb/thiet-lap-buoc-phe-duyet/): hành động phê duyệt/từ chối và người được giao.

Các nguồn là đối chiếu hành vi sản phẩm; không sao chép giao diện thương hiệu, assets hoặc nội dung hướng dẫn dài. UI dùng shadcn, Be Vietnam Pro và palette TLQM. Không đăng ký/publish Sites hoặc deploy cloud.
