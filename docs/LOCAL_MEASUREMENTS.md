# Số đo Foundation local

Lượt đo: 2026-11-09T17:35:57.272Z. Node v24.20.0. Database aio_foundation_test, dữ liệu giả lập.

API được chạy bằng JavaScript đã build trong process riêng, gồm ba BFF A/B/C; không tính process Chromium/runner. PID, command line, cổng và health identity được đối chiếu trước/sau đo.

| Chỉ số API | Giá trị |
| --- | --- |
| Khởi động API (IdP/DB đã chạy) | 836.46 ms |
| RSS khi nghỉ sau warmup | 120.92 MiB |
| CPU lúc nghỉ / một core | 0% |
| RSS cao nhất trong các mẫu workload | 121.92 MiB |
| CPU workload / một core | 11.56% |

100 request tuần tự, concurrency 1, sau 15 warmup request; 3928.46 ms. Access được introspect và quyền được đọc từ DB trên mỗi request.

| Endpoint | n | p50 ms | p95 ms | max ms | Bytes cuối |
| --- | --- | --- | --- | --- | --- |
| health/live | 20 | 2.02 | 2.78 | 3.08 | 42 |
| me | 20 | 47.17 | 58.82 | 63.63 | 828 |
| directory | 20 | 45.94 | 54.01 | 55.42 | 722 |
| roles | 20 | 46.19 | 52.3 | 57.86 | 26462 |
| audit | 20 | 47.34 | 61.2 | 71.09 | 77585 |

Docker stats trong lúc workload (snapshot, không phải CPU trung bình toàn lượt):

| Container | CPU | RAM sử dụng / giới hạn | PIDs |
| --- | --- | --- | --- |
| tlqm-aio-local-keycloak-1 | 73.09% | 642.6MiB / 2GiB | 74 |
| tlqm-aio-local-foundation-db-1 | 40.93% | 55.27MiB / 15.44GiB | 8 |
| tlqm-aio-local-identity-db-1 | 2.76% | 52.43MiB / 15.44GiB | 8 |

Đây là số đo một máy local, warm cache và fixture nhỏ. Không suy ra SLA production, capacity hoặc kết luận “nhẹ” từ lượt đo này. RSS khác heap; giới hạn memory container khác mức RAM thực dùng. Keycloak/PostgreSQL nằm trong Docker Desktop VM, không cộng thẳng các số này để suy ra RAM toàn máy.

Lệnh tái lập: npm run build rồi npm run measure:local, khi API dev/E2E đã dừng. Báo cáo JSON chi tiết trong .local/evidence/measurements.json. Không chứa token/cookie hoặc response dữ liệu người dùng.
