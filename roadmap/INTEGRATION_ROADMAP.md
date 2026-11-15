# Lộ trình triển khai

Ngày: 10/11/2026. Trạng thái: **Foundation/Forms/LMS sandbox đã nghiệm thu local; module Quy trình theo yêu cầu mới đã có bản đầu chạy được**. Chưa ấn định lịch production hoặc nguồn lực toàn chương trình. [Tiến độ Quy trình](WORKFLOWS_PROGRESS.md).

Thứ tự người dùng đã chốt: **SSO và nền tảng chung → Form Builder + tích hợp LMS → các ứng dụng khác; LIMS để sau**.

| Giai đoạn | Kết quả | Điều kiện qua giai đoạn |
| --- | --- | --- |
| 0 — Khởi tạo hiện tại | Master repo, inventory, mô hình tổ chức/quyền, kiến trúc, backlog | Tài liệu nhất quán, có bằng chứng và giới hạn |
| 1 — Foundation MVP | IdP thử, Directory/Access/Registry/Audit tối thiểu, hai client kiểm chứng | Login/SSO, cấp/thu hồi quyền, scope, key rotation và lỗi dịch vụ được test |
| 2A — Form Builder ưu tiên | Designer, schema version, publish, audience, submit và báo cáo tối thiểu | Khảo sát nội bộ chạy xuyên suốt; giữ version cũ, chống gửi trùng, cách ly dữ liệu |
| 2B — Tích hợp LMS | Adapter SSO, mapping học viên, quyền ứng dụng, thu hồi phiên | Cùng identity với Forms, không mất tiến độ/điểm, kiểm thử role/scope |
| 3 — Portal/Connect mở rộng | Cổng công việc, khảo sát và dashboard theo nhu cầu | Nghiệp vụ/owner đã chốt; không làm lại auth từng app |
| 4 — BOS, CRM/CMS, YMS, LIMS, ERP | Adapter theo hệ thống | Kiểm kê từng source, ownership và kế hoạch cutover/rollback riêng |

2A và 2B cùng là ưu tiên đầu; có thể triển khai đồng thời nếu có người phụ trách riêng. Nếu một luồng triển khai, thực hiện Form Builder MVP trước rồi nối LMS. Chuẩn bị assessment/contract của cả hai ngay trong Sprint 01.

## Tái sử dụng trước khi xây mới

- Foundation: xem mô hình BOS nhưng không đưa schema nghiệp vụ vào lõi.
- Forms: spike renderer/designer/registry BOS; chọn adapter, tách package hoặc module nhỏ dựa trên dependency thực tế.
- LMS: giữ Next/Workers/D1; ưu tiên adapter và mapping user.
- Việc chuyển code giữa repo cần xác minh nguồn chủ, quyền sử dụng và phạm vi được giao.

## Gate cho môi trường và dữ liệu

Trước implementation: chốt runtime thử, repository nguồn LMS, owner Directory và loại dữ liệu giả lập. Chưa cần chốt toàn bộ production để bắt đầu PoC.

Trước pilot người thật: kiểm thử authz/tenant, đối soát dữ liệu, quản lý secret, thu hồi account, backup/restore, audit, hỗ trợ vận hành và rollback đã có bằng chứng. Thay đổi remote/production theo phạm vi người dùng cho phép, không suy ra từ bản kế hoạch.

## Những quyết định chưa cần ép chốt

- Một hay nhiều repository cho code Foundation/Forms.
- Hosting/domain production và version cụ thể của các dịch vụ.
- Dùng toàn bộ CMS trong BOS hay headless CMS riêng.
- Chuyển database/framework ứng dụng hiện có.
- Lịch triển khai LIMS riêng.

## Sản phẩm bàn giao theo nhánh công việc

| Nhánh | Sản phẩm review được |
| --- | --- |
| Identity | Cấu hình không secret, test report, session/revocation contract |
| Directory/Access | Schema logic, API contract, scope matrix, audit examples giả lập |
| Forms | Prototype hoặc module MVP khi được giao xây, sample survey, version tests |
| LMS | Mapping report giả lập, adapter test, đối soát lịch sử học và rollback plan |

Không coi file tài liệu “đã có” là bằng chứng hệ thống “đã chạy”. Trạng thái thực hiện hiện tại được ghi ở README.
