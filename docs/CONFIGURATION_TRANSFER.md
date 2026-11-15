# Nhập, xuất và khôi phục cấu hình

Ngày 11/11/2026. Mốc E4c của [goal bộ ứng dụng có thể cấu hình](../roadmap/GOAL_CONFIGURABLE_SUITE.md). Workspace `D:/thanhnx/TLQM-AIO`, nhánh `feat/foundation-mvp`, baseline `abea705b0937fe164fa9c983700089bec88c82ba`, worktree dirty. Đã nghiệm thu local: hồi quy 19/19 lệnh, 209 tests, sourceStable=true; E4c SSO/UI đạt 12 axe scans và đã xem ảnh cuối. Chỉ môi trường AIO local giả lập.

## Phạm vi

| Loại gói                                                             | Nội dung                                                                       | Quyền nguồn                           |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------- |
| `directory-people`                                                   | Schema hồ sơ, trường nhân viên được xem/đề xuất sửa                            | Foundation `people:manage`, MFA       |
| `directory-org-units`, `directory-job-titles`, `directory-positions` | Schema thông tin mở rộng của đơn vị/chức danh/vị trí                           | Foundation `directory:manage`, MFA    |
| `workflow`                                                           | Biểu mẫu, đồ thị bước/điều kiện, người/nhóm xử lý, lịch/SLA và audience        | `workflows:design` đúng đơn vị, MFA   |
| `lms-course`                                                         | Nội dung khóa, câu hỏi/đáp án, policy, audience và tham chiếu media/tiên quyết | `lms:admin`, MFA và mapping hiện hành |
| `lms-path`                                                           | Lộ trình, thứ tự/phiên bản khóa và audience                                    | `lms:admin`, MFA và mapping hiện hành |

Gói là cấu hình của một mục, không chứa hồ sơ người, quan hệ công tác, tài khoản, grant/binding, dữ liệu thi, enrollment hoặc binary media. Khóa học xuất có đáp án, vì vậy endpoint luôn yêu cầu quyền quản trị nguồn; học viên bị từ chối. Chức danh và nhãn trường không sinh quyền ứng dụng.

## Thao tác qua giao diện

Trong màn thiết kế tương ứng, lưu nháp trước. Các nút **Xuất cấu hình / Nhập cấu hình** dùng bản đã lưu; khi đang sửa chưa lưu, hoàn tất lưu hoặc bỏ thay đổi trước khi nhập/xuất.

1. **Xuất cấu hình** tải gói JSON v1 về máy. Có thể dùng làm mẫu hoặc bản sao trước thay đổi.
2. **Nhập cấu hình** nhận tệp JSON tối đa 256 KB. Chọn đúng loại gói cho màn đang mở.
3. **Đối chiếu đối tượng hiện hành** cho phép thay UUID của đơn vị, người/nhóm duyệt, phiên bản khóa và media bằng đối tượng hiện có trong phạm vi. Tham chiếu trùng ID và còn khả dụng được chọn sẵn; tham chiếu không tồn tại cần chọn rõ. Có tìm kiếm và phân trang danh sách tham chiếu.
4. **Xem trước khác biệt** kiểm cấu trúc, tham chiếu và quyền, hiển thị giá trị trước/sau. Gói không hợp lệ không được ghi. Thay file hoặc mapping hủy bản xem trước cũ.
5. Nhập lý do, bấm **Ghi bản nháp đã đối chiếu**. Trình duyệt nhận `*-truoc-khi-nhap.json` trước yêu cầu ghi; giữ tệp này để khôi phục. Dialog chờ bản nháp mới tải xong rồi mới đóng.
6. Kiểm tra trong trình thiết kế và **phát hành riêng** theo quyền hiện hành. Publication tiếp tục kiểm đầy đủ luật nghiệp vụ như người xử lý đủ điều kiện, vòng phụ thuộc tiên quyết và audience. Nhập hợp lệ không tự phát hành.

Tệp media không được sao chép theo gói; upload ở LMS trước, sau đó đối chiếu tới ID media hiện hành. Ngày tạo và nhãn tham chiếu trong tệp là thông tin do người cung cấp tệp đưa vào; quyền và tính khả dụng luôn được kiểm từ nguồn hiện tại.

## Hợp đồng và tính nhất quán

Định dạng gồm `format="tlqm-aio-configuration"`, `version=1`, `kind`, `label`, `createdAt`, `content` và `references`. Ví dụ đầy đủ ở [bộ mẫu](../examples/configuration/README.md). Mỗi module dùng parser có phiên bản của nó để diễn giải `content`; không thực thi JS/SQL hoặc biên dịch schema từ tệp thành Fastify validator. Thuộc tính lạ, prototype keys, độ sâu/kích thước vượt giới hạn và loại gói sai đều bị từ chối.

Server tạo bản xem trước có HMAC miền riêng, gắn account/person, tenant, loại/đích, nội dung đã chuẩn hóa, metadata ownership và revision nháp. Bản xem trước không cấp quyền. Khi áp dụng, server kiểm lại chữ ký, danh tính, quyền và tham chiếu; mutation gốc kiểm CAS, audit và idempotency. Chỉnh nội dung bản xem trước hoặc dùng cho tài khoản/đích/môi trường khác bị chặn. Nếu nháp đã đổi, cần xem trước lại. Retry cùng key và nội dung dùng receipt mutation hiện hành.

