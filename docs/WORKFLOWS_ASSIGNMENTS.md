# Quy trình — Nhóm xử lý và người nhận theo cấu hình

Ngày 10/11/2026. Nâng cấp local sau [bản đầu](WORKFLOWS_ACCEPTANCE.md). [ADR 0006](decisions/0006-workflow-assignment-policies.md) ghi mô hình và nguồn BOS; [runbook](WORKFLOWS_LOCAL_DEVELOPMENT.md) ghi cách vận hành.

Bổ sung: [người duyệt theo cơ cấu](ORGANIZATION_OPERATIONS.md) dùng WorkflowSpec v3 và migration Workflows 003. Rule nhóm/người xử lý bước trước ở v2 và snapshot cũ được giữ.

## Thao tác sử dụng

Điều phối viên vào **Nhóm xử lý** để tạo nhóm, chọn phạm vi và thành viên. Chỉ người đủ quyền xử lý được thêm mới. Có thể bỏ thành viên/ngừng nhóm, cần lý do và đúng revision. Không xóa lịch sử. Thành viên đã mất quyền có thể được loại bỏ hoặc giữ để đối soát; giữ trong nhóm không phục hồi quyền đã thu hồi.

Designer chọn bước → **Cách giao nhiệm vụ**:

- **Người cố định**: giữ cách dùng trước đây.
- **Chọn người trong nhóm** cho phép chọn nhóm và thời điểm chọn người. Mặc định người khởi tạo chọn thành viên khi gửi/gửi lại. Bước phê duyệt loại tài khoản và person của người khởi tạo khỏi danh sách ứng viên.
- **Người đã xử lý bước trước**: chọn một human step chắc chắn đứng trước. Hệ thống lấy người thực sự hoàn thành bước trong cùng lần gửi; người đó vẫn cần quyền hiện hành.

Publisher kiểm tra và phát hành version mới. Cấu hình này không sửa phiên bản cũ. Khi bổ sung/gửi lại, lựa chọn cũ chỉ điền sẵn nếu còn hợp lệ; người đã bị bỏ khỏi nhóm phải được chọn lại. Không tự chọn người khác thay người gửi.

Bỏ thành viên/ngừng nhóm chặn nhiệm vụ liên quan. Inbox loại task không còn hợp lệ; người gửi/điều phối hoặc người có quyền độc lập qua nhiệm vụ khác vẫn có thể xem hồ sơ theo quyền. Điều phối viên được thông báo người/nhóm chưa đủ điều kiện và có thể phân công lại trong pool hợp lệ. Kích hoạt lại nhóm không khôi phục thành viên đã bỏ hoặc grants/roles đã thu hồi.

### Quyền phân công lại theo bước

Trong trình thiết kế, với bước **Chọn người trong nhóm**, mục **Ai được phân công lại?** cho phép cấp quyền cho **Người đang được giao bước** và **Người đã chuyển hồ sơ đến bước**. Điều phối viên vẫn dùng quyền điều phối hiện hành. Cấu hình gắn với phiên bản phát hành v5. Với bước đồng duyệt, điều phối viên tiếp tục quản lý thay thế thành viên như trước.

Người nhận mới phải là thành viên đang hoạt động, có quyền xử lý trong đúng đơn vị và không rơi vào ca tự duyệt. Danh sách ứng viên và lệnh ghi đều kiểm quyền. Nhật ký lưu lý do, người cũ, người mới và vai trò thực hiện. Thời hạn và lựa chọn lúc gửi của vòng giữ nguyên. Người chuyển đi chỉ tiếp tục xem nếu còn quyền đọc hồ sơ từ vai trò khác. Nếu mất quyền đọc, giao diện đưa họ về danh sách việc. Thao tác từ bản xem đã cũ bị chặn theo revision.

