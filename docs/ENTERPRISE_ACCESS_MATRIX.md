# Ma trận kiểm quyền staging

Các ca bổ sung cần dữ liệu giả lập ở cả hai tenant. Trong mỗi tenant, bố trí ít nhất hai đơn vị và hai người cùng đơn vị nhưng có quyền đối tượng khác nhau. Mỗi người thử phải truy cập được một đối tượng hợp lệ trước khi thử đối tượng ngoài phạm vi. Kiểm thao tác UI và request tới dịch vụ sở hữu dữ liệu bằng cùng phiên SSO/MFA. Với danh sách hoặc tìm kiếm, kiểm nội dung và số lượng sau lọc. Với file/export, kiểm quyền ở lúc lấy tệp và từng hàng hoặc trường trong kết quả. Với ghi, kiểm trạng thái, revision và audit sau ca từ chối. [Yêu cầu V8](ENTERPRISE_ASVS_5_LEVEL_2.md#quyền-và-audit)

## Các ca staging đã chạy

| Ứng dụng  | Đọc                                                                                                                     | Ghi                                                                                      | File                                                                                                                 | Tìm kiếm                                                                        | Export                                                                   |
| --------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Portal    | Registry theo grant, mở việc Quy trình và đợt LMS đúng nguồn. Feed từ chối sau thu hồi và chéo tenant ở ca LMS.         | Thử CSRF và quản trị grant; ca vòng đời chặn phiên cũ sau mở lại.                        | Cần kiểm URL file tại ứng dụng sở hữu.                                                                               | Kiểm route tìm việc và giữ phân trang sau lọc còn mở.                           | Cần chốt các bề mặt export của Foundation quản trị và ca kiểm tương ứng. |
| Forms     | Người điền đọc danh sách tenant A, bị từ chối ở tenant B.                                                               | Operator phát hành, respondent gửi đúng đơn vị. Ngoài đơn vị hoặc thiếu CSRF bị từ chối. | Forms MVP được nghiệm thu với câu trả lời và CSV. Ca upload chờ xác nhận theo artifact trước khi quyết định áp dụng. | Kiểm tra lookup, lọc danh sách và phân trang submissions còn mở.                | Operator có quyền export tải CSV, respondent bị từ chối.                 |
| Quy trình | Portal mở đúng lượt đã ghim phiên bản. Handler không nhận trường dành riêng cho người khởi tạo. Chéo tenant bị từ chối. | Người được giao xử lý bước; người khởi tạo bị từ chối ở bước đó.                         | Cần chạy kiểm tài liệu, tệp đính kèm và tải lại sau thu hồi trên staging.                                            | Cần kiểm người được tìm, đối tượng reference và field filter theo đơn vị/quyền. | Cần chạy báo cáo và tệp đầu ra trên staging.                             |
| Công việc | Thành viên mở dự án được giao, dự án khác cùng tenant và request chéo tenant bị từ chối.                                | Bàn giao đổi người được sửa, revision cũ bị chặn, replay hoàn thành trả cùng kết quả.    | Cần xác nhận bề mặt tệp trong artifact và dữ liệu đầu ra từ tích hợp.                                                | Cần kiểm tìm task/candidate theo project membership, đơn vị và assignee.        | Có API báo cáo. Cần đối chiếu bề mặt xuất tệp trong artifact.            |
| LMS       | Người học thấy nội dung đã cấp, đáp án bị che. Admin đọc báo cáo, learner bị từ chối.                                   | Admin phát hành khóa học, người học nộp bài; người học bị chặn thao tác quản trị.        | Media ngoài phiên bản bị từ chối, media đã gắn phiên bản được đọc.                                                   | Cần kiểm tìm người học/điểm theo vai trò và đơn vị, cùng phân trang.            | Cần chạy xuất XLSX đúng scope và replay sau thu hồi trên staging.        |

Các kết quả trên dùng API trình duyệt trong phiên thật, ngoại trừ ca mở liên kết và xác thực lại đã có bước UI. Giới hạn bằng chứng và receipt nằm ở phần IAM. [Runner Portal, Forms, Quy trình và Công việc](../scripts/staging-business-e2e.ts) · [Runner LMS](../scripts/staging-lms-e2e.ts) · [Biên bản E2](ENTERPRISE_IAM_AUDIT.md)

## Ca cần bổ sung trên cùng ứng viên

| Ứng dụng  | Dữ liệu và actor cần dựng                                                                                                            | Chứng cứ phải giữ                                                                                                                                                                                    |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Portal    | Cùng từ khóa ở hai tenant, hai đơn vị và hai lượt thuộc actor khác nhau. Grant cho ứng dụng A, thu hồi grant A sau khi mở danh sách. | Hàng, tổng và cursor của `/api/v1/work-center/work` phản ánh scope. UI mở đúng lượt. URL nguồn vừa thu hồi bị từ chối. Kiểm quản trị Directory và các đường tra cứu độc lập.                         |
| Forms     | Cùng một version có phiếu của hai đơn vị, actor riêng cho design, publish, respond, review, analyze và export.                       | UI chỉ hiện thao tác được phép. API đọc/ghi trực tiếp và gọi lookup không vượt scope. CSV đúng phiên bản, đơn vị, phiếu và trường. Đối chiếu số trang submissions cùng tenant.                       |
| Quy trình | Một lượt chứa trường riêng, tệp theo đối tượng, hai task được phân công khác nhau, hai phiên bản.                                    | So sánh phản hồi trước và sau đổi assignee khi mở lượt, tải tệp, tìm reference, lọc run và xuất báo cáo. Ghi cùng revision để chứng minh deny không sửa dữ liệu, và xác nhận lịch sử ghim phiên bản. |
| Công việc | Hai dự án trong cùng đơn vị, có thành viên trùng và thành viên chỉ thuộc một dự án. Một dự án khác tenant.                           | Kiểm UI tìm/lọc, API `projects/:id/items`, `projects/:id/candidates` và `projects/:id/report` theo membership. Lưu quyền trước/sau bàn giao và số liệu báo cáo đã lọc.                               |
| LMS       | Hai người học cùng khóa, hai đơn vị, manager từng scope và admin. Có bài thi và media riêng theo version.                            | Kiểm UI tìm learner/điểm, API báo cáo theo employee/đơn vị, media theo version và tệp XLSX của `/api/lms/report-export`. Đối chiếu rows/cột, dữ liệu chéo tenant/đơn vị, quyền cấp mới và thu hồi.   |

[Forms API](../src/forms/routes.ts) · [Quy trình API](../src/workflows/routes.ts) · [Công việc API](../src/tasks/routes.ts) · [LMS Report API](../src/lms/report-routes.ts) · [Portal Work Center API](../src/work-center-boundary.ts)

## Profile giao diện

Fault profile v23 hoàn tất lúc **19:34:34 ngày 13/11/2026, giờ Việt Nam**. Trên mỗi slot, Forms reviewer và analyst chỉ thấy hai trong ba phiếu đối chứng, CSV giữ phạm vi và API có cursor. Quy trình kiểm trường và tệp riêng, loại trường của owner khỏi CSV, từ chối actor thiếu quyền báo cáo và thử lại job qua UI ở 390 px. Công việc giữ membership, CAS và góc nhìn sau tải lại, đồng thời chặn API candidate/report với vai trò thiếu quyền. LMS manager thấy ba trong bốn dòng, tìm ngoài đơn vị trả rỗng và replay xuất XLSX bị chặn sau thu hồi. Năm request đầu tiên sau sự kiện thu hồi đều bị từ chối. Khoảng thời gian từ khi connector xác nhận đến phản hồi từ chối là **21–56 ms ở A** và **12–40 ms ở B** trong lượt này. [Receipt UI/API v23](../.local/evidence/enterprise-e3-staging-faults-ce7496f1.json) · [Các tổ hợp còn mở](#ca-cần-bổ-sung-trên-cùng-ứng-viên)

Lúc **17:20:12 ngày 13/11/2026, giờ Việt Nam**, hai slot v19 đã chạy các ca dưới đây trong phiên SSO/MFA. Các ô mô tả phạm vi được kiểm trên đúng artifact và image v19. [Receipt hostname v19](../.local/evidence/enterprise-e3-staging-telemetry-21d952ff.json)

| Ứng dụng | Đã kiểm trên v19 | Còn cần kiểm |
| --- | --- | --- |
| Portal | Tìm việc Quy trình, mở đúng hồ sơ nguồn, hiển thị Công việc theo trạng thái, mở lại nháp Forms và đọc đợt LMS. Phiên đang mở bị chặn ở nguồn sau thu hồi. Directory đọc 511 hồ sơ qua hai trang và chặn vai trò thiếu quyền. | Đối chiếu cursor trên kết quả tìm việc sau lọc và rà các bề mặt export của Foundation. |
| Forms | Gửi phiếu từ UI và API, reviewer đọc hai phiếu đơn vị A trong ba phiếu đối chứng, analyst chỉ xuất hai phiếu cùng đơn vị, phân trang có cursor. Người điền thiếu quyền xuất và request ngoài phạm vi bị từ chối. | Đối chiếu quyền đọc/ghi cấp trường với các loại biểu mẫu áp dụng. |
| Quy trình | Handler mở đúng lượt, trường và tệp của owner không hiện với handler, URL tệp riêng bị từ chối. Người được giao phê duyệt, người khởi tạo bị chặn khi thử thao tác đó. Báo cáo CSV lọc quyền và bỏ trường riêng. Job retry yêu cầu quyền publish và revision đúng, LMS nhận một bản ghi. | Kiểm lại truy cập tệp thư viện sau đổi assignee và phạm vi đọc/ghi của các trường đã cấu hình. |
| Công việc | Thành viên chỉ mở được dự án được giao, tìm và bàn giao từ Portal. Bàn giao đổi người được sửa. CAS và replay giữ kết quả. Bộ lọc trạng thái và góc nhìn Kanban được giữ sau reload ở 390 px. Candidate và report từ chối thành viên thiếu quyền. | Đối chiếu các bề mặt xuất tệp và tích hợp có thể trả dữ liệu Công việc. |
| LMS | Người học mở khóa, tải media theo phiên bản và nộp bài. Manager thấy ba dòng đúng phạm vi trong bốn dòng đối chứng. Tìm ngoài đơn vị trả rỗng, tải XLSX giữ scope và replay bị từ chối ngay khi thu hồi. Workbook kiểm chuẩn bị chặn. | Rà quyền theo trường cho tất cả loại báo cáo và dữ liệu media được nhập trước khi có scanner. |

`--access-ui` chạy trên image qua TLS, dùng lại kiểm vòng đời nhân sự, IAM và audit hạ tầng. Các actor đăng nhập SSO/MFA với session riêng. Runner đưa dữ liệu qua API source có quyền rồi thao tác bằng Chromium trên cùng bản ứng viên. Tệp tải dùng thư mục tạm của browser context, đối chiếu nội dung CSV/XLSX và tệp giả lập trước khi đóng context. [Runner UI](../scripts/staging-access-ui.ts) · [Playwright Downloads](https://playwright.dev/docs/downloads)

Các cặp đối chiếu trong profile gồm nộp Forms ngoài đơn vị và quyền tải CSV, tìm việc trên Portal và mở đúng hồ sơ, trường và tệp riêng của người khởi tạo Quy trình, membership và bàn giao Công việc, quyền media và export LMS. Ca Công việc tạo dự án thuộc cả hai tenant với grant riêng để mỗi actor có truy cập hợp lệ trong tenant của mình. Khi đưa ID dự án của tenant kia vào truy vấn đang dùng tenant của actor, nguồn phải từ chối.

Lượt `e2-access-ui-v3` qua cả hai slot lúc **01:06:43 ngày 13/11/2026, giờ Việt Nam**. Artifact `dbf4f0a6579ab9849696d605cae480937778329d0cf479113dd7c95a178d21df`, image `sha256:d26ecb86fa8d86b186c3c428a44056323b56b6b6c79133f942db19bd5a491227`, receipt `.local/evidence/enterprise-e2-staging-access-ui-42c09acd.json`. Cả 292 hash payload khớp `e2-infra-audit-v2`. Source và artifact digest khác do runner và fixture thay đổi.

| Ứng dụng  | Đã quan sát ở cả hai slot                                                                                                                                                                                                                                                                              |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Portal    | Thành viên tìm đúng việc, mở đúng link hồ sơ và nhiệm vụ ở Quy trình trong phiên SSO. Nguồn thu hồi grant và lần đọc tiếp theo bị chặn.                                                                                                                                                                |
| Forms     | Người điền gửi phiếu qua UI. Operator tải CSV và đối chiếu đáp án gửi bằng cả UI lẫn API. Người điền thiếu quyền export bị chặn ở API, UI không có nút tải. API từ chối nộp ngoài đơn vị và khi thiếu CSRF.                                                                                            |
| Quy trình | Người khởi tạo thấy trường riêng và tải được tệp đúng nội dung. Người được giao phê duyệt không thấy trường hoặc link tệp, gọi URL tệp trả 404. Người đó phê duyệt qua UI. API của người khởi tạo bị từ chối khi thử phê duyệt, lượt chạy vẫn ghim phiên bản.                                          |
| Công việc | Thành viên chỉ thấy dự án thuộc membership, tìm việc và bàn giao qua UI. Sau bàn giao, mất thao tác tiến độ và API từ chối sửa bằng phiên cũ. Candidate và report chặn thành viên thiếu quyền. Hai actor tạo hoặc đọc dự án hợp lệ trong tenant của mình, rồi API trả 404 khi đọc ID dự án tenant kia. |
| LMS       | Người học mở khóa và tải tài liệu đúng byte từ phiên bản được cấp. Tab báo cáo ẩn và API export trả 403 với người học. Operator lọc theo khóa và người học rồi tải XLSX, bảng điểm chỉ có một dòng khớp bộ lọc.                                                                                        |

```powershell
$r = Get-Content -Raw .local/releases/e2-access-ui-v3/receipt.json | ConvertFrom-Json
$prior = Get-Content -Raw .local/releases/e2-audit-v2/receipt.json | ConvertFrom-Json
$image = Get-Content -Raw .local/releases/e2-access-ui-v3/image-5f545a38/receipt.json | ConvertFrom-Json
npm run test:staging -- e2-access-ui-v3 $r.artifactDigest e2-audit-v2 $prior.artifactDigest $image.imageDigest --access-ui
```

Các nhóm còn mở gồm thử ranh giới reference cùng tenant giữa các đơn vị và tổ hợp báo cáo nhiều đơn vị. Ca reviewer, analyst và manager theo đơn vị được ghi ở mục dưới.

Lúc **11:19:26 ngày 13/11/2026, giờ Việt Nam**, mỗi slot `enterprise-rc-v1` duyệt đủ 511 hồ sơ Directory qua hai trang. Runner đối chiếu 503 fixture trùng tên không lặp ID và từ chối truy cập chéo tenant hoặc thiếu quyền đọc. Tra cứu người từ Quy trình trả đúng người ở đơn vị được cấp và từ chối truy vấn tenant khác. [Receipt hai slot](../.local/evidence/enterprise-e5-staging-rollback-d98a0165.json)

Lúc **12:22:13 ngày 13/11/2026, giờ Việt Nam**, `enterprise-rc-v3` xác nhận xuất CSV Quy trình theo đơn vị, phiên bản và bước ở cả hai slot. File chứa đúng mã lượt và lần xử lý, không chứa giá trị trường riêng của người khởi tạo. Handler không có quyền báo cáo nhận 403. Audit export khớp request ID. [Receipt hai slot](../.local/evidence/enterprise-e5-staging-rollback-d61acd8e.json)

## Báo cáo Forms và LMS theo đơn vị

Profile `--scoped-reports` chạy tiếp các ca `--access-ui`. Ba tài khoản giả lập có liên kết issuer/subject riêng và MFA. Reviewer Forms và analyst Forms nhận quyền khác nhau ở đơn vị A. Reviewer đồng thời có vai trò manager LMS ở A. Tài khoản đơn vị C chỉ gửi phiếu và học. Ràng buộc role theo đơn vị nằm tại Foundation, và các kho ứng dụng kiểm quyền hiện hành trước khi đọc hoặc xuất. [Fixture staging](../scripts/staging-report-fixtures.ts)

Forms dùng biểu mẫu cấp tenant, phát hành một phiên bản cho hai đơn vị. Phiếu C được tạo giữa hai phiếu A để kiểm tiếp từ cursor của phiếu A mới nhất. Operator đối chiếu tổng cả hai đơn vị, reviewer đọc phiếu và analyst tổng hợp rồi tải CSV. LMS dùng cùng phiên bản khóa học cho hai đơn vị, có bài làm thật ở cả hai. Manager thử tìm tên ngoài phạm vi, truy cập chi tiết bằng ID, tải XLSX và gửi lại cùng yêu cầu export sau khi grant LMS bị thu hồi. [ASVS V8](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x17-V8-Authorization.md)

Lúc **09:47:46 ngày 13/11/2026, giờ Việt Nam**, `e2-transport-v1` qua profile báo cáo trên hai slot. Mỗi slot xác nhận reviewer và analyst Forms thấy hai trong ba phiếu, CSV giữ phạm vi và cursor bỏ qua phiếu đơn vị C. Manager LMS thấy ba trong bốn dòng đối chứng. Tìm tên đơn vị ngoài phạm vi trả rỗng. XLSX giữ phạm vi và phát lại yêu cầu export sau thu hồi quyền bị từ chối. [Receipt hai slot](../.local/evidence/enterprise-e3-staging-telemetry-9a0a9c95.json)

Chạy hai slot tuần tự với receipt quét đã đạt và khớp digest artifact. Thêm `--telemetry` để chạy lại cấu hình của receipt trên. [Đối chiếu ASVS V9](ENTERPRISE_ASVS_5_LEVEL_2.md#token-tự-chứa)

```powershell
$release = 'e2-transport-v1'
$r = Get-Content -Raw ".local/releases/$release/receipt.json" | ConvertFrom-Json
$prior = Get-Content -Raw .local/releases/e2-audit-v2/receipt.json | ConvertFrom-Json
npm run release:image -- $release $r.artifactDigest
if ($LASTEXITCODE -ne 0) { throw 'Image gate failed.' }
$image = Get-ChildItem ".local/releases/$release" -Directory -Filter 'image-*' |
  ForEach-Object {
    $path = Join-Path $_.FullName 'receipt.json'
    if (Test-Path -LiteralPath $path -PathType Leaf) {
      Get-Content -Raw -LiteralPath $path | ConvertFrom-Json
    }
  } |
  Where-Object { $_.status -eq 'pass' -and $_.artifactDigest -eq $r.artifactDigest } |
  Sort-Object scannedAt -Descending |
  Select-Object -First 1
if (-not $image) { throw 'Matching image receipt missing.' }
npm run test:staging -- $release $r.artifactDigest e2-audit-v2 $prior.artifactDigest $image.imageDigest --scoped-reports
```

## Đối chiếu quyền tại nguồn trên v26

Lúc **21:44:42 ngày 13/11/2026, giờ Việt Nam**, profile hostname v26 qua cả hai slot với MFA. Sau xác nhận sự kiện vòng đời nhân sự, request đầu tới Portal, Forms, Quy trình và Công việc trả 401 trong tối đa 14 ms theo đồng hồ runner. LMS trả 403 trong tối đa 51 ms. Ma trận dưới đây ghi các hành vi đã được thử trên digest v26. [Receipt hostname](../.local/evidence/enterprise-e3-staging-telemetry-a53ee07c.json) · [Fault profile](../.local/evidence/enterprise-e3-staging-faults-be16569c.json)

| Nguồn | Ca đã chạy ở hai slot | Phạm vi cần đối chiếu thêm |
| --- | --- | --- |
| Portal | Tìm và mở nguồn Quy trình, Forms, Công việc. Từ chối sau khi thu hồi, kiểm phím và axe cho lối mở Công việc. | Role liên kết nhiều đơn vị và kết quả tìm kiếm khi grant thay đổi trong phiên. |
| Forms | Reviewer và analyst thấy đúng 2/3 phiếu, bỏ qua phiếu đơn vị khác qua cursor. CSV đúng phạm vi, thao tác chéo role bị từ chối. | Kết hợp nhiều assignment đang hiệu lực với form giới hạn người nhận và trường báo cáo. |
| Quy trình | Chặn tenant và đơn vị ngoài phạm vi, đọc tệp/trường theo quyền, CSV bỏ trường riêng của người khởi tạo và từ chối người thiếu quyền báo cáo. | Đọc và ghi từng nhóm trường theo role, kiểm tệp cũ của Thư viện tài liệu trên bản ứng viên. |
| Công việc | Tìm kiếm, bàn giao, xác nhận CAS và thu hồi. Từ chối ứng viên hoặc quyền báo cáo sai, đọc dự án ngoài membership và thao tác chéo tenant. | Chuyển trạng thái, báo cáo và tìm kiếm với tổ hợp nhiều dự án và quyền vừa thay đổi. |
| LMS | Manager thấy đúng 3/4 dòng, tìm tên ngoài phạm vi trả rỗng, XLSX đúng quyền. Learner bị từ chối export trực tiếp, replay sau thu hồi bị từ chối, và file có kiểm quyền. | Tổ hợp nhiều đơn vị của manager, scope theo phiên bản khóa học và kiểm xuất lịch sử sau đổi quyền. |

## Đối chiếu quyền tại nguồn trên v33

Fault và hostname v33 kiểm lại quyền trên cùng artifact và image ở cả hai slot. Forms trả 2/3 phiếu cho reviewer và analyst, dùng cursor và CSV theo đơn vị. Quy trình bỏ trường riêng của người khởi tạo trong báo cáo và chặn role thiếu quyền. Công việc chặn truy cập chéo tenant và dự án ngoài membership. LMS giới hạn báo cáo còn 3/4 dòng, chặn tìm ngoài đơn vị và chặn replay export sau thu hồi. Portal dẫn đến nguồn và request đầu sau thu hồi bị từ chối ở cả năm nguồn. Phạm vi cần kiểm thêm theo từng nguồn vẫn theo bảng trên. [Hostname v33](../.local/evidence/enterprise-e3-staging-telemetry-ad906850.json) · [Đối chiếu quyền và audit](../.local/evidence/enterprise-e2-v33-iam-audit-review.json)

## Bề mặt file và export trong ứng viên v34

Đối chiếu tĩnh lúc **00:59 ngày 14/11/2026, giờ Việt Nam**, trên snapshot có digest nguồn `7f59e701967f258e7f4e0fc45d294d80814c18f4b8f4f1d21ee5cd2334967434`. Các cột dưới đây xác định bề mặt cần biên bản runtime v34. [Bản dựng v34](../.local/evidence/enterprise-rc-v34-build-receipt.json)

| Nguồn | Bề mặt trong v34 | Ca cần đối chiếu theo quyền |
| --- | --- | --- |
| Portal/Foundation | Portal mở URL nguồn. Foundation có workbook mẫu cho nhập cơ cấu và xuất gói cấu hình Directory cho người, đơn vị, chức danh, vị trí. | Kiểm quyền tải workbook mẫu, phạm vi gói JSON và từng loại cấu hình. Kiểm link Portal sau đổi grant ở nguồn. [Workbook](../src/management/organization-import-routes.ts) · [Gói Directory](../src/management/configuration-transfer-routes.ts) |
| Forms | Routes dùng schema standalone v1, còn attachment thuộc schema nghiệp vụ v2 của Quy trình. Forms có CSV theo phiên bản và API lookup, submissions, report. | Đối chiếu CSV với quyền và bộ lọc đơn vị. Kiểm lookup và quyền đọc từng nhóm trường với nhiều assignment. [Hợp đồng schema](../src/forms/contracts.ts) · [API](../src/forms/routes.ts) |
| Quy trình | Tệp hồ sơ và tệp phiên bản Thư viện tài liệu có hai đường tải riêng. Báo cáo hiệu suất có CSV và hồ sơ có đầu ra HTML. | Kiểm quyền và checksum ở cả hai đường tải. Đối chiếu hàng, trường và phiên bản của hai loại đầu ra, gồm sau đổi người xử lý hoặc quyền xem. [API Quy trình](../src/workflows/routes.ts) |
| Công việc | API dự án trả báo cáo JSON, danh sách việc và ứng viên có tìm kiếm. Routes của module không khai báo upload, download hoặc export tệp. | Kiểm báo cáo JSON, tập ứng viên, tìm kiếm và phân trang sau đổi membership. Kiểm link từ Portal dẫn đến nguồn. [API Công việc](../src/tasks/routes.ts) · [Nguồn Portal](../src/tasks-work-center-boundary.ts) |
| LMS | Media có GET/HEAD và XLSX báo cáo có tuyến riêng. Workbook câu hỏi có mẫu, export và đường nhập. | Kiểm đọc media theo phiên bản, quyền GET/HEAD với object cũ, quyền workbook câu hỏi và scope khi tải hoặc phát lại XLSX báo cáo. [Worker](../src/lms/worker.ts) · [Báo cáo](../src/lms/report-routes.ts) · [Workbook câu hỏi](../src/lms/question-routes.ts) |

Lúc **01:45:28 ngày 14/11/2026, giờ Việt Nam**, fault profile v34 xác nhận cùng artifact và image ở hai slot. Portal tìm và mở đúng đối tượng nguồn. Forms lọc còn **2/3 phiếu** qua cursor và CSV. Quy trình kiểm quyền field và tệp hồ sơ, bỏ trường riêng khỏi CSV và từ chối người thiếu quyền báo cáo. Công việc kiểm tra membership, quyền xem ứng viên và báo cáo, tìm và bàn giao trên UI. LMS lọc báo cáo còn **3/4 dòng**, chặn tìm ngoài đơn vị và chặn replay export sau thu hồi. Sau khi connector xác nhận thu hồi, request đầu ở cả năm nguồn trả 401 hoặc 403, muộn nhất **227 ms ở A** và **208 ms ở B**. Các tổ hợp chưa quan sát vẫn theo bảng trên. [Receipt fault v34](../.local/evidence/enterprise-e3-staging-faults-93821bd3.json)

### Quy tắc truy cập theo chức năng và đối tượng

Nguồn kiểm tra account, phiên, grant ứng dụng, quyền cho hành động và phạm vi dữ liệu còn hiệu lực. Tenant và đối tượng được xác minh ở dịch vụ sở hữu dữ liệu, kể cả khi người dùng mở URL từ Portal hoặc gửi lại cùng idempotency key. [Mô hình truy cập](APPLICATION_ACCESS_MODEL.md)

| Ứng dụng | Chức năng và đối tượng | Phạm vi trường |
| --- | --- | --- |
| Portal/Foundation | Danh mục lấy grant còn hiệu lực của account. Công việc, phiếu và đợt đào tạo trong feed mở về nguồn. Quản trị IAM và tổ chức yêu cầu permission và phạm vi ủy quyền tại Foundation. | API quản trị cập nhật trường theo từng action. Directory tra người theo scope cấp quyền, còn bản xuất được kiểm ở tuyến sở hữu. [Quản trị Foundation](../src/management/routes.ts) · [Quyền và tổ chức](APPLICATION_ACCESS_MODEL.md) |
| Forms | Designer lưu bản nháp, publisher phát hành và respondent gửi khi khớp audience của phiên bản. Reviewer và analyst đọc hoặc xuất trong phạm vi đơn vị được cấp. | Phiếu chỉ ghi trường của schema đã phát hành qua kiểm kiểu và điều kiện. CSV lấy các câu trả lời trong các phiếu và trường được phép đọc. [Quy tắc Forms](FORM_BUILDER_MVP.md) · [Forms API](../src/forms/routes.ts) |
| Quy trình | Người khởi tạo mở hồ sơ có quyền và phiên bản ghim. Người được giao xử lý bước đúng lượt và revision. Quản trị vận hành, báo cáo và thư viện dùng quyền riêng. | Quyền xem trường gắn với người khởi tạo, điều phối hoặc người thực sự được giao. Bước xử lý giới hạn trường được sửa. Báo cáo, lịch sử và tệp giữ phạm vi trường và phiên bản. [Quyền trường và biểu mẫu](WORKFLOWS_BUSINESS_FORMS.md) |
| Công việc | Phạm vi dự án theo membership và quyền ứng dụng. Người giao hoặc người thực hiện đủ quyền cập nhật hoặc bàn giao. Báo cáo yêu cầu `tasks:report` và giữ phạm vi hàng. | Quyền sửa phụ thuộc hành động, vai trò, trạng thái và quy tắc chuyển của dự án. Dữ liệu danh sách và báo cáo dùng cùng phạm vi công việc. [Phân quyền Công việc](TASKS_LOCAL_DEVELOPMENT.md#sử-dụng-và-phân-quyền) |
| LMS | Learner dùng khóa và media thuộc phiên bản được cấp. Manager chỉ xem phạm vi Directory còn hiệu lực, còn quản trị khóa học yêu cầu quyền quản trị LMS. | Kết quả và export lấy dữ liệu học viên, đơn vị, phiên bản và trường của báo cáo được phép. Learner nhận câu hỏi theo phiên bản và dữ liệu kết quả được cấp. [Quyền báo cáo LMS](LMS_REPORTING.md#directory-và-quyền) · [API LMS](../src/lms/worker.ts) |

Ma trận runtime ở trên ghi các mẫu UI/API đã quan sát trên v34. Các tổ hợp vai trò, đối tượng, trường và trạng thái ngoài các mẫu đó còn phải đối chiếu khi chốt V8.2 và V8.4. [Sổ ASVS v34](../.local/evidence/enterprise-e2-v34-session-ledger.json)

## Đối chiếu UI và API trên v36

Lúc **08:02:18 ngày 14/11/2026, giờ Việt Nam**, đối chiếu receipt hostname và fault của hai slot trên artifact v36. Request đầu sau thu hồi tại Portal, Forms, Quy trình và Công việc trả 401. LMS trả 403. Phản hồi cuối đến sau 308 ms tại A và 170 ms tại B. Phiên cũ vẫn bị chặn sau mở lại. [Receipt đối chiếu v36](../.local/evidence/enterprise-e2-v36-access-matrix-review.json)

| Nguồn | Đã xác minh trên A và B | Ca cần bổ sung |
| --- | --- | --- |
| Portal và Foundation | Portal tìm và mở đúng nguồn. Directory trả 511 hồ sơ qua hai trang, từ chối chéo tenant và vai trò thiếu quyền. Workbook chặn tệp bị cách ly và actor thiếu quyền. | Kiểm cursor của feed sau đổi grant và phạm vi từng loại gói xuất Directory. Cần receipt các đường nhập workbook hợp lệ. |
| Forms | Reviewer và analyst chỉ thấy 2/3 phiếu trên API. Cursor và CSV giữ phạm vi đơn vị. Người điền gửi qua UI. API chặn thao tác chéo vai trò và nộp ngoài đơn vị. | Quyền lookup và hành vi theo trường khi người dùng có nhiều assignment. |
| Quy trình | Link mở đúng lượt ghim. Kiểm trường và tệp của người khởi tạo, quyền phê duyệt, CSV theo phạm vi và chặn vai trò thiếu quyền. Retry job chặn ngoài tenant, thiếu quyền và revision cũ. | Tệp Thư viện và tệp cũ sau đổi quyền, đọc và ghi theo tổ hợp vai trò, lọc nội dung HTML theo phiên bản. |
| Công việc | Tìm và bàn giao qua UI. API chặn ngoài membership, chéo tenant và thiếu quyền ứng viên hoặc báo cáo. Quy tắc chuyển trạng thái kiểm vai trò, CAS và phát lại. | Kiểm phân trang và báo cáo khi membership đổi trong phiên trên nhiều dự án. |
| LMS | File được tải đúng phạm vi. Learner bị chặn export qua API. Manager thấy 3/4 dòng đối chứng, tìm ngoài phạm vi trả rỗng, XLSX giữ scope và replay bị chặn sau thu hồi. | Receipt runtime cho workbook câu hỏi, manager nhiều đơn vị và xuất lịch sử sau đổi quyền. |

## Đối chiếu hai slot v37

Lúc **09:14:20 ngày 14/11/2026, giờ Việt Nam**, sổ v37 xác minh lại phạm vi trên đúng artifact. Portal mở đúng nguồn. Forms trả 2/3 phiếu cho reviewer và analyst, cursor và CSV giữ phạm vi. Quy trình kiểm màn trường và tệp, CSV bỏ trường riêng. Công việc từ chối báo cáo và tra ứng viên ngoài quyền. LMS giữ 3/4 dòng đối chứng và chặn replay export sau thu hồi. Audit giữ 90 ngày trong projection và tách vai trò đọc/ghi. Các tổ hợp vai trò, đối tượng và quyền còn mở tiếp tục theo bảng v36. [Receipt quyền v37](../.local/evidence/enterprise-e2-v37-session-and-access-ledger.json)

## Đối chiếu hai slot v38 r2

Lúc **11:43:57 ngày 14/11/2026, giờ Việt Nam**, đối chiếu lượt `13852541` xác nhận Portal mở đúng nguồn và Directory trả 511 hồ sơ qua hai trang, đồng thời chặn truy cập chéo tenant và người thiếu quyền. Forms trả đúng 2/3 phiếu cho reviewer và analyst, giữ scope qua cursor và CSV. Quy trình kiểm trường, tệp và bước phê duyệt theo quyền. Công việc kiểm tìm kiếm, bàn giao, báo cáo và tra ứng viên. LMS kiểm tải tệp, XLSX và từ chối export trực tiếp của learner. Sau offboarding, request đầu ở Portal, Forms, Quy trình và Công việc trả 401, còn LMS trả 403. Phản hồi từ chối cuối đến sau 249 ms ở A và 287 ms ở B. [Biên bản quyền và audit v38 r2](../.local/evidence/enterprise-e2-v38-r2-access-audit-review.json)

Lúc **13:19:11 ngày 14/11/2026, giờ Việt Nam**, phép đọc quyền PostgreSQL trên v38 r2 slot B xác nhận bốn role runtime của Foundation, Forms, Quy trình và Công việc chỉ có CONNECT vào database nghiệp vụ của mình trong tám database được kiểm. Các role không có quyền CREATE trên các database này, không thuộc role khác và không có các cờ superuser, tạo role, tạo database, replication hoặc bypass RLS. Kỳ nghiệm thu còn kiểm quyền theo bảng và cột, cùng các role của audit và kho khác. [Receipt quyền database](../.local/evidence/enterprise-e2-v38-r2-pg-role-scope-1d58541b-b.json)

Lúc **13:24:40 ngày 14/11/2026, giờ Việt Nam**, kiểm quyền hiệu lực ở slot B trên **41 bảng** nhật ký, marker, audit, biên nhận và phiên bản ghim. Bốn role runtime không sở hữu các bảng này, không được cập nhật, xóa, truncate, tạo trigger hoặc tạo đối tượng trong schema `public`. Quyền INSERT bị từ chối trên migration, marker và biên nhận bootstrap. Phép đo dùng metadata PostgreSQL với role và tên bảng đã định trước. V13.2.2 còn chờ kiểm tương ứng ở slot A và các kho, role ngoài nhóm này. [Biên bản quyền bảng slot B](../.local/evidence/enterprise-e2-v38-r2-pg-protected-tables-1d58541b-b.json)

## Quy tắc quyền theo chức năng, đối tượng và trường trên v39

Đối chiếu mã nguồn của ứng viên `enterprise-rc-v39-staging` với SHA-256 artifact `ca386a02b04a9022a6a23255e463e6aac437f776e55ef4b7276a13dd244a45d0`. Các quy tắc mô tả hành vi tại dịch vụ sở hữu dữ liệu. Grant còn hiệu lực và tenant là điều kiện chung. Mỗi dòng có ca cần đối chiếu bằng cùng ứng viên để theo dõi V8.1–V8.4.

| Nguồn | Đọc, tìm, tải và xuất | Ghi và phạm vi trường | Đối chứng cần chạy lại trên v39 |
| --- | --- | --- | --- |
| Portal và Foundation | Portal liệt kê ứng dụng theo grant và dẫn đến nguồn kiểm quyền. Directory áp quyền đọc theo loại tài nguyên. Danh sách và chi tiết lọc tenant và đơn vị ở truy vấn. Tài khoản dùng `accounts:manage`. | Directory chỉ nhận thuộc tính khai báo trong hợp đồng tài nguyên và yêu cầu quyền quản lý cùng revision. Các liên kết định danh và trường bất biến được xử lý ở ranh giới riêng. | Đối chiếu danh sách với chi tiết khi thiếu quyền, cursor đi qua đơn vị khác, và việc thu hồi grant khi link đang mở. [Quyền ứng dụng](APPLICATION_ACCESS_MODEL.md) |
| Forms | Người điền đọc phiếu của chính mình khi có `forms:respond` trong tenant. Reviewer chỉ đọc phiếu đã gửi trong đơn vị được cấp. `forms:analyze` tổng hợp và `forms:export` xuất CSV theo quyền hiện hành và phiên bản. CSV chứa metadata của phiếu và cột câu trả lời thuộc schema đã phát hành. | Designer sửa schema nháp. Publisher phát hành và thiết lập audience. Người điền chỉ lưu phiếu của mình trong audience, theo schema đã ghim và revision hiện tại. Bộ kiểm phía máy chủ từ chối trường ngoài schema hoặc đang ẩn, từ chối kiểu dữ liệu sai và kiểm trường bắt buộc khi gửi. Phiếu đã gửi giữ nguyên. | So trang và CSV với hai đơn vị, dùng người điền, reviewer và analyst. Đối chiếu phạm vi cursor, mỗi trường trả về và trạng thái sau từ chối. [Form Builder](FORM_BUILDER_MVP.md) |
| Quy trình | Quyền xem lượt, bước và tệp dựa trên tenant, đơn vị, vai trò và phiên bản ghim. `fieldReaders` lọc schema và câu trả lời theo nguồn trường và quan hệ của người xem với hồ sơ. Báo cáo và đầu ra áp lại phạm vi khi chiếu trường. Thư viện kiểm phiên bản tệp và quyền hiện hành. | Người khởi tạo ghi dữ liệu theo hợp đồng biểu mẫu. Người thực hiện chỉ thao tác bước được giao còn mở, dùng revision và các trường cho phép của bước. Trường đầu vào có chế độ đọc/ghi theo bước. Quyền quản lý hồ sơ và quyền xuất báo cáo tách biệt. | Dùng owner, handler và reviewer với tệp riêng và trường bị ẩn. Kiểm đọc URL file, CSV, thử sửa trường chỉ đọc và request kế tiếp sau đổi người xử lý. [Biểu mẫu nghiệp vụ](WORKFLOWS_BUSINESS_FORMS.md) |
| Công việc | Danh sách và báo cáo lấy điều kiện tenant/project, thành viên hiện hành, owner, người được giao và người tham gia. Quyền báo cáo, tra ứng viên và thao tác quản lý được kiểm riêng. | Quản lý dự án hoặc người tạo đủ quyền sửa tiêu đề, mô tả, hạn và cấu hình giao việc. Người được giao có thể cập nhật tiến độ theo trạng thái và quy tắc chuyển của dự án. Bàn giao yêu cầu quyền theo việc, người đích đủ điều kiện và revision hiện tại. | So danh sách, báo cáo và chi tiết bằng actor của hai tenant. Kiểm thao tác dự án đã lưu trữ, mất membership và cập nhật sau bàn giao. [Quyền và luồng Công việc](TASKS_LOCAL_DEVELOPMENT.md) |
| LMS | Người học đọc lớp, media và lịch sử theo liên kết định danh và phiên bản được cấp. DTO học viên loại đáp án gốc. Manager lấy đơn vị và hồ sơ hợp lệ từ Directory hiện hành. Báo cáo và XLSX dùng tập hàng được phép và dữ liệu tổng hợp, không gồm câu trả lời thô của người học khác. | `lms:admin` yêu cầu quyền và MFA khi sửa khóa, media và ngân hàng câu hỏi. Người học ghi tiến độ, lần làm và ghi chú của mình theo phiên bản và quyền còn hiệu lực. XLSX kiểm quyền tại lúc tạo receipt. Learner 403 của workbook đã có bằng chứng thành phần với phiên giả lập. | Kiểm vai trò trực tiếp qua SSO hai slot, đổi grant trong phiên và scope của file, XLSX, dữ liệu lịch sử và workbook. [Báo cáo LMS](LMS_REPORTING.md) · [Ca learner workbook](../.local/evidence/enterprise-e2-v39-workbook-learner-component-review.json) |

Các ca UI/API đã chạy ở các digest cũ dùng để so sánh. Bộ quan sát v39 sẽ đo lại quyền bảng PostgreSQL và cấu hình Keycloak ở hai slot khi profile hostname chạy.

Lúc **15:27:33 ngày 14/11/2026, giờ Việt Nam**, ca Forms API chạy từ snapshot v39 trên AIO local giả lập đạt SSO/MFA, năm vai trò, CSRF, từ chối chéo tenant/đơn vị và trường ẩn, gửi lại một hiệu ứng và CSV đúng quyền. Request đầu tiên sau thu hồi grant bị chặn. Phép đo từ lúc bắt đầu thu hồi đến lúc đọc phản hồi từ chối là **119 ms**. Kết quả này ghi riêng cho AIO local. Hai slot HTTPS của v39 tiếp tục theo profile hostname. [Biên bản Forms API](../.local/evidence/enterprise-e2-v39-forms-api-local-review.json)

### Đối chiếu UI và API trên hai slot v39

Lúc **17:47:34 ngày 14/11/2026, giờ Việt Nam**, biên bản kết hợp hai profile cùng digest v39. Mỗi slot chạy các ca sau bằng phiên staging qua SSO/MFA. [Biên bản quyền UI/API](../.local/evidence/enterprise-e2-v39-staged-access-matrix-review.json)

| Nguồn | Ca đã đối chiếu ở A và B |
| --- | --- |
| Portal | Tìm việc và mở đúng đối tượng tại nguồn. Khóa tài khoản ở nguồn chặn request tiếp theo. |
| Forms | Nộp phiếu, kiểm reviewer và analyst theo phạm vi hàng, đọc tiếp qua cursor, xuất CSV theo quyền và từ chối thao tác trái vai trò. |
| Quy trình | Actor chỉ nhận trường và tệp được cấp. Ca phê duyệt kiểm quyền ở bước được giao. |
| Công việc | Tìm và bàn giao, từ chối đọc chéo tenant và tra ứng viên hoặc báo cáo thiếu quyền. Giữ CAS và phát lại. |
| LMS | Tệp theo phạm vi học viên, tìm và xuất XLSX theo đơn vị, từ chối learner gọi export trực tiếp và từ chối phát lại export sau thu hồi. |

Bốn role PostgreSQL trên mỗi slot chỉ kết nối kho nghiệp vụ tương ứng. Request kế tiếp sau offboarding trả 401 tại Portal, Forms, Quy trình và Công việc, và 403 tại LMS. Ca workbook và reset quản trị còn chờ profile bổ sung của v39. [Ma trận quyền runtime](../.local/evidence/enterprise-e2-v39-runtime-scope-0fb12092-review.json)

### Đối chiếu UI và API trên hai slot v40

Lúc **20:16:38 ngày 14/11/2026, giờ Việt Nam**, kết hợp hostname `65c148f2` và fault `bab0334d` trên cùng artifact và image v40. Biên bản xác nhận các ca trong bảng ở cả hai slot, gồm trường và tệp Quy trình, báo cáo Công việc, CSV Forms và XLSX LMS. Sau khi nguồn xác nhận offboarding, request kế tiếp bị chặn ở cả năm ứng dụng. Phản hồi từ chối cuối cùng đến sau **139 ms ở A** và **185 ms ở B**. Lượt tải slot A đã đối chiếu thêm bốn role kết nối đúng kho nghiệp vụ và quyền ghi trên 41 bảng. [Ma trận v40](../.local/evidence/enterprise-e2-v40-staged-access-matrix-review.json) · [Quyền bảng slot A](../.local/evidence/enterprise-e2-v40-pg-protected-tables-8f03cbc7-a.json)

Lúc **20:49:18 ngày 14/11/2026, giờ Việt Nam**, lượt `a3f603c4` kiểm quyền workbook LMS ở cả hai slot sau SSO. Người học nhận 403 `LMS_PERMISSION_DENIED`. Quản trị viên được xem trước XLSX, XLS và CSV, giữ số 0 đầu. Tệp sai loại trả 400 và tệp bị scanner cách ly trả 422. [Receipt E2 v40](../.local/evidence/enterprise-e2-v40-workbook-reset-a3f603c4-review.json)
