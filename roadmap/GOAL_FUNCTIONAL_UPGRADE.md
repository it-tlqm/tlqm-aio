# Goal nâng cấp chức năng toàn diện

Cập nhật **15/11/2026**, sau khi candidate enterprise `enterprise-rc-v42-final` đã qua E1–E5 trên môi trường cô lập. Goal này tập trung vào khả năng sử dụng và nghiệp vụ liên module của Portal, IAM/Directory, Forms, Quy trình, Công việc, LMS và Work Center. Mỗi lát được kiểm thử trên AIO local hoặc staging với dữ liệu giả lập, ghi receipt theo giờ Việt Nam và giữ nguyên các kiểm soát SSO/MFA/CSRF, quyền tại nguồn, issuer+subject, CAS/idempotency, audit, snapshot, migration và digest.

## Thứ tự thực hiện

1. Khôi phục trạng thái Work Center qua URL, gồm nguồn, view, trang, tìm kiếm, đơn vị, người xử lý và lọc thông báo.
2. Hoàn thiện tác nghiệp Quy trình theo W1–W2. Ưu tiên bảng dữ liệu nghiệp vụ, quyền trường, trả về, bàn giao, phân công lại và các nhánh độc lập.
3. Hoàn thiện phối hợp W3. Bổ sung hồ sơ tổng hợp, bộ lọc lưu được, cột nghiệp vụ, người theo dõi, nhắc tên và kiểm quyền khi mất quyền.
4. Hoàn thiện tự động hóa W4. Đối soát outbox, lịch tạo nháp, retry, thông báo và adapter HR/LMS trên connector giả lập.
5. Nâng cấp Forms, LMS và Work Center theo cùng các nguyên tắc tìm kiếm, báo cáo, thông báo, cấu hình và khả năng phục hồi.
6. Chạy hồi quy liên module, đo hiệu năng local và cập nhật tài liệu trước mỗi mốc.

## Lát đã hoàn thành

### Work Center URL state

Receipt [functional-upgrade-work-center-route-20261115.json](../.local/evidence/functional-upgrade-work-center-route-20261115.json) và [receipt liên module](../.local/evidence/functional-upgrade-work-center-modules-20261115.json) ghi nhận helper route được thêm vào frontend. App Portal nhận diện phần view trước query của hash. Work Center khôi phục nguồn, tab, page, search, unit, assignee và unread filter. Các nguồn Forms, Công việc và LMS giữ thêm view, tìm kiếm và trang riêng sau reload hoặc mở deep link. Query được giới hạn tab, UUID, độ dài tìm kiếm, source code và page trước khi dùng cho request.

Kiểm tra đã đạt `npm run typecheck`, `npm run format:check`, bốn test route trong `tests/work-center-navigation.test.ts` và toàn bộ `npm test` với **277/277 bài pass** sau lát này.

### LMS report filter state

Lát tiếp theo thêm route `#lms-report` có kiểm tra cho đơn vị, khóa học, trạng thái, tìm kiếm, chỉ môn bắt buộc và trang. Báo cáo LMS khôi phục bộ lọc sau reload hoặc deep link, đồng thời login target chỉ nhận query hợp lệ. Receipt [functional-upgrade-lms-report-route-20261115.json](../.local/evidence/functional-upgrade-lms-report-route-20261115.json) ghi nhận 281/281 test pass sau khi thêm hai test route và các test CMS đang có trong worktree.

Các file thay đổi của lát này đã qua typecheck và kiểm tra Prettier riêng. `npm run format:check` toàn repo còn báo ba file `src/cms/access.ts`, `src/cms/contracts.ts` và `tests/cms-contracts.test.ts` đang dirty từ phần khác trong workspace. Tôi giữ nguyên các file đó.

### Forms list search state

