# E2 · IAM, ma trận quyền và audit

Phạm vi là AIO với dữ liệu giả lập. Mốc đối chiếu dùng OWASP ASVS **5.0.0**, yêu cầu mức 1 và mức 2. Các mã dưới đây mang tiền tố `v5.0.0-`. Bảng ghi bằng chứng từng lát cắt. Các yêu cầu còn lại vẫn cần quyết định áp dụng, bài thử và kết quả trước khi đóng E2. [Đối chiếu phạm vi theo chương](ENTERPRISE_ASVS_5_LEVEL_2.md) · [Danh mục yêu cầu ASVS 5.0.0](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/docs_en/OWASP_Application_Security_Verification_Standard_5.0.0_en.flat.json)

## Ca kiểm quyền trên staging

| Module    | Ca cho phép                                                                                              | Ca từ chối và giới hạn bằng chứng                                                                                          |
| --------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Portal    | Registry trả link đúng slot và Trung tâm công việc mở lượt Quy trình, đợt LMS theo quyền nguồn.          | Sau thu hồi grant, nguồn tương ứng từ chối request kế tiếp trong phiên đang mở.                                            |
| Forms     | Phát hành, nộp và xuất phiếu với grant và role phù hợp.                                                  | Người điền bị từ chối export, nộp ở đơn vị ngoài binding và đọc tenant khác.                                               |
| Quy trình | Người khởi tạo đọc trường dành riêng cho mình. Người được giao mở đúng lượt và xử lý bước của họ.        | Handler không nhận nội dung trường dành riêng cho người khởi tạo. Người không được giao và yêu cầu chéo tenant bị từ chối. |
| Công việc | Thành viên được giao có thể bàn giao. Quản lý hoàn thành với revision hiện hành và gửi lại cùng key.     | Dự án cùng tenant ngoài membership bị từ chối. Bàn giao làm mất quyền sửa của người cũ. CAS từ chối revision cũ.           |
| LMS       | Người học đọc media đã được gắn vào phiên bản họ được cấp, làm bài và xem kết quả. Quản trị đọc báo cáo. | Người học bị chặn media ngoài phiên bản, báo cáo và trường đáp án. LMS và feed Portal từ chối request kế tiếp sau thu hồi. |

Các ca dùng Chromium để đăng nhập SSO/MFA và gửi API trong phiên thật qua TLS. Cần bổ sung các ca thao tác bằng giao diện và ma trận tra cứu, file, export theo đối tượng và vai trò trên tất cả module. Các phép thử hiện tại đóng góp bằng chứng cho `8.1.1`, `8.1.2`, `8.2.1`–`8.2.3`, `8.3.1` và `8.4.1` trong phạm vi từng dòng.

## Kiểm kê audit của lần thử

| Nguồn                                         | Kho audit giao dịch                                                                      | Cách đưa sang kho tập trung                                                                                                                        |
| --------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Foundation                                    | PostgreSQL `audit_events`. Xác thực, định danh, cấp và thu hồi quyền, thao tác quản trị. | View chỉ cung cấp metadata. Runtime ứng dụng giữ quyền ghi giao dịch tại nguồn.                                                                    |
| Forms, Quy trình, Công việc                   | PostgreSQL riêng từng module. Lịch sử ghi cùng mutation và receipt.                      | Mỗi kho có view chỉ cung cấp metadata. Collector dùng role riêng.                                                                                  |
| LMS                                           | D1 `aio_audit`. Lịch sử phiên, học tập và quản trị.                                      | Runner đọc đúng các cột metadata qua D1 binding của slot. D1 binding là quyền của runner, cần adapter giới hạn riêng khi tách tiến trình thu thập. |
| Ingress, Keycloak, log lỗi và các lần từ chối | Log tiến trình và cấu hình hạ tầng của slot.                                             | Cần nghiệm thu thu thập, quyền truy cập, đồng bộ giờ và retention cho các luồng này.                                                               |

Kho PostgreSQL tập trung lưu nguồn, mã bản ghi nguồn, thời điểm sự kiện, mã ứng dụng, tenant, đơn vị khi nguồn có cột này, định danh actor/subject, hành động và request ID hợp lệ. View và câu đọc D1 loại bỏ `reason`, `details`, tên hiển thị, token, cookie và nội dung nghiệp vụ. LMS trả request ID do Worker sinh qua `x-request-id` và dùng nó cho audit mutation. Idempotency key tiếp tục phục vụ receipt của lệnh.

Collector chỉ đọc view đã cấp ở PostgreSQL nguồn và INSERT ở kho tập trung. Reader chỉ SELECT. Retention role chỉ được gọi hàm dọn với cửa sổ **90 ngày** tính từ thời điểm sự kiện. Đây là ngưỡng thử cho kho tập trung. Audit nguồn giữ nguyên lịch sử. Collector chạy lại theo trang và dùng khóa `(source, source_id)` để chống trùng. Runner kiểm từng request ID và hành động kỳ vọng trong kho tập trung. [Schema thử](../infrastructure/audit/001-staging-audit.sql), [Runner](../scripts/staging-audit.ts)

