# Quy trình liên kết

AIO local dùng quy tắc liên kết để chuẩn bị nháp cho quy trình kế tiếp. Ca nghiệp vụ đầu tiên là Tạm ứng đã duyệt → Quyết toán cần bổ sung chứng từ. [Thiết lập liên kết trong AMIS Quy trình](https://helpamis.misa.vn/amis-quy-trinh/kb/thiet-lap-quy-trinh-lien-ket/)

## Cấu hình và sử dụng

1. Phát hành hai quy trình với một đơn vị được phép khởi tạo cả hai. Người áp dụng quy tắc cần quyền phát hành tại đơn vị này và đơn vị quản lý của hai quy trình.
2. Trong **Tự động hóa**, chọn quy trình nguồn, quy trình đích và đơn vị. Chọn hoàn thành cả quy trình hoặc một bước phê duyệt hay tác vụ. Ghép các trường tương thích và thêm điều kiện bằng nếu cần. Với quy tắc theo bước, có thể chọn cả trường khởi tạo lẫn trường kết quả của bước.
3. Chọn người khởi tạo, người hoàn tất bước nguồn hoặc một tài khoản đủ quyền trong đơn vị. Người nhận mở **Hồ sơ liên kết** từ lượt nguồn hoặc tìm nháp trong **Nháp của tôi**, bổ sung chứng từ và gửi. Sau khi gửi, lượt nguồn hiển thị trạng thái lượt đích cho người có quyền đọc cả hai.
4. Trong **Quy tắc và lịch sử chạy**, chọn quy tắc để xem trạng thái, lý do dừng và các lần thử. Sau khi xử lý nguyên nhân, người có quyền phát hành nhập lý do rồi bấm **Thử lại**. Bấm **Tắt quy tắc** để ngừng áp dụng.

Worker xác minh tài khoản và người tương ứng, grant, đơn vị, quyền đọc lượt nguồn và từng trường dùng cho điều kiện hoặc ghép dữ liệu. Nếu chọn người hoàn tất bước đồng duyệt, dùng tài khoản thực hiện hành động chốt bước. Người này vẫn phải có quyền khởi tạo ở đơn vị áp dụng. Việc xem hoặc gửi nháp tiếp tục dùng phiên SSO và quyền hiện hành của người nhận.

## Dữ liệu và vận hành

- Workflows 015 ghi một job cho mỗi quy tắc và lượt nguồn hoàn thành. Workflows 017 ghi job theo đúng lần xử lý bước đã được duyệt hoặc hoàn tất. Cả hai ghi job cùng giao dịch với sự kiện nguồn. Nháp, lịch sử, audit và kết quả job được ghi cùng giao dịch.
- Giá trị ghép lấy từ biểu mẫu khởi tạo hoặc biểu mẫu kết quả của lần xử lý đã ghim. Các trường trống giữ trống. Đích kiểm tra dữ liệu nháp và xác minh tham chiếu qua Foundation. Người nhận đính kèm tệp ở nháp đích.
- Nếu bước bị thu hồi, được xử lý lại hoặc lượt nguồn đổi vòng, kỳ chạy cũ mất hiệu lực. Nháp cũ xuất hiện trong lịch sử. Các trường ghép bị ẩn và các thao tác lưu, đính kèm hoặc gửi bị khóa. Lần xử lý mới tạo nháp riêng. Hồ sơ đích đã gửi giữ liên kết đến lần xử lý đã dùng khi gửi.
- Với quy tắc dùng trường hạn chế, lịch sử lần chạy và thao tác thử lại cũng cần quyền đọc trường đó trên hồ sơ nguồn.
- Phiên bản nguồn và đích được ghim. Nếu đích ngừng phát hành hoặc đã có bản mới trước khi worker xử lý, job dừng với lý do phiên bản. Tắt quy tắc cũ và tạo quy tắc với bản đích mới để áp dụng cho các lượt hoàn thành tiếp theo.
- Lỗi tạm thời có tối đa ba lần tự thử lại sau lần đầu, theo các khoảng 30, 60 và 120 giây. Lỗi dữ liệu hoặc quyền được ghi vào lịch sử. Quy tắc đang tắt chặn các job còn chờ. Lần xử lý đã ghi và nháp đã tạo vẫn tra được theo quyền.
- Giới hạn hiện tại là 12 quy tắc hoạt động cho một phiên bản nguồn ở một đơn vị, và bốn liên kết trong một chuỗi lượt. Kiểm tra vòng khi áp dụng quy tắc.
- `npm run dev` chạy worker local mỗi 30 giây. Có thể chạy một lượt bằng `npm run work-center:worker -- --once`. Chạy `npm run test:suite-regression -- w4-step-links` tuần tự với các bài DB/MFA sau khi dừng dev. [Runbook local](WORKFLOWS_LOCAL_DEVELOPMENT.md)

## Vận hành job theo phạm vi

Mở **Tự động hóa → Vận hành job** và chọn Quy trình liên kết, Nháp định kỳ, Email hoặc Chuyển đề nghị. Nhóm **Cần kiểm tra** hiển thị job đã dừng và job chờ quá 120 giây kể từ thời điểm có thể xử lý. Dùng **Đang chờ xử lý** để xem thời điểm chạy hoặc thử lại, và **Đã xử lý** để đối chiếu kết quả. Mỗi trang có tối đa 50 job và mỗi job hiển thị tối đa 10 lần xử lý gần nhất. [Tham khảo cách theo dõi và xử lý sự cố trong Camunda Operate](https://docs.camunda.io/docs/components/operate/operate-introduction/)

Quyền phát hành phải bao phủ đơn vị cấu hình và đơn vị quản lý quy trình. Job liên kết còn kiểm đơn vị quản lý quy trình đích và quyền đọc trường hạn chế. Lọc theo mã lượt chạy và mở lượt chạy yêu cầu quyền đọc lượt đó. Màn vận hành trả mã lỗi, thời gian, phiên bản và lịch sử thử. Nội dung biểu mẫu và nội dung email nằm trong các màn nguồn có kiểm quyền riêng.

Với job **Đã dừng**, xử lý nguyên nhân rồi nhập lý do và chọn **Đưa vào hàng chờ** nếu cấu hình còn bật. Hệ thống kiểm số lần thử hiện hành và audit yêu cầu retry. Job quá hạn đang chờ do worker xử lý. Kiểm readiness, hàng đợi và tiến trình worker trước khi khởi động lại workload. Sau đó mở **Đã xử lý** để đối soát lần thử và kết quả tại đích. [Runbook cảnh báo](ENTERPRISE_TELEMETRY.md#xử-lý-cảnh-báo)

### Diễn tập thành phần

```powershell
$release = 'e4-workflow-ops-v4'
$build = Get-Content -Raw ".local/releases/$release/receipt.json" | ConvertFrom-Json
& node_modules/.bin/tsx.cmd scripts/enterprise-recovery-postgres.ts $release $build.artifactDigest 'C:/Program Files/PostgreSQL/17/bin' --with-workflow-operations
& node_modules/.bin/tsx.cmd scripts/workflow-operations-ui-drill.ts $release $build.artifactDigest
```

Lượt API `84fbf592-8fec-4b74-88ff-d1d218d654e2` đạt lúc **08:50:04 ngày 13/11/2026, giờ Việt Nam** trên PostgreSQL 17.11 cô lập với role runtime Quy trình. Đối chiếu 52 job quá hạn qua hai trang, phạm vi tenant/đơn vị, quyền mở lượt chạy, retry có revision và replay. Hai worker xử lý một lượt chuyển đề nghị đến đích giả lập. Lịch sử ghi `blocked → done` và có một audit retry. Fixture sử dụng định danh giả lập và chạy worker nghiệp vụ từ artifact. Lượt Chromium `04ba9335-a06c-4f22-a5a3-ce88ed3a3d1e` dùng HTTP fixture, qua kiểm bàn phím, form retry và axe ở 390 px. Chạy qua TLS/Keycloak hai slot và trình đọc màn hình thuộc nghiệm thu E4 đầy đủ.

## Rollback

Tắt các quy tắc cần lùi trước. Giữ migration 015–017, outbox, lịch sử và nháp đã ghi. Khi lùi giao diện, giữ backend kiểm hiệu lực lần xử lý nguồn và worker ghi trạng thái cho job đang chờ. Đối chiếu quyền đọc nguồn và đích cùng trạng thái job trước khi áp dụng quy tắc thay thế.

## Tạo nháp theo lịch

Trong **Tự động hóa → Tạo nháp định kỳ**, người có quyền phát hành ở đơn vị áp dụng và đơn vị quản lý quy trình chọn phiên bản đang phát hành, đơn vị nhận, người có quyền khởi tạo tại đơn vị đó và thời gian tạo. Lịch có thể chạy một lần hoặc lặp theo ngày, tuần, tháng hay năm. Giờ và ngày hiển thị theo Việt Nam (UTC+7). [Thiết lập chạy định kỳ trong AMIS Quy trình](https://helpamis.misa.vn/amis-quy-trinh/kb/thiet-lap-chay-dinh-ky/)

- Lịch lấy ngày bắt đầu làm mốc. Ví dụ lịch hai tuần một lần chạy đúng thứ của ngày bắt đầu. Lịch tháng hoặc năm dùng ngày cuối tháng nếu tháng đó thiếu ngày đã chọn. Ngày kết thúc được tính vào hiệu lực. Khi lưu lịch, kỳ đầu là kỳ từ lúc áp dụng trở đi.
- Workflows 016 lưu một job cho mỗi lịch và thời điểm đến hạn. Khi worker ngừng, các kỳ quá hạn được bổ sung theo thứ tự khi chạy lại. Mỗi vòng lập tối đa tám kỳ cho một lịch. Việc tạo nháp và ghi kết quả cùng giao dịch. Nhật ký giữ cả những lần xử lý thất bại.
- Worker kiểm lại tài khoản, người liên kết, grant, quyền khởi tạo, quan hệ đơn vị và phiên bản đang phát hành. Nếu quyền người nhận bị thu hồi hoặc quy trình đổi phiên bản, kỳ chạy dừng với lý do. Lịch khác vẫn được xử lý.
- Người nhận mở **Nháp của tôi**, bổ sung các trường bắt buộc rồi gửi theo quyền. Nhật ký của người phát hành hiển thị trạng thái vận hành. Quyền mở nội dung nháp vẫn thuộc người nhận.
- Người phát hành có thể thử lại kỳ bị dừng sau khi xử lý nguyên nhân. Hệ thống giữ lịch sử cũ và tránh tạo nháp trùng. Lỗi tạm thời có ba lần thử lại tự động theo các khoảng 30, 60 và 120 giây.

Để lùi, dùng **Tắt lịch**. Kỳ chưa xử lý sẽ ghi lý do dừng. Nháp đã tạo, phiên bản và nhật ký được giữ. Khi cần lùi UI, giữ migration 016 và worker hiểu các kỳ đang chờ. Áp dụng cấu hình mới bằng lịch thay thế sau khi đối chiếu trạng thái các kỳ cũ.

## Mẫu in và email theo sự kiện

Trong **Tự động hóa → Mẫu in và email**, người có quyền phát hành tại cả đơn vị quản lý quy trình và đơn vị áp dụng chọn phiên bản đang phát hành. Nhập tiêu đề, nội dung và chèn trường bằng danh mục có sẵn. Mẫu in cho phép thêm trường và bảng chi tiết có tổng. Người có quyền đọc hồ sơ mở **Mẫu in → Tải mẫu in**, xem bản in trong trình duyệt hoặc tải tệp HTML để in. Mỗi hồ sơ dùng mẫu ghim với phiên bản và đơn vị của chính hồ sơ. [Mẫu in trong AMIS Quy trình](https://helpamis.misa.vn/amis-quy-trinh/kb/thiet-lap-mau-in/)

Mẫu email dùng văn bản và trường trộn. Chọn sự kiện từ Trung tâm công việc, và chọn bước khi sự kiện hỗ trợ. Người nhận do sự kiện và quyền hiện hành xác định. Migration 018 ghi job cùng giao dịch với thông báo và chống trùng theo cặp mẫu–thông báo. Worker ghi kết quả và lịch sử từng lần xử lý vào PostgreSQL local. Người nhận mở **Hộp thư local** để xem thư và đi tới hồ sơ hoặc lần xử lý được chia sẻ. Phạm vi triển khai là HTML in từ trình duyệt và hộp thư giả lập local. [Mẫu email theo sự kiện trong AMIS Quy trình](https://helpamis.misa.vn/amis-quy-trinh/kb/thiet-lap-mau-email-tu-dong-gui-email-theo-tung-buoc/)

- Server trộn dữ liệu từ quyền người xem hoặc người nhận. Bản in dùng dữ liệu của vòng và lần xử lý còn hiệu lực. Người chỉ theo dõi một bước nhận nội dung trong phạm vi chia sẻ của bước đó và mở đúng lần xử lý từ thư.
- Hộp thư kiểm lại quyền, tính hiệu lực của sự kiện và nội dung mỗi lần tải. Thư mất hiệu lực khi lượt đổi vòng, bước bị thay thế hoặc quyền đọc nội dung bị thu hồi. Nhật ký xử lý vẫn được giữ. Người vận hành xem trạng thái và lý do dừng trong **Mẫu đã lưu và lịch sử gửi** rồi thử lại sau khi xử lý nguyên nhân.
- Chạy `npm run test:suite-regression -- w4-output-templates` khi các cổng dev đã trống. Suite dùng SSO/MFA thật trên stack giả lập và kiểm hồi quy liên kết, lịch, biểu mẫu và Portal.

Để rollback, dùng **Tắt mẫu** và giữ migration 018, job, lần xử lý và thư đã ghi. Tắt mẫu in chặn xem/tải theo mẫu đó. Tắt mẫu email dừng áp dụng cho sự kiện mới và ghi trạng thái cho job chờ. Khi lùi UI, giữ backend kiểm quyền và tính hiệu lực trước khi trả bản in hoặc thư. Tạo mẫu mới khi cần sửa cấu hình của phiên bản đang phát hành.

## Chuyển đề nghị tiếp nhận sang Nhân sự

Trong **Tự động hóa → Chuyển đề nghị**, người phát hành chọn phiên bản đang áp dụng, đơn vị và người tiếp nhận. Có thể ghép họ tên và mã nhân sự từ trường văn bản ngắn của biểu mẫu khởi tạo. Ô bỏ trống được bổ sung ở Nhân sự. Người tiếp nhận cần có quyền đọc hồ sơ nguồn và quyền vận hành nhân sự trong cùng tenant.

Khi hồ sơ Quy trình hoàn tất, Workflows 019 ghi một job theo quy tắc, hồ sơ và vòng đã duyệt. Worker kiểm phiên bản, đơn vị, định danh và quyền đọc trường của người nhận. Foundation 009 ghi đề nghị và audit nhận cùng giao dịch. Mã job là khóa duy nhất ở cả hai đầu, nên chạy lại sau lỗi ghi nhận kết quả chỉ xác nhận lại cùng đề nghị. Foundation lưu tham chiếu hồ sơ, phiên bản và vòng. Dữ liệu ghép được lấy qua hợp đồng Quy trình theo quyền hiện hành khi mở đề nghị.

Trong **Nhân sự & tài khoản → Tiếp nhận / Điều chuyển / Nghỉ việc**, tải **Đề nghị tiếp nhận từ Quy trình**, mở đề nghị, bổ sung pháp nhân, vị trí cùng đơn vị và các ô còn thiếu. Thao tác **Xem trước thay đổi → Xác nhận thực hiện** dùng luồng Nhân sự hiện có. Kết quả gồm hồ sơ, quan hệ công tác và bổ nhiệm chính. Ghi kết quả, đánh dấu đề nghị đã xác nhận và ghi audit trong cùng giao dịch. Việc cấp tài khoản và quyền ứng dụng có quy trình IAM riêng.

Người phát hành xem **Quy tắc và lịch sử chuyển đề nghị**, nhập lý do và chọn **Thử lại** cho lượt bị dừng sau khi xử lý quyền hoặc dữ liệu. Dùng **Tắt quy tắc** để dừng lượt mới và job còn chờ. Để rollback UI, giữ Foundation 009, Workflows 019, các tham chiếu và lịch sử đã ghi. Giữ kiểm quyền trên endpoint đọc/xác nhận đề nghị. Nếu cần sửa quan hệ công tác đã xác nhận, thực hiện bằng thao tác Nhân sự có audit.

Sau khi dừng API và LMS dev, chạy `npm run db:setup` rồi `npm run workflows:setup` theo runbook local. Chạy `npm run test:suite-regression -- w4-personnel-intake` để kiểm đề nghị qua SSO/MFA, quyền nguồn/đích và hồi quy vận hành nhân sự, Quy trình và Portal. [Runbook local](WORKFLOWS_LOCAL_DEVELOPMENT.md)

## Chuyển đề nghị đào tạo sang LMS

Trong **Tự động hóa → Chuyển đề nghị**, chọn **Đào tạo LMS**, phiên bản quy trình đang phát hành, đơn vị và quản trị viên tiếp nhận. Có thể ghép tên đợt từ văn bản ngắn và nội dung từ văn bản ngắn hoặc dài. Khi hồ sơ hoàn tất, Workflows 019 ghi job theo phiên bản và vòng đã duyệt. Worker gửi tham chiếu sang LMS local, nơi migration 010 lưu một nháp cùng audit nhận. Mã job dùng làm khóa ghi lại an toàn sau lỗi hoặc khi worker khởi động lại.

Trong **Quản lý đào tạo → Đề nghị đào tạo từ Quy trình**, quản trị viên có MFA mở đề nghị, bổ sung lộ trình, ngày và người học rồi xác nhận giao đợt. Đơn vị phụ trách lấy từ đề nghị. LMS kiểm quyền hiện hành ở cả hai ứng dụng, quyền đọc từng trường ghép và mapping của quản trị viên. LMS ghi đợt, ghi danh, đánh dấu đề nghị đã xác nhận và audit trong một giao dịch. Người học và người theo dõi dùng các quyền LMS hiện có để xem tiến độ. [Lộ trình và đợt đào tạo](LMS_TRAINING.md)

Hồ sơ Quy trình đọc trạng thái từ LMS qua hợp đồng, gồm chờ xác nhận, đã giao và đã hủy. Danh sách và kết quả của từng người học được xem ở LMS. Chữ ký dịch vụ ràng buộc thao tác, ứng dụng đích, instance, môi trường, tham chiếu và cửa sổ 30 giây. Lấy nội dung đề nghị cần thêm bearer LMS hiện hành của đúng quản trị viên và kiểm quyền phía Quy trình.

Để rollback, dùng **Tắt quy tắc** và giữ Workflows 019, LMS 010, các nháp, đợt và lịch sử đã ghi. Khi cần dừng một đợt đã giao, dùng **Hủy đợt** theo quyền LMS để giữ kết quả học đã có. Chạy `npm run test:suite-regression -- w4-training-intake` tuần tự khi các cổng dev đã trống. [Runbook LMS](LMS_LOCAL_DEVELOPMENT.md)
