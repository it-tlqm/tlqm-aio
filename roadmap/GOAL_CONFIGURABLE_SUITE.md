# Goal — Hoàn thiện bộ ứng dụng có thể cấu hình

Ngày 11/11/2026. Người dùng mở rộng mục tiêu: nâng cấp toàn diện Quy trình, LMS, cơ cấu tổ chức và con người, cấu hình mở bằng giao diện, tham khảo các giải pháp như MISA AMIS. Tiếp tục tự triển khai từng mốc, không dừng ở tài liệu/khung UI. Không coi mục tiêu này đã hoàn tất khi mới xong Trung tâm công việc.

**Đã hoàn thành phạm vi E0–E4 trong môi trường local**. Hồi quy cuối kết thúc **11/11/2026 06:20 giờ Việt Nam** (`2026-11-10T23:20:03.140Z`) với **209 tests, 19/19 lệnh pass, 401 source hashes ổn định**. Đã xem ảnh cuối và mở lại toàn bộ stack local. Kiểm Vimeo live được cập nhật riêng tại [roadmap LMS](GOAL_LMS_COMPLETE.md).

Sau phản hồi “Quy trình vẫn rất cơ bản”, đã [đọc sâu tài liệu AMIS và đối chiếu source](../docs/WORKFLOWS_AMIS_GAP_ANALYSIS.md). Kết quả E0–E4 giữ nguyên phạm vi kỹ thuật đã đạt; chưa coi module Quy trình hoàn chỉnh. [Lộ trình W1–W5](WORKFLOWS_NEXT.md) là phần đề xuất tiếp theo, chưa triển khai/nghiệm thu.

Workspace `D:/thanhnx/TLQM-AIO`, nhánh `feat/foundation-mvp`, baseline `abea705b0937fe164fa9c983700089bec88c82ba`, worktree dirty. Chỉ AIO local giả lập; giữ source/dữ liệu/auth LMS/BOS/YMS cũ. Không commit/push/deploy. Tài liệu này ghi tiến độ và nghiệm thu của phạm vi E0–E4.

## Các mốc và tiêu chí hoàn tất

| Mốc | Kết quả cụ thể | Trạng thái |
| --- | --- | --- |
| E0 | Trung tâm công việc, thông báo, worker nhắc hạn, bảng quản lý; hồi quy và tài khoản local | Đã đạt 156 tests/8 lệnh; chốt audit |
| E1 | Cấu hình có phiên bản cho hồ sơ người, đơn vị, chức danh/vị trí: section/field/required/conditions/options, nháp–xem trước–phát hành, giữ dữ liệu cũ; HR ghi metadata theo quyền; nhân viên đề xuất cập nhật các trường được phép và HR duyệt với CAS/audit | Đạt 161 tests/9 lệnh + UI follow-up; checkpoint E1 pass |
| E2 | Quy trình cấu hình nâng cao: chính sách người duyệt nhiều người (tất cả/một người/quorum có ràng buộc), hành động trả về, lịch/SLA và thông báo; mẫu tái sử dụng, kiểm tra cấu hình trước phát hành; lịch sử phiên bản/lượt cũ bất biến | Đạt 171 tests / 10 lệnh, sourceStable=true; 6 axe E2; đã xem ảnh cuối |
| E3 | LMS cấu hình chính sách thi/học: điểm đạt, số lần thi, chờ thi lại, điều kiện hoàn thành; khóa tiên quyết/lộ trình có phiên bản; đối tượng và thời hạn theo đợt đào tạo; báo cáo tiến độ theo cơ cấu; không lộ đáp án hoặc tự sinh chứng nhận | E3a đạt 179 tests/10 lệnh. E3b đạt 186 tests/8 lệnh, sourceStable=true; SSO E2E 7 axe scans, đã xem ảnh |
| E4 | Kết nối các mốc: biểu mẫu nhân sự → duyệt → áp dụng có xác nhận, công việc/nhắc hạn từ đào tạo, cấu hình import/export có preview/diff/validation và kiểm permission; runbook quản trị, rollback, bộ mẫu giả lập trọn luồng | Hoàn tất: E4a 193 tests/10 lệnh, E4b 200 tests/11 lệnh; E4 cuối 209 tests/19 lệnh, sourceStable=true; E4c 12 axe scans, ảnh cuối và stack local đã kiểm |