Nhập dùng chính các dịch vụ lưu nháp hiện hữu. Cấu hình Directory không đổi phiên bản đang áp dụng; Workflows không viết lại lượt/phiếu/phiên bản đang chạy; LMS không đổi bản học, kết quả, chứng nhận hoặc enrollment đã giao. Source schema versions/migration journal giữ nguyên. Field ID Directory đã phát hành không được đổi loại qua import.

Giới hạn package 256 KB, depth 20, tối đa 30.000 nút dữ liệu; tham chiếu tối đa 1.000. Danh mục LMS được chặn rõ nếu vượt 5.000 khóa/media/đơn vị thay vì trả thiếu. Picker chỉ hiện tối đa 100 kết quả đã lọc cùng lựa chọn đang giữ; thêm từ khóa nếu cần thu hẹp. Các giới hạn native về số trường, node, câu hỏi/policy tiếp tục áp dụng.

Các API đều yêu cầu phiên/quyền nguồn và CSRF khi dùng cookie. Foundation và Quy trình dùng `/api/v1/configuration-transfer/.../{options|export|preview|apply}`; LMS dùng POST `/api/lms/config-transfer`. Apply ghi audit/receipt qua mutator của module; export/preview là đọc, không tạo phiên bản hay audit mutation giả.

Với gói Quy trình, preview ký kèm SHA-256 của JSON gói đã parse, SHA-256 của danh sách mapping và số tham chiếu đã map. Hash dùng JSON chuẩn hóa theo thứ tự khóa, giữ thứ tự phần tử mảng. Khi áp dụng, sự kiện `definition.updated` ghi các giá trị đó trong `details.configurationImport` cùng checksum nháp, actor, lý do, request ID và revision. Audit chỉ giữ dấu vết đối soát, không sao chép nội dung gói, UUID trong mapping hoặc chữ ký review. Gói nguồn có thể mang sang đích. Review phải tạo lại tại đích theo quyền và tham chiếu hiện hành. [NIST SP 800-128](https://csrc.nist.gov/pubs/sp/800/128/upd1/final)

## Khôi phục

Nhập lại gói sao lưu trước thay đổi vào đúng nháp, xem khác biệt và ghi revision mới. Đối chiếu lại các tham chiếu đã thay đổi hoặc bị thu hồi. Nếu cần đổi cấu hình đang áp dụng, phát hành phiên bản mới sau khi kiểm tra; các lượt/bài học cũ vẫn giữ phiên bản cũ.

Không sửa trực tiếp journal, xóa lịch sử hoặc hồi quyền để rollback. Bộ nhập không khôi phục binary media đã mất và không gộp giao dịch qua nhiều module; phục hồi media theo [runbook storage](LMS_STORAGE_OPERATIONS.md). Thực hiện từng cấu hình với bản sao và receipt riêng.

## Kiểm chứng

8 domain tests đã pass: kiểu/giới hạn/prototype, signature/owner/environment, Directory toàn bộ bốn resource, CAS/idempotency, tham chiếu workflow, giữ phiên bản/lượt đang chạy, private answer keys, lộ trình/enrollment, audit rollback và khôi phục backup. SSO E2E cuối lúc 2026-11-10T23:07:35.185Z đã pass 12 axe scans trên desktop/mobile, download/upload/mapping/diff/apply và kiểm tệp backup thật. Đã xem ảnh chính và bốn ảnh diff/nút áp dụng mobile của Directory, Quy trình, khóa học và lộ trình; controls và focus hiển thị trong vùng cuộn. Axe không báo violations nhưng còn mục cần đánh giá thủ công, không phải chứng nhận WCAG đầy đủ.

`npm run test:configuration-transfer`; bằng chứng `.local/evidence/configuration-transfer-e2e.json`, ảnh `configuration-transfer-*.png`, các gói nguồn/backup giả lập trong `.local/evidence/configuration-*.json`. Hồi quy toàn bộ đợt: `npm run test:suite-regression -- e4-final`. Không đưa proof/credential vào tệp tải về hoặc ảnh kiểm thử.

### Chuyển cấu hình Quy trình giữa hai cụm cô lập

```powershell
$release = 'e4-workflow-promotion-v1'
$build = Get-Content -Raw ".local/releases/$release/receipt.json" | ConvertFrom-Json
& node_modules/.bin/tsx.cmd scripts/enterprise-recovery-postgres.ts $release $build.artifactDigest 'C:/Program Files/PostgreSQL/17/bin' --with-workflow-promotion
```

Lượt `32b04073-46f9-4392-b323-79e41098bc28` đạt lúc **09:04:07 ngày 13/11/2026, giờ Việt Nam**. Runner khởi tạo hai cụm PostgreSQL 17.11 trên loopback, dùng role runtime Quy trình, hai miền review và UUID đơn vị/người xử lý riêng. Gói xuất từ API nguồn cần hai mapping và tạo một thay đổi tên tại đích. API từ chối review nguồn, review của người khác, quyền đã thu hồi, tham chiếu đã mất và revision cũ. Replay giữ một audit nhập. Apply chỉ ghi nháp. Lệnh publish riêng tạo v2 cho lượt mới, lượt đang chạy giữ v1 và nhiệm vụ cũ. Nhập lại backup khôi phục bản nháp trước thay đổi và giữ v2 đã phát hành. Receipt `.local/enterprise-recovery/32b04073-46f9-4392-b323-79e41098bc28/receipt.json` ghi digest ứng viên, gói và mapping. Lượt này dùng Fastify injection và fixture định danh/Directory. Còn chạy với TLS, Keycloak và giao diện ở hai slot staging.
