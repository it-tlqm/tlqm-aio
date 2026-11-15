# Frontend TLQM AIO — shadcn/ui và màu TLQM

Ngày: 10/11/2026. Trạng thái: **đã áp dụng vào frontend React/shadcn và theme đăng nhập SSO trong worktree local feat/foundation-mvp, chưa commit**. E2E đã kiểm chứng các thông số dưới đây trong phạm vi ghi cuối tài liệu.

## Công nghệ và nguồn chuẩn

Frontend mới ưu tiên shadcn/ui trên React + TypeScript, Vite và Tailwind CSS v4. Cấu hình component dùng CSS variables; ánh xạ token TLQM vào semantic tokens của shadcn. [shadcn theming](https://ui.shadcn.com/docs/theming), [Vite integration](https://ui.shadcn.com/docs/installation/vite).

Ưu tiên palette người dùng gửi trong chat ngày 09/11/2026. Đã đọc đối chiếu ba nguồn local của YMS Sơn Cảng:

- D:/thanhnx/OpenCode/YMS-project/scripts/tlqm-design-tokens.css — DS-01, phù hợp bộ token gốc.
- D:/thanhnx/OpenCode/YMS-project/src/app/globals.css — DS-02, hiện có một số màu/font/radius khác.
- D:/thanhnx/OpenCode/YMS-project/ProjectContext/04_UI_Stitch_tham_khao/DESIGN.md — hướng dẫn DS-01 và accessibility.

DS-02 đang dùng nền app trắng, text #17202E, nav accent #326DD8 và ưu tiên Inter. AIO áp dụng palette mới được người dùng gửi: canvas #F5F8FA, text #1F2937, CTA xanh và Be Vietnam Pro. Không sao chép toàn bộ globals.css của YMS vì có style nghiệp vụ, in ấn và override không thuộc AIO.

## Tokens AIO

| Nhóm | Token | Giá trị |
| --- | --- | --- |
| Brand | brand-green | #0A9444 |
| Brand | brand-navy | #223873 |
| Action | action-primary | #087C3C |
| Action | action-primary-hover | #076934 |
| Surface | canvas | #F5F8FA |
| Surface | surface | #FFFFFF |
| Surface | surface-soft | #F0F5F2 |
| Navigation | sidebar-bg | #F8F9FB |
| Navigation | nav-active-bg | #EAF6EF |
| Selection | item-selected | #EAF1FD |
| Border | border | #E3E8EF |
| Control | input border | #8490A1; chỉ cho đường bao control |
| Text | text-primary | #1F2937 |
| Text | text-secondary | #475467 |
| Text | text-muted | #667085 |
| Success | success / success-bg | #067647 / #ECFDF3 |
| Warning | warning / warning-bg | #9A4808 / #FFFAEB |
| Danger | danger / danger-bg | #B42318 / #FEF3F2 |
| Info | info / info-bg | #1D4ED8 / #EFF6FF |

Các mã status khác trong bảng tham khảo của người dùng là biến thể. Baseline AIO dùng các cặp trong CSS token người dùng cung cấp ở trên để tránh mỗi màn hình chọn một màu khác.

Font chính Be Vietnam Pro; fallback Arial, sans-serif. Font cần được nạp thực sự, ưu tiên phục vụ nội bộ từ asset có giấy phép phù hợp. Chỉ khai báo tên font mà browser dùng fallback không được coi là đã hoàn thành.

Radius sm 8px, md 10px, lg 14px. Khoảng cách theo bội 4px. Vùng bấm tối thiểu 44 × 44px; mobile input text tối thiểu 16px. Light mode cho giai đoạn này.

## Ánh xạ shadcn

| Token shadcn | Token/giá trị TLQM |
| --- | --- |
| background / foreground | canvas / text-primary |
| card / card-foreground | surface / text-primary |
| popover / popover-foreground | surface / text-primary |
| primary / primary-foreground | action-primary / #FFFFFF |
| secondary / secondary-foreground | surface-soft / brand-navy |
| muted / muted-foreground | surface-soft / text-muted |
| accent / accent-foreground | nav-active-bg / brand-navy |
| destructive / destructive-foreground nếu component sử dụng | danger / #FFFFFF |
| border | border |
| input | #8490A1 trên nền surface trắng; không dùng border trang trí làm dấu hiệu duy nhất |
| ring | brand-green |
| sidebar / sidebar-foreground | sidebar-bg / brand-navy |
| sidebar-primary / sidebar-primary-foreground | action-primary / #FFFFFF |
| sidebar-accent / sidebar-accent-foreground | nav-active-bg / brand-navy |
| sidebar-border / sidebar-ring | border / brand-green |

Một lớp tokens gốc và một lớp ánh xạ semantic; tránh alias tự trỏ vào chính nó. Thêm namespace TLQM nếu cần phân biệt radius của brand với scale sinh bởi shadcn/Tailwind. Không mặc định scale radius sinh sẵn sẽ trùng 8/10/14px; kiểm tra computed style của component thật.

Hover CTA dùng action-primary-hover rõ ràng. Không thay CTA xanh bằng navy hoặc nav accent xanh dương mặc định của template. Không giảm opacity tùy ý trên chữ phụ và status vì sẽ đổi tương phản thực tế.

## Kiểm tra tương phản đã tính

Các tỷ lệ dưới đây được tính từ màu sRGB phẳng, chưa gồm opacity, overlay hoặc font rendering của UI:

| Foreground / background | Tỷ lệ |
| --- | --- |
| #FFFFFF / #087C3C — CTA | 5,30:1 |
| #FFFFFF / #0A9444 — xanh brand | 3,94:1 |
| #667085 / #F5F8FA — chữ phụ trên canvas | 4,66:1 |
| #067647 / #ECFDF3 — success | 5,40:1 |
| #9A4808 / #FFFAEB — warning | 6,09:1 |
| #B42318 / #FEF3F2 — danger | 6,05:1 |
| #1D4ED8 / #EFF6FF — info | 6,16:1 |
| #E3E8EF / #FFFFFF — border | 1,23:1 |
| #8490A1 / #FFFFFF — control border | 3,24:1 |
| #8490A1 / #F5F8FA — control border | 3,04:1 |

Giữ #087C3C cho CTA chữ trắng cỡ thường; brand-green dành cho điểm nhấn/focus và trường hợp có tương phản phù hợp. Không gọi toàn bộ giao diện là đạt WCAG AA chỉ vì màu CTA đạt một phép kiểm tra.

Border #E3E8EF phù hợp đường phân cách trang trí. Control dùng biến thể #8490A1 để giữ đường bao nhận diện trên nền trắng/canvas mà không dùng viền tối như chữ. Focus ring phải nhìn thấy; trạng thái lỗi/thành công có text/icon ngoài màu.

## Điều chỉnh component dùng chung ngày 10/11/2026

AIO tiếp tục dùng component shadcn/Radix trong frontend/src/components/ui. Loại bỏ các override toàn cục font shorthand, min-size trên mọi button và focus outline ngoài CSS layer: chúng làm chữ/control mất scale riêng, checkbox thành ô 44px và tạo hai vòng focus. Kích thước, padding, màu hover/focus/disabled được khai báo tại Button, Input, Select, Textarea, Checkbox, Tabs, Card, Dialog, Badge, Table và menu.

Button/input/select giữ vùng thao tác tối thiểu 44px. Checkbox có phần hiển thị 20px trong vùng bấm 44px, cả trạng thái checked/indeterminate và focus bàn phím. Tabs tự cao theo nội dung khi xuống dòng, không áp chiều cao cố định thấp hơn trigger; bỏ các lớp vá rời ở Foundation và Quy trình. Dialog rộng và có padding thống nhất; input nền trắng, bảng có header và khoảng cách cột rõ ràng. Palette thương hiệu, logo, Be Vietnam Pro, Radix semantics và CSP nonce được giữ.

Canvas Quy trình theo dõi kích thước vùng vẽ để fit lại khi chuyển desktop/mobile, không ghi lại vị trí bước hay thay đổi cấu hình quy trình từ thao tác resize. Khi kiểm tra hình ảnh, chờ tải dữ liệu và animation kết thúc; ảnh đang vào dialog hoặc còn skeleton không dùng làm bằng chứng bố cục cuối.

### Kết quả kiểm chứng bản sửa component

Kiểm chứng ngày 10/11/2026 tại D:/thanhnx/TLQM-AIO, nhánh feat/foundation-mvp, baseline HEAD abea705b0937fe164fa9c983700089bec88c82ba; worktree dirty. Các thay đổi frontend, scripts và tài liệu chưa commit nên không mô tả ảnh/test là kết quả của riêng HEAD.

- `npm run check`: pass, 103 unit/integration tests, TypeScript, format và build. `npm run test:e2e`: pass cả ba suite Foundation SSO, identity và admin UI.
- `test:workflows`, `test:workflows-assignments`, `test:forms-ui`, `test:lms`: pass tuần tự trên dữ liệu giả lập. Những lượt thất bại trước do kiểm tra ngay lúc Select đang đóng vẫn giữ trong evidence lịch sử. Helper mới chờ listbox đóng, xác nhận giá trị được chọn; checkbox dùng role cụ thể và kiểm trạng thái checked. Không tắt animation, bỏ assertion hay giảm kiểm tra auth/quyền để đạt pass.
- Kiểm tra hình ảnh riêng trên bản build cuối: 8 trạng thái desktop/mobile bằng axe, không có violation; giữ các mục incomplete để đánh giá thủ công. Đã xem trực tiếp ảnh bảng, dialog, thư viện mẫu, thông tin quy trình và canvas ở 1440/390/320px. Đây không phải chứng nhận WCAG đầy đủ.
- Checkbox đo được vùng bấm 44×44px, ô hiển thị 20×20px, màu checked #087C3C; kiểm Space bật/tắt và focus xanh #0A9444. Dialog giữ focus bên trong, Escape đóng và trả focus về nút mở. Select mở/đóng bằng bàn phím và trả focus đúng control.
- Regression Quy trình kiểm đủ sáu bước của mẫu nằm trong canvas và tâm sơ đồ khớp tâm khung khi chuyển 1440 → 390 → 320 → 1440; không chỉ kiểm trang hết tràn ngang. Tabs xuống dòng nằm trong khung riêng.

Evidence ignored trong `.local/evidence`: `shared-ui-regression.json`, `shared-ui-regression-followup.json`, `shared-ui-forms-lms-followup.json`, `shared-ui-workflow-final.json`, `shared-ui-visual-review.json`, ảnh `shared-ui-*.png`; snapshot hash source/evidence `shared-ui-revision.json`. Các snapshot/ảnh cũ là lịch sử, không đại diện bản sửa này. Kiểm tra hình ảnh không ghi màn hình mật khẩu, OTP hoặc QR enrollment.

## Quy chuẩn giao diện Foundation

- Sidebar sáng, tiêu đề/nav navy, thao tác chính xanh; nền canvas và card trắng.
- Tiếng Việt rõ nghĩa; không chép ngôn ngữ cổng bãi/container sang sản phẩm Foundation.
- Ưu tiên bảng, bộ lọc, form và phân cấp thông tin; tránh KPI/trang trí không phục vụ tác vụ.
- Component thực tế từ shadcn/ui, cấu hình theme chung; không chỉ đặt tên CSS “shadcn”.
- Table responsive hoặc có vùng cuộn có chủ đích; không tràn toàn trang trên mobile.
- Label luôn hiện, lỗi đặt cạnh trường, dialog có focus trap/restore focus và thao tác bàn phím.
- Màn hình phải có loading, empty, error, no-access; quyền backend vẫn quyết định thao tác được phép.
- Dùng [logo chính thức TLQM 2026](../brand/tlqm-2026/README.md) từ D:/TLQM/Logo, được người dùng cung cấp ngày 10/11/2026. Emblem màu trên nền sáng, phiên bản trắng chính thức trên nền navy; dùng component Brand chung và favicon. Không thay logo bằng icon nghiệp vụ hoặc tự đổi màu logo.
- Với identity/session, giữ cơ chế server session/BFF và CSRF; thay giao diện không làm yếu luồng SSO.

## Trang đăng nhập SSO

Từ 10/11/2026, realm aio-local dùng theme TLQM kế thừa Keycloak v2 với cùng palette, font nội bộ, light mode và kích thước control. Login/OTP/lỗi có kiểm tra màu thực tế, bàn phím và responsive 1440/390/320; 7 axe scans không có violations. Đây là theme Keycloak dùng chung design tokens, không phải component React/shadcn. [Cấu hình, rollback và phạm vi nghiệm thu](SSO_THEME.md).

## Nghiệm thu khi triển khai frontend

Kiểm tra desktop 1440px, mobile 390px và thao tác keyboard. Chụp ảnh từ dữ liệu giả lập sau khi đọc computed colors/font/radius của component thật; kiểm tra primary/hover/focus, badges, bảng, modal và form invalid.

Frontend hiện nằm trong frontend/: React/TypeScript/Vite/Tailwind v4, shadcn radix-nova (component sinh bằng CLI), Be Vietnam Pro phục vụ từ asset local và license kèm theo. Token tập trung ở frontend/src/index.css. Fastify phục vụ frontend/dist sau build; public/ chỉ còn fallback cũ.

E2E đã kiểm tra 1440px/390px, font loaded, CTA/canvas/radius/44px, dialog focus trap/restore, form invalid, Select quan hệ và checkbox permission. CSP giữ nonce, không nới unsafe-inline. Suite admin-ui đã quét 17 trạng thái bằng axe-core với tags WCAG A/AA, không exclude/disable rule: 0 violation; một số kiểm tra modal cần đánh giá thủ công (focus/contrast đã được kiểm tra bổ sung). Đây không phải chứng nhận WCAG đầy đủ.

Qua kiểm tra đã sửa hai lỗi thực tế: tab chưa chọn dùng text-foreground/60 chỉ đạt 3,95:1 nên đổi sang token text-secondary; nội dung của tabs được đặt trong TabsContent đúng để aria-controls trỏ đến panel tồn tại. Giữ palette người dùng, không đổi ngưỡng test hoặc bỏ luật tương phản để pass. Ảnh audit desktop/mobile và identity confirmation đã được xem trực tiếp.

LMS sandbox ở frontend/src/lms dùng cùng components/tokens và chunk riêng. E2E kiểm font loaded, canvas #F5F8FA, CTA #087C3C, button tối thiểu 44px, không tràn toàn trang 1440/390px và CSP. Năm trạng thái learner desktop/mobile, reviewer, admin và unmapped denial được quét axe: zero violation, giữ các incomplete checks trong artifact. Ảnh learner desktop/mobile và admin đã được xem; trạng thái sandbox và dữ liệu giả lập ghi ngay đầu trang. [Nghiệm thu LMS](LMS_ACCEPTANCE.md).

Mốc học tập/chứng nhận ngày 10/11/2026 bổ sung catalogue/player/quiz/result, chứng nhận TLQM và xếp hạng đơn vị trên cùng shadcn/tokens. `test:lms-learner` bản cuối 06:32Z có 10 axe scans không violation, kiểm dialog Escape/restore focus và mobile. Đã xem ảnh UI/PNG xuất/PDF render; bản in có CSS riêng bỏ dịch chuyển của dialog, không in màn nền. [Hướng dẫn học tập và phạm vi bằng chứng](LMS_LEARNING.md).
