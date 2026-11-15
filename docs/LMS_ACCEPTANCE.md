# Nghiệm thu LMS — baseline và các mốc chức năng

Cập nhật 11/11/2026. LMS chạy trong AIO local với dữ liệu giả lập, tách biệt dữ liệu và xác thực của LMS hiện hữu. Đã kiểm chứng khóa học, media, học và thi, chứng nhận, ngân hàng câu hỏi, báo cáo Excel và quản trị học viên SSO. Vimeo live đã đạt lại trên Edge sau khi sửa lưu mốc cuối. Tiến độ nghiệm thu bản hiện hành được ghi tại [roadmap LMS](../roadmap/GOAL_LMS_COMPLETE.md). [Runbook](LMS_LOCAL_DEVELOPMENT.md), [học tập](LMS_LEARNING.md), [quản trị học viên](LMS_LEARNER_ADMIN.md), [storage](LMS_STORAGE_OPERATIONS.md).

## Trạng thái chức năng hiện hành — G0 đến G8

Phần mở rộng đã đạt trong [goal bộ ứng dụng có thể cấu hình](../roadmap/GOAL_CONFIGURABLE_SUITE.md) gồm [chính sách học/thi v3](LMS_POLICIES.md), [lộ trình và đợt đào tạo](LMS_TRAINING.md), [công việc và nhắc hạn trong Portal](LMS_WORK_CENTER.md) và [nhập/xuất cấu hình](CONFIGURATION_TRANSFER.md). LMS **001–009** đã áp dụng local/test và giữ nguyên checksum. Thay đổi schema tiếp theo dùng migration 010 trở lên.

Ma trận dưới đây ghi bằng chứng cho từng nghiệp vụ LMS trong AIO.

| Yêu cầu | Hiện trạng kiểm chứng | Bằng chứng local |
| --- | --- | --- |
| Đối chiếu source | 17 file tham chiếu có hash, phân biệt mock với nghiệp vụ; không chạy/sửa LMS gốc | LMS_FUNCTIONAL_SOURCE_SNAPSHOT.json; lms-g7-local-review.json |
| Khóa học và nội dung | Tạo/sửa nháp, danh mục/series, audience AIO, publish/archive, revision/CAS, version bất biến | test:lms-courses, test:lms-authoring |
| Media | Upload bền vững, kiểm checksum/kích thước/chữ ký container; 100 MiB thật; đọc có quyền, HEAD/Range, restart/audit rollback | lms-media-e2e.json |
| Học tập | Catalogue, file/HTTPS và provider, resume/checkpoint, ghi chú riêng. Vimeo live qua Edge, Drive lưu mốc học viên tự xác nhận | lms-learner-e2e.json, lms-providers-e2e.json, lms-vimeo-live-recheck-2026-11-11T09-26-04-610Z.json |
| Bài thi | Single/multiple/text, server grading, gate checkpoint, retake tách retry, snapshot review | test:lms-courses, test:lms-learner, test:lms-questions |
| Thành tích | Chứng nhận từ bài đạt thật, tra cứu có quyền, PNG/PDF; ranking theo scope, không streak/badge giả | lms-learner-e2e.json, lms-certificate-*.png/pdf |
| Ngân hàng/Excel | XLSX/XLS/CSV, preview lỗi, append/replace rõ ràng, atomic apply/retry, export thật, không lộ keys cho learner | lms-questions-e2e.json (8 scans); migration 005 |
| Báo cáo | Gradebook đúng version hiện hành, best/attempts/watched/mandatory/overdue, Directory hiện hành, XLSX bốn sheet | lms-reports-e2e.json (4 scans), lms-g7-local-review.json |
| Học viên/SSO admin | Tạo SSO-only không password LMS, khóa/mở/đối soát; ownership bất biến, proof identity-v1/capability ceiling, MFA thực | lms-provisioning-e2e.json (6 scans); migration 006 |
| Tài khoản dùng thử | lms.admin local có mapping SSO-only; giữ credentials trong local file; người dùng tự làm required actions. Tài khoản QA riêng đã hoàn thành setup → đăng nhập mới OTP → quản trị | lms-g7-local-review.json và lms-provisioning-e2e.json |
| Phân trang | Khóa học/media/lịch sử thi/legacy dùng cursor 100/trang; UI tải đủ hoặc lỗi toàn bộ. Test 501 bản ghi trùng timestamp và 521 dòng legacy | tests/lms-pagination.test.ts; lms-e2e.json (10 scans, UI thấy dòng sau 500) |
| Phục hồi/storage | Khóa độc quyền, D1/R2 backup SHA, restore tách biệt khóa quyền/phiên, nguồn giữ nguyên; orphan/preview cleanup có backup, intent, audit/retry | lms-backup-restore-e2e.json, lms-maintenance-e2e.json; LMS_STORAGE_OPERATIONS.md |

