import { ApiError } from './api';

const messages: Record<string, string> = {
  CONFIGURATION_TOO_LARGE:
    'Cấu hình vượt giới hạn 256 KB hoặc có quá nhiều đối tượng để xử lý. Hãy chia thành tệp nhỏ hơn.',
  CONFIGURATION_INVALID: 'Cấu hình có dữ liệu hoặc thuộc tính không được hỗ trợ.',
  CONFIGURATION_PACKAGE_INVALID:
    'Tệp không đúng định dạng TLQM AIO v1 hoặc khác loại cấu hình đang mở.',
  CONFIGURATION_MAPPING_INVALID:
    'Danh sách đối chiếu chưa hợp lệ. Hãy chọn lại các đối tượng thay thế.',
  CONFIGURATION_REFERENCE_INVALID: 'Tệp có mã tham chiếu không hợp lệ.',
  CONFIGURATION_REFERENCE_UNAVAILABLE:
    'Có đơn vị, người xử lý, nhóm, khóa học hoặc tệp không còn phù hợp. Đối chiếu lại rồi xem trước.',
  CONFIGURATION_REFERENCE_KIND: 'Tệp đã chọn không đúng loại nội dung cần dùng.',
  CONFIGURATION_REVIEW_INVALID:
    'Bản xem trước không còn hợp lệ. Hãy xem trước khác biệt một lần nữa.',
  CONFIGURATION_REVIEW_OWNER_MISMATCH:
    'Bản xem trước thuộc người dùng hoặc cấu hình khác. Hãy mở lại bằng tài khoản hiện tại.',
  CONFIGURATION_PREVIEW_STALE:
    'Cấu hình hoặc cách diễn giải đã thay đổi. Hãy xem trước lại trước khi ghi.',
  CONFIGURATION_KIND_INVALID: 'Loại cấu hình này chưa được hỗ trợ.',
  CONFIGURATION_TARGET_NOT_FOUND: 'Không còn cấu hình đích trong phạm vi được phép.',
  CONFIGURATION_SAVE_FIRST: 'Lưu bản nháp đầu tiên trước khi nhập hoặc xuất cấu hình.',
  LMS_WORK_SOURCE_UNAVAILABLE:
    'Nguồn Đào tạo tạm thời chưa sẵn sàng. Hãy tải lại khi dịch vụ hoạt động.',
  LMS_WORK_CONTRACT_INVALID: 'Dữ liệu công việc từ Đào tạo chưa hợp lệ. Chưa hiển thị kết quả.',
  LMS_TRAINING_NOTICE_UNAVAILABLE: 'Thông báo không còn hiệu lực hoặc không thuộc quyền của bạn.',
  LMS_PORTAL_READ_ONLY: 'Thao tác này cần mở trực tiếp module Đào tạo và đăng nhập SSO.',
  PORTAL_SESSION_REQUIRED: 'Hãy đăng nhập Portal để xem công việc đào tạo.',
  PROFILE_WORKFLOW_REQUIRED:
    'Đề xuất đã gắn quy trình. Hãy mở Quy trình phê duyệt để kiểm tra và xác nhận áp dụng.',
  PROFILE_WORKFLOW_NOT_APPROVED:
    'Quy trình chưa hoàn thành với ít nhất một bước phê duyệt độc lập.',
  PROFILE_WORKFLOW_MISMATCH:
    'Nội dung đề xuất và lượt phê duyệt không khớp. Chưa áp dụng thay đổi.',
  PROFILE_WORKFLOW_ALREADY_LINKED:
    'Đề xuất đã được chốt cho một lượt quy trình. Mở lượt đã liên kết hoặc rút đề xuất để tạo lại.',
  PROFILE_DISPATCH_OWNER_REQUIRED: 'Chỉ người đã gửi duyệt được gửi lại lượt đang chuẩn bị.',
  WORKFLOW_SOURCE_INVALID: 'Nội dung đề xuất nguồn không hợp lệ hoặc vượt giới hạn.',
  WORKFLOW_SOURCE_SELF_APPROVAL:
    'Chủ hồ sơ không được phê duyệt đề xuất của mình. Hãy chọn người duyệt độc lập.',
  WORKFLOW_SOURCE_INPUT_IMMUTABLE:
    'Lượt gắn đề xuất giữ nguyên nội dung đã chốt. Muốn sửa thông tin, hãy rút đề xuất và gửi đề xuất mới.',
  PROFILE_CONFIGURATION_INVALID:
    'Cấu hình trường hoặc quyền tự cập nhật chưa hợp lệ. Hãy kiểm tra các trường đã chọn.',
  PROFILE_SELF_CONDITION_HIDDEN:
    'Trường nhân viên được xem không được phụ thuộc vào một trường bị ẩn khỏi nhân viên.',
  PROFILE_CONFIGURATION_UNPUBLISHED: 'Chưa có cấu hình thông tin mở rộng được phát hành.',
  PROFILE_FIELD_TYPE_IMMUTABLE:
    'Trường đã phát hành không được đổi loại dữ liệu. Hãy thêm trường mới để giữ lịch sử.',
  PROFILE_SCHEMA_CHANGED:
    'Cấu hình đã thay đổi. Tải lại và gửi đề xuất mới theo phiên bản hiện hành.',
  PROFILE_FIELD_DENIED: 'Đề xuất có trường không được phép sửa hoặc chưa có thay đổi.',
  PROFILE_SELF_DENIED: 'Bạn không có quyền cập nhật hồ sơ cá nhân trong không gian này.',
  PROFILE_TARGET_INACTIVE: 'Hồ sơ đã ngừng hoạt động, không thể ghi thông tin mới.',
  PROFILE_PROPOSAL_INVALID:
    'Thông tin đề xuất chưa hợp lệ hoặc hồ sơ cần HR bổ sung trường bắt buộc. Hãy kiểm tra lại.',
  PROFILE_PROPOSAL_LIST_LIMIT:
    'Danh sách đề xuất vượt giới hạn tổng hợp; cần phân trang hoặc lọc trước khi tiếp tục.',
  WORK_CENTER_TOO_MANY_ITEMS:
    'Phạm vi có quá nhiều bản ghi để tổng hợp. Hãy liên hệ quản trị để phân vùng dữ liệu; hệ thống chưa trả số liệu một phần.',
  WORK_CENTER_NOTIFICATION_UNAVAILABLE:
    'Thông báo không còn khả dụng hoặc bạn đã mất quyền xem hồ sơ nguồn. Hãy tải lại.',
  ORGANIZATION_WORKBOOK_INVALID:
    'Tệp Excel không hợp lệ, có macro hoặc cấu trúc nén không an toàn.',
  ORGANIZATION_WORKBOOK_TOO_LARGE: 'Tệp Excel phải có dữ liệu và không vượt quá 2 MB.',
  ORGANIZATION_WORKBOOK_SHEETS: 'Chỉ nhận các sheet DonVi, ChucDanh, ViTri, NhanSu từ tệp mẫu.',
  ORGANIZATION_WORKBOOK_LIMIT: 'Tệp vượt quá 500 dòng hoặc số cột trong tệp mẫu.',
  ORGANIZATION_WORKBOOK_ERRORS: 'Tệp còn lỗi. Hãy sửa và xem trước lại trước khi nhập.',
  ORGANIZATION_WORKBOOK_QUARANTINED: 'Tệp không qua kiểm tra an toàn. Hãy chọn tệp khác.',
  ORGANIZATION_WORKBOOK_SCANNER_UNAVAILABLE: 'Chưa thể kiểm tra an toàn tệp. Hãy thử lại sau.',
  WORKFLOW_ORGANIZATION_EMPLOYMENT_AMBIGUOUS:
    'Cần đúng một vị trí chính đang hiệu lực của người gửi trong đơn vị lượt chạy.',
  WORKFLOW_ORGANIZATION_RESPONSIBLE_MISSING:
    'Chưa có người quản lý/trưởng đơn vị còn hiệu lực. Hãy cấu hình cơ cấu trước khi gửi.',
  WORKFLOW_ORGANIZATION_SUBSTITUTE_CHAIN:
    'Quan hệ thay thế bị trùng hoặc tạo chuỗi nhiều tầng. Chỉ nhận một người thay thế trực tiếp.',
  WORKFLOW_ORGANIZATION_ACCOUNT_AMBIGUOUS:
    'Người phụ trách cần đúng một tài khoản SSO còn hiệu lực và có quyền xử lý tại đơn vị này.',
  WORKFLOW_ORGANIZATION_CHANGED:
    'Người phụ trách theo cơ cấu đã đổi. Điều phối viên cần đối soát và giao lại nhiệm vụ.',
  PERSONNEL_PREVIEW_EXPIRED:
    'Bản xem trước đã quá 15 phút hoặc thời điểm thực hiện không hợp lệ. Hãy xem trước lại.',
  PERSONNEL_PREVIEW_STALE:
    'Dữ liệu đã đổi sau lần xem trước. Hãy tải lại và rà soát trước khi thực hiện.',
  PERSONNEL_OTHER_TENANT_MEMBERSHIPS:
    'Tài khoản còn hoạt động ở không gian khác. Cần xử lý riêng để không thu hồi nhầm phạm vi.',
  PERSONNEL_FUTURE_ASSIGNMENT:
    'Có công tác hoặc bổ nhiệm tương lai cần rà soát trước khi điều chuyển/nghỉ việc.',
  PERSONNEL_EMPLOYMENT_ENDED: 'Quan hệ công tác chưa bắt đầu hoặc đã kết thúc.',
  RESPONSIBILITY_CYCLE:
    'Quan hệ này tạo vòng lặp quản lý hoặc thay thế trong cùng thời gian hiệu lực.',
  RESPONSIBILITY_GRAPH_TOO_COMPLEX:
    'Cấu trúc quan hệ quá phức tạp. Hãy rà soát các nhánh liên quan.',
  RESPONSIBILITY_SELF_REFERENCE: 'Một người không thể quản lý hoặc thay thế chính mình.',
  RESPONSIBILITY_INVALID_PERIOD: 'Thời điểm kết thúc phải sau thời điểm bắt đầu.',
  RESPONSIBILITY_EMPLOYMENT_INVALID:
    'Nhân sự phải cùng pháp nhân, còn hoạt động và có thời gian công tác bao trùm phân công.',
  RESPONSIBILITY_OVERLAP:
    'Đã có người phụ trách trong khoảng thời gian này. Hãy kết thúc phân công cũ trước.',
  WORKFLOW_GROUP_UNAVAILABLE:
    'Nhóm xử lý đã ngừng, không tồn tại hoặc không thuộc phạm vi đơn vị này.',
  WORKFLOW_GROUP_EMPTY:
    'Nhóm chưa có người đủ quyền xử lý. Hãy bổ sung thành viên và quyền ứng dụng trước khi phát hành.',
  WORKFLOW_GROUP_MEMBER_DENIED: 'Người được chọn không còn là thành viên hợp lệ của nhóm xử lý.',
  WORKFLOW_SELECTION_REQUIRED:
    'Vui lòng chọn một người đủ quyền trong nhóm cho từng bước yêu cầu lựa chọn.',
  WORKFLOW_ASSIGNMENT_INVALID: 'Lựa chọn người xử lý không khớp cấu hình của quy trình.',
  WORKFLOW_HANDOFF_REQUIRED: 'Hãy mở lại xác nhận và chọn người nhận bàn giao.',
  WORKFLOW_HANDOFF_CHANGED: 'Bước tiếp theo hoặc người nhận đã thay đổi. Hãy mở lại xác nhận.',
  WORKFLOW_RETURN_TARGET_REQUIRED: 'Chọn bước cần trả về.',
  WORKFLOW_RETURN_TARGET_CHANGED: 'Bước đã chọn không còn hợp lệ. Hãy tải lại lượt chạy.',
  WORKFLOW_RETURN_LIMIT: 'Lần gửi này đã đạt giới hạn 30 lần quay lại bước trước.',
  WORKFLOW_PARALLEL_CHANGED: 'Trạng thái nhánh đã thay đổi. Hãy tải lại lượt chạy.',
  WORKFLOW_RECALL_UNAVAILABLE: 'Không thể thu hồi ở trạng thái hiện tại. Hãy tải lại lượt chạy.',
  WORKFLOW_ATTACHMENT_NAME_INVALID: 'Tên tệp chứa ký tự không hợp lệ.',
  WORKFLOW_ATTACHMENT_TOO_LARGE: 'Tệp vượt giới hạn dung lượng của trường.',
  WORKFLOW_ATTACHMENT_CONTENT_INVALID: 'Không đọc được nội dung tệp.',
  WORKFLOW_ATTACHMENT_TARGET_CLOSED: 'Hồ sơ hoặc nhiệm vụ đã thay đổi. Hãy tải lại.',
  WORKFLOW_ATTACHMENT_FIELD_INVALID: 'Trường này không nhận tệp đính kèm.',
  WORKFLOW_ATTACHMENT_NOT_FOUND: 'Tệp không còn khả dụng.',
  WORKFLOW_INVALID_GROUP: 'Vui lòng kiểm tra tên, phạm vi và trạng thái nhóm xử lý.',
  WORKFLOW_INVALID_GROUP_MEMBERS: 'Nhóm nhận tối đa 50 tài khoản, không trùng lặp.',
  WORKFLOW_PREVIOUS_ACTOR_UNAVAILABLE:
    'Chưa tìm thấy người đã hoàn thành bước tham chiếu trong lần gửi hiện tại.',
  WORKFLOW_PERMISSION_DENIED: 'Bạn chưa có quyền thực hiện thao tác này trong phạm vi quy trình.',
  WORKFLOW_FOLLOWER_UNAVAILABLE: 'Người được chọn hiện không đủ quyền theo dõi hồ sơ.',
  WORKFLOW_FOLLOWER_LIMIT: 'Mỗi hồ sơ có tối đa 50 người theo dõi.',
  WORKFLOW_FOLLOWER_CONFLICT: 'Danh sách người theo dõi đã thay đổi. Tải lại hồ sơ để kiểm tra.',
  WORKFLOW_COMMENT_INVALID: 'Kiểm tra nội dung bình luận và người được nhắc tên.',
  WORKFLOW_WORKSPACE_INVALID: 'Kiểm tra tên, bộ lọc và cột hiển thị.',
  WORKFLOW_WORKSPACE_LIMIT: 'Mỗi danh sách có tối đa 20 bộ lọc đã lưu.',
  WORKFLOW_WORKSPACE_CONFLICT: 'Bộ lọc đã thay đổi. Tải lại trang để cập nhật.',
  WORKFLOW_LINK_INVALID: 'Kiểm tra tên quy tắc, hai quy trình và các trường đã ghép.',
  WORKFLOW_LINK_MAPPING_INVALID: 'Kiểu trường hoặc giá trị nguồn không phù hợp với trường đích.',
  WORKFLOW_LINK_CONDITION_INVALID: 'Chọn trường và giá trị hợp lệ cho điều kiện tạo nháp.',
  WORKFLOW_LINK_FIELD_DENIED: 'Người nhận hiện không có quyền đọc trường nguồn.',
  WORKFLOW_LINK_RECIPIENT_UNAVAILABLE: 'Người nhận không còn quyền khởi tạo trong đơn vị này.',
  WORKFLOW_LINK_CYCLE: 'Quy tắc này tạo vòng lặp giữa các quy trình đã liên kết.',
  WORKFLOW_LINK_LIMIT: 'Phiên bản nguồn đã đủ 12 quy tắc liên kết trong đơn vị này.',
  WORKFLOW_LINK_DEPTH: 'Chuỗi hồ sơ đã đạt giới hạn bốn lần liên kết.',
  WORKFLOW_LINK_DISABLED: 'Quy tắc liên kết đã tắt.',
  WORKFLOW_SCHEDULE_INVALID: 'Kiểm tra tiêu đề, chu kỳ và thời gian hiệu lực của lịch.',
  WORKFLOW_SCHEDULE_NO_OCCURRENCE: 'Khoảng hiệu lực đã chọn không còn kỳ nào trong tương lai.',
  WORKFLOW_SCHEDULE_RECIPIENT_UNAVAILABLE: 'Người nhận không còn quyền khởi tạo trong đơn vị.',
  WORKFLOW_SCHEDULE_DISABLED: 'Lịch tạo nháp đã tắt.',
  WORKFLOW_SCHEDULE_RETRY_UNAVAILABLE: 'Kỳ chạy này hiện chưa thể thử lại.',
  WORKFLOW_SCHEDULE_INPUT_INVALID: 'Biểu mẫu hiện không thể lưu thành nháp.',
  WORKFLOW_SCHEDULE_TEMPORARY_FAILURE: 'Có lỗi tạm thời khi tạo nháp theo lịch.',
  WORKFLOW_LINK_SOURCE_CHANGED: 'Hồ sơ nguồn hoặc dữ liệu được phép đọc đã thay đổi.',
  WORKFLOW_OUTPUT_INVALID: 'Kiểm tra nội dung mẫu, mã trường, phiên bản và sự kiện đã chọn.',
  WORKFLOW_INTAKE_INVALID: 'Kiểm tra cấu hình chuyển đề nghị.',
  WORKFLOW_INTAKE_UNAVAILABLE: 'Dịch vụ chuyển đề nghị chưa sẵn sàng.',
  WORKFLOW_INTAKE_RECIPIENT_DENIED: 'Người tiếp nhận không còn đủ quyền trong phạm vi áp dụng.',
  WORKFLOW_INTAKE_FIELD_DENIED: 'Người tiếp nhận không được đọc trường đã ghép.',
  WORKFLOW_INTAKE_MAPPING_INVALID: 'Chọn trường có kiểu dữ liệu phù hợp để ghép.',
  WORKFLOW_INTAKE_DISABLED: 'Quy tắc chuyển đề nghị đã tắt.',
  WORKFLOW_INTAKE_SOURCE_STALE: 'Hồ sơ nguồn không còn ở phiên bản và vòng đã chuyển.',
  WORKFLOW_INTAKE_RETRY_UNAVAILABLE: 'Lượt chuyển đề nghị chưa thể thử lại.',
  WORKFLOW_INTAKE_REFERENCE_CONFLICT: 'Tham chiếu đề nghị không khớp với hồ sơ nguồn.',
  TASKS_PERMISSION_DENIED: 'Bạn thiếu quyền trong phạm vi dự án hoặc công việc này.',
  TASKS_WORKFLOW_INVALID: 'Kiểm tra mã, tên, nhóm trạng thái và quyền chuyển trong cấu hình dự án.',
  TASKS_STAGE_IN_USE: 'Một công việc đang dùng trạng thái bị xóa hoặc đổi nhóm.',
  TASKS_TRANSITION_DENIED: 'Vai trò hiện tại không được chuyển công việc sang trạng thái này.',
  WORKFLOW_OPERATIONS_TOO_MANY:
    'Thu hẹp danh sách theo mã lượt chạy để xem job trong phạm vi của bạn.',
  TASKS_NOT_FOUND: 'Không tìm thấy dự án hoặc công việc.',
  TASKS_INVALID: 'Kiểm tra nội dung, hạn và thông tin công việc.',
  TASKS_DUPLICATE: 'Thành viên hoặc dữ liệu này đã có trong dự án.',
  TASKS_MEMBER_UNAVAILABLE: 'Tài khoản đã chọn thiếu quyền hoặc quan hệ công tác hiện hành.',
  TASKS_UNIT_UNAVAILABLE: 'Đơn vị này không còn hiệu lực.',
  TASKS_DONE: 'Mở lại công việc đã hoàn thành trước khi bàn giao.',
  TASKS_ALREADY_ASSIGNED: 'Hãy chọn một người thực hiện khác.',
  TASKS_DATABASE_NOT_READY: 'Dữ liệu Công việc đang được khởi tạo.',
  WORKFLOW_DOCUMENT_NOT_FOUND:
    'Tài liệu hoặc thư mục nằm ngoài phạm vi truy cập hoặc đã ngừng ban hành.',
  WORKFLOW_DOCUMENT_INVALID:
    'Kiểm tra tên, nội dung, đơn vị, thư mục, phiên bản quy trình và tệp đính kèm.',
  WORKFLOW_DOCUMENT_STATE: 'Trạng thái tài liệu đã thay đổi. Tải lại để chọn thao tác phù hợp.',
  WORKFLOW_DOCUMENT_FILE_QUARANTINED: 'Hãy thay tệp đang cách ly trước khi gửi duyệt.',
  WORKFLOW_DOCUMENT_SELF_REVIEW: 'Chọn một người phát hành khác để phê duyệt bản soạn thảo.',
  WORKFLOW_VERSION_CURRENT: 'Phiên bản này đang được phát hành. Hãy chọn một phiên bản trước đó.',
  WORKFLOW_REPORT_INVALID: 'Kiểm tra nguồn dữ liệu, nhóm, chỉ số và bộ lọc.',
  WORKFLOW_REPORT_DATES_INVALID: 'Chọn khoảng ngày hợp lệ, tối đa 366 ngày.',
  WORKFLOW_REPORT_EXPORT_TOO_LARGE: 'Thu hẹp khoảng ngày hoặc phạm vi để xuất tối đa 2.000 dòng.',
  WORKFLOW_REPORT_FIELD_DENIED:
    'Một trường đã chọn nằm ngoài quyền xem của bạn. Hãy kiểm tra cấu hình báo cáo.',
  WORKFLOW_REPORT_FILTER_STALE:
    'Giá trị lọc đã chọn hết hiệu lực trong phạm vi này. Hãy chọn lại giá trị.',
  WORKFLOW_REPORT_FIELDS_TOO_LARGE:
    'Thu hẹp khoảng ngày hoặc đơn vị để báo cáo theo trường có tối đa 5.000 dòng.',
  WORKFLOW_REPORT_FIELDS_UNAVAILABLE: 'Báo cáo theo trường đang không khả dụng.',
  WORKFLOW_REPORT_CHANGED: 'Dữ liệu đã cập nhật. Mở lại cửa sổ xuất để lấy báo cáo mới.',
  PERSONNEL_WORKFLOW_INTAKE_NOT_FOUND: 'Không tìm thấy đề nghị tiếp nhận trong phạm vi của bạn.',
  PERSONNEL_WORKFLOW_INTAKE_APPLIED: 'Đề nghị tiếp nhận đã được xác nhận.',
  PERSONNEL_WORKFLOW_INTAKE_INVALID: 'Đề nghị này dùng cho thao tác tiếp nhận nhân sự.',
  PERSONNEL_WORKFLOW_INTAKE_UNIT_DENIED: 'Chọn vị trí thuộc đơn vị của đề nghị tiếp nhận.',
  WORKFLOW_OUTPUT_DISABLED: 'Mẫu này đã tắt.',
  WORKFLOW_OUTPUT_RETRY_UNAVAILABLE: 'Lần gửi này hiện chưa thể thử lại.',
  WORKFLOW_OUTPUT_RECIPIENT_DENIED: 'Người nhận hiện không còn quyền xem sự kiện hoặc hồ sơ.',
  WORKFLOW_OUTPUT_EVENT_STALE: 'Sự kiện thuộc lần xử lý đã mất hiệu lực.',
  WORKFLOW_OUTPUT_TEMPORARY_FAILURE: 'Có lỗi tạm thời khi ghi email vào hộp thư local.',
  WORKFLOW_LINK_STEP_INVALID: 'Chọn một bước xử lý hợp lệ trong phiên bản nguồn.',
  WORKFLOW_LINK_STEP_INACTIVE: 'Lần xử lý nguồn đã mất hiệu lực. Dùng nháp từ lần xử lý hiện tại.',
  WORKFLOW_LINK_SOURCE_DENIED: 'Bạn hiện không có quyền đọc hồ sơ nguồn của nháp này.',
  WORKFLOW_LINK_RETRY_UNAVAILABLE: 'Trạng thái quy tắc hoặc lần chạy không cho phép thử lại.',
  WORKFLOW_LINK_TEMPORARY_FAILURE: 'Worker gặp lỗi tạm thời khi tạo bản nháp.',
  WORKFLOW_NOT_ASSIGNED: 'Nhiệm vụ này được giao cho người khác. Hãy tải lại danh sách.',
  WORKFLOW_SELF_APPROVAL: 'Người khởi tạo không được tự phê duyệt đề nghị của mình.',
  WORKFLOW_VERSION_STALE:
    'Quy trình đã có phiên bản mới hoặc ngừng phát hành. Hãy tải lại trước khi gửi.',
  WORKFLOW_AUDIENCE_DENIED: 'Đơn vị của bạn chưa được phép khởi chạy quy trình này.',
  WORKFLOW_TASK_CLOSED: 'Nhiệm vụ đã được xử lý hoặc chuyển bước. Hãy tải lại lượt chạy.',
  WORKFLOW_RUN_CLOSED: 'Trạng thái lượt chạy không cho phép thao tác này.',
  WORKFLOW_ASSIGNEE_UNAVAILABLE:
    'Người được chọn chưa có quyền xử lý trong đơn vị của lượt chạy hoặc đã bị khóa.',
  WORKFLOW_REFERENCE_DENIED: 'Đơn vị hoặc người tham gia không còn hợp lệ.',
  WORKFLOW_DIRECTORY_UNAVAILABLE: 'Chưa kết nối được danh bạ nhân sự. Hãy thử lại sau.',
  WORKFLOW_INVALID_DEFINITION:
    'Bản thiết kế chưa hợp lệ. Kiểm tra người xử lý, điều kiện và các bước nối.',
  WORKFLOW_NOT_FOUND: 'Không tìm thấy quy trình hoặc lượt chạy trong không gian này.',
  WORKFLOW_DUPLICATE: 'Mã quy trình hoặc yêu cầu bị trùng. Hãy kiểm tra lại.',
  WORKFLOW_TITLE_REQUIRED: 'Vui lòng nhập tiêu đề lượt chạy.',
  WORKFLOW_ACTION_INVALID: 'Hành động không phù hợp với loại nhiệm vụ này.',
  WORKFLOW_RETURN_DISABLED: 'Bước này không cho phép trả về người gửi.',
  WORKFLOW_ALREADY_VOTED: 'Người này đã gửi quyết định. Hãy tải lại tiến độ phê duyệt.',
  WORKFLOW_POOL_DUPLICATE_PERSON:
    'Mỗi người chỉ được có một tài khoản đang tham gia trong bước phê duyệt.',
  WORKFLOW_POOL_INSUFFICIENT:
    'Không đủ người duyệt độc lập có quyền hợp lệ cho số phiếu yêu cầu. Người gửi không được tự duyệt.',
  WORKFLOW_REPLACEMENT_REQUIRED: 'Chọn thành viên chưa bỏ phiếu cần thay thế và người nhận khác.',
  WORKFLOW_POOL_IDENTITY_CHANGED:
    'Định danh của thành viên đã thay đổi. Cần đối soát trước khi phân công.',
  WORKFLOW_CALENDAR_INVALID:
    'Lịch hoặc thời hạn không hợp lệ. Kiểm tra ca làm việc, ngày nghỉ và thời lượng trong giới hạn 10 năm.',
  LMS_IDENTITY_NOT_LINKED:
    'Danh tính SSO chưa được liên kết với hồ sơ LMS. Hãy liên hệ quản trị để đối soát.',
  LMS_UNIT_MAPPING_STALE: 'Đơn vị công tác đã thay đổi. Quản trị cần đối soát lại liên kết LMS.',
  LMS_PERMISSION_DENIED: 'Bạn chưa có quyền xem dữ liệu LMS trong phạm vi này.',
  LMS_PROVISIONING_DENIED: 'Bạn chưa được cấp quyền quản trị liên kết học viên với AIO.',
  LMS_IDENTITY_TARGET_UNAVAILABLE:
    'Hồ sơ AIO, đơn vị hoặc quyền LMS không còn hợp lệ. Kiểm tra tại Portal rồi tải lại.',
  LMS_IDENTITY_TARGET_CHANGED: 'Hồ sơ AIO vừa thay đổi. Tải lại và kiểm tra trước khi tiếp tục.',
  LMS_IDENTITY_OWNERSHIP_MISMATCH:
    'Định danh không khớp liên kết đã xác minh. Không thể chuyển lịch sử sang tài khoản khác.',
  LMS_ACCOUNT_ALREADY_LINKED: 'Tài khoản đã có liên kết LMS. Hãy cấu hình hồ sơ hiện có.',
  LMS_PROFILE_INACTIVE: 'Hồ sơ lịch sử đã ngừng hoạt động. Cần đối soát hồ sơ trước khi mở lại.',
  LMS_MAPPING_NOT_FOUND: 'Không tìm thấy liên kết học viên trong phạm vi của bạn.',
  LMS_SELF_MAPPING_CHANGE_DENIED:
    'Cần một quản trị viên khác thay đổi liên kết tài khoản đang dùng.',
  LMS_RECONCILE_REQUIRED: 'Chọn thao tác Đối soát đơn vị để cập nhật đơn vị học tập.',
  LMS_ADAPTER_DISABLED: 'LMS sandbox đang tạm dừng đăng nhập. Lịch sử học vẫn được giữ.',
  LMS_DEPENDENCY_UNAVAILABLE: 'Dịch vụ LMS tạm thời chưa sẵn sàng. Vui lòng thử lại.',
  LMS_MEDIA_SIZE_INVALID: 'Kích thước file không khớp. Hãy chọn lại file và tải lại.',
  LMS_MEDIA_TYPE_INVALID: 'Định dạng hoặc nội dung file không được hỗ trợ.',
  LMS_MEDIA_NAME_INVALID: 'Tên file không hợp lệ. Hãy đổi tên file rồi thử lại.',
  LMS_MEDIA_CHECKSUM_INVALID: 'File truyền lên không toàn vẹn. Hãy tải lại.',
  LMS_MEDIA_STORAGE_UNAVAILABLE: 'Chưa lưu hoặc đọc được file. Vui lòng thử lại.',
  LMS_MEDIA_NOT_FOUND: 'Không tìm thấy file thuộc phạm vi được cấp.',
  LMS_INVALID_COURSE:
    'Nội dung khóa học chưa hợp lệ. Kiểm tra tên, video, đơn vị và đáp án câu hỏi.',
  LMS_TRAINING_INVALID: 'Kiểm tra tên, lịch, đối tượng và các khóa trong lộ trình.',
  LMS_TRAINING_INTAKE_INVALID: 'Đề nghị đào tạo không hợp lệ.',
  LMS_TRAINING_INTAKE_SOURCE_DENIED: 'Quyền đọc đề nghị nguồn đã thay đổi. Hãy tải lại đề nghị.',
  LMS_TRAINING_INTAKE_SOURCE_UNAVAILABLE: 'Tạm thời chưa lấy được đề nghị từ Quy trình.',
  LMS_TRAINING_INTAKE_NOT_FOUND: 'Không tìm thấy đề nghị đào tạo trong phạm vi của bạn.',
  LMS_TRAINING_INTAKE_APPLIED: 'Đề nghị đã được dùng để giao một đợt đào tạo.',
  LMS_TRAINING_INTAKE_UNIT_DENIED: 'Chọn đơn vị phụ trách của đề nghị đã duyệt.',
  LMS_TRAINING_NOT_FOUND: 'Không tìm thấy đợt đào tạo trong phạm vi hiện tại.',
  LMS_TRAINING_IMMUTABLE: 'Lịch sử đào tạo không được sửa. Hãy tạo phiên bản hoặc đợt mới.',
  LMS_TRAINING_COURSE_UNAVAILABLE:
    'Khóa trong lộ trình không còn phát hành phiên bản đã chọn hoặc khác đối tượng học.',
  LMS_TRAINING_PARTICIPANT_CHANGED:
    'Danh sách người học đã thay đổi hoặc trùng người. Hãy tải lại và chọn người còn đủ quyền.',
  LMS_TRAINING_VERSION_STALE: 'Lộ trình đã có phiên bản mới. Hãy tải lại trước khi giao đợt.',
  LMS_TRAINING_TOO_MANY: 'Danh sách quá lớn; hãy chọn phạm vi đơn vị nhỏ hơn.',
  LMS_ATTEMPT_LIMIT: 'Bạn đã dùng hết số lần nộp của phiên bản khóa học này.',
  LMS_ATTEMPT_COOLDOWN:
    'Chưa hết thời gian chờ giữa hai lần nộp. Hãy xem thời điểm được nộp tiếp trong bài học.',
  LMS_PREREQUISITES_REQUIRED: 'Cần đạt các khóa học tiên quyết trước khi mở nội dung này.',
  LMS_PREREQUISITE_UNAVAILABLE:
    'Khóa tiên quyết chưa phát hành, không còn hiện hành hoặc không cùng đối tượng học. Hãy chọn lại.',
  LMS_PREREQUISITE_CYCLE: 'Khóa tiên quyết tạo vòng phụ thuộc hoặc tham chiếu lại chính khóa này.',
  LMS_ASSESSMENT_POLICY_MISMATCH:
    'Kết quả không khớp chính sách của phiên bản khóa học. Hãy tải lại.',
  LMS_COURSE_NOT_FOUND: 'Không tìm thấy khóa học trong phạm vi được cấp.',
  LMS_DIRECTORY_DENIED:
    'Ứng dụng chưa được cấp quyền tra cứu Directory trong phạm vi này. Hãy kiểm tra phân quyền AIO.',
  LMS_UNIT_UNAVAILABLE:
    'Đơn vị đã ngừng hoạt động hoặc không thuộc phạm vi được cấp. Hãy tải lại danh mục AIO.',
  LMS_LEARNER_NOT_FOUND: 'Không tìm thấy học viên trong phạm vi được cấp hiện hành.',
  LMS_REPORT_CHANGED: 'Dữ liệu hoặc phạm vi báo cáo đã thay đổi. Hãy tải lại và xuất bản mới.',
  LMS_EXPORT_LIMIT:
    'Báo cáo quá lớn để xuất một tệp. Hãy lọc theo đơn vị hoặc khóa học rồi xuất tiếp.',
  LMS_WORKBOOK_TOO_LARGE: 'Tệp nhập tối đa 2 MiB. Hãy chia nhỏ tệp rồi thử lại.',
  LMS_WORKBOOK_INVALID: 'Không đọc được cấu trúc tệp hoặc nội dung tệp không toàn vẹn.',
  LMS_WORKBOOK_EMPTY: 'Tệp chưa có trang tính và dữ liệu câu hỏi.',
  LMS_WORKBOOK_FORMAT: 'Chỉ nhận XLSX, XLS hoặc CSV UTF-8.',
  LMS_WORKBOOK_MACROS: 'Hãy lưu lại tệp không có macro trước khi nhập.',
  LMS_WORKBOOK_LIMIT:
    'Tệp hoặc nội dung vượt giới hạn số dòng, cột hoặc dung lượng. Hãy dùng mẫu và chia nhỏ tệp.',
  LMS_IMPORT_EXPIRED:
    'Bản xem trước đã hết hạn hoặc không thuộc phiên quản trị này. Hãy kiểm tra tệp lại.',
  LMS_IMPORT_HAS_ERRORS: 'Tệp còn lỗi hoặc chưa có câu hỏi. Hãy sửa và kiểm tra lại.',
  LMS_QUESTION_NOT_FOUND: 'Không tìm thấy câu hỏi trong phạm vi được cấp.',
  LMS_INVALID_QUESTION:
    'Kiểm tra nội dung câu hỏi, lựa chọn, đáp án chuẩn và thời điểm nếu là điểm dừng.',
  LMS_CERTIFICATE_NOT_FOUND: 'Không tìm thấy chứng nhận trong phạm vi được cấp.',
  LMS_CERTIFICATE_NOT_ELIGIBLE: 'Bài kiểm tra chưa đạt điều kiện cấp chứng nhận (từ 80 điểm).',
  LMS_COURSE_UNAVAILABLE: 'Khóa học đã ngừng hoặc bạn chưa được cấp quyền học.',
  LMS_LEARNING_INCOMPLETE: 'Hãy xem hết video và trả lời các điểm dừng trước khi nộp bài.',
  LMS_CHECKPOINT_NOT_REACHED: 'Hãy học đến điểm dừng và trả lời các câu trước theo thứ tự.',
  LMS_ANSWER_INVALID: 'Vui lòng nhập hoặc chọn đáp án hợp lệ.',
  LMS_VIDEO_SOURCE_INVALID: 'Liên kết hoặc ID video không hợp lệ cho nguồn đã chọn.',
  LMS_MANUAL_CONFIRMATION_REQUIRED: 'Video này cần xác nhận mốc học của học viên.',
  PAYLOAD_TOO_LARGE: 'File hoặc nội dung vượt quá dung lượng cho phép.',
  FOUNDATION_UNAVAILABLE: 'Dịch vụ kiểm tra quyền tạm thời chưa sẵn sàng. Vui lòng thử lại.',
  FORMS_PERMISSION_DENIED: 'Bạn không có quyền thực hiện thao tác này trong phạm vi đã chọn.',
  FORM_AUDIENCE_DENIED: 'Biểu mẫu chưa được giao cho bạn hoặc đã hết thời gian nhận phiếu.',
  FORM_VALIDATION_FAILED: 'Vui lòng kiểm tra nội dung và các điều kiện của biểu mẫu.',
  FORM_CLOSED: 'Biểu mẫu đã đóng, không nhận thêm phiếu hoặc bản nháp.',
  FORM_ARCHIVED: 'Biểu mẫu đã lưu trữ. Lịch sử vẫn được giữ để tra cứu.',
  FORM_VERSION_CLOSED:
    'Phiên bản này đã đóng. Hãy hủy bản nháp cũ và tạo phiếu theo phiên bản mới.',
  FORM_VERSION_STALE: 'Biểu mẫu đã có phiên bản mới. Hãy tải lại trước khi tạo phiếu.',
  FORM_SUBMISSION_LIMIT: 'Bạn đã gửi đủ số phiếu được phép cho biểu mẫu này.',
  FORM_SUBMISSION_IMMUTABLE: 'Phiếu đã gửi hoặc đã hủy không thể sửa lại.',
  FORM_REFERENCE_DENIED: 'Người hoặc đơn vị được chọn không còn thuộc phạm vi hợp lệ.',
  FORM_NOT_PUBLISHABLE: 'Cần bản nháp hợp lệ và biểu mẫu đang mở để xuất bản.',
  FORMS_DUPLICATE_RECORD: 'Mã biểu mẫu bị trùng hoặc bạn đã có bản nháp đang mở.',
  FORM_REPORT_TOO_LARGE: 'Báo cáo vượt giới hạn 10.000 phiếu cho một lần xử lý.',
  RATE_LIMITED: 'Có quá nhiều thao tác trong thời gian ngắn. Vui lòng chờ một lúc rồi thử lại.',
  DATABASE_UNAVAILABLE: 'Dịch vụ dữ liệu tạm thời chưa sẵn sàng. Vui lòng thử lại sau.',
  AUTHENTICATION_REQUIRED: 'Phiên đăng nhập chưa sẵn sàng. Vui lòng đăng nhập SSO.',
  SESSION_EXPIRED: 'Phiên đã hết hạn. Vui lòng đăng nhập lại.',
  SESSION_REVOKED: 'Phiên đã bị thu hồi. Vui lòng đăng nhập lại.',
  REAUTHENTICATION_REQUIRED:
    'Tài khoản đã thay đổi trạng thái bảo mật. Vui lòng xác thực lại bằng mật khẩu và OTP nếu được yêu cầu.',
  IDENTITY_PROOF_UNAVAILABLE:
    'Mã xác minh không còn hiệu lực hoặc đã được sử dụng. Hãy yêu cầu người dùng xác minh SSO lại.',
  FRESH_IDENTITY_PROOF_REQUIRED: 'Cần xác thực SSO mới để tạo mã liên kết.',
  IDENTITY_BOUND_TO_OTHER_ACCOUNT:
    'Định danh này đã thuộc một tài khoản khác và không thể chuyển chủ sở hữu.',
  IDENTITY_ALREADY_LINKED: 'Định danh này đã được liên kết.',
  IDENTITY_SUBJECT_MISMATCH: 'Định danh không khớp bản xem trước. Hãy kiểm tra lại mã xác minh.',
  FOUNDATION_ONLY: 'Thao tác định danh được thực hiện tại Foundation.',
  SESSION_IDENTITY_CHANGED: 'Danh tính phiên không còn khớp. Vui lòng đăng nhập lại.',
  MFA_REQUIRED:
    'Tài khoản quản trị cần xác minh mật khẩu và mã OTP. Hãy cấu hình ứng dụng xác thực trong tài khoản SSO rồi đăng nhập lại.',
  ACCOUNT_UNAVAILABLE: 'Tài khoản hiện không được phép truy cập.',
  APPLICATION_ACCESS_DENIED: 'Bạn chưa được cấp quyền vào ứng dụng này.',
  PERMISSION_DENIED: 'Bạn chưa được cấp quyền thực hiện thao tác này.',
  APPLICATION_DELEGATION_DENIED: 'Ứng dụng này nằm ngoài phạm vi quản trị được giao.',
  PERMISSION_CEILING_EXCEEDED: 'Quyền được cấp vượt phạm vi mà bạn có thể ủy quyền.',
  REVISION_CONFLICT: 'Bản ghi đã thay đổi. Hãy tải lại danh sách và kiểm tra trước khi sửa tiếp.',
  DUPLICATE_RECORD: 'Mã hoặc bản ghi đã tồn tại.',
  INVALID_REQUEST: 'Vui lòng kiểm tra các trường bắt buộc và định dạng dữ liệu.',
  INVALID_RELATION: 'Đối tượng liên quan không thuộc phạm vi hợp lệ.',
  INVALID_ASSIGNMENT_PERIOD: 'Khoảng bổ nhiệm phải nằm trong thời gian công tác.',
  PRIMARY_ASSIGNMENT_OVERLAP: 'Đã có vị trí chính trong khoảng thời gian này.',
  ORGANIZATION_CYCLE: 'Đơn vị cha được chọn sẽ tạo vòng lặp cơ cấu tổ chức.',
  ACTIVE_DEPENDENCIES: 'Còn bản ghi đang hoạt động phụ thuộc vào đối tượng này.',
  PROTECTED_ACCOUNT: 'Tài khoản quản trị được bảo vệ khỏi thay đổi này.',
  PROTECTED_ROLE: 'Vai trò hệ thống được bảo vệ.',
  PROTECTED_PERMISSION: 'Quyền hệ thống được bảo vệ.',
  PROTECTED_APPLICATION: 'Ứng dụng nền tảng được bảo vệ khỏi thay đổi cấu hình truy cập.',
  APPLICATION_PROVISIONING_REQUIRED:
    'Ứng dụng cần được cấu hình và xác minh SSO trước khi kích hoạt.',
  SELF_ESCALATION_FORBIDDEN: 'Không được tự nâng quyền thông qua vai trò của mình.',
  SELF_ASSIGNMENT_FORBIDDEN: 'Không được tự cấp hoặc thay đổi quyền truy cập của mình.',
  SELF_MANAGEMENT_FORBIDDEN: 'Không được tự vô hiệu hóa tài khoản quản trị đang sử dụng.',
  IDENTITY_UNAVAILABLE: 'Dịch vụ đăng nhập tạm thời chưa sẵn sàng. Vui lòng thử lại.',
  IDEMPOTENCY_KEY_REUSED: 'Nội dung yêu cầu đã thay đổi. Hãy mở lại biểu mẫu trước khi gửi.',
  REASON_REQUIRED: 'Vui lòng nhập lý do thay đổi, tối thiểu 5 ký tự.',
  CMS_PERMISSION_DENIED: 'Bạn chưa được cấp quyền CMS trong website này.',
  CMS_WEBSITE_NOT_FOUND: 'Website không tồn tại hoặc không thuộc phạm vi hiện tại.',
  CMS_PAGE_NOT_FOUND: 'Trang CMS không tồn tại hoặc đã bị thu hồi.',
  CMS_CONTENT_ENTRY_NOT_FOUND: 'Nội dung CMS không tồn tại hoặc đã bị thu hồi.',
  CMS_CONTENT_TYPE_NOT_FOUND: 'Loại nội dung chưa được khai báo cho website.',
  CMS_DRAFT_NOT_FOUND: 'Chưa có bản nháp phù hợp để xử lý.',
  CMS_REVISION_CONFLICT: 'Nội dung đã thay đổi. Hãy tải lại và rà soát revision mới nhất.',
  CMS_INVALID_BLOCKS: 'Danh sách block chưa đúng định dạng JSON.',
  CMS_CHANNEL_NOT_FOUND: 'Kênh xuất bản không còn tồn tại.',
  CMS_CHANNEL_UNAVAILABLE: 'Kênh xuất bản đang lỗi hoặc đã bị vô hiệu hóa.',
  CMS_TOKEN_REFERENCE_REQUIRED: 'Kênh social cần token reference trước khi xếp hàng xuất bản.',
  CMS_PROVIDER_TARGET_UNSUPPORTED: 'Kênh này chưa hỗ trợ loại nội dung được chọn.',
  CMS_REVISION_NOT_PUBLISHED: 'Chỉ revision đã phát hành mới được đưa vào publication queue.',
  CMS_MENU_NOT_FOUND: 'Menu không tồn tại hoặc đã bị xóa.',
};

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError)
    return (
      messages[error.code] ||
      (error.status === 403
        ? messages.PERMISSION_DENIED!
        : 'Không thể hoàn tất thao tác. Vui lòng thử lại hoặc kiểm tra quyền.')
    );
  return 'Không kết nối được dịch vụ. Vui lòng thử lại.';
}
