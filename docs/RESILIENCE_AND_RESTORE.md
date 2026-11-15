# Diễn tập lỗi dịch vụ và khôi phục local

Ngày 10/11/2026. Chỉ dành cho project Docker tlqm-aio-local và dữ liệu giả lập. Không dùng các script dưới đây với database/IdP của dự án cũ hoặc production.

## Kiểm tra môi trường trước thao tác

scripts/local-docker.ts từ chối DOCKER_HOST/DOCKER_CONTEXT override, yêu cầu context desktop-linux dùng named pipe local, kiểm tra đúng một container theo project/service, tên, image pin và host binding loopback. Chỉ stop/start container đã xác minh; không xóa container/volume. Script rehearsal tự mở các API A/B/C nên phải dừng API dev trước khi chạy.

## IdP/DB outage, logout và key rotation

```powershell
npm run test:resilience
```

Các kịch bản đã chạy thật:

- Logout token do Keycloak ký thu hồi A/B/C. Replay cùng token không lặp audit và không hủy phiên mới; token sai client hoặc sửa chữ ký bị từ chối.
- Dừng Foundation PostgreSQL: /health/live vẫn 200, /health/ready và request cần DB trả DATABASE_UNAVAILABLE 503. Pool mất kết nối không làm chết API. Mutation trong outage không tạo record/audit/receipt; retry cùng key sau phục hồi tạo đúng một hiệu ứng.
- Dừng Keycloak: cả verifier đã cache và verifier chưa có JWKS trả IDENTITY_UNAVAILABLE 503; không dùng quyền cũ để cho truy cập và không xóa phiên chỉ vì lỗi phụ thuộc. Sau restart, phiên hợp lệ tiếp tục hoạt động trong lần diễn tập.
- Tạo khóa RSA mới tại IdP sau khi API cache đã ấm, chuyển khóa ký RS256, kiểm tra token khóa cũ/mới và audience isolation mà không restart API. Trả khóa thử về passive và giữ public key để xác minh token đã phát hành. Khóa gốc không bị sửa/xóa; private key không được đọc/xuất.
- Gia hạn phiên MFA vẫn giữ pwd/otp và auth_time đã xác minh.

