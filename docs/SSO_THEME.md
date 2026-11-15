# Giao diện đăng nhập SSO TLQM

Ngày 10/11/2026. Theme `tlqm` dành cho realm **aio-local** trong stack `tlqm-aio-local`, Keycloak **26.8.2**. Theme chung cho các ứng dụng AIO dùng realm này; không sửa màn quản trị Keycloak hoặc hệ thống BOS/LMS hiện hữu.

## Thiết kế và phạm vi

Đối chiếu [Design System TLQM](FRONTEND_DESIGN_SYSTEM.md): Be Vietnam Pro 400/500/600/700 phục vụ nội bộ, CTA #087C3C/hover #076934, navy #223873, canvas #F5F8FA, card trắng, focus #0A9444, radius 8/10/14px và vùng bấm tối thiểu 44px. Light mode kể cả khi hệ điều hành chọn dark. Dùng [emblem và wordmark chính thức](../brand/tlqm-2026/README.md) từ D:/TLQM/Logo; bản màu ở header, bản trắng trên nền navy, cùng favicon với AIO.

Theme kế thừa `keycloak.v2`; CSS, messages vi/en, layout, footer và một script accessibility nhỏ nằm ở `infrastructure/keycloak/themes/tlqm/login`. Layout template.ftl được trích từ Keycloak 26.8.2, giữ scripts bảo mật và các nested section, thay bố cục ngoài thành hai vùng và chuyển chọn ngôn ngữ lên topbar. Giấy phép upstream nằm trong KEYCLOAK-LICENSE.txt. Font WOFF2 và giấy phép SIL OFL được lấy từ package @fontsource/be-vietnam-pro đã cài trong AIO. Đây là theme Keycloak cùng design tokens với React/shadcn; không chạy React trong trang xác thực.

Giữ nguyên templates/form actions của password, OTP, enrollment, logout và lỗi từ Keycloak. Script accessibility chỉ nối label của tên tài khoản với đúng ID input trên OTP/reauthentication và bỏ `aria-invalid` rỗng của template gốc. Không đọc giá trị trường, không có analytics hoặc request ra ngoài. Tooltip đổi vị trí để vừa màn hình nhỏ và hỗ trợ focus bàn phím.

Đã đối chiếu template/properties từ JAR của container 26.8.2 thực tế và [tài liệu theme chính thức](https://www.keycloak.org/ui-customization/themes). Khi nâng phiên bản Keycloak phải chạy lại kiểm thử kế thừa template, không suy ra tương thích từ tên theme.

## Cài đặt và chạy lại

Đọc [runbook local](LOCAL_DEVELOPMENT.md) trước khi vận hành. Docker mount chỉ đọc source theme vào `/opt/keycloak/themes/tlqm`. Các cờ tắt cache theme chỉ dùng cho stack phát triển local. Thay đổi mount cần chạy lại local:up; CSS/messages sau đó được đọc trực tiếp từ source.

~~~powershell
npm run local:up
npm run local:sso-theme -- status
npm run test:sso-theme
~~~

local:up gọi `ensure`: lần đầu áp dụng theme và tạo receipt `.local/sso-theme.json` chỉ chứa instance ID, thời gian và bốn cài đặt giao diện cũ. Những lần sau giữ lựa chọn hiện hành, kể cả khi đã rollback. Lệnh `apply` rõ ràng sẽ chọn lại theme TLQM:

~~~powershell
npm run local:sso-theme -- apply
npm run local:sso-theme -- rollback
~~~

Rollback phục hồi loginTheme, internationalizationEnabled, supportedLocales và defaultLocale đã ghi nhận; nếu lựa chọn đã thay đổi độc lập, script từ chối ghi đè. Script chỉ cập nhật bốn thuộc tính này và so sánh tất cả thuộc tính realm còn lại trước/sau. Flow, MFA, brute-force protection, audiences, PKCE, CSP và credentials không bị cập nhật bởi script theme. Không rollback database hoặc xóa volume.

Đã diễn tập rollback → ensure giữ lựa chọn → apply → apply lần nữa; receipt gốc được giữ nguyên. local:up vẫn thực hiện các bước đồng bộ audience vốn có của stack trước bước theme.

Mở ứng dụng tại http://127.0.0.1:4105 rồi chọn Đăng nhập SSO. Khi đang có phiên SSO, dùng http://127.0.0.1:4105/auth/login?reauth=1 để mở lượt xác thực mới. Không lưu/chia sẻ URL authorize chứa state/nonce từ một lượt đăng nhập cũ.

## Kiểm chứng

`test:sso-theme` kiểm computed colors/font thực sự loaded, 44px/radius, hover/focus, keyboard và hiện/ẩn password, vi/en, lỗi mật khẩu/OTP và proof MFA thật qua OIDC client có kiểm state/nonce/PKCE/audience. Có geometry checks tại 1904/1440/1024/900/899/768/390/320px: form desktop không co thành khung mobile, tiêu đề một dòng, ô ngôn ngữ đủ rộng và hai vùng không đè nhau. Bảy scans axe không có violations trong đợt layout đã chạy; các luật incomplete giữ trong `.local/evidence/sso-theme-e2e.json`.

Suite xác thực không chụp màn hình, không lưu DOM/trace, URL callback, credential, mã OTP, token hoặc cookie. Riêng kiểm tra bố cục theo yêu cầu người dùng dùng browser context mới, chỉ chụp trang đăng nhập trống sau khi xác nhận username/password rỗng và không có OTP/enrollment/tài khoản đã chọn; không đăng nhập trong context này. Đã xem ảnh desktop/mobile, không suy ra chất lượng bố cục chỉ từ axe. Kiểm tra tự động không phải chứng nhận WCAG toàn sản phẩm. Evidence hồi quy theme đầu ở sso-theme-regression.json; layout hai vùng ở sso-theme-layout-regression.json; tích hợp bộ logo ở brand-integration-regression.json trong `.local/evidence`.

Chưa tùy biến Account Console, Admin Console, email, WebAuthn/passkeys hoặc giao diện production; không tuyên bố nghiệm thu các luồng chưa kiểm thử.

Chốt đợt logo chính thức: check 103 tests, test:sso-theme với 7 scans và toàn bộ hồi quy Foundation/Quy trình/Forms UI/LMS đều pass, kết thúc 2026-11-10T01:34:03Z. Đã kiểm chứng logo/favicons trả đúng bytes trong manifest web và xem ảnh login trống 1440/390px; kiểm tra thêm 1904/320px không tràn. Chi tiết ở [bộ nhận diện](../brand/tlqm-2026/README.md).