### Đường ghi và thời hạn lưu trong staging v36

Đối chiếu lúc **08:18 ngày 14/11/2026, giờ Việt Nam**, theo cấu hình snapshot v36 và hai receipt fault. Phần kiểm kê này bổ sung V16.1.1 và V16.2.2. [OWASP ASVS V16](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x25-V16-Security-Logging-and-Error-Handling.md) · [OWASP Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)

| Nguồn | Định dạng và đường ghi | Đọc, sử dụng và thời hạn |
| --- | --- | --- |
| Audit giao dịch AIO | PostgreSQL tại bốn nguồn BFF và D1 tại LMS. Collector đưa metadata đã giới hạn vào `audit_projection.events`, với thời điểm PostgreSQL kiểu `timestamptz`; LMS quy đổi từ epoch UTC. | Vai trò nguồn ghi audit cùng giao dịch. Collector đọc theo view hoặc binding, người phân tích đọc projection. Hai slot xác nhận prune 90 ngày trên projection. Kho nguồn đi theo vòng đời fixture. |
| Ingress BFF và workerd | Lỗi HTTP, từ chối và callback dùng metadata có request ID do nguồn sinh. Writer giữ bản chờ trong SQLite theo instance, chuyển qua TLS vào `audit_projection.infrastructure_events` rồi xóa mục khỏi hàng chờ sau khi đích nhận. | Mỗi writer chỉ INSERT cho nguồn của mình. Reader đối chiếu request đã phát lại đúng một lần ở mỗi slot. Prune projection sau 90 ngày. |
| Keycloak | Realm cấu hình lưu sự kiện người dùng 86.400 giây và tắt nội dung chi tiết của admin event. Collector đưa các hành động cho phép vào projection hạ tầng. | Keycloak giữ sự kiện gốc tại kho IdP và projection dùng vai trò đọc audit. Cần kiểm thời hạn thực tế của admin event riêng. |
| OpenBao | Audit file cục bộ của instance, NDJSON và tắt raw logging. Receipt chỉ giữ số lượng thao tác được phép, thời gian hoặc hash. | Giữ cùng thư mục diễn tập để chẩn đoán. Cần quyết định kỳ lưu, quyền đọc vận hành và chuyển tiếp vào kho phân tích. |
| Telemetry, cảnh báo và log vận hành | BFF phát JSON theo tiền tố `AIO_TELEMETRY`; collector nhận mẫu LMS qua binding và ghi NDJSON, timestamp epoch UTC, trace và mã request. Alert NDJSON lưu chuyển trạng thái của monitor. | Runner đọc theo run/slot để dựng dashboard và đối chiếu SLO, hàng đợi, lỗi. Tệp được giữ theo lượt thử. Cần xác minh quyền file thực tế trên Windows, kỳ lưu và bao phủ toàn bộ stderr. |

Fault profile ghi **52 sự kiện Keycloak, 35 callback khớp và 3 sự kiện phát lại đúng một lần ở mỗi slot**. Collector ghi 0 mẫu rơi. Hai slot dùng TLS 1.3 cho đường audit đã thử và chặn plaintext, CA sai. Đồng bộ giờ có thẩm quyền và vòng đời log ngoài projection vẫn mở. [Receipt fault v36](../.local/evidence/enterprise-e3-staging-faults-0371a378.json) · [Schema hạ tầng](../infrastructure/audit/002-staging-infrastructure-audit.sql) · [Writer](../src/staging-ingress-audit.ts) · [Collector telemetry](../scripts/staging-telemetry.ts)

Lượt bổ sung `5ece0519` đóng sự cố audit lúc **08:45:30 ở A** và **08:50:31 ở B**, ngày **14/11/2026, giờ Việt Nam**. Script tiếp nhận và chuyển việc đối soát cho vai trò `aio_audit_read`. Sau khởi động lại writer, reader thấy cả ba sự kiện của mỗi slot đúng một lần. Receipt đã đối chiếu hash, thứ tự tiếp nhận và đối soát ở cả hai slot. Bằng chứng người trực tiếp nhận qua kênh thông báo thực vẫn còn mở. [Đối chiếu hai slot](../.local/evidence/enterprise-e3-v36-supplemental-alerts-review.json)

Các ca trên cung cấp bằng chứng từng phần cho `16.1.1`, `16.2.1`, `16.2.3`–`16.2.5` và `16.4.2`. Cần chứng minh truyền audit an toàn giữa workload tách riêng, thu nhận sự kiện thất bại và che log tại các nguồn. Kiểm thử hiện dùng database cùng cụm trong từng slot. [ASVS V16](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x25-V16-Security-Logging-and-Error-Handling.md)

Lúc **17:35:12 ngày 14/11/2026, giờ Việt Nam**, biên bản hostname v39 xác minh cả hai slot nhận audit từ năm nguồn. Slot A tập trung 130 bản ghi và khớp 18 sự kiện nghiệp vụ theo request ID. Slot B tập trung 137 bản ghi và khớp 19 sự kiện. Mỗi slot khớp 35 callback, ghi 52 sự kiện Keycloak và chạy lại collector thêm 0 dòng. Thử retention 90 ngày dọn hai bản ghi giả lập mỗi slot ở hai bảng audit tập trung. Kiểm tiếp chuyển cấp, khôi phục writer và độ phủ log ngoài projection. [Biên bản audit v39](../.local/evidence/enterprise-e2-v39-audit-projection-41699e47-review.json)

