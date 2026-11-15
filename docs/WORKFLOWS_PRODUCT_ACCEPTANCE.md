# Nghiệm thu đầu-cuối AIO Quy trình

Nghiệm thu local lúc **15:46:24 ngày 12/11/2026 (UTC+7)**. W1–W5 đã có receipt từng hạng mục. Cổng sản phẩm đạt cả bốn kịch bản trên AIO local và cơ sở dữ liệu kiểm thử giả lập. Ma trận theo [bốn kịch bản sản phẩm](../roadmap/WORKFLOWS_NEXT.md#bốn-kịch-bản-nghiệm-thu-sản-phẩm).

| Kịch bản | Hành vi và quyền cần đối chiếu | Suite |
| --- | --- | --- |
| Mua sắm | Bảng hàng tính tổng ở máy chủ, thiếu dòng thì từ chối gửi, tổng chọn cấp duyệt. Tài chính và kỹ thuật nhận hai nhiệm vụ độc lập. Kỹ thuật yêu cầu bổ sung. Vòng mới giữ tổng và quyết định vòng cũ. Hai thao tác đồng thời hợp nhánh một lần. Lỗi ghi audit giữ nhiệm vụ đang chờ. Bản phát hành sau giữ snapshot của hồ sơ trước. | `test:workflows-assignments`, `test:workflows-business` |
| Tạm ứng → quyết toán | Quyết định nguồn tạo nháp ghép dữ liệu. Người nhận bổ sung chứng từ rồi gửi. Worker cạnh tranh tạo một nháp, lỗi ghi giao dịch giữ nguồn và đích nhất quán, thu hồi quyền khóa tra cứu dữ liệu nguồn. Liên kết ghi đúng trạng thái và phiên bản. | `test:workflows-step-links`, ca PostgreSQL liên kết |
| Tiếp nhận nhân sự | IT và Hành chính điền bàn giao riêng, thiếu trường thì từ chối hoàn tất, lương bị ẩn. Chỉ sau khi hợp nhánh mới chuyển một đề nghị sang Nhân sự. Người xác nhận có quyền đơn vị, audit lỗi lùi hồ sơ/công tác/bổ nhiệm, gửi lại giữ một kết quả và xác nhận không tạo tài khoản IAM. | `test:workflows-personnel-intake` |
| Đề nghị đào tạo | Quy trình duyệt nhu cầu, adapter ký và tạo một nháp LMS. Admin MFA xác nhận lộ trình và người học theo quyền. Thu hồi nguồn hoặc sai đơn vị chặn xác nhận. Audit lỗi lùi đợt và ghi danh. Người học hoàn thành khóa ghim phiên bản và trạng thái đợt trở về hồ sơ. | `test:workflows-training-intake` |

Chạy `npm run test:suite-regression -- w5-product-gate` khi dev đã dừng. Các suite dùng database test và SSO thật theo [runbook local](LOCAL_DEVELOPMENT.md). Bằng chứng cần có ảnh desktop/390 px, thao tác bàn phím, axe, đối chiếu journal và readiness sau khi mở lại dev. Các bản phát hành và nhật ký đã có được giữ khi dừng một tính năng. [Rollback từng mốc](../roadmap/GOAL_WORKFLOWS_COMPLETE.md)

Hồi quy đạt 9/9 lệnh với 265 bài kiểm thử, 477 hash nguồn ổn định và tám journal khớp. Receipt tổng `.local/evidence/workflows-w5-product-gate-local-ready.json` ghi kết quả từng ca, ảnh, các lượt axe và cổng dev. Hồi quy `.local/evidence/configurable-w5-product-gate-regression.json` lưu các lệnh theo thứ tự. Các lượt axe ở bốn kịch bản không báo vi phạm. Các mục cần kiểm thủ công được giữ trong receipt từng ca.
