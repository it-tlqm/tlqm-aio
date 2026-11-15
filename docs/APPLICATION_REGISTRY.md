# Application Registry và hợp đồng tích hợp

Ngày: 10/11/2026. Trạng thái: **CRUD Registry/delegation và onboarding local v1/v2/v3 đã chạy**, gồm probe, application Forms/Quy trình và external application LMS sandbox. Ownership sản phẩm/production dưới đây vẫn là hợp đồng mục tiêu. [Runbook client local](LOCAL_CLIENT_ONBOARDING.md).

## Bản ghi tối thiểu

Mỗi ứng dụng có appId bất biến, code, displayName, businessOwner, technicalOwner, trạng thái, phân loại dữ liệu, danh mục permission và hướng dẫn hỗ trợ.

Mỗi môi trường có environment, issuer, clientId, API audience, base URL, redirect URI chính xác, post-logout URI, session strategy, khả năng back-channel logout và phiên bản adapter. Registry lưu tham chiếu secret nếu cần; không lưu giá trị secret.

Thay redirect/issuer/owner là thao tác quản trị có audit và review phù hợp. Không dùng URL do end-user gửi để redirect hoặc gọi discovery.

| Code | Vai trò | Trạng thái |
| --- | --- | --- |
| aio-admin | Quản trị Foundation | Đề xuất |
| aio-portal | Cổng ứng dụng tối thiểu | Đề xuất |
| aio-forms | Form Builder, khảo sát và phiếu nội bộ | MVP local đã nghiệm thu |
| aio-workflows | Module Quy trình | Bản local đầu chạy ở 4105 |
| aio-lms-sandbox | Adapter LMS giả lập | Đã kiểm chứng; không phải LMS hiện hữu |
| tlqm-lms | Đào tạo | Source local đã xác minh, chưa tích hợp |
| bos | Nền tảng điều hành hiện hữu | Khảo sát, tích hợp sau |
| lims | Phòng lab, dự án riêng | Giai đoạn sau; chưa có source |
| yms / crm / erp | Nhóm mở rộng | Cần registry riêng theo hệ thống thực tế |

Client IdP local đang dùng là aio-foundation, aio-probe, aio-onboarding, aio-forms, aio-workflows và aio-lms-sandbox; không dùng như client production. Các code khác trong bảng còn đề xuất/chưa tích hợp. Mỗi client có audience/cookie/quyền riêng; fixture được cấp rõ qua governance, không seed grant chung cho toàn bộ người dùng.

## Checklist onboarding một ứng dụng

1. Chốt owner, môi trường, nguồn source và dữ liệu được phép dùng.
2. Đăng ký client/audience theo môi trường; kiểm tra issuer và callback.
3. Thiết kế mapping account/person và user legacy nếu có.
4. Công bố roles/permissions và scope; kiểm tra cả grant cấp ứng dụng.
5. Thiết lập session, refresh, logout và thu hồi quyền có kiểm thử.
6. Kiểm tra backend enforcement, audit, xử lý lỗi IdP/Access và key rotation.
7. Đối soát người dùng giả lập, không làm mất liên kết nghiệp vụ.
8. Ghi kế hoạch rollout/rollback và người chịu trách nhiệm.
9. Chỉ hiện trạng thái “đã tích hợp” khi bộ kiểm thử đã có bằng chứng.

## Nguyên tắc giao tiếp

HTTP API dùng version hợp đồng và request/correlation ID. Lỗi có mã ổn định, thông điệp phù hợp người dùng và không tiết lộ dữ liệu nhạy cảm. Retry thao tác ghi cần idempotency key; không tự retry vô hạn.

LMS không đọc DB Forms; Forms không truy cập bảng Keycloak. Các ứng dụng tiêu thụ thông tin được cấp qua API/event đã công bố.