Hồ sơ legacy vẫn giao quyền IAM với role legacy. Với hồ sơ SSO-only, quyền do IAM hiện hành quyết định; role learner trong bảng employees không cản quyền admin đã xác minh MFA. Không ghép danh tính bằng email hoặc tên/mã nhân viên.

Migrations 001–006 đã áp dụng và kiểm checksum ở cả local/test. Không sửa các version này. Các bằng chứng 84/103/115 tests bên dưới là lịch sử các mốc cũ, không phải số kiểm thử của bản hiện hành. Hồi quy G7 đã pass 131 tests và toàn chuỗi LMS/Foundation; G8 pagination đã pass check 133 tests, tiếp đó ba test khóa storage và các rehearsal backup/cleanup riêng pass.

Hồi quy tích hợp **10/11/2026 lúc 11:19:41Z** đạt **19/19 lệnh**, gồm check, LMS, ba suite Foundation E2E, Forms API/UI và Quy trình/assignment. Receipt `.local/evidence/lms-g8-final-regression.json` ghi `sourceStable=true` và hashes. Lượt Vimeo cùng ngày bị timeout; ảnh và receipt thất bại vẫn giữ tại `.local/evidence/lms-vimeo-final-live.json/png`.

Kiểm lại **11/11/2026 lúc 16:26:42 (UTC+7)** với video mẫu thật trên Edge: SDK và iframe HTTP 200, dừng ở 2 giây, nhận đáp án, phát tiếp bằng bàn phím, tự lưu 8/8 giây và mở bài thi. Tải lại giữ tiến độ. Đã xem ảnh 1440px/390px và chạy hai lượt axe trên giao diện AIO. [Chi tiết kiểm video](LMS_LEARNING.md). [Video mẫu trong tài liệu Vimeo Player API](https://github.com/vimeo/player.js#pre-existing-player).

Nghiệm thu bản bàn giao **11/11/2026** đạt **19/19 lệnh**, **223 tests** và **421 hash mã ổn định**. Mở lại LMS local, kiểm XLSX bốn sheet, UI quản trị desktop/mobile và khóa mẫu cho học viên. Tài khoản `lms.admin` đã xác minh yêu cầu MFA và còn bước đổi mật khẩu lần đầu do người dùng hoàn thành. Receipt, ảnh, rollback và hướng dẫn thử nằm trong [roadmap LMS](../roadmap/GOAL_LMS_COMPLETE.md#nghiệm-thu-lại-ngày-11112026).


## Phạm vi kiểm chứng

Workspace D:/thanhnx/TLQM-AIO; nhánh feat/foundation-mvp, HEAD baseline abea705b0937fe164fa9c983700089bec88c82ba. Worktree dirty và chưa commit/push/PR/deploy. Node thực tế 24.20.0. Miniflare 4.20260730.0/workerd, D1 local riêng, openid-client/jose/Web Crypto; không bật nodejs_compat cho adapter. Foundation vẫn TypeScript + Fastify/PostgreSQL.

LMS hiện hữu tại D:/thanhnx/OpenCode/LMS-TLQM/tlqm-learning-mvp chỉ được đọc chọn lọc, không có Git root để xác định snapshot commit. Không sửa, cài dependencies, chạy ứng dụng hoặc dùng database/auth thật. UI ở 4104 ghi rõ sandbox, không giả là UI của LMS hiện hữu. LIMS vẫn để sau.

## Đối chiếu tiêu chí baseline adapter — lịch sử

| Tiêu chí | Bằng chứng |
| --- | --- |
| Portal/Forms → LMS SSO | Browser thật qua A/Forms/Worker; không hỏi lại credential khi có phiên IdP. Confidential client/audience riêng, /me Foundation từ chối token LMS. |
| Xác thực đúng giao thức | Worker dùng Code + PKCE/state/nonce, ID-token signature, access JWT issuer/aud/azp/expiry; Foundation introspection trực tuyến. Cookie/ID token/token client khác không thay bearer đúng audience. |
| Giữ ID và lịch sử | Bốn mapping explicit issuer+subject/account/person/employee; đối chiếu byte-equivalent toàn rows employees, lessons, progress, attempts, notes trước/sau E2E và rollback. Synthetic password hashes không đổi; login không tạo employee. |
| No grant/blocked/unmapped | Callback từ chối và không tạo session/employee. UI giải thích no access; credentials không ghi vào log/ảnh. |
| Quyền và phạm vi | Learner không đọc user khác/admin; reviewer đơn vị A không đọc C; admin cần cả role legacy, quyền AIO và MFA thật. Subject eligibility có proof của backend, chỉ trả Directory tối thiểu cho cùng app/tenant. |
| Quyền trên phiên đang mở | Thu hồi grant, role, application, account hoặc kết thúc công tác được kiểm lại qua HTTP. Reviewer/admin loại học viên có mapping đơn vị cũ hoặc account bị khóa; UI xóa dữ liệu cũ khi tải lại thất bại. |
| Session và đồng thời | Payload mã hóa ràng buộc app/environment/hash; CSRF theo origin/session. Sáu request Worker đồng thời chỉ rotate refresh token thật một lần, absolute deadline giữ nguyên. D1 test race logout/renewal không hồi session; lỗi dependency không tăng idle deadline. |
| Logout/replay | Keycloak phát logout token ký thật; Worker xóa session, duplicate không tăng audit hoặc hủy phiên mới; sai client/chữ ký bị từ chối. Token thử chỉ ở RAM. |
| Outage/recovery | Dừng Foundation HTTP, PostgreSQL/IdP Docker đúng local project; warm/cold Worker từ chối và không gia hạn session. Phục hồi kiểm lại quyền. Marker D1 bị mất được mô phỏng và phục hồi, không tuyên bố mất ổ đĩa đã thử. |
| Mapping và rollback | Ownership không chuyển account/person/employee/tenant, audit append-only; CLI MFA + delegation, revision/idempotency. Disable adapter/mapping giữ lịch sử, enable không hồi grant/binding/session cũ. Chuyển unit qua operator cần nguồn Directory hiện hành, nâng auth_not_before. |
| Setup chạy lại | MFA operator thật; khóa mapping/adapter, thu hồi grant/binding rồi lms:setup vẫn giữ trạng thái. Credentials/OTP seeds và lịch sử không đổi; chỉ explicit restore có audit mới phục hồi fixture. |
| Frontend | React/Vite/Tailwind v4/shadcn thật, TLQM/Be Vietnam Pro local; learner/reviewer/admin/loading/empty/error/no access; desktop 1440/mobile 390. Năm axe scans không violation; incomplete rules giữ trong evidence, không chứng nhận WCAG. Đã xem ảnh learner desktop/mobile và admin. |

## Bằng chứng baseline — lịch sử

- npm run check cuối kết thúc 2026-11-09T20:00:46Z: 84 tests, 0 fail/skip; Prettier, TypeScript strict và build UI/API pass. Bao gồm 9 test LMS/proof/D1; không bỏ các tests Foundation/Forms.
- test:lms: pass 2026-11-09T19:59:45Z; revoke grant 25 ms trong local không tải, không là SLA. Bao gồm wrong PKCE/nonce qua code exchange thật, subject eligibility, quyền account/unit hiện hành, font/tokens/44px/CSP và năm axe scans.
- test:lms-resilience: pass 2026-11-09T20:00:06Z; outage/replay/expiry theo bảng trên. JWKS unavailable phân biệt 503 với chữ ký/token sai 401. Các thông báo ConnectEx connection-refused xuất hiện trong lúc diễn tập dừng dịch vụ; toàn suite kết thúc exit 0.
- test:lms-onboarding cuối kết thúc 2026-11-09T20:02:03Z, gồm CLI MFA và setup preservation trên code cuối. Đã phân biệt replay counter OTP dự kiến tăng với OTP seed phải giữ nguyên. lms:status xác nhận local/test adapter và bốn mapping active sau explicit restore.
- Hồi quy Foundation test:e2e cả ba suites pass: security lifecycle 19:57:30Z, identity 19:58:19Z, admin UI 19:58:51Z (17 scans). Forms API 19:59:01Z và Forms UI 19:59:31Z (13 scans) đều pass trên extension LMS.
- npm audit, cả dependencies dev: 0 advisory ở lần kiểm tra này. Không thay bằng container image scan.
- Runtime fixes đã được test: Miniflare router has_user_worker, fetch redirect manual để không chuyển bearer theo 3xx, consume bounded POST body trước từ chối CSRF để tránh ECONNRESET trên kết nối workerd tái dùng, RETURNING cho CAS D1 vì meta.changes gồm cả trigger writes.

Artifacts ignored dưới .local/evidence: lms-e2e.json, lms-resilience.json, lms-rehearsal.json, lms-runtime-spike.json, lms-npm-audit.json, lms-final-checks.json; ảnh lms-learner-desktop/mobile và lms-admin-desktop. Snapshot cuối lms-revision.json ghi hash từng file source/config/docs và metadata dirty trên HEAD baseline; không có credentials, D1 data hoặc token. Các snapshot Foundation/Forms trước đó giữ làm bằng chứng lịch sử, không đại diện cho code LMS mới.

## Nâng giao diện học viên và theo dõi — 10/11/2026

Theo yêu cầu ưu tiên LMS, đã thay màn lịch sử đơn giản bằng dashboard học tập dùng cùng shadcn/TLQM: thống kê từ dữ liệu trả về, thẻ bài học có metadata và tiến độ, tìm kiếm không phân biệt dấu, lọc trạng thái và xem chi tiết theo lesson_id. Reviewer/admin có tìm kiếm học viên–bài học, lọc phòng ban lưu trong hồ sơ LMS, thống kê trong tập dữ liệu được tải và phân trang 10 dòng. [Cách sử dụng và giới hạn](LMS_LOCAL_DEVELOPMENT.md#giao-diện-học-tập-và-theo-dõi).

Worker chỉ bổ sung các cột metadata được chọn rõ ràng trong truy vấn đọc, giữ toàn bộ hàng rào auth/scope và subjects proof. Không đổi migration 001–002, grants/mapping hoặc dữ liệu học. Không trả answer key, answers/snapshot bài kiểm tra hay URL video. Phần Table dùng chung bổ sung containerProps để vùng cuộn ngang LMS có tên, focus và phím mũi tên; component không được truyền props mới giữ cấu trúc cũ.

`test:lms` pass lúc 2026-11-10T04:22:13Z: 8 axe scans không violation, giữ incomplete trong artifact. Đã kiểm tra tìm kiếm không dấu, trạng thái rỗng/hoàn thành, mở/đóng chi tiết và trả focus, tách ghi chú/kết quả giữa nhiều bài, phân trang 12 dòng rồi đổi bộ lọc về trang đầu, lọc phòng ban, cuộn bảng bằng bàn phím, thu hồi quyền xóa dữ liệu cũ trên UI. Dữ liệu bổ sung chỉ trong database test và được dọn theo ID riêng; đối chiếu toàn bộ bảng lịch sử trước/sau vẫn khớp. Đã xem ảnh desktop 1440/mobile 390 của học viên, quản trị và chi tiết bài học. Không tuyên bố chứng nhận WCAG đầy đủ.

`npm run check` pass 2026-11-10T04:22:55Z: format, TypeScript, 103 unit/integration tests và build frontend/backend. `npm run test:e2e` pass cả ba suite Foundation SSO, identity và admin UI, kết thúc 2026-11-10T04:25:40Z; bao gồm hồi quy Table dùng chung.

Evidence mới: `.local/evidence/lms-e2e.json`, `lms-ui-regression.json`, ảnh `lms-learner-desktop.png`, `lms-learner-mobile.png`, `lms-admin-desktop.png`, `lms-admin-mobile.png`, `lms-lesson-detail-mobile.png`; snapshot hash `lms-ui-revision.json`. Worktree vẫn dirty trên baseline/nhánh nêu đầu tài liệu, chưa commit. Snapshot baseline LMS cũ không đại diện đợt sửa giao diện này.

## Phục hồi callback đăng nhập — 10/11/2026

Sau phản hồi `LOGIN_TRANSACTION_INVALID`, bổ sung recovery riêng cho Worker LMS tại callback GET nhận HTML. Cookie tạm thiếu hoặc transaction hết hạn/đã dùng chuyển 303 đến `/#login-recovery`; nút Đăng nhập lại tạo transaction mới. Không đổi hạn 5 phút, không tự lặp redirect, không trao đổi code mồ côi, không thay đổi session hợp lệ đang có. API JSON/wildcard/HTML q=0 vẫn nhận HTTP 400. State/nonce/PKCE sai vẫn bị từ chối 401.

`test:lms` pass 2026-11-10T04:31:53Z với 9 axe scans: tái hiện hết hạn sau nhập mật khẩu, kiểm chưa tạo session trước recovery, click sang SSO thành công với state/nonce/code_challenge khác; callback cũ sau khi có session không xóa session; mã lỗi JSON giữ nguyên. Màn phục hồi mobile đã xem trực tiếp. Bổ sung điều kiện chờ dashboard tải xong trong helper login trước test thu hồi quyền, tránh request nền của UI thu hồi phiên trước request kiểm thử chủ đích; không đổi status mong đợi hoặc giảm kiểm tra quyền.

Evidence ignored: `lms-login-recovery-regression.json`, `lms-login-recovery-mobile.png`, `lms-login-recovery-live.json`, snapshot `lms-login-recovery-revision.json`. Cùng worktree dirty/nhánh/baseline nêu đầu tài liệu, không migrate/seed hoặc triển khai hệ thống hiện hữu.

Hồi quy sau bản sửa: `check` pass 103 tests, format, TypeScript và build; `test:e2e` pass ba suite SSO, identity và admin UI. Timestamps từng lệnh nằm trong receipt regression ở trên.

## Domain học tập và chứng nhận — 10/11/2026

Các bảng lms_* riêng từ migration 003 phục vụ nháp/phát hành, R2 media, catalogue/player/checkpoint/ghi chú/bài thi. Migration 004 bổ sung chứng nhận bất biến, không sửa migration đã áp dụng. [Hướng dẫn sử dụng](LMS_LEARNING.md), [media](LMS_MEDIA.md).

`test:lms-learner` pass 06:20Z: video native thật, resume sau reload, ba dạng câu hỏi, server grading, intentional retake và retry sau mất response, version snapshot, archive và chặn quyền. Bổ sung chứng nhận từ bài đạt, từ chối bài chưa đạt/peer ngoài scope, kiểm reviewer/admin qua subject eligibility hiện hành, tra cứu, download PNG và in PDF. Thu hồi grant trên phiên đang mở chặn chứng nhận/ranking và xóa nội dung trên UI. Có 10 axe scans không violation; incomplete checks ghi trong receipt. Đã xem ảnh desktop/mobile, ảnh PNG xuất và PDF một trang render bằng Poppler; không suy ra chứng nhận WCAG đầy đủ.

Chứng nhận không chứa chữ ký/con dấu giả. Xếp hạng lấy điểm tốt nhất mỗi khóa, không cộng lại version/retake và đồng hạng khi cùng chỉ số. Không có streak/badge ngày nhận bịa. Test domain kiểm immutable/atomic audit failure/concurrent receipt và current subject/unit; test browser dùng SSO/MFA thật trong AIO test. Bằng chứng `.local/evidence/lms-learner-e2e.json`, `lms-certificate-*.png/pdf`, `lms-ranking-*.png`. Hồi quy sau mốc này ghi riêng `lms-achievements-regression.json`.

Hồi quy phát hiện Directory/identity picker cắt mất hồ sơ sau 500 bản ghi. Đã sửa cursor API và frontend tải đủ trang; test 503 hồ sơ đồng tên, scope và lỗi trang sau pass. Bản cuối `check` **115 tests**, ba suite Foundation E2E và learner E2E **10 scans** đều pass, kết thúc 06:32Z; receipt `lms-achievements-pagination-regression.json`. Chứng nhận PDF được render kiểm một trang A4, không cắt nội dung. Migration 004 đã áp dụng local/test; không sửa 001–004.

## Giới hạn hiện hành

Ngân hàng và Excel câu hỏi: [runbook G6](LMS_QUESTIONS.md). `test:lms-questions` đã pass 8 axe scans lúc 07:00:59Z, gồm bản ghi lỗi, retry mất response, XLSX/XLS/CSV, phân trang 53 câu, checkpoint và bài thi nhập chấm server, bảo toàn version đã phát hành và revoke grant. Migration 005 đã áp dụng test, không thay 001–004. Hồi quy và phục hồi sau sự cố Docker được ghi trong goal/receipts riêng; không đồng nhất mốc G6 với nghiệm thu toàn LMS.

- Chức năng LMS mới đã được chạy tại AIO; build/runtime Vinext, database D1 hiện hữu và người dùng thật không được tác động. [Call-site plan](LMS_SSO_INTEGRATION.md) giữ phạm vi kết nối hệ thống cũ tách biệt.
- Không thay chương trình học, video, câu hỏi/đáp án hoặc thuật toán của source LMS hiện hữu. Domain lms_* trong AIO có nghiệp vụ mới và giữ độc lập các bảng lịch sử legacy; tiến độ nghiệm thu theo goal chức năng.
- Chỉ HTTP loopback và credentials trong .local. D1/R2 backup/restore/cleanup đã được diễn tập; TLS, secret store/rotation, shared rate limiting, HA/load test và topology production chưa được triển khai.
- Các danh sách LMS đã có cursor, không cắt ở 500; subject batches vẫn 100 IDs và được ghép đủ. Không suy ra SLA hoặc tải production từ các fixture >500 bản ghi.
- Rate limiting trong một isolate; mapping mới qua API quản trị có verified identity proof + MFA, hoặc setup operator cho fixtures. Workflow HR xác minh người thật không được thay bằng matching email/code.
- Khi refresh token đã rotate nhưng dependency kế tiếp lỗi, request từ chối và có thể cần đăng nhập mới; không lưu payload chưa xác minh để cố duy trì phiên.
- Thời gian session kiểm qua deadline trong DB/token fixture; không tuyên bố đã chờ 60 phút hoạt động thực. Web accessibility tự động không thay đánh giá đầy đủ với người dùng.
