# ADR 0001 — Nền tảng trước, ưu tiên Form Builder và LMS

Ngày: 09/11/2026.

## Trạng thái

**Thứ tự ưu tiên: đã được người dùng xác nhận.** Stack backend được chốt tiếp tại [ADR 0002](0002-typescript-fastify.md). Có bộ khung local; topology production còn mở.

## Bối cảnh

TLQM AIO cần nền tảng định danh, tổ chức và phân quyền dùng chung cho nhiều ứng dụng. Người dùng chốt ưu tiên Form Builder và tích hợp LMS ở giai đoạn ứng dụng đầu tiên, sau phần nền tảng. LIMS riêng để giai đoạn sau.

Khảo sát chỉ đọc tìm thấy LMS đào tạo và các thành phần metadata/form schema trong BOS. Đây là nguồn đánh giá tái sử dụng; chưa có quyết định chuyển code hoặc thay auth.

## Quyết định về phạm vi

1. Nền tảng chung là sản phẩm của giai đoạn đầu.
2. Identity, Directory, Access và Registry phải độc lập với nghiệp vụ của ứng dụng pilot.
3. Nghiệm thu kỹ thuật nền tảng bằng hai client thử; triển khai Form Builder MVP và tích hợp LMS ngay giai đoạn ứng dụng đầu tiên.
4. Giữ nguyên các source và auth hiện hữu trong đợt kiểm kê.
5. Master Project hiện chứa tài liệu và code Foundation local theo yêu cầu tiếp theo của người dùng; source ứng dụng cũ giữ độc lập.

## Đề xuất kỹ thuật để kiểm chứng

- Keycloak làm IdP qua OIDC.
- Backend nền tảng chia module, triển khai nhỏ trước khi cân nhắc microservice.
- Dữ liệu Identity, nền tảng và nghiệp vụ có ownership riêng.
- Tái sử dụng BOS có chọn lọc sau khi đánh giá coupling và ownership.
- Không ép gộp repo hoặc đổi database các ứng dụng.

## Hệ quả

Có thể thiết kế Foundation và hai ứng dụng ưu tiên từ source đã tìm thấy. LMS tiếp tục giữ dữ liệu học tập; Form Builder cần ranh giới schema/phiếu trả lời độc lập với lõi tổ chức. Chưa ấn định lịch hoặc công sức triển khai trước các spike kỹ thuật.

Cấu hình đang chạy local được ghi ở LOCAL_DEVELOPMENT và IMPLEMENTATION_STATUS. Các đề xuất mở rộng và mục tiêu thời gian còn lại không được coi là cấu hình production.