Người đã chuyển hồ sơ được xác định bằng sự kiện giao nhiệm vụ ban đầu của chính bước đang chờ. Đổi người xử lý không đổi người chuyển hồ sơ. Quyền hiện hành được kiểm lại trong cùng giao dịch. Phiên bản cũ và journal vẫn dùng được, không cần migration. Có thể phát hành cấu hình mới bỏ quyền bổ sung và ngừng nhận lượt mới trên cấu hình cũ theo [runbook](WORKFLOWS_LOCAL_DEVELOPMENT.md#kiểm-thử-và-rollback). [Tham chiếu cách phân công lại trên AMIS](https://helpamis.misa.vn/amis-quy-trinh/kb/phan-cong-lai-cong-viec/).

### Chuyển nhánh khi từ chối và chọn người khi bàn giao

Trong **Luồng xử lý**, bước phê duyệt có thể cấu hình **Khi từ chối** để tiếp tục tới một bước khác, kể cả bước điều kiện. Nếu để mặc định, từ chối kết thúc lượt chạy. Nhật ký giữ quyết định từ chối ngay cả khi lượt chạy đi tiếp. Hồ sơ nhân sự liên kết vẫn bị chặn áp dụng thay đổi khi có quyết định từ chối trong cùng lần gửi.

Tại bước nhận việc, chọn **Chọn người trong nhóm** → **Thời điểm chọn người** → **Khi bàn giao đến bước**. Người chuyển chọn ứng viên trong hộp xác nhận sau khi nhập dữ liệu cần thiết. Nếu bước nhận việc đứng đầu luồng thực tế, người khởi tạo chọn khi gửi. Với đồng duyệt, chỉ phiếu làm bước kết thúc mới cần chọn người. Khi có thể tới bước bàn giao, publisher phải cấp cho bước chuyển quyền đọc các trường khởi tạo dùng trong những điều kiện có thể đi qua trước bước xử lý tiếp theo.

`POST /tasks/:id/handoff-preview` trả ứng viên theo đích được tính từ phiên bản đã ghim và dữ liệu được chuẩn hóa. Preview không ghi dữ liệu. `POST /tasks/:id/action` nhận `handoff: { stepId, accountId }` khi cần. Server xác minh lại bước đích, revision, quyền xử lý và tư cách thành viên hiện hành. Quyết định, giao việc và audit `handedOffFrom` được ghi cùng giao dịch. Nếu ứng viên hoặc đích thay đổi, mở lại hộp xác nhận để lấy lựa chọn mới.

Hai cấu hình dùng WorkflowSpec v5 và journal hiện có. Để quay lại hành vi mặc định, phát hành phiên bản mới với **Khi từ chối** kết thúc lượt và thời điểm chọn người khi gửi. Duy trì runtime hỗ trợ v5 để xử lý các lượt đã ghim phiên bản có bàn giao. [Thiết lập luồng AMIS](https://helpamis.misa.vn/amis-quy-trinh/kb/thiet-lap-luong-quy-trinh/)

### Mở và hợp các nhánh song song

Trong **Luồng xử lý**, thêm **Song song** để tạo điểm tách và điểm hợp. Chọn **Bước đầu nhánh** cho từng nhánh, nối các đường đi của nhánh về điểm hợp, rồi chọn **Chuyển đến** tại điểm hợp. Mỗi nhánh có thể có nhiều bước, điều kiện hoặc một cụm song song lồng bên trong. Publisher kiểm mỗi đường của nhánh về đúng điểm hợp của nó và từ chối các đường chồng chéo.

Các nhiệm vụ đầu nhánh được giao cùng lúc. Nếu cần chọn người bàn giao ở nhiều nhánh, hộp xác nhận yêu cầu đủ người nhận trước khi ghi. **Cần xử lý** và Trung tâm công việc mở đúng nhiệm vụ. Trong hồ sơ, **Nhiệm vụ đang mở** chuyển giữa các nhánh theo quyền hiện hành. Điểm hợp chỉ mở bước tiếp theo khi đã nhận đủ nhánh. Điều kiện sau điểm hợp có thể dùng kết quả của những bước chắc chắn đã xử lý.

Khi trả về một bước trong nhánh, chỉ các nhiệm vụ phụ thuộc bước đó được mở lại hoặc thay thế. Các nhánh độc lập giữ kết quả. Nếu quay về trước điểm tách, hệ thống đóng nhiệm vụ cũ của các nhánh phụ thuộc, giữ lịch sử và tạo một lần tách mới khi đi tới điểm tách. Khi cần chỉ định rõ nhánh phải xử lý lại từ sau điểm hợp, chọn **Người xử lý chọn bước**.

Migration Workflows 009 lưu từng lần tách, trạng thái đến điểm hợp và liên kết giữa các nhiệm vụ. Để ngừng mở nhánh cho lượt mới, phát hành phiên bản đã bỏ cấu hình song song hoặc ngừng phát hành phiên bản hiện tại. Giữ runtime và migration 009 để các lượt đã ghim phiên bản cũ tiếp tục chạy. [Thiết lập bước song song AMIS](https://helpamis.misa.vn/amis-quy-trinh/kb/thiet-lap-buoc-song-song/)

### Thu hồi hồ sơ và bước đã chuyển

Chọn **Thu hồi hồ sơ** khi bạn là người khởi tạo và lần gửi vẫn đang chờ quyết định. Hồ sơ chuyển sang **Cần bổ sung**. Khi gửi lại, hệ thống tạo lần gửi mới trên phiên bản quy trình đã ghim và giữ lịch sử lần gửi cũ.

Người đã chuyển bước chọn **Thu hồi bước** để sửa và chuyển lại khi các nhiệm vụ phụ thuộc chưa có quyết định hoặc phiếu đồng duyệt. Hệ thống đóng các nhiệm vụ phụ thuộc đang chờ, giữ quyết định cũ trong nhật ký và mở một nhiệm vụ mới ở bước thu hồi. Hạn xử lý của bước được giữ. Các nhánh độc lập tiếp tục xử lý hoặc giữ kết quả đã có. Người thu hồi cần còn quyền xử lý bước. Nếu quyền hoặc revision thay đổi, tải lại hồ sơ để xem thao tác còn khả dụng.

API `POST /api/v1/workflows/runs/:id/recall` dùng quyền hiện hành, `expectedRevision`, lý do và idempotency key. Thêm `sourceTaskId` để thu hồi bước. Migration Workflows 010 lưu sự kiện thu hồi và liên kết với nhiệm vụ bị thay thế. Khi quay lại bản ứng dụng trước đợt này, giữ migration 010 và các bản ghi đã phát sinh. Người khởi tạo vẫn xử lý được hồ sơ đã thu hồi qua **Cần bổ sung**. [Hướng dẫn thu hồi trên AMIS](https://helpamis.misa.vn/amis-quy-trinh/kb/thu-hoi-quy-trinh/)

## Hợp đồng kỹ thuật

### Trả về bước đã xử lý

Trong **Luồng xử lý**, bật **Cho phép trả về** rồi chọn **Khi trả về**. Có thể trả về người khởi tạo, về bước liền trước, cho người xử lý chọn đích hoặc kết thúc lượt. Bước phê duyệt có thể dùng **Khi từ chối** để về bước trước, chọn đích, rẽ tới bước đã cấu hình hoặc kết thúc với trạng thái từ chối. Nếu chưa có bước xử lý trước, chế độ bước liền trước đưa lượt về người khởi tạo.

Đích chọn chỉ gồm các lần xử lý còn hiệu lực trên đường đi của lần gửi hiện tại và người khởi tạo. Sau khi quay về một bước, hệ thống tạo nhiệm vụ mới, áp dụng quy tắc giao việc của phiên bản đã ghim và kiểm lại quyền người nhận. Nếu bước yêu cầu chọn người lúc bàn giao, hộp xác nhận yêu cầu chọn ứng viên trước khi ghi. Dữ liệu đã nhập trước đó của một nhiệm vụ cá nhân có thể điền sẵn theo quyền xem trường. Quyết định, phiếu, dữ liệu và lý do cũ vẫn hiện trong nhật ký với trạng thái đã thay thế. Rẽ nhánh và lấy người xử lý bước trước chỉ dùng lần xử lý còn hiệu lực. Một lần gửi có thể quay lại tối đa 30 lần.

API detail trả `returnTargets` cho người đang có quyền xử lý. Chế độ chọn đích nhận `returnTarget` là ID nhiệm vụ hoặc `initiator` trong cả preview và action. Máy chủ kiểm lại revision, lần gửi và tình trạng đích. Quyết định, quan hệ thay thế, nhiệm vụ mới và audit ghi cùng giao dịch. Hồ sơ nhân sự liên kết cần phê duyệt còn hiệu lực và vẫn giữ quy tắc chặn khi đã có từ chối trong cùng lần gửi.

Migration Workflows 008 bổ sung lần thực hiện và quan hệ thay thế, giữ nguyên kết quả cũ. Để quay lại hành vi trước đây, phát hành phiên bản mới với đích trả về người khởi tạo và đích từ chối phù hợp. Duy trì runtime đọc được lượt cũ đã dùng lần thực hiện mới và giữ migration 008. [Thiết lập luồng AMIS](https://helpamis.misa.vn/amis-quy-trinh/kb/thiet-lap-luong-quy-trinh/)

### Phân công và API nhóm

Migration Workflows **001–002 đã áp dụng và bất biến**. Group/member soft state, ownership immutable, revision; workflow_run_assignments giữ choices và group_revisions theo run/round. Task giữ assignment_group_id không đổi để kiểm quyền trực tuyến. Quyết định, chuyển bước, audit và receipt vẫn nguyên tử.

WorkflowSpec v2 thêm assigneeRule, v1 vẫn được chấp nhận. Khi dùng rule, assignee cố định phải rỗng để không có hai nguồn chỉ định. Không nhận biểu thức thực thi. Kiểm graph chặn tham chiếu tương lai, chính mình, step không phải người xử lý hoặc step chỉ có trên một nhánh.

API mới dưới /api/v1/workflows:

| Endpoint | Quyền/giới hạn |
| --- | --- |
| GET /groups | Metadata cho design/publish/manage theo scope; danh sách member chỉ cho manager đúng scope |
| POST /groups, /groups/:id | Manage/MFA, reason, idempotency; update cần expectedRevision; tối đa 50 member |
| GET /definitions/:id/selections | Start trong unit công tác, đúng version hiện hành, audience; trả candidates hợp lệ |
| GET /runs/:id/selections | Người khởi tạo đang bổ sung, dùng version đã pin |
| GET /tasks/:id/candidates | Nhiệm vụ đang chờ, điều phối viên hoặc vai trò được cấu hình theo bước. Danh sách ứng viên theo nhóm và quyền hiện hành |
| POST /runs, /runs/:id/resubmit | Nhận selections theo node ID; thiếu/giả mạo/out-of-pool bị từ chối |

Version 1 không cần selections. Snapshot lựa chọn không phải quyền cache: group, account, role và app grant vẫn được kiểm lại. Không chuyển credential hay cho domain đọc DB định danh.

## Kiểm chứng hiện tại

- 8 tests mới về contract, scope nhóm, đồng thời/idempotency, candidate/self-approval, live revoke, previous actor và snapshots từng round. 11 tests của module bản trước vẫn pass.
- E2E mới pass lần cuối trong hồi quy kết thúc 2026-11-09T23:45:48Z: manager MFA tạo nhóm qua UI; designer tạo rule v2; người gửi chọn; bỏ member khi task mở; deny inbox/detail/action theo quyền; reassign không thoát pool; bước sau lấy actual actor; trả về/chọn lại và giữ round cũ; ngừng/mở nhóm không hồi member.
- 4 axe scans zero violations (group dialog, assignment designer, requester selection, resubmit mobile); incomplete rules giữ trong evidence. Scan chờ animation kết thúc, không loại luật tương phản.
- Full check qua **103 tests**, format/TypeScript/build. Hồi quy tuần tự gồm Quy trình bản đầu, assignment E2E, onboarding, ba suite Foundation, Forms API/UI và LMS đều pass; kết thúc 2026-11-09T23:48:47Z. [Nghiệm thu cập nhật](WORKFLOWS_ACCEPTANCE.md#nâng-cấp-nhóm-và-người-xử-lý).

Evidence ignored: workflows-assignments-e2e.json, ảnh workflows-assignment-designer/mobile, workflows-assignment-regression.json. Nhóm thực tế đang thử chỉ gồm tài khoản và dữ liệu giả lập của AIO.

Mẫu “Đề nghị mua sắm · Chọn người trong nhóm” đã phát hành tại local bằng workflows:demo-assignments. Đã kiểm lại version v2, nhóm active/hai thành viên và hai kiểu rule; chạy lại cả lệnh mẫu cố định/mẫu nhóm giữ nguyên nội dung 11 bảng Workflows. Evidence workflows-assignment-demo.json; receipt ownership riêng .local/workflows-assignments-demo.json.

## Giới hạn tại checkpoint v2

Đây là mô tả lịch sử của bản v2. Bản hiện hành đã thêm quản lý trực tiếp/trưởng đơn vị, đồng duyệt all/any/quorum, lịch làm việc và thông báo; xem [E0–E4](../roadmap/GOAL_CONFIGURABLE_SUITE.md) và [đối chiếu hiện trạng](WORKFLOWS_AMIS_GAP_ANALYSIS.md).

Chọn người được thực hiện ở đầu mỗi round cho mọi bước nhóm của definition, chưa có chọn người bởi người chuyển bước. Previous selector không thay cơ chế quyền; nếu actor nguồn mất quyền, task chờ đối soát/phân công lại. Nhóm tối đa 50 member, danh sách nhóm tối đa 200. Chưa có nhóm lồng, đồng bộ HR, người duyệt động theo manager/chức danh, parallel/quorum hoặc notifications. Không dùng nâng cấp này để tuyên bố toàn bộ AMIS đã được clone.
