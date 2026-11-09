# Frontend TLQM AIO — shadcn/ui và màu TLQM

Ngày: 09/11/2026. Trạng thái: **ưu tiên frontend và palette đã được người dùng xác nhận; chưa áp dụng vào trang thử hiện tại**.

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
| input | Theo quy tắc nhận diện control bên dưới; không dùng viền mờ làm dấu hiệu duy nhất |
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

Giữ #087C3C cho CTA chữ trắng cỡ thường; brand-green dành cho điểm nhấn/focus và trường hợp có tương phản phù hợp. Không gọi toàn bộ giao diện là đạt WCAG AA chỉ vì màu CTA đạt một phép kiểm tra.

Border #E3E8EF phù hợp đường phân cách trang trí. Với control cần đường bao để nhận diện, dùng biến thể control-border rõ hơn từ palette, ví dụ text-muted, và kiểm tra trên nền thực tế. Focus ring phải nhìn thấy; trạng thái lỗi/thành công có text/icon ngoài màu.

## Quy chuẩn giao diện Foundation

- Sidebar sáng, tiêu đề/nav navy, thao tác chính xanh; nền canvas và card trắng.
- Tiếng Việt rõ nghĩa; không chép ngôn ngữ cổng bãi/container sang sản phẩm Foundation.
- Ưu tiên bảng, bộ lọc, form và phân cấp thông tin; tránh KPI/trang trí không phục vụ tác vụ.
- Component thực tế từ shadcn/ui, cấu hình theme chung; không chỉ đặt tên CSS “shadcn”.
- Table responsive hoặc có vùng cuộn có chủ đích; không tràn toàn trang trên mobile.
- Label luôn hiện, lỗi đặt cạnh trường, dialog có focus trap/restore focus và thao tác bàn phím.
- Màn hình phải có loading, empty, error, no-access; quyền backend vẫn quyết định thao tác được phép.
- Chỉ dùng logo chính thức đã được cung cấp; trước đó dùng wordmark TLQM AIO dạng chữ.
- Với identity/session, giữ cơ chế server session/BFF và CSRF; thay giao diện không làm yếu luồng SSO.

## Nghiệm thu khi triển khai frontend

Kiểm tra desktop 1440px, mobile 390px và thao tác keyboard. Chụp ảnh từ dữ liệu giả lập sau khi đọc computed colors/font/radius của component thật; kiểm tra primary/hover/focus, badges, bảng, modal và form invalid.

Hiện public/index.html và public/styles.css vẫn là trang kiểm chứng SSO cũ. Tài liệu này xác định chuẩn cho lần xây frontend tiếp theo, không tuyên bố trang hiện tại đã chuyển sang shadcn.