Forms list hỗ trợ route `#forms?search=...` để giữ tìm kiếm sau reload hoặc deep link. Parser chỉ nhận khóa `search`, giới hạn 120 ký tự và giữ route Forms detail/SSO hiện hành. Receipt [functional-upgrade-forms-list-route-20261115.json](../.local/evidence/functional-upgrade-forms-list-route-20261115.json) ghi nhận typecheck, formatter riêng và 7 test route pass.

Forms detail hỗ trợ route `#forms/<formId>?tab=...` cho các tab Thiết kế, Phân phối, Phiên bản, Trả lời, Phiếu đã gửi, Tổng hợp và Lịch sử. Tab được kiểm tra lại theo quyền hiện hành khi tải form. Receipt [functional-upgrade-forms-detail-route-20261115.json](../.local/evidence/functional-upgrade-forms-detail-route-20261115.json) ghi nhận 9 test route pass. Hồi quy cuối đạt **286/286 bài pass**.

### Directory people filter state

Danh bạ nhân sự hỗ trợ route `#people` với tab quản trị, tìm kiếm, đơn vị, trạng thái hoạt động và trang. Query sai hoặc không liên quan bị loại bỏ. Receipt [functional-upgrade-directory-people-route-20261115.json](../.local/evidence/functional-upgrade-directory-people-route-20261115.json) và [workspace final](../.local/evidence/functional-upgrade-directory-people-workspace-final-20261115.json) ghi nhận typecheck, formatter riêng và 8 test route pass. Hồi quy cuối sau lát này đạt **285/285 bài pass**.

### Workflow current source review

Đã đối chiếu lại source Quy trình và test hiện hành. Branch/join WorkflowSpec v5, pool approval, cộng tác, attachment/document library, linked requests, scheduling, performance reports, references và field access đều có hợp đồng cùng test tương ứng. Biên bản [functional-upgrade-workflows-current-source-review-20261115.json](../.local/evidence/functional-upgrade-workflows-current-source-review-20261115.json) ghi rõ residual vận hành và production connector.

### Copy route links

Work Center, báo cáo LMS, Forms list và Danh bạ nhân sự có nút sao chép liên kết hiện tại. URL chỉ chứa route và bộ lọc đã được giới hạn. Receipt [functional-upgrade-copy-route-button-20261115.json](../.local/evidence/functional-upgrade-copy-route-button-20261115.json) ghi nhận typecheck, formatter riêng và test route pass.

Các màn này cũng có nút xóa nhanh bộ lọc, đưa state về mặc định và cập nhật URL route tương ứng. Receipt [functional-upgrade-filter-clear-controls-20261115.json](../.local/evidence/functional-upgrade-filter-clear-controls-20261115.json) ghi nhận typecheck, formatter riêng và 9 test route pass.

## Gate bàn giao local/staging

Gate [functional-upgrade-final-gate-20261115.json](../.local/evidence/functional-upgrade-final-gate-20261115.json) ghi nhận 12 nhóm yêu cầu pass cho Portal, IAM/Directory, Forms, Quy trình, Công việc, LMS, Work Center, báo cáo, tìm kiếm/lọc, cộng tác, cấu hình, security invariants, build, hồi quy và tài liệu. Candidate được chấp nhận trong phạm vi AIO local/staging với dữ liệu giả lập. Connector production, ký số, BPMN parity đầy đủ, lịch DST và vận hành production cần phạm vi riêng.

## Bằng chứng cần có cho mỗi lát

- API, frontend, persistence và quyền phải cùng đi qua một workflow thật bằng dữ liệu giả lập.
- Test domain hoặc integration phải kiểm input bất hợp lệ, quyền hiện hành, CAS/idempotency, audit rollback và dữ liệu cũ.
- UI phải kiểm desktop, mobile, keyboard, empty/loading/error state và axe khi lát có giao diện.
- Receipt ghi commit/source state, dirty worktree, thời gian Việt Nam, lệnh kiểm tra, file thay đổi và residual.
- Không sửa migration đã áp dụng, không đọc hoặc ghi database hệ thống cũ và không triển khai remote.