Trên v40, đối chiếu hostname lúc **20:38:15 ngày 14/11/2026, giờ Việt Nam** xác nhận cả năm nguồn vào projection tại hai slot. Mỗi slot khớp 35 callback, thu lại thêm 0 dòng và kiểm retention 90 ngày. Lượt fault bổ sung kết thúc lúc **20:59:22**. Hai slot có receipt tiếp nhận và chuyển cấp do script ghi, sau đó mỗi slot xác nhận ba bản ghi đã phát lại bằng vai trò `aio_audit_read`. Phạm vi log OpenBao, stderr, quyền đọc thư mục và đồng bộ nguồn giờ tiếp tục mở. [Biên bản projection v40](../.local/evidence/enterprise-e2-v40-audit-projection-65c148f2-review.json) · [Diễn tập audit](../.local/evidence/enterprise-e3-v40-supplemental-alerts-916fc9f9-review.json)

Audit cũ có thể dùng idempotency key theo định dạng UUID. Định dạng của bản ghi cũ chưa đủ để xác nhận đó là request ID do máy chủ sinh. Receipt hiện đối soát các mutation mới qua header và hành động tại nguồn.

Lượt image ngày 12/11/2026 kết thúc lúc **23:02:41 giờ Việt Nam**. Mỗi slot thu 47 sự kiện, gồm Foundation 19, Forms 5, Quy trình 6, Công việc 6 và LMS 11. Kết quả lưu ở `.local/evidence/enterprise-e2-staging-audit-5eba7dd7.json`. Trivy ghi 0 HIGH/CRITICAL và 0 phát hiện secret cho cùng image.

Lượt xác nhận `e2-audit-v2` kết thúc lúc **23:10:58 ngày 12/11/2026, giờ Việt Nam**. Cả hai slot giữ kết quả 47 sự kiện, khớp request ID ở năm nguồn, replay thêm 0 dòng và retention dọn 1 dòng thử mỗi slot. Hồi quy local đạt **268/268**, gồm kiểm hai request ID đồng thời dùng chung idempotency key chỉ tạo một bản ghi audit LMS. Build, kiểm định dạng, kiểu dữ liệu, dependency audit và image gate đều đạt. Digest nguồn `5e50748ba0c5c1610e94919103bace8235420797459e10d05a7792d9acef15a1` khớp worktree khi đối chiếu trước khi tiếp tục E2. Digest gói `73487042b63eb334e4427479d03d557f1cc21e9febc2e8d0cc497d2f51a34419`, image `sha256:e456404a22e68e271747da229c15027307c0c8b3cc012e0a7ac45ae9b6a9b7ae`. Receipt `.local/evidence/enterprise-e2-staging-audit-86e7b074.json`, log `.local/evidence/enterprise-e2-audit-v2-unit.log`.

## Chạy lại

```powershell
$r = Get-Content -Raw .local/releases/e2-audit-v2/receipt.json | ConvertFrom-Json
$prior = Get-Content -Raw .local/releases/e1-staging-v1/receipt.json | ConvertFrom-Json
$image = Get-Content -Raw .local/releases/e2-audit-v2/image-f5db204e/receipt.json | ConvertFrom-Json
npm run test:staging -- e2-audit-v2 $r.artifactDigest e1-staging-v1 $prior.artifactDigest $image.imageDigest --audit
```

`--audit` chạy cả profile nghiệp vụ và LMS rồi tạo, đối soát kho audit của mỗi slot trước khi dọn môi trường. Có thể truyền receipt image và digest bản trước theo [hướng dẫn staging](ENTERPRISE_STAGING.md). Receipt dưới `.local/evidence/enterprise-e2-staging-audit-<id>.json` chỉ chứa số lượng, trạng thái, scope và digest.

## Connector nhân sự giả lập

Profile `--personnel` chọn nguồn giả lập phát snapshot trạng thái công tác. Payload gồm mã nguồn ổn định, revision nguyên tăng dần cho mỗi mã và trạng thái đang công tác. Fixture thiết lập liên kết tường minh với một employment và một account AIO trong home tenant của người đó. IAM tiếp tục sở hữu cặp issuer và subject. Role connector gọi một hàm có ràng buộc tên database, marker test và ID instance staging. Role thực thi bên trong hàm có quyền riêng theo cột và không có LOGIN. [Migration 011](../infrastructure/database/011-personnel-source.sql) · [Kịch bản kiểm chứng](../scripts/staging-personnel.ts)