Mỗi mốc phải có API/UI/data migration additive/tests E2E/ảnh desktop-mobile-keyboard-axe và tài liệu, không chỉ có JSON config hoặc mock. Toàn goal chỉ hoàn thành khi ma trận này có receipt pass tương ứng. Tính năng chưa làm ghi rõ, không quảng cáo ngang bằng toàn bộ AMIS. Không đưa payroll, tính thuế, tuyển dụng, ký số hoặc AI quyết định nhân sự vào phạm vi chỉ vì xuất hiện trên trang tham khảo.

## Nguyên tắc cấu hình

- Cấu hình mở trong tập kiểu/rule được hỗ trợ và có version; không thực thi JS/SQL hoặc biên dịch schema người dùng thành Fastify validator.
- Phân tách cấu hình bố cục/nghiệp vụ với IAM. Trường tên “vai trò/chức danh” không tạo quyền. Backend thực thi quyền trường, record, tenant/unit/delegation; cache/menu/badge không phải security boundary.
- Cấu hình nháp không ảnh hưởng đang chạy; phát hành cần validation/revision/audit. Đổi hoặc bỏ field không xóa lịch sử hay đổi nghĩa bản ghi cũ. Import không ghi đè hoặc mở rộng quyền ngầm.
- Employee self-service là đề xuất trong trường được cho phép; HR duyệt xung đột revision, lưu vết và từ chối khi scope/schema thay đổi. Không thay identity issuer+subject qua metadata.
- Migration mới tiếp theo: Foundation 009+, Workflows 007+, LMS 010+; các journal đã áp dụng giữ nguyên. Suites DB/MFA tuần tự, credentials chỉ chương trình dùng.
- UI React/shadcn, TLQM light palette, Be Vietnam Pro; cấu hình không đòi người dùng sửa mã nguồn. Không đổi nhận diện theo MISA.

## Tham khảo đã kiểm chứng ngày 11/11/2026

