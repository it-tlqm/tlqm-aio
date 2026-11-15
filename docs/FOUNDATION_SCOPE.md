# Phạm vi nền tảng TLQM AIO

Ngày: 09/11/2026. Trạng thái: **phạm vi ưu tiên đã được người dùng xác nhận; chi tiết triển khai là đề xuất**.

## Kết quả cần đạt

Một người được nhận diện nhất quán trong các ứng dụng; bộ phận quản trị biết người đó thuộc tổ chức nào, được vào ứng dụng nào, được làm gì và trên phạm vi dữ liệu nào. Thêm ứng dụng mới không đòi hỏi xây lại hệ thống danh tính.

| Thành phần | Trách nhiệm tối thiểu | Không sở hữu |
| --- | --- | --- |
| AIO Identity | Đăng nhập, MFA, credential, phiên SSO, OIDC clients | Khóa học, mẫu xét nghiệm, đơn hàng |
| Organization Directory | Người, pháp nhân, đơn vị, chức danh, vị trí, quan hệ công tác | Password, chính sách chấm điểm hoặc phê duyệt kết quả lab |
| Access Management | Quyền truy cập ứng dụng, role bindings, phạm vi, vòng đời cấp/thu hồi | Tự suy luận quyền từ tên chức danh |
| Application Registry | Mã ứng dụng, chủ sở hữu, môi trường, client/audience, trạng thái tích hợp | Client secret hoặc token |
| Audit nền tảng | Ai thay đổi tài khoản/tổ chức/quyền, lúc nào, lý do | Nội dung hồ sơ nghiệp vụ nhạy cảm |
| Portal tối thiểu | Hiện các ứng dụng được cấp, mở ứng dụng qua SSO | Thực thi thay mọi kiểm tra quyền backend |

Portal tối thiểu là màn hình truy cập và quản trị nền tảng. **Form Builder là ưu tiên ứng dụng đầu tiên cùng tích hợp LMS**, bắt đầu bằng biểu mẫu/khảo sát nội bộ. Workflow nhiều bước và dashboard quản trị kinh doanh mở rộng thuộc giai đoạn sau.

## Ranh giới giai đoạn

Người dùng đã cho phép xây SSO/nền tảng chung bằng TypeScript + Fastify và tiếp tục Forms, rồi LMS sau Foundation. Mức hoàn thành từng mục được ghi trong [trạng thái triển khai](IMPLEMENTATION_STATUS.md) và [đối chiếu nghiệm thu](FOUNDATION_ACCEPTANCE.md).

Foundation MVP đề xuất gồm Identity, Directory, Access, Registry, audit và trang kiểm chứng tối thiểu. Hai client thử chứng minh luồng chung trước khi gắn vào một hệ thống đang dùng. Sau đó xây Form Builder MVP và tích hợp LMS; có thể thực hiện đồng thời nếu đủ nguồn lực, nhưng không bỏ qua cổng nghiệm thu nền tảng.

Chưa bao gồm ERP/HRM đầy đủ, lương, công, CRM, nghiệp vụ LIMS, kho dữ liệu BI, workflow engine tổng quát hoặc một hệ thống cấp quyền phức tạp cho mọi điều kiện nghiệp vụ.

## Tiêu chí hoàn thành Foundation MVP

1. Một tài khoản thử đăng nhập client A rồi mở client B qua SSO, không chia sẻ cookie/token ứng dụng giữa hai client.
2. Đăng nhập thành công nhưng chưa được cấp ứng dụng vẫn bị backend từ chối.
3. Cùng người có thể có nhiều quan hệ công tác và vai trò khác nhau theo ứng dụng.
4. Chọn đơn vị không cho phép tự đổi tenant hoặc truy cập dữ liệu ngoài quyền.
5. Thu hồi quyền, khóa tài khoản và logout có kết quả đo được theo mục tiêu thời gian trong tài liệu SSO.
6. Các thao tác quản trị có audit; quản trị tổ chức không tự nâng thành quản trị hệ thống.
7. Quyền của client A không dùng được để truy cập API client B.
8. Đăng ký được ứng dụng mới qua hợp đồng đã mô tả mà không thêm cột nghiệp vụ riêng vào Directory.
9. Môi trường thử chỉ có dữ liệu giả lập; có quy trình khôi phục thử được.
10. Kịch bản lỗi IdP, lỗi kiểm tra quyền, key rotation và stale session có hành vi xác định.

## Những điều đã chốt và còn mở

| Đã chốt bởi người dùng | Chưa chốt |
| --- | --- |
| Tên TLQM AIO, repo it-tlqm/tlqm-aio; local pin Keycloak 26.8.2, PostgreSQL 17.7 | Topology/hosting/domain và vận hành production |
| Nền tảng và SSO trước | Nguồn nhân sự chuẩn, IdP/AD/Microsoft 365 hiện có |
| Ưu tiên Form Builder và tích hợp LMS | Phạm vi khảo sát đầu tiên, owner dữ liệu LMS, môi trường pilot |
| Giữ source cũ nguyên trạng trong kiểm kê | Mức tái sử dụng code BOS, giấy phép và quyền chuyển code |
| TypeScript + Fastify, frontend React/shadcn; code/test trong Master Project | Cách phân phối nhiều repository khi vận hành, lịch và nhân lực |

Các mục còn mở về hosting không cản việc hoàn thiện thiết kế nền tảng. LIMS riêng chưa có đường dẫn và được để lại cho giai đoạn sau.