Mốc revision mới cập nhật trạng thái nguồn và ghi audit trong cùng transaction. Gửi lại revision hiện hành với cùng trạng thái trả request ID cũ. Revision thấp hơn bị bỏ qua, còn trạng thái xung đột ở cùng revision được báo lại để đối soát. Sự kiện thôi việc dùng cơ chế khóa account hiện có, xóa phiên Foundation và tăng `auth_not_before`. Khi nguồn báo quay lại, IAM phải mở account bằng thao tác quản trị có revision và audit. Hồ sơ công tác, grants và liên kết SSO được đối chiếu trước và sau ca thử. Phép đo ghi riêng thời gian xử lý sự kiện và thời gian tới phản hồi từ chối đầu tiên của từng ứng dụng.

Migration 012 chỉ định rõ `public.sessions` cho trigger thu hồi. Connector đặt `search_path` giới hạn khi gọi hàm, nên trigger dùng tham chiếu đầy đủ để xóa phiên trong cùng giao dịch khóa. [Migration 012](../infrastructure/database/012-qualify-session-revocation.sql)

Mẫu tham khảo dùng định danh nguồn và đích riêng biệt. `externalId` trong SCIM cũng do miền provisioning cấp. Bài thử dùng snapshot giả lập, và quyết định SCIM phụ thuộc giao thức nguồn chủ thực tế. Các ca phiên của profile đóng góp bằng chứng cho `7.4.2` trong phạm vi năm ứng dụng. [Microsoft Entra Object Connection IDs](https://learn.microsoft.com/en-us/entra/identity/app-provisioning/object-connection-identifiers) · [RFC 7643 §3.1](https://www.rfc-editor.org/rfc/rfc7643.html#section-3.1) · [ASVS V7](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x16-V7-Session-Management.md)

Lệnh chạy `--personnel` dùng baseline `e2-audit-v2` để đối chiếu journal trước và sau khi thêm 011–012. Kịch bản cấp seed OTP riêng cho từng tài khoản giả lập và chờ sang chu kỳ kế tiếp khi đăng nhập lại trong cùng cửa sổ TOTP.

```powershell
$r = Get-Content -Raw .local/releases/e2-personnel-v7/receipt.json | ConvertFrom-Json
$prior = Get-Content -Raw .local/releases/e2-audit-v2/receipt.json | ConvertFrom-Json
$image = Get-Content -Raw .local/releases/e2-personnel-v7/image-b30c8d10/receipt.json | ConvertFrom-Json
npm run test:staging -- e2-personnel-v7 $r.artifactDigest e2-audit-v2 $prior.artifactDigest $image.imageDigest --personnel
```

Lượt `e2-personnel-v7` đạt lúc **23:57:56 ngày 12/11/2026, giờ Việt Nam**. Cả hai slot qua cùng artifact `25494bb07f67bda6f3a839f85679c86baf8e8582135a26173b04386990281851` và image `sha256:974c1a3698fcf09f0a7f6d8cacadd7c1dbecdeb689670f77dd4442e6594ad39c`. Trivy ghi 0 phát hiện chặn và 0 phát hiện secret. Source digest `7962971476e2662365593760776200a2968a728d59b91668f5c11ea7b3ea7486` khớp worktree. Gói v6 đã qua **268/268** bài kiểm thử local và toàn bộ 289 hash tệp payload trùng v7. Thay đổi v7 điều phối OTP trong runner staging. Receipt `.local/evidence/enterprise-e2-staging-personnel-dd8c99ed.json`, log hồi quy `.local/evidence/enterprise-e2-personnel-v6-unit.log`.

Connector xác nhận cặp gửi đồng thời trong **24 ms ở A** và **22 ms ở B**. Sau xác nhận, phản hồi từ chối đầu tiên đến trong **18–21 ms** ở Portal, Forms, Quy trình và Công việc (401), và **46 ms ở A**, **138 ms ở B** ở LMS (403). Mỗi slot xóa bốn phiên Foundation trong transaction. LMS xóa phiên khi nguồn từ chối request đầu tiên. Sau khi IAM mở lại, cả năm phiên cũ đều trả 401 và Portal yêu cầu xác thực lại qua giao diện khi dùng phiên SSO cũ. Đây là thời gian của hai ca thử trên staging.

Mỗi slot tập trung **57 sự kiện** và đối soát **9 sự kiện** theo request ID và hành động, gồm trạng thái nhân sự ở Foundation và `session.revoked` ở LMS. Thu lại thêm 0 dòng, retention dọn một dòng thử. Diễn tập rollback Foundation về `e2-audit-v2` giữ nguyên journal đã nâng tới 012, phiên quản trị và receipt nghiệp vụ đã ghi trước khi nâng cấp.

## Xoay khóa ký và truy cập khẩn cấp

Từ lượt `enterprise-rc-v3`, realm thử đặt chiều dài mật khẩu tối thiểu 15 ký tự, mã ủy quyền 60 giây và refresh rotation không tái dùng token cũ. Realm bật bảo vệ tạm thời sau đăng nhập lỗi với `failureFactor=8`, thời gian tăng 30 giây, tối đa 120 giây và cửa sổ đếm lỗi 900 giây. Runner kiểm cấu hình đọc lại từ Admin REST và modulus của khóa RSA công bố. Lượt **12:22:13 ngày 13/11/2026, giờ Việt Nam** xác nhận RSA từ 3072 bit trước/sau xoay khóa, MFA, thu hồi và backchannel trên hai slot. Chính sách từ cấm, kiểm mật khẩu rò rỉ và diễn tập lockout còn mở. [Receipt](../.local/evidence/enterprise-e5-staging-rollback-d61acd8e.json) · [Keycloak Server Administration Guide](https://www.keycloak.org/docs/latest/server_admin/) · [NIST SP 800-57 Part 1 Rev. 5](https://csrc.nist.gov/pubs/sp/800/57/pt1/r5/final)

Profile `--iam` mở rộng `--personnel`. Mỗi slot bật sự kiện Keycloak `LOGIN`, `LOGIN_ERROR` và admin audit với nội dung mutation tắt. Service account bootstrap chỉ dùng trong runner của slot để gọi Keycloak Admin REST qua TLS với CA của slot. Hai quản trị viên AIO đăng nhập trình duyệt với mật khẩu và seed OTP riêng. [Runner IAM](../scripts/staging-iam.ts) · [Keycloak bootstrap](https://www.keycloak.org/server/bootstrap-admin-recovery)

Runner tạo khóa RS256 mới ở trạng thái passive, tăng ưu tiên để Keycloak dùng khóa đó ký, kiểm tra cả hai khóa công khai trên JWKS, rồi thử phiên trước và sau khi chuyển khóa ở sáu client. Khi trở về khóa gốc, runner giữ khóa mới ở trạng thái passive để các phiên đã cấp tiếp tục được xác minh. [Keycloak Server Administration Guide](https://www.keycloak.org/docs/26.8.0/server_admin/#_rotating-keys)

Ca khẩn cấp mô phỏng quản trị chính mất quyền đăng nhập khi Keycloak còn phục vụ. Runner khóa đúng danh tính giả lập và kết thúc phiên tại IdP. Quản trị dự phòng đăng nhập MFA độc lập, thu hồi rồi cấp lại grant của nhân sự thử ở client Probe qua API có CSRF, revision và idempotency. Receipt đối chiếu đăng nhập và hai mutation theo request ID trong audit Foundation, đồng thời kiểm metadata đăng nhập và thao tác quản trị tại Keycloak. Sau diễn tập, runner mở lại danh tính chính và yêu cầu đăng nhập MFA mới. [Hướng dẫn tài khoản khẩn cấp Microsoft Entra](https://learn.microsoft.com/en-us/entra/identity/role-based-access-control/security-emergency-access) · [Keycloak Admin REST](https://www.keycloak.org/docs-api/26.8.1/rest-api/index.html)

```powershell
$r = Get-Content -Raw .local/releases/e2-iam-v1/receipt.json | ConvertFrom-Json
$prior = Get-Content -Raw .local/releases/e2-audit-v2/receipt.json | ConvertFrom-Json
$image = Get-Content -Raw .local/releases/e2-iam-v1/image-fed6a5e4/receipt.json | ConvertFrom-Json
npm run test:staging -- e2-iam-v1 $r.artifactDigest e2-audit-v2 $prior.artifactDigest $image.imageDigest --iam
```

Lượt `e2-iam-v1` đạt ở cả hai slot lúc **00:13:47 ngày 13/11/2026, giờ Việt Nam**. Artifact `b3b6f21adca23a2416e9924e474022856bf59125396f1fbfbe25773c8adea4cc`, image `sha256:f1a53c0005c0b525258f86208d804a53e5dd148bafef5b5a7cf3eb740e582310`. Trivy ghi 0 phát hiện chặn và 0 phát hiện secret. Source digest `4adf78c5d4059e4c33077a21268ee0f7d1961853c2fdd3ad4b1f17bab23dcb53` khớp worktree. Gói giữ 289 hash payload của `e2-personnel-v7`. Receipt `.local/evidence/enterprise-e2-staging-iam-fe873cee.json`.

Chuyển khóa và xác nhận hai public key trên JWKS mất **175 ms ở A** và **173 ms ở B**. Phiên trước và sau chuyển khóa đều qua API có xác thực ở Portal, Probe, Forms, Quy trình, Công việc và LMS. Cả hai nhóm phiên vẫn hoạt động sau khi đưa khóa mới về passive. Keycloak ghi ba thao tác xoay khóa mỗi slot.

Sau khi runner bắt đầu khóa quản trị chính và kết thúc phiên ở IdP, request kiểm đầu tiên nhận 401 trên cả sáu client trong **235–321 ms**. Quản trị dự phòng vào Foundation với MFA sau **3131 ms ở A** và **3466 ms ở B**, rồi thu hồi và cấp lại grant Probe có kiểm revision. Ba request ID của đăng nhập, thu hồi và cấp lại đều khớp actor dự phòng. Keycloak ghi đăng nhập dự phòng, từ chối đăng nhập của tài khoản bị khóa và ba thao tác trên danh tính chính. Sau khôi phục, các phiên cũ tiếp tục bị từ chối và quản trị chính đăng nhập lại bằng MFA.

Lượt `--iam` tập trung **81 sự kiện** từ năm nguồn ứng dụng và khớp **12 sự kiện** theo request ID mỗi slot. Runner đọc sự kiện Keycloak qua Admin REST và ghi kết quả kiểm vào receipt. Profile hạ tầng bên dưới bổ sung đường thu nhận riêng. [Ma trận UI/API](ENTERPRISE_ACCESS_MATRIX.md)

## Audit Keycloak và ingress

Lúc **19:34:34 ngày 13/11/2026, giờ Việt Nam**, hai slot v23 đối soát 18/19 sự kiện nghiệp vụ và 52 sự kiện Keycloak mỗi slot. Mỗi slot khớp một 401 và một 503 từ workerd, với sai lệch đồng hồ đối chiếu tối đa 58/81 ms. Role workerd chỉ ghi, mã request do nguồn tạo, thu lặp thêm 0 dòng và retention dọn một dòng thử mỗi slot. Runner cũng xác nhận RSA tối thiểu 3072 bit trước và sau xoay, backchannel và khôi phục quản trị với MFA mới. [Receipt v23](../.local/evidence/enterprise-e3-staging-faults-ce7496f1.json) · [Ma trận quyền](ENTERPRISE_ACCESS_MATRIX.md#profile-giao-diện)

Lúc **20:36:47 ngày 13/11/2026, giờ Việt Nam**, đối chiếu theo SHA-256 receipt v23 cho connector và audit. Sau khi connector xác nhận, lần gọi đầu tiên ở cả năm ứng dụng trả 401 hoặc 403, với chậm nhất 56 ms ở A và 40 ms ở B. Mỗi slot khớp 35 callback qua mã request và hai từ chối ingress. E2 còn cần diễn tập mất đường ghi audit và xác minh phân tích/cảnh báo từ kho tách biệt. [Receipt đối chiếu](../.local/evidence/enterprise-e2-v23-iam-audit-review.json) · [Sổ ASVS v23](../.local/evidence/enterprise-e2-asvs-ledger-c2f00d37/receipt.json)

Profile `--infra-audit` thêm bảng sự kiện hạ tầng vào database audit của slot, giữ nguyên schema giao dịch đã dùng trong `--iam`. Ingress BFF trong image gửi sự kiện callback, 401/403, lỗi 5xx và yêu cầu bị ingress từ chối. Bản ghi gồm thời gian, mã client, lớp sự kiện, HTTP status và request ID do máy chủ cấp. Profile kiểm quyền ghi theo nguồn, từ chối request ID do client cung cấp và đối chiếu callback thành công với `auth.login` của Foundation. [Schema audit hạ tầng](../infrastructure/audit/002-staging-infrastructure-audit.sql) · [Ingress staging](../scripts/staging.ts)

View trong kho IdP ghim theo schema sự kiện Keycloak 26.8.2 và tên realm của slot. Collector đọc `LOGIN`, `LOGIN_ERROR` và thao tác quản trị khóa/tài khoản theo danh mục cho phép. Projection dùng ID sự kiện để thu lại an toàn. Tên đăng nhập, địa chỉ IP, URL, query, cookie, chi tiết và representation nằm ngoài danh mục trường của kho phân tích. [Keycloak EventEntity](https://github.com/keycloak/keycloak/blob/26.8.2/model/jpa/src/main/java/org/keycloak/events/jpa/EventEntity.java) · [Keycloak AdminEventEntity](https://github.com/keycloak/keycloak/blob/26.8.2/model/jpa/src/main/java/org/keycloak/events/jpa/AdminEventEntity.java)

Các role audit dùng TLS có CA của slot và xác minh máy chủ. HBA từ chối kết nối plaintext cho ingress writer, collector, reader và retention role. Ingress writer chỉ INSERT nguồn ingress. Collector đọc view nguồn và chỉ INSERT trong projection. Reader đọc, còn retention role chỉ gọi hàm dọn bản ghi quá 90 ngày. Database audit có tên và quyền CONNECT riêng trong cụm PostgreSQL staging. [PostgreSQL TLS](https://www.postgresql.org/docs/17/ssl-tcp.html) · [Cấu hình HBA](../infrastructure/audit/staging-pg-hba.conf)

Chạy tuần tự cùng các profile staging khác để giữ cổng và dữ liệu từng slot độc lập. Profile cần image đã qua gate và dùng artifact trước để kiểm nâng schema rồi rollback Foundation.

```powershell
$r = Get-Content -Raw .local/releases/e2-infra-audit-v2/receipt.json | ConvertFrom-Json
$prior = Get-Content -Raw .local/releases/e2-audit-v2/receipt.json | ConvertFrom-Json
$image = Get-Content -Raw .local/releases/e2-infra-audit-v2/image-e170cf06/receipt.json | ConvertFrom-Json
npm run test:staging -- e2-infra-audit-v2 $r.artifactDigest e2-audit-v2 $prior.artifactDigest $image.imageDigest --infra-audit
```

LMS Worker tiếp tục góp sự kiện nghiệp vụ qua D1. Đường ingress workerd, đồng bộ đồng hồ giữa các tiến trình, kiểm cảnh báo khi giao nhận lỗi và kiểm độ phủ log theo ASVS vẫn cần các ca riêng.

V15 thêm service binding từ workerd đến writer TLS có quyền INSERT cho nguồn `workerd` và chỉ cho app LMS. Runner dùng phản hồi 401 và mô phỏng D1 sai marker để quan sát 503 rồi khôi phục marker. Kiểm request ID sinh ở nguồn, từ chối role ghi sai nguồn và đo chênh lệch thời gian sự kiện đến khi database nhận. Cần chạy profile để xác nhận các kiểm này. Cảnh báo mất bản ghi và kiểm đồng bộ toàn topology vẫn thuộc E2/E3. [Cấu hình audit bổ sung](../infrastructure/audit/003-staging-workerd-audit.sql) · [Runner kiểm audit](../scripts/staging-infrastructure-audit.ts)

Lúc **16:11:24 ngày 13/11/2026, giờ Việt Nam**, PostgreSQL 17.11 trong cụm thử mới áp dụng đủ ba tệp schema audit từ artifact v15. Kiểm role workerd ghi được 503 của LMS, bị từ chối SELECT và ghi chéo nguồn, còn ingress bị từ chối ghi nguồn workerd. Ca thành phần chưa chạy qua TLS và service binding. [Receipt PostgreSQL](../.local/enterprise-audit-sql-smoke-59f7b5d1/receipt.json)

Lượt `e2-infra-audit-v2` đạt cả hai slot lúc **00:36:44 ngày 13/11/2026, giờ Việt Nam**. Artifact `d8ccd5c43a33a8fe2ea3fc4406fe049bdd77756fa02fcfa0f232f92c300f47ef`, image `sha256:1ddf26bba1764b814d09be523a5e9716535f8ae54158da07a78de681e712e6a9`. Trivy ghi 0 phát hiện chặn và 0 phát hiện secret. Bản v1 qua **268/268** bài kiểm thử local. Toàn bộ 292 SHA-256 payload trùng với v2. V2 chỉnh phép thử TLS để HTTP Host sai đi tới ingress và giới hạn thao tác component ở các provider khóa của Keycloak. Receipt `.local/evidence/enterprise-e2-staging-infra-audit-d0e73835.json`, log hồi quy `.local/evidence/enterprise-e2-infra-audit-v1-unit.log`.

Mỗi slot ghi **44 sự kiện Keycloak** và **71 sự kiện ingress BFF**, bên cạnh 81 sự kiện ứng dụng. Có 29 callback khớp `auth.login` của Foundation, gồm phiên quản trị dự phòng, và hai request ID khớp ca 401 tại backend và 400 tại ingress. ID do client gửi vắng mặt trong projection. Đọc lại nguồn Keycloak thêm 0 dòng. Hàm retention dọn đúng một dòng thử quá hạn và chạy lại dọn 0 dòng. Kết nối PostgreSQL kiểm tra dùng **TLS 1.3**, và probe xác nhận từ chối plaintext và CA không tin cậy. Rollback Foundation giữ journal qua 012.

Lúc **17:20:12 ngày 13/11/2026, giờ Việt Nam**, hai slot v19 đối chiếu 35 callback Foundation mỗi slot và 52 sự kiện Keycloak mỗi slot. Workerd ghi khớp request ID nguồn của ca 401 và ca 503, với chênh thời gian từ sự kiện đến lúc nhận tối đa **49 ms ở A** và **42 ms ở B**. Profile xác nhận role workerd chỉ ghi được nguồn của mình. Sau khi connector xác nhận thay đổi nhân sự, request kế tiếp bị từ chối ở cả năm ứng dụng, trong khoảng **11–54 ms**. Quyền, quan hệ nhân sự và dấu vết IAM được giữ qua tái kích hoạt có phê duyệt. [Receipt v19 hai slot](../.local/evidence/enterprise-e3-staging-telemetry-21d952ff.json)

### Gián đoạn chuyển tiếp audit staging

V29 ghi metadata ingress và workerd vào hai hàng đợi SQLite cục bộ theo instance và nguồn trước khi chuyển tới PostgreSQL qua TLS. Mỗi sự kiện giữ cùng ID khi thử lại. Writer chỉ xóa dòng khỏi hàng đợi sau khi kho đích xác nhận ghi hoặc đã có dòng cùng khóa. Mỗi hàng đợi giới hạn 4.096 sự kiện. Sự kiện bị từ chối khi hàng đợi đầy hoặc lỗi ghi có số đếm riêng. Audit giao dịch nghiệp vụ tiếp tục thuộc kho của từng ứng dụng. [Mã writer](../src/staging-ingress-audit.ts) · [Mẫu hàng đợi bền vững OpenTelemetry](https://opentelemetry.io/docs/collector/resiliency/)

Khi thấy `AIO_AUDIT_DELIVERY <nguồn> firing`, kiểm kết nối TLS, tình trạng bảng đích và dung lượng ổ chứa hàng đợi của slot. Giữ thư mục hàng đợi cùng instance khi khởi động lại writer. Dùng vai trò `aio_audit_read` đối chiếu request ID với bản ghi đã nhận và kiểm tín hiệu `resolved` khi writer đang chạy gửi lại thành công. Khi writer khởi động mới sau gián đoạn, dùng kết quả đối soát request ID để xác nhận phát lại. Fault profile v29 giữ khóa bảng đích qua lần dừng writer rồi kiểm không có dòng trước khi khởi động lại và đúng một dòng cho mỗi request sau phát lại. Ca thành phần đã kiểm writer ingress. Kho phân tích vẫn là database riêng trong cùng cụm staging. [Receipt thành phần](../.local/evidence/enterprise-v29-audit-spool-component.json) · [Biên bản v29](ENTERPRISE_READINESS_AUDIT.md#phục-hồi-openbao-và-chuyển-tiếp-audit-trên-snapshot-v29)

Lúc **01:06:09 ngày 14/11/2026, giờ Việt Nam**, ca thành phần áp dụng ba tệp SQL audit trong artifact v34 lên cụm PostgreSQL 17.11 cô lập. Role ứng dụng bị chặn kết nối kho audit, writer được ghi nhưng không đọc bảng, reader không sửa, xóa hoặc chạy retention. Với năm sự kiện giả lập, truy vấn theo cửa sổ năm phút đối chiếu đúng bốn lần từ chối và bốn mã request thuộc Foundation và Quy trình. Gửi lại một sự kiện thêm 0 dòng. V16.4.3 còn cần bằng chứng TLS và đường cảnh báo, tiếp nhận, chuyển cấp trên staging v34. [Receipt phân tích audit](../.local/evidence/enterprise-e2-v34-audit-reader-component.json) · [ASVS mức 2](ENTERPRISE_ASVS_5_LEVEL_2.md)

Lúc **03:13:44 ngày 14/11/2026, giờ Việt Nam**, đối chiếu fault profile v34 xác nhận hai slot chuyển audit qua TLS 1.3, từ chối plaintext và CA sai, đối chiếu 35 callback và thu 52 sự kiện Keycloak mỗi slot. Role đọc xác nhận ba sự kiện mỗi slot được phát lại đúng một lần sau khi writer khởi động lại. Chênh lệch lớn nhất giữa thời điểm workerd ghi sự kiện và thời điểm kho nhận là **481 ms ở A** và **438 ms ở B**, gồm cả thời gian chuyển tiếp. Kiểm đồng bộ nguồn giờ và diễn tập tiếp nhận, chuyển cấp cảnh báo vẫn mở. [Receipt audit v34](../.local/evidence/enterprise-e2-v34-audit-transport-review.json) · [Runbook cảnh báo](ENTERPRISE_TELEMETRY.md#xử-lý-cảnh-báo)

Lúc **04:18:49 ngày 14/11/2026, giờ Việt Nam**, cả hai slot qua diễn tập gián đoạn audit có script tiếp nhận và chuyển cấp. Kho đích chưa có ba sự kiện khi mở biên nhận. Sau khi hai writer khởi động lại, mỗi sự kiện hiện đúng một lần trong truy vấn dưới vai trò `aio_audit_read`. Bằng chứng bổ sung cho V16.4.3 áp dụng cho chuyển tiếp ingress và workerd đã chạy. Cần đối chiếu tiếp phạm vi các nguồn audit còn lại và việc tiếp nhận của người trực. [Biên bản diễn tập](../.local/evidence/enterprise-e3-v34-audit-incident-review.json) · [ASVS V16](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x25-V16-Security-Logging-and-Error-Handling.md)

Lúc **04:28:04 ở A** và **04:31:54 ở B**, ngày **14/11/2026, giờ Việt Nam**, bộ quan sát đọc đồng hồ Node của BFF, đồng hồ container Keycloak, `clock_timestamp()` của PostgreSQL và thời điểm phát telemetry tại workerd. Mỗi nguồn có ba mẫu kẹp giữa hai lần đọc UTC của Windows. Khoảng giao của ba mẫu cho workerd là **−7 đến +37 ms ở A** và **−7 đến +40 ms ở B**. Windows Time đang dừng ở hai lần đo. V16.2.2 vẫn cần bằng chứng về nguồn đồng bộ có thẩm quyền và định dạng giờ của toàn bộ nguồn log. [Biên bản đồng hồ](../.local/evidence/enterprise-e2-v34-clock-review.json) · [Microsoft Windows Time for Traceability](https://learn.microsoft.com/en-us/windows-server/networking/windows-time-service/windows-time-for-traceability)

Lúc **11:43:57 ngày 14/11/2026, giờ Việt Nam**, lượt fault v38 r2 đối soát 18 sự kiện nghiệp vụ ở A và 19 ở B trên năm nguồn. Mỗi slot nối 35 callback, thu 52 sự kiện Keycloak và phát lại đúng ba sự kiện audit qua vai trò `aio_audit_read`. Projection giữ cửa sổ 90 ngày, dọn một dòng quá hạn mỗi slot và không thêm dòng khi thu lặp. Đường ghi kiểm được dùng TLS 1.3 và từ chối plaintext hoặc CA sai. [Biên bản quyền và audit v38 r2](../.local/evidence/enterprise-e2-v38-r2-access-audit-review.json)