1. [AMIS trường mở rộng](https://helpamis.misa.vn/amis-thong-tin-nhan-su/kb/tuy-chinh-truong-mo-rong-thong-tin/): hướng dẫn cấu hình section/field, thứ tự, bắt buộc nhập, preview/khôi phục; dùng làm căn cứ E1, không sao chép tài sản giao diện.
2. [AMIS nhân viên cập nhật hồ sơ](https://helpamis.misa.vn/amis-thong-tin-nhan-su/kb/tuy-chinh-nhan-vien-cap-nhat-ho-so/): cấu hình được xem/cập nhật và HR đồng ý thay đổi; căn cứ self-service có review.
3. [AMIS điều kiện trường](https://helpamis.misa.vn/amis-quy-trinh/kb/thiet-lap-dieu-kien-truong/): rule VÀ/HOẶC, ẩn/hiện và lựa chọn theo điều kiện; đối chiếu với Form Builder AIO đã có để mở rộng có kiểm soát.
4. [AMIS người xử lý](https://helpamis.misa.vn/amis-quy-trinh/kb/thiet-lap-nguoi-thuc-hien-buoc-la-mot-nguoi-cu-the/): người cụ thể và điều kiện chọn người, nháp/phát hành; các phần AIO đã có giữ riêng với phần mới.
5. [AMIS thủ tục nhân sự qua Quy trình](https://helpamis.misa.vn/amis-thong-tin-nhan-su/kb/tao-de-xuat-mot-so-thu-tuc-nhan-su/): đã đọc đầy đủ khi triển khai E4; tham khảo kết nối đề xuất–duyệt–thực thi. Phạm vi AIO ở mốc này là đề xuất trường hồ sơ tùy chỉnh, không phải mọi thủ tục nhân sự của AMIS.
6. [Moodle hạn chế truy cập](https://docs.moodle.org/503/en/Restrict_access): điều kiện ngày/điểm/nhóm/hoàn thành hoạt động; tham khảo E3. [Moodle hoàn thành khóa](https://docs.moodle.org/503/en/Course_completion) phân biệt báo cáo hoàn thành với chặn truy cập; AIO cần kiểm riêng hai hợp đồng.

Các bài blog tổng hợp LMS trên amis.misa.vn không được dùng để tuyên bố đó là chức năng đã có trong sản phẩm AMIS. Phạm vi E2/E3/E4 là đề xuất triển khai AIO từ yêu cầu người dùng, không phải xác nhận đầy đủ parity với một sản phẩm khác. Chưa đăng nhập demo AMIS hoặc kiểm thử runtime của nhà cung cấp.

## Nhật ký checkpoint

Các ghi chú dưới đây được giữ theo thời điểm thực hiện; trạng thái ở bảng mốc và phần nghiệm thu cuối thay thế những dòng “đang chạy/chưa triển khai” của checkpoint cũ.

## Tiến độ E1

- Đã áp dụng Foundation 007 trên local/test, checksum cũ giữ nguyên. Metadata/schema version/history/proposals và DB guards đã có. Mutator self-service bắt buộc callback ownership; không bỏ kiểm tra principal hoặc MFA/CSRF.
- 5 tests domain pass và E2E thật pass 6 axe scans; phát hiện/sửa normalization assertion, xử lý null để xóa trường tùy chọn, cursor cho history/proposal và tên trường đúng version trên hàng đợi. [Runbook E1](../docs/CONFIGURABLE_DIRECTORY.md).
- Hồi quy E1 chạy tuần tự tại `.local/evidence/directory-metadata-regression.json`; chưa gọi toàn bộ E1 hoàn tất trước receipt. Visual cuối cần chụp đầu trang để tránh sticky header bị đặt giữa ảnh full-page.

## Đối chiếu tiếp E2

- [AMIS nhiều người xử lý](https://helpamis.misa.vn/amis-quy-trinh/kb/huong-dan-thiet-lap-nguoi-thuc-hien-nguoi-phe-duyet-amis-quy-trinh/) mô tả cấu hình đồng thời nhiều người và điều kiện chọn người. AIO sẽ thêm policy pool all/any/quorum có snapshot và chống trùng person/self-approval, không tự cấp quyền từ danh sách người duyệt.
- [AMIS lịch làm việc](https://helpamis.misa.vn/amis-quy-trinh/kb/thiet-lap-thoi-gian-lam-viec/) mô tả ngày/ca/lễ và cách tính hạn theo giờ làm việc. AIO dự kiến chụp lịch vào phiên bản phát hành; đổi lịch mới không âm thầm sửa deadline/history của task đang chạy. Đây là quyết định thiết kế AIO, không mô tả AMIS hành xử như vậy.

- E1 hồi quy hoàn tất 19:45:12Z: **161 tests, 9 lệnh pass**, sourceStable=true cho 296 file. Lượt UI follow-up chỉ thay `frontend/src/foundation/metadata.tsx` và `scripts/directory-metadata-e2e.ts` để phân trang hàng đợi, hiện lỗi tại field và chụp ảnh đúng vị trí; giữ nguyên backend/auth/migration. Receipt `.local/evidence/directory-metadata-ui-followup.json`.

## Tiến độ E2 và hướng E3

- Workflows 005 đã áp dụng local/test, không sửa lại migration. Pool all/any/quorum, phiếu bất biến, điều phối thay người chưa duyệt, lịch/phút/return toggle, Work Center và thông báo theo phiên bản phân công đã nối trọn luồng. [Runbook](../docs/WORKFLOWS_ADVANCED.md).
- E2 domain 8 tests pass; SSO/MFA thật đã pass 6 axe scans. Qua xem ảnh đã đổi danh sách đơn vị dài thành bộ lọc/tìm kiếm và vùng cuộn. Đang chạy lại check/SSO/các module tuần tự bằng `test:suite-regression -- e2`; chưa coi receipt cũ là chứng minh source sau thay đổi.
- E3: rà soát thấy ngưỡng 80 còn ở chấm bài, catalogue, cấp chứng nhận, báo cáo và xếp hạng. Chính sách phải dùng nhất quán và giữ snapshot lịch sử. [Moodle Quiz settings](https://docs.moodle.org/503/en/Quiz_settings) mô tả ngưỡng đạt, số lần thi và thời gian chờ; đây là tham khảo cho AIO. [Course completion](https://docs.moodle.org/503/en/Course_completion) phân biệt hoàn thành với hạn chế truy cập; điều kiện tiên quyết AIO cần kiểm backend riêng, không chỉ đổi badge. Đã đọc trang chính thức ngày 11/11/2026; chưa thay runtime LMS trong checkpoint E2.

- Checkpoint E2 hoàn tất 2026-11-10T20:14:53.598Z: **171 tests, 10 lệnh pass, 346 source hashes ổn định** tại `.local/evidence/configurable-e2-regression.json`. Sau checkpoint bắt đầu thay source LMS E3a; không dùng receipt E2 làm bằng chứng cho LMS mới.

- E3a đã thêm policy v3, ngưỡng đạt xuyên kết quả/chứng nhận/báo cáo, giới hạn lần nộp và cooldown atomic, khóa tiên quyết có kiểm trực tiếp API. 8 domain tests pass. [Runbook E3a](../docs/LMS_POLICIES.md); E2E/hồi quy đang chạy. E3b/E4 chưa hoàn tất.

- E3a 007 đã áp dụng local/test, 8 domain tests + SSO E2E 6 axe pass. Source đang đóng băng để chạy 10 lệnh hồi quy E3a; receipt `.local/evidence/configurable-e3-policy-regression.json`. Còn E3b/E4.

- Checkpoint E3a pass 2026-11-10T20:37:33.091Z: **179 tests, 10 lệnh, 351 source hashes ổn định**. Receipt `configurable-e3-policy-regression.json`. Bắt đầu tích hợp E3b sau checkpoint; migration LMS 008 đang soạn, chưa áp dụng persistent.

## Tiếp tục E3b và chuẩn bị E4

- Trạng thái mới nhất thay cho ghi chú chuẩn bị phía trên: **LMS 008 đã áp dụng local/test**. [Runbook](../docs/LMS_TRAINING.md). Lộ trình nháp/phát hành, đợt ghim phiên bản, enrollment, lịch/hủy, tiến độ từ kết quả thật và phạm vi Directory đã có; 7 domain tests và SSO E2E ban đầu pass 6 axe scans.
- Đã xem sáu ảnh UI ban đầu. Bổ sung tìm kiếm/phân trang 10 học viên và tải lại chi tiết; làm rõ tính kết quả đạt trước đây. Hồi quy cuối `e3-training` đang chạy, không dùng receipt ban đầu để chốt source mới. Lượt đầu chỉ lỗi định dạng `src/lms/training.ts`, đã sửa và giữ receipt/log attempt1.
- Đọc đầy đủ [AMIS thủ tục nhân sự qua Quy trình](https://helpamis.misa.vn/amis-thong-tin-nhan-su/kb/tao-de-xuat-mot-so-thu-tuc-nhan-su/): xác nhận luồng đề xuất, gửi duyệt và thực hiện thủ tục sau duyệt. Thiết kế AIO dự kiến dùng adapter nguồn, revision/hash nội dung và HR xác nhận áp dụng; không sao chép quyền hoặc ghi trực tiếp DB module khác. E4 vẫn chưa triển khai.

- Checkpoint E3b kết thúc **2026-11-10T21:50:26Z**, **186 tests, 8/8 lệnh pass, 358 source hashes ổn định**. 7 axe scans E3b cuối; đã xem ảnh dialog và tìm học viên sau UI follow-up. Receipt `.local/evidence/configurable-e3-training-regression.json`. Bắt đầu E4a liên kết đề xuất hồ sơ với Quy trình sau checkpoint; chưa nghiệm thu E4.

- E4a đã triển khai adapter liên kết đề xuất metadata hồ sơ → Quy trình → HR xác nhận áp dụng. **Foundation 008 và Workflows 006 đã áp dụng local/test**, từ đây bất biến. 6 domain tests đầu pass; SSO E2E đang kiểm tra. Đã sửa focus restore dialog và đúng method PATCH của cleanup fixture; hai binding thử nghiệm sót ở lượt `bb19f630` đã được khôi phục qua Governance bằng MFA thật, không đổi quyền khác. [Runbook E4a](../docs/PROFILE_WORKFLOWS.md).
- E4b công việc/nhắc hạn LMS, E4c import/export cấu hình và bộ demo tổng hợp vẫn chưa triển khai. Không gọi toàn E4 complete từ phần liên kết hồ sơ.

## Checkpoint E4a và triển khai E4b/E4c

- E4a hoàn tất hồi quy **2026-11-10T22:11:47.614Z**: **193 tests, 10/10 lệnh, sourceStable=true cho 366 file**. Receipt `.local/evidence/configurable-e4-profile-regression.json`. Sau đó bổ sung E2E gửi từ mobile, ảnh cuối dialog; lượt follow-up chạy trong hồi quy E4b.
- [E4b công việc và nhắc hạn đào tạo](../docs/LMS_WORK_CENTER.md) đã triển khai. **LMS 009 đã áp dụng local/test** và giữ bất biến. 7 domain tests mới pass; SSO E2E 8 axe pass, gồm Portal không tạo phiên LMS giả, proof/audience/tenant/session, thu hồi grant, deep link, native đã đọc và hoàn thành thật. Bổ sung outage/restart và kiểm quyền người nhận nền đã pass trong lượt đang chạy.
- `test:suite-regression -- e4-training` đang chạy tuần tự 11 lệnh; `check` đã đạt **200 tests**. Chưa có receipt cuối, không coi là toàn E4 complete. Source đóng băng trong lượt; phần E4c đang soạn ở `.local/staging/e4-config`, chưa tích hợp hoặc chạy.
- Staging E3/E3b/E4a/E4b trước đó chỉ là bản chuẩn bị cũ; không chép lại vào main source đã cập nhật. Bộ demo tổng hợp và nghiệm thu import/export vẫn còn.

## Nghiệm thu toàn bộ E4

- E4b checkpoint hoàn tất **2026-11-10T22:38:08Z**: **200 tests, 11/11 lệnh, sourceStable=true cho 380 file**, có resilience và backup. Đã xem ảnh mobile cuối của notifications, deep link, native đã đọc và controls HR. Receipt `.local/evidence/configurable-e4-training-regression.json`.
- [E4c nhập/xuất cấu hình](../docs/CONFIGURATION_TRANSFER.md) đã tích hợp vào Directory, Quy trình, khóa học và lộ trình. 8 domain tests và SSO E2E 8 axe scans đầu pass. Đã sửa race đóng dialog trước reload và kiểm file/preview theo quyền. Xuất/nhập chỉ cấu hình nháp, media đối chiếu riêng, không tự cấp quyền hoặc ghi dữ liệu người.
- [Bộ mẫu cấu hình](../examples/configuration/README.md) có bốn gói portable, video giả lập và manifest SHA; parser/test kiểm format, schema và media. Các UUID mẫu bắt buộc đối chiếu qua UI. Kịch bản mẫu chạy qua hồ sơ → duyệt → HR áp dụng và đào tạo → công việc → kết quả; không dùng dữ liệu/credential thật.
- Source đã đóng băng để chạy **19 lệnh** `test:suite-regression -- e4-final`; receipt đích `.local/evidence/configurable-e4-final-regression.json`. Chưa đánh dấu goal này hoàn tất trước receipt pass, kiểm ảnh cuối và xác nhận stack local chạy lại. Goal engine LMS cũ vẫn blocked riêng tại Vimeo live.
- `workflows:review-admin` đã giới hạn assertion grant/binding vào app Quy trình để grant Portal cá nhân đã được phép không làm script lỗi. Chưa chạy lại CLI cấp tài khoản, không thay mật khẩu/MFA hoặc quyền của tài khoản dùng thử từ thay đổi này.

## Kết quả cuối và bàn giao local

- **Pass**: `.local/evidence/configurable-e4-final-regression.json`, bắt đầu `2026-11-10T23:05:22Z`, kết thúc `2026-11-10T23:20:03.140Z`. `check` gồm format, typecheck, **209 tests (0 fail/skip)** và build frontend/backend. 18 lệnh còn lại kiểm nhập/xuất cấu hình, hồ sơ qua Quy trình, LMS Work Center, Directory metadata, nhóm duyệt/assignment/lượt chạy, Work Center, đào tạo/policy/editor/học viên/ngân hàng/báo cáo/LMS, Forms, vận hành tổ chức và ba suite SSO/identity/admin UI. **401 file source giữ nguyên hash** trong toàn bộ lượt.
- E4c cuối đạt **12 axe scans không violations**, có keyboard focus và tải file backup thật. Đã xem bốn ảnh `configuration-transfer-{directory,workflow,course,path}-apply-mobile.png`; receipt visual `.local/evidence/configuration-transfer-visual-review.json`. Những mục axe `incomplete` vẫn cần đánh giá chuyên sâu; không tuyên bố chứng nhận WCAG.
- Mở lại bằng `npm run dev` và `npm run lms:dev` sau khi tests kết thúc. Lúc `2026-11-10T23:20:45.406Z`, sáu client **4100–4105** đều trả readiness và trang chủ 200; LMS xác nhận marker `tlqm-aio-lms-local`. Receipt `.local/evidence/configurable-suite-local-ready.json`. Cả worker nhắc Quy trình và đào tạo chạy theo runtime local.
- Dùng [Portal/tổ chức/nhân sự](http://127.0.0.1:4100), [Forms](http://127.0.0.1:4103), [LMS](http://127.0.0.1:4104), [Quy trình](http://127.0.0.1:4105). [Bộ mẫu và hướng dẫn thử trọn luồng](../examples/configuration/README.md), [nhập/xuất/khôi phục cấu hình](../docs/CONFIGURATION_TRANSFER.md), [hướng dẫn vận hành local](../docs/LOCAL_DEVELOPMENT.md). Dùng tài khoản hiện hữu và quyền hiện hành; không in credential hoặc thay MFA của người dùng.
- Đã kiểm liên kết tương đối của README, goal, các runbook bàn giao và bộ mẫu; không có đích thiếu. Source vẫn là worktree dirty trên baseline đã ghi, không commit/push/deploy.

### Giới hạn đã chốt

- Quy trình nhiều người hiện là đồng duyệt trong một bước (all/any/quorum); chưa phải đồ thị fork/join nhánh song song tùy ý. Lịch dùng UTC offset cố định, không có DST.
- Adapter nhân sự liên kết đề xuất **trường hồ sơ tùy chỉnh**; thủ tục tiếp nhận/điều chuyển/nghỉ việc cấu trúc chưa đi qua adapter này. Chức danh, metadata, import và enrollment không cấp quyền IAM.
- Lộ trình ghim phiên bản khóa; thứ tự là hướng dẫn. Chặn học trước/sau thuộc policy tiên quyết; kết quả đạt trước đây của cùng phiên bản được tính. Hủy đợt giữ lịch sử.
- Bộ mẫu portable có đối chiếu tham chiếu thủ công, không tự cài bộ dữ liệu nghiệp vụ hoặc người dùng. Gói cấu hình không chứa binary media, hồ sơ người, grant/binding; áp dụng nháp và phát hành là hai bước riêng.
- Đợt E0–E4 dùng fixture để kiểm hợp đồng player. Vimeo live được chạy lại riêng sau E4, với kết quả tại [roadmap LMS](GOAL_LMS_COMPLETE.md). Phạm vi nghiệm thu E0–E4 là bộ ứng dụng AIO local với dữ liệu giả lập.