OIDC token exchange sử dụng verification context mới với discovery metadata pinned; giữ PKCE/state/nonce, signature và non-repudiation checks. JWKS access-token verifier được cập nhật sau grant. Việc này tránh kế thừa cache ID-token cũ khi một khóa mới xuất hiện, không phải bỏ kiểm tra chữ ký. Tham khảo cơ chế khóa [Keycloak server administration](https://www.keycloak.org/docs/latest/server_admin/index.html#_realm_keys).

Script giữ receipt của từng component thử trong .local/rotation-fixtures. Component được trả passive trong finally; không xóa khóa gốc hoặc khóa public cần cho token còn hạn. Đây là fixture local, chưa phải lịch rotation/retention production. Nếu script bị ngắt cưỡng bức, đối chiếu receipt và metadata /keys trước thao tác khôi phục; không đoán component ID.

Báo cáo .local/evidence/resilience.json ghi lần thành công 2026-11-09T17:25:13Z: back-channel revocation 292 ms, database recovery 977 ms, IdP recovery 6.708 ms. Đây là thời gian trong điều kiện local của lượt đo, không phải SLA.

## Backup/restore vào target riêng

```powershell
npm run test:restore
```

Script từ chối chạy khi cổng API còn mở; kiểm tra source host 127.0.0.1:5438, database aio_foundation, owner aio_foundation và marker tlqm-aio-local. Mở transaction REPEATABLE READ READ ONLY và export snapshot, pg_dump dùng chính snapshot đó. Dump custom format chỉ được stream vào .local/backups, không in hoặc gửi ra ngoài.

Target mới có tên aio_foundation_restore_YYYYMMDD_<suffix>, phải chưa tồn tại; không nhận target arbitrary, không ghi đè DB hiện tại. Chỉ restore bằng owner, --single-transaction/--exit-on-error/--no-owner/--no-privileges, thu hồi CONNECT của PUBLIC. Marker riêng nằm ở schema aio_restore_guard và chứa instance/source/target.

Sau restore, script đối chiếu:

- Số dòng và SHA-256 nội dung chuẩn hóa của từng bảng public, gồm audit.
- Migration version/checksum và giá trị sequence.
- Owner table/sequence là aio_foundation; aio_runtime không có CONNECT vào target restore.
- Transaction smoke insert/rollback và trigger audit append-only vẫn hoạt động.
- Fingerprint source và runtime.json không thay đổi.

Lượt đã kiểm chứng: aio_foundation_restore_20261109_4cb19c8f, 27 bảng, 41 audit rows, archive 86.859 bytes; dump 415 ms, restore 429 ms. Source/config giữ nguyên. Báo cáo .local/evidence/restore.json và receipt cạnh archive; không mở/in nội dung dump để báo cáo.

Target/backup được giữ để review. Script không có bước xóa DB hoặc volume, không trỏ API sang restore target và không cấp runtime quyền vào target. Đưa dữ liệu restore vào hệ thống đang dùng là thao tác khác, chưa được thực hiện.

## E3 · Diễn tập phục hồi thành phần PostgreSQL

Lần đo ngày 13/11/2026 dùng Windows, Node 24.20.0 và PostgreSQL 17.11 bản native. Runner tạo hai cụm PostgreSQL mới với cổng động, bind `127.0.0.1`, xác thực SCRAM và marker riêng theo lần chạy. Runner xác minh manifest của artifact trước khi khởi tạo cụm và dùng migration SQL từ artifact. Các role của ứng dụng và audit được kiểm tra bằng `SET ROLE` và quyền `CONNECT`. Chạy từ gốc workspace AIO bằng PostgreSQL 17 đã cài trên máy.

```powershell
$release = 'e2-token-types-v1'
$build = Get-Content -Raw ".local/releases/$release/receipt.json" | ConvertFrom-Json
& node_modules/.bin/tsx.cmd scripts/enterprise-recovery-postgres.ts $release $build.artifactDigest 'C:/Program Files/PostgreSQL/17/bin'
```

1. Nạp fixture giả lập vào Foundation, Forms, Quy trình, Công việc và kho phân tích audit. Tất cả writer là thao tác của runner và dừng trước lúc ghi mốc checkpoint. Mỗi kho xuất snapshot riêng bằng `pg_export_snapshot()` trong transaction chỉ đọc và truyền snapshot đó cho `pg_dump`. Việc dừng writer cho phép năm dump biểu diễn cùng mốc nghiệp vụ dù PostgreSQL chỉ đồng bộ snapshot trong từng database. [PostgreSQL 17 · pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html)
2. Commit một sự kiện giả lập sau checkpoint rồi dừng cụm nguồn. Khởi tạo cụm đích độc lập, tạo database trống cùng owner và role đã biết, kiểm SHA-256 của từng archive trước khi chạy `pg_restore --single-transaction`. Duy trì ownership và ACL đối tượng từ dump. Chỉ sử dụng archive do chính lượt thử tạo ra. [PostgreSQL 17 · pg_restore](https://www.postgresql.org/docs/17/app-pgrestore.html)
3. Đối chiếu hash và số dòng từng bảng, journal migration và sequence. Kiểm issuer + subject và grant Foundation, membership Công việc, phiếu Forms ghim bản 1 cùng receipt, lượt Quy trình ghim bản 1 cùng checksum tệp và job intake đang chờ. Đối soát một request ID tại bốn nguồn và kho audit. Kiểm journal và audit từ chối sửa bằng role runtime, đồng thời xác nhận sự kiện phát sinh sau checkpoint vắng mặt ở đích.

RPO thành phần đo từ lúc chốt checkpoint đến thời điểm bắt đầu sự cố giả lập. RTO thành phần đo từ thời điểm đó tới khi hoàn tất đối soát trong cụm mới, gồm thời gian dừng nguồn, khởi tạo đích và khôi phục. Biên bản ghi timestamp UTC và giờ Việt Nam, SHA-256 của artifact, hai tệp runner và từng archive. Runner dừng cả hai cụm khi kết thúc. Biên bản `receipt.json` và bản đối chiếu `checkpoint.json` nằm trong `.local/enterprise-recovery/<run>`. Archive và dữ liệu cụm giữ trong thư mục local của lượt diễn tập.

Lượt `3540e2f1-83cd-4d86-9d93-ef6995b481ae` đạt lúc **07:52:40 ngày 13/11/2026, giờ Việt Nam**. Đóng gói năm dump mất 1,729 giây, RPO **1,758 giây**, RTO **21,128 giây**. Tổng cộng đối chiếu 110 bảng và 5 sequence. Dữ liệu đo lấy từ migration trong `e2-token-types-v1`, artifact SHA-256 `58939c701afbfa2fe4380e175485fced924245c5054b64cf49164ce67da80153`. Hai script được chạy từ worktree dirty `feat/foundation-mvp`, HEAD `abea705b0937fe164fa9c983700089bec88c82ba`.

### Checkpoint chung với LMS và phát lại hàng đợi Quy trình

Thêm `--with-lms` sau đường dẫn bộ công cụ PostgreSQL để đưa D1/R2 của LMS vào cùng lượt diễn tập. Worker chạy từ bundle trong artifact bằng workerd, bind cổng loopback động và dùng thư mục lưu trữ riêng cho từng lượt. Adapter outbound chỉ trả metadata discovery giả lập, còn các request đi ra khác bị từ chối. Cấu hình và khóa thử sinh trong bộ nhớ. Worker nguồn đóng trước checkpoint, rồi runner sao lưu file D1/R2 cùng năm dump PostgreSQL. Đích kiểm tập tệp và SHA-256 trước khi mở Worker từ bản sao. [Miniflare D1](https://developers.cloudflare.com/workers/testing/miniflare/storage/d1/) · [Miniflare R2](https://developers.cloudflare.com/workers/testing/miniflare/storage/r2/)

Fixture có đề nghị đào tạo đã được Worker nhận qua hợp đồng nội bộ có chữ ký, trong khi job nguồn vẫn `queued`. Tại đích, runner đối soát đề nghị, audit, tiến độ, bài thi, chứng chỉ ghim bản 1 và nội dung media dù khóa học đã phát hành bản 2. Lần phát lại đầu mô phỏng mất xác nhận sau khi Worker trả thành công. Runner xác nhận lịch backoff 30 giây và đóng pool của worker. Hai worker dùng pool mới cùng thử job khi đến hạn. Cơ chế claim chỉ cho một worker gửi lại. Runner đối chiếu journal `retry → done` và xác nhận một đề nghị, một sự kiện audit tại LMS. Bước cuối áp dụng chính sách restore của LMS để vô hiệu hóa adapter và mapping, xóa phiên/giao dịch đăng nhập, rồi kiểm API từ chối truy cập.

Lượt `f576b79f-d284-4f98-82e5-54afbe2ad1d9` đạt lúc **08:01:43 ngày 13/11/2026, giờ Việt Nam** trên artifact `e2-token-types-v1`. RPO **1,799 giây**, RTO **50,371 giây**, gồm 30 giây backoff. Đối chiếu 110 bảng PostgreSQL, 23 bảng nghiệp vụ D1, journal LMS 001–010 và SHA-256 của một object R2. `checkpoint.json` ghi hash của 13 tệp D1/R2 và năm dump PostgreSQL. `receipt.json` ghi digest artifact và bốn tệp runner. Cụm PostgreSQL và Worker được dừng sau diễn tập.

Phép đo profile này kết thúc khi PostgreSQL và LMS đã được đối soát, job đã hoàn tất và LMS ở trạng thái cách ly. RTO toàn E3 cần phục hồi Keycloak, đăng nhập mới, kiểm quyền và thao tác nghiệp vụ sau khi mở đích. Cổng E3 cũng cần kết quả telemetry, cảnh báo, lỗi phụ thuộc và đo tải theo roadmap. [Điều kiện E3](../roadmap/GOAL_ENTERPRISE_READINESS.md#mốc-triển-khai)

Lúc **12:48:28 ngày 13/11/2026, giờ Việt Nam**, `enterprise-rc-v5` qua profile thành phần trên SHA-256 `ae4afb431488ceaf79be03b68314cb2700872c4283d332c4c6a73ca6ef1fe54e`. RPO **2,075 giây**, RTO **62,092 giây** gồm 30 giây backoff. Kiểm giữ phiên bản khóa, bài thi, chứng chỉ và media. Sau restart, hai worker cùng nhận việc và có một lượt gửi. Receipt thuộc profile thành phần. [Receipt v5](../.local/enterprise-recovery/8552ba99-1eae-416c-b661-e195acf17798/receipt.json)

## E3 · Phục hồi staging gồm Keycloak

Lúc **13:28:15 ngày 13/11/2026, giờ Việt Nam**, slot A của v5 trên PostgreSQL 17.12 phục hồi sáu database, gồm Keycloak và kho audit, cùng D1/R2 sang đích mới. RPO **15,420 giây**, RTO **73,360 giây**. Runner đối chiếu hai object media, xác nhận marker tạo sau checkpoint vắng mặt và đăng nhập MFA mới để kiểm quyền ở cả năm ứng dụng. Bốn cảnh báo mẫu hàng đợi quá hạn chuyển `firing` khi dừng workload và `resolved` sau khởi động lại. [Receipt slot A](../.local/evidence/enterprise-e3-staging-recovery-e1e16512-a.json) · [Log cảnh báo slot A](../.local/evidence/enterprise-e3-alerts-e1e16512-a.ndjson)

Slot B đạt lúc **13:32:58 ngày 13/11/2026, giờ Việt Nam**, với RPO **12,231 giây** và RTO **65,150 giây**. Runner đối soát cùng các kho, hai object media và quyền sau MFA mới. Hai slot kết thúc lúc **13:33:44** trên cùng digest ứng viên và hạ tầng. Cần bổ sung bằng chứng cảnh báo SLO khi lỗi từng phụ thuộc và chuyển replica. [Receipt slot B](../.local/evidence/enterprise-e3-staging-recovery-e1e16512-b.json) · [Receipt hai slot](../.local/evidence/enterprise-e3-staging-recovery-e1e16512.json)

Profile `--recover` dừng các writer AIO và Keycloak của slot, rồi chốt một checkpoint cho sáu database và D1/R2. Runner xác minh digest của archive, dựng PostgreSQL mới với bootstrap role riêng, phục hồi role và database, đối chiếu dữ liệu và owner theo bảng rồi khởi động lại IdP từ database đã phục hồi. Đích tiếp quản cùng địa chỉ staging của slot để giữ issuer và redirect đã đăng ký. Runner mở phiên MFA mới, đọc dữ liệu được cấp quyền ở năm ứng dụng và kiểm lại phiên bản bài thi cùng hash media. [Runner](../scripts/staging-recovery.ts) · [PostgreSQL pg_restore](https://www.postgresql.org/docs/17/app-pgrestore.html)

V29 thêm snapshot Raft của OpenBao vào checkpoint sau khi dừng writer. Runner dừng tiến trình nguồn, phục hồi vào kho mới cùng cổng loopback và cấu hình audit, mở kho bằng hai phần khóa của nguồn, kiểm bốn AppRole, từ chối token bootstrap của đích và kiểm marker sau checkpoint vắng mặt. PostgreSQL, Keycloak, BFF và LMS lấy lại bí mật trước khi mở dịch vụ ở đích. Receipt lưu SHA-256 và kích thước snapshot, tên workload và số đo toàn chuỗi. Snapshot thử giữ trong bộ nhớ. [Kiểm thành phần OpenBao v29](../.local/evidence/enterprise-v29-openbao-store-component.json) · [Đối chiếu ứng viên](ENTERPRISE_READINESS_AUDIT.md#phục-hồi-openbao-và-chuyển-tiếp-audit-trên-snapshot-v29) · [OpenBao Raft](https://openbao.org/docs/commands/operator/raft/)

```powershell
$r = Get-Content -Raw .local/releases/e2-transport-v4/receipt.json | ConvertFrom-Json
$i = Get-Content -Raw .local/releases/e2-transport-v4/image-a8dceb85/receipt.json | ConvertFrom-Json
npm run test:staging -- e2-transport-v4 $r.artifactDigest $i.imageDigest --infra-audit --telemetry --recover
```

Lúc **10:50:13 ngày 13/11/2026, giờ Việt Nam**, cả hai slot qua ca này trên `e2-transport-v4`. Mỗi slot đối chiếu 212 bảng, gồm 101 bảng IdP, và 14 tệp D1/R2. Marker ghi sau checkpoint vắng mặt ở đích. RPO/RTO của A là **4,325 giây / 52,248 giây** và của B là **8,716 giây / 44,785 giây**. RPO đo từ lúc dừng writer để chốt checkpoint đến lúc tuyên bố sự cố. RTO kết thúc sau MFA mới và các lần đọc hợp lệ trên đích. Các ca retry hai worker và cảnh báo nằm ở các receipt riêng. [Receipt hai slot](../.local/evidence/enterprise-e3-staging-recovery-3833419e.json)

Lúc **15:37:51 ngày 13/11/2026, giờ Việt Nam**, `enterprise-rc-v13-staging` qua phục hồi cả hai slot với PostgreSQL và Keycloak theo digest đã quét. RPO/RTO slot A **3,431 / 31,249 giây**, slot B **3,546 / 29,614 giây**. Mỗi slot phục hồi sáu database và 14 tệp trong checkpoint D1/R2, xác minh hai đối tượng media, đăng nhập lại bằng MFA và đọc được dữ liệu ở năm ứng dụng. Sự kiện tạo sau checkpoint vắng mặt ở đích. Lượt này ghi 0 chuyển trạng thái cảnh báo. [Receipt tổng hợp](../.local/evidence/enterprise-e3-staging-recovery-d67c523e.json)

Lúc **17:30:15 ngày 13/11/2026, giờ Việt Nam**, v19 qua diễn tập thành phần PostgreSQL, D1 và R2. Worker đã ghi đích LMS trước khi mô phỏng mất xác nhận giao nhận. Sau backoff **30 giây**, hai worker cạnh tranh khi khởi động lại và chỉ một worker xử lý. Lịch sử ghi `retry` → `done`, đích giữ một bản ghi và một audit. Ca này dùng mô phỏng OIDC discovery. RPO/RTO **2,640 / 58,667 giây** thuộc ca thành phần, gồm thời gian đợi retry. [Receipt worker restart v19](../.local/evidence/enterprise-rc-v19-workflow-restart.json)

Lúc **17:33:32 ngày 13/11/2026, giờ Việt Nam**, cả hai slot v19 qua phục hồi phối hợp bằng đúng artifact, image và runner của lượt rollback v19. RPO/RTO là **6,102 / 46,353 giây** ở A và **3,826 / 38,868 giây** ở B. Mỗi slot phục hồi sáu database, 14 tệp checkpoint D1/R2 và hai đối tượng media. Runner xác nhận marker phát sinh sau checkpoint vắng mặt ở đích, MFA mới và quyền đọc tại năm ứng dụng. Lượt này ghi 0 chuyển trạng thái cảnh báo. [Receipt hai slot v19](../.local/evidence/enterprise-e3-staging-recovery-8c7c4501.json)

Lúc **19:53:26 ngày 13/11/2026, giờ Việt Nam**, v23 qua phục hồi phối hợp ở cả hai slot trên cùng digest với profile chèn lỗi và rollback. RPO/RTO **3,850 / 32,795 giây** ở A và **3,424 / 33,824 giây** ở B. Mỗi slot xác minh sáu database, checkpoint D1/R2, hai media, đăng nhập MFA mới và đọc có quyền ở năm ứng dụng. Hai log cảnh báo của profile phục hồi trống. Các cảnh báo lỗi phụ thuộc và hàng đợi được kiểm trong fault profile riêng. [Receipt phục hồi v23](../.local/evidence/enterprise-e3-staging-recovery-12c1034b.json) · [Fault profile](../.local/evidence/enterprise-e3-staging-faults-ce7496f1.json)

Lúc **01:36:02 ngày 14/11/2026, giờ Việt Nam**, v34 hoàn tất phục hồi phối hợp ở cả hai slot. RPO/RTO là **3,895 / 72,423 giây** ở A và **5,333 / 61,823 giây** ở B. Mỗi slot đối chiếu **212 bảng** trong sáu database, **14 tệp D1/R2** và checksum của **hai media**. Lượt phục hồi giữ đúng phiên bản và điểm bài làm LMS, loại marker sau checkpoint, rồi đăng nhập MFA mới và kiểm quyền đọc tại cả năm ứng dụng. OpenBao đích dùng kho mới và binary khớp manifest, từ chối token bootstrap đích và đọc lại được bốn AppRole. Bộ đếm của toàn profile ghi **3 lượt khởi động lại OpenBao để thử đọc ở A** và **1 lượt ở B**. [Receipt phục hồi v34](../.local/evidence/enterprise-e3-staging-recovery-99f870fd.json) · [Slot A](../.local/evidence/enterprise-e3-staging-recovery-99f870fd-a.json) · [Slot B](../.local/evidence/enterprise-e3-staging-recovery-99f870fd-b.json)

Lúc **07:12:51 ngày 14/11/2026, giờ Việt Nam**, lần phục hồi v36 dừng ở slot A sau khi thao tác phục hồi Raft có phản hồi. Cả sáu lần mở wrapper được đối soát, còn hai trong sáu yêu cầu AppRole login thiếu phản hồi. Lượt rollback v36 sau đó cũng dừng ở bước cấp bí mật ban đầu, với hai yêu cầu AppRole login không có phản hồi dù hai lượt mở wrapper đều thành công. Số đo v34 tiếp tục thuộc v34. Lỗi v36 chưa có bằng chứng nguyên nhân hoặc RPO/RTO nghiệm thu. [Receipt phục hồi v36](../.local/evidence/enterprise-e2-staging-failed-391bf862.json) · [Đối chiếu metadata v36](../.local/evidence/enterprise-v36-openbao-timeout-review.json)

Lúc **07:20:36 ngày 14/11/2026, giờ Việt Nam**, ca thành phần dùng đúng binary OpenBao ghi trong manifest v36. Mỗi slot thử phục hồi Raft vào kho mới, xác nhận marker sau checkpoint vắng mặt và token bootstrap đích bị từ chối. Mỗi slot đọc đúng bí mật giả lập cho bốn AppRole và qua 16 lượt đọc bổ sung, với 0 timeout và 0 lần khởi động lại. Ca này chạy trên cổng loopback riêng với bộ chạy có ghi metadata khi timeout. Phục hồi và rollback staging được xếp chạy lại tuần tự trên đúng artifact và image v36 sau lượt diễn tập cảnh báo. [Biên bản thành phần](../.local/evidence/enterprise-v36-openbao-component-diagnostic.json) · [Chuỗi thử lại v36](../.local/evidence/enterprise-rc-v36-staging-retry-sequence.log)

Lúc **08:12:13 ngày 14/11/2026, giờ Việt Nam**, bộ quan sát OpenBao đã thử bốn mẫu health/leader trên slot B của lượt tải `09c015e8`. Endpoint loopback dùng chứng thư của lượt thử. Cả bốn mẫu trả HTTP 200, vault đã mở và tự báo là leader. Hai bộ quan sát chờ thời điểm bắt đầu phục hồi và rollback để ghi cùng tín hiệu trong các lượt thử lại. Các mẫu health/leader bổ sung thời điểm cho chẩn đoán AppRole. Điều kiện nghiệm thu phục hồi vẫn là thực thi đủ trên hai slot và đo RPO/RTO của toàn chuỗi. [Receipt quan sát](../.local/evidence/enterprise-v36-openbao-health-1794617736929.json) · [Chuỗi phục hồi và rollback](../.local/evidence/enterprise-rc-v36-staging-retry-sequence.log)

Lúc **08:54:58 ngày 14/11/2026, giờ Việt Nam**, lượt thử lại v36 `9fbc62bf` phục hồi thành công tại slot A. RPO **3,215 giây**, RTO **45,520 giây**, trong ngưỡng roadmap. Đối soát 212 bảng trên sáu database, 14 tệp D1/R2 và hai đối tượng media. OpenBao phục hồi bốn AppRole sang kho mới, đăng nhập lại bằng MFA và kiểm quyền tại cả năm ứng dụng. Slot B chạy tiếp trong cùng lượt. [Receipt phục hồi A](../.local/evidence/enterprise-e3-staging-recovery-9fbc62bf-a.json) · [Chuỗi thử lại](../.local/evidence/enterprise-rc-v36-staging-retry-sequence.log)

Lúc **08:57:52**, slot B dừng trong bước kiểm AppRole sau phục hồi. Audit ghi phản hồi thành công cho Raft restore, cả hai grant BFF và cả hai lần mở wrapper. Hai yêu cầu AppRole login tiếp theo đều thiếu bản ghi phản hồi. Receipt hiện chỉ xác nhận RPO/RTO của A. [Receipt thất bại slot B](../.local/evidence/enterprise-e2-staging-failed-9fbc62bf.json) · [Đối chiếu OpenBao](../.local/evidence/enterprise-v36-recovery-9fbc62bf-openbao-review.json)

Lúc **09:07:00 ngày 14/11/2026, giờ Việt Nam**, phép thử thành phần mới dùng binary ghim và điều chỉnh fixture theo thứ tự workload staging, với giá trị BFF giả lập lớn hơn. Sáu vòng ghi **15 timeout**, gồm bốn lần trước restore. Health vẫn trả trạng thái vault mở và active ở cả 15 lần. Một mẫu stack chụp lúc timeout có đường AppRole qua giao dịch lưu trữ và Raft apply. Đây là tín hiệu chẩn đoán của phép thử thành phần; nguyên nhân của timeout staging vẫn chưa xác định. [Receipt điều tra](../.local/evidence/enterprise-v36-openbao-restore-shape-investigation.json)

Lúc **09:14:49**, ca đối chứng mở socket HTTPS mới cho từng yêu cầu vẫn ghi **21 timeout trong sáu vòng**, với một vòng hoàn tất. Health vẫn trả trạng thái active trong 21 lần. Bốn mẫu stack có đường AppRole qua Raft apply. Việc bỏ tái sử dụng socket chưa loại lỗi và chưa đủ để xác định nguyên nhân ở lưu trữ. [Receipt đối chứng socket](../.local/evidence/enterprise-v36-openbao-fresh-sockets-investigation.json)

Lúc **09:19:47**, ca thành phần dùng cùng binary và fixture, với Raft mở mmap ban đầu **16 MiB**, hoàn tất **6/6 vòng và 96 lần đọc bổ sung**, 0 timeout và 0 lần khởi động lại. So sánh này thực hiện trên Windows và dữ liệu giả lập. Runner phục hồi bổ sung v37 giữ digest artifact và image, với thay đổi mmap giới hạn ở tiến trình OpenBao do runner staging trên Windows tạo. Kết quả vẫn cần xác nhận trên cả hai slot. [Receipt thử mmap](../.local/evidence/enterprise-v36-openbao-mmap-comparison.json)

Lúc **09:25:08 ngày 14/11/2026, giờ Việt Nam**, lượt phục hồi v37 `421c307f` qua slot A với RPO **3,323 giây** và RTO **56,857 giây**. Receipt xác minh MFA mới, quyền tại năm nguồn, dữ liệu và tệp LMS, cùng bí mật của bốn AppRole trong kho mới. Slot B chạy tiếp trước ca rollback. Runner mmap chỉ khởi động nếu lượt phục hồi chính kết thúc lỗi. [Receipt v37 slot A](../.local/evidence/enterprise-e3-staging-recovery-421c307f-a.json) · [Runner bổ sung](../.local/evidence/enterprise-e3-v37-openbao-recovery-runner.json)

Lúc **09:28:18**, runner niêm phong v37 xác nhận cả hai slot hoàn tất. Slot B đo RPO **3,467 giây** và RTO **51,195 giây**. Mỗi slot đối soát 212 bảng trên sáu database, 14 tệp D1/R2, hai media và quyền đọc ở năm nguồn sau MFA mới. A cần một lần khởi động lại OpenBao khi xác minh bí mật, B hoàn tất không cần khởi động lại. Kết quả dùng cấu hình OpenBao của runner niêm phong. [Đối chiếu phục hồi v37](../.local/evidence/enterprise-e3-v37-recovery-review.json)

Lúc **11:54:46 ngày 14/11/2026, giờ Việt Nam**, đối chiếu metadata hai lần dừng v38 r2. Ở slot A `273f499f`, OpenBao cấp hai grant PostgreSQL và phản hồi cả hai lần mở wrapper. Ở slot B `3b1a902d`, đích đã phản hồi thao tác phục hồi Raft rồi cấp hai grant BFF và phản hồi cả hai lần mở wrapper. Mỗi ca có hai yêu cầu AppRole login thiếu phản hồi trong audit. Biên bản chỉ giữ số đếm và SHA-256 của nguồn. Nguyên nhân timeout vẫn cần xác minh. [Đối chiếu timeout v38 r2](../.local/evidence/enterprise-e3-v38-r2-openbao-timeout-review.json)

Lúc **11:58:01 ngày 14/11/2026, giờ Việt Nam**, lượt thử lại v38 r2 `925d3140` hoàn tất trên cả hai slot. RPO/RTO là **3,033/51,480 giây ở A** và **2,996/64,825 giây ở B**. Mỗi slot đối soát 212 bảng trong sáu database, 14 tệp D1/R2, hai đối tượng media và quyền đọc năm ứng dụng sau MFA mới. A hoàn tất với 0 lần khởi động lại OpenBao. B cần hai lần khởi động lại khi xác minh bí mật. [Biên bản phục hồi v38 r2](../.local/evidence/enterprise-e3-v38-r2-recovery-review.json)

Lúc **17:42:44 ngày 14/11/2026, giờ Việt Nam**, ứng viên v39 hoàn tất phục hồi phối hợp `505ec4a5` ở cả hai slot. RPO/RTO là **3,352/49,567 giây ở A** và **5,227/43,216 giây ở B**, đạt ngưỡng 15 phút và 60 phút. Mỗi slot đối soát 212 bảng trong sáu database, 14 tệp D1/R2, hai media, bí mật của bốn workload và quyền tại năm ứng dụng sau MFA mới. Cả hai lượt dùng kho OpenBao đích mới và hoàn tất với 0 lần khởi động lại khi xác minh bí mật. [Biên bản phục hồi v39](../.local/evidence/enterprise-e3-v39-recovery-505ec4a5-review.json)

## Migration và rollback

Migration 001–005 đã áp dụng thì bất biến. Runner dùng version/checksum và marker, từ chối drift; thay đổi mới cần migration tiếp theo. Không sửa SQL cũ hoặc chạy down migration phá lịch sử để “rollback”.

Rollback vận hành local ưu tiên dừng writer, giữ backup và dựng target riêng để kiểm chứng; không ghi đè nguồn tự động. Credentials và encryption key trong .local cần được giữ cùng môi trường để đọc các session payload đã mã hóa; không xóa .local rồi giữ volume cũ. Secret store, lịch backup/retention, HA và RPO/RTO production vẫn ngoài phạm vi goal này.

Đo CPU/RAM/latency riêng: [LOCAL_MEASUREMENTS](LOCAL_MEASUREMENTS.md). Các script MFA/E2E/onboarding/resilience/restore/measurement phải chạy tuần tự.
