# Kiến trúc mục tiêu TLQM AIO

Ngày: 09/11/2026. Trạng thái: **kiến trúc mục tiêu; stack TypeScript + Fastify đã chốt và có bộ khung local**. Xem [trạng thái triển khai](IMPLEMENTATION_STATUS.md) để biết phạm vi thực tế.

## Sơ đồ trách nhiệm

~~~mermaid
flowchart TB
    U["Nhân viên / khách hàng / đối tác"] --> P["AIO Portal"]
    U --> A["Các ứng dụng nghiệp vụ"]
    P --> I["AIO Identity — Keycloak dự kiến"]
    A --> I
    P --> F["AIO Foundation API"]
    A --> F
    F --> O["Organization Directory"]
    F --> R["Access Management"]
    F --> C["Application Registry"]
    F --> L["Audit"]
    I --> IDB[("Database Identity riêng")]
    O --> FDB[("Database nền tảng")]
    R --> FDB
    C --> FDB
    L --> FDB
    A --> ADB[("Database theo ứng dụng")]
    P --> B["AIO Forms — Form Builder MVP"]
    B --> I
    B --> F
    B --> BDB[("Schema phiên bản và phiếu trả lời")]
~~~

Mũi tên thể hiện phụ thuộc giao tiếp, không phải quyền truy cập database. Identity và các ứng dụng không có tài khoản database dùng chung với nhau.

## Đề xuất tổ chức ban đầu

Giữ các ứng dụng hiện hữu độc lập trong đợt này. Foundation có thể bắt đầu bằng một backend chia module Directory, Access, Registry và Audit, cộng một giao diện quản trị tối thiểu. Tách Keycloak thành thành phần vận hành riêng. Chưa cần chia mọi module thành microservice.

| Lựa chọn | Lợi ích | Đổi lại | Khuyến nghị |
| --- | --- | --- | --- |
| Đưa toàn bộ BOS thành lõi AIO | Tận dụng nhiều chức năng sẵn có | Gắn IdP/Directory với tenant, user và nghiệp vụ BOS; source đang thay đổi nhiều | Chưa chọn |
| Foundation độc lập, tái sử dụng có chọn lọc | Ranh giới chung rõ; tích hợp nhiều ứng dụng | Cần xây và vận hành một nền tảng nhỏ | Đề xuất |
| Viết tất cả ứng dụng mới cùng một stack | Đồng nhất kỹ thuật | Phạm vi lớn, thay thế code đang dùng | Chưa có cơ sở |

Tái sử dụng ưu tiên hợp đồng dữ liệu, danh mục quyền và kinh nghiệm UI. Sao chép code cần đánh giá coupling, giấy phép và quyền sử dụng. Remote BOS thuộc tài khoản cá nhân; điều đó không tự chứng minh ownership hoặc quyền đưa code sang repo công ty.

## Công nghệ

| Thành phần | Đề xuất | Cơ sở/giới hạn |
| --- | --- | --- |
| Identity Provider | Keycloak qua OIDC | Local pin 26.8.2; đã kiểm chứng SSO hai client, chưa chốt vận hành production |
| Foundation API | TypeScript + Fastify | Người dùng đã chốt; Node 24, backend chia module |
| Directory/Access/Registry | PostgreSQL, module ownership rõ | Cần quan hệ và lịch sử nhất quán; không ép đổi DB ứng dụng cũ |
| Admin/Portal tương lai | React + TypeScript + Vite + Tailwind v4 + shadcn/ui | Người dùng ưu tiên shadcn và palette TLQM; hiện vẫn là trang HTML/JS kiểm chứng auth |
| Môi trường thử | Docker Compose riêng, dữ liệu giả lập | Đã dựng project tlqm-aio-local; PostgreSQL pin 17.7 |
| Tích hợp | OIDC, HTTP API version hóa; event khi thật sự cần | Chưa cần một message broker riêng |

Keycloak cung cấp discovery, token, userinfo, logout và khóa xác minh qua OIDC; điều này phù hợp với adapter ứng dụng độc lập. [Tài liệu Keycloak OIDC](https://www.keycloak.org/securing-apps/oidc-layers).

Đề xuất cấu hình container theo từng môi trường. Development mode chỉ dùng thử local; production cần cấu hình riêng. [Tài liệu container Keycloak](https://www.keycloak.org/server/containers).

## Sở hữu dữ liệu và đồng bộ

- Identity sở hữu credential, MFA và phiên đăng nhập.
- Directory sở hữu ID người, cấu trúc tổ chức và quan hệ công tác.
- Access sở hữu quyết định cấp ứng dụng và bindings vai trò/phạm vi.
- Ứng dụng sở hữu dữ liệu, quyền chi tiết và điều kiện nghiệp vụ của chính nó.
- ID AIO mới không thay thế ngay khóa chính legacy; bảng mapping giữ quan hệ giữa hai bên.
- Không đọc bảng Keycloak hoặc bảng BOS từ Foundation như một API.
- Đồng bộ chỉ một nguồn chủ cho mỗi thuộc tính. Nếu có event: eventId, schemaVersion, occurredAt, aggregateVersion, correlationId; consumer xử lý trùng và sai thứ tự.
- Import sau này cần dry-run, danh sách xung đột và đối soát. Đợt này không import người thật.

## Rủi ro và cổng quyết định

| Rủi ro | Cách giảm | Cổng trước bước tiếp theo |
| --- | --- | --- |
| Tạo Directory trùng HR/AD hiện có | Xác định nguồn chủ, trường nào được sửa ở đâu | Trước nạp dữ liệu nhân sự |
| Đồng nhất tenant BOS với pháp nhân | Mô hình riêng và bảng ánh xạ | Trước tích hợp hệ thống có nhiều tenant |
| Access service gây phụ thuộc runtime | Kiểm tra online cho thao tác quản trị; cache có hạn và từ chối khi hết hạn | Test lỗi và thu hồi quyền |
| Email trùng dẫn đến nối nhầm tài khoản | Mapping issuer + subject, quy trình xác minh liên kết | Trước account linking |
| Thu hồi IdP nhưng phiên app còn sống | Thu hồi cả app session và grant; đo thời gian | Trước mở cho người thật |
| LMS dùng D1 và session riêng | Adapter OIDC phù hợp Workers, giữ ID học viên và kiểm thử dữ liệu học tập | Trước pilot LMS |
| Form Builder phụ thuộc sâu BOS | Spike dependency; so sánh adapter với module mới tối thiểu | Trước sao chép hoặc tách code Forms |

## Ưu tiên ứng dụng và phần tiếp tục độc lập

Form Builder và tích hợp LMS là ưu tiên đầu tiên sau Foundation. Form Builder sở hữu schema, phiên bản và phiếu trả lời; Directory chỉ cung cấp danh tính/tổ chức, Access cung cấp quyền. LIMS riêng để giai đoạn sau.

LIMS, LMS, BOS, CRM, YMS, ERP có thể giữ backend, database, release và repository riêng. Chỉ chuẩn hóa cách xác thực, ID tham chiếu, cấp quyền ứng dụng, audit và hợp đồng trao đổi. Quyết định tổ chức code lâu dài cần một ADR sau kiểm kê đủ các ứng dụng.
