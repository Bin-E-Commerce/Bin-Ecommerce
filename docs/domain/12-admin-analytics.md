# 📊 Domain: Admin Analytics & Reports

> **Không có service riêng** — queries thực thi trong từng service tương ứng, expose qua admin API Gateway
> **Database:** RDS PostgreSQL (order-service, product-service, inventory-service schemas)
> **Cập nhật:** 22/04/2026

---

## Mục Lục

1. [Tổng Quan Domain](#1-tổng-quan-domain)
2. [Report Definitions](#2-report-definitions)
3. [API Contract](#3-api-contract)
4. [Response Format Convention](#4-response-format-convention)
5. [Query Strategies & Caching](#5-query-strategies--caching)
6. [KPI Definitions](#6-kpi-definitions)
7. [Validation Rules](#7-validation-rules)
8. [Error Catalog](#8-error-catalog)

---

## 1. Tổng Quan Domain

Analytics MVP chạy theo cơ chế **query-on-demand**: khi admin request → service query DB theo params → trả kết quả chart-ready.

**Không dùng data warehouse** (quá phức tạp và tốn RAM cho MVP trên t3.micro).

| Report                   | Service xử lý     | DB query                                       |
| ------------------------ | ----------------- | ---------------------------------------------- |
| Doanh thu theo thời gian | order-service     | `orders` table                                 |
| Sản phẩm bán chạy        | order-service     | `order_items` JOIN `products`                  |
| Thống kê trạng thái đơn  | order-service     | `orders` table GROUP BY status                 |
| Tồn kho thấp / nguy hiểm | inventory-service | `inventory_items` WHERE qty <= threshold       |
| Tỉ lệ đổi trả            | return-service    | `return_requests` COUNT                        |
| Summary card             | order-service     | Multi-query: revenue today, orders today, etc. |

**Ngoài phạm vi MVP:**

- Real-time dashboards (WebSocket)
- Custom report builder
- Export to Excel / CSV
- Scheduled reports gửi email
- Funnel analytics (từ view → add-to-cart → checkout → order)
- Cohort analysis

---

## 2. Report Definitions

### 2.1 Revenue Report

**Mục đích:** Doanh thu theo ngày / tuần / tháng  
**Nguồn:** `orders` WHERE `status IN ('CONFIRMED', 'SHIPPING', 'DELIVERED')`  
**Metric:** `SUM(total_amount)`, `COUNT(*) as order_count`, `AVG(total_amount) as aov`

**groupBy options:**

- `day`: mỗi điểm = 1 ngày
- `week`: mỗi điểm = 1 tuần (ISO week)
- `month`: mỗi điểm = 1 tháng

---

### 2.2 Top Products Report

**Mục đích:** Sản phẩm / variant bán chạy nhất  
**Nguồn:** `order_items` JOIN `orders` WHERE `orders.status IN ('CONFIRMED','SHIPPING','DELIVERED')`  
**Metric:** `SUM(quantity) as unitsSold`, `SUM(quantity * unit_price) as revenue`

---

### 2.3 Order Status Distribution

**Mục đích:** Phân phối đơn hàng theo trạng thái trong khoảng thời gian  
**Nguồn:** `orders` GROUP BY `status`  
**Metric:** `COUNT(*) as count`, `SUM(total_amount) as totalRevenue`

---

### 2.4 Inventory Health Report

**Mục đích:** Tồn kho theo mức độ nguy hiểm  
**Nguồn:** `inventory_items` JOIN `product_variants` JOIN `products`  
**Metric:** `available_qty`, `reserved_qty`, `threshold`

**Alert levels:**

- `CRITICAL`: `available_qty ≤ 2`
- `LOW`: `available_qty ≤ threshold AND available_qty > 2`
- `NORMAL`: `available_qty > threshold`

---

### 2.5 Return Rate Report

**Mục đích:** Tỉ lệ đổi trả theo thời gian  
**Nguồn:** `return_requests` + `orders`  
**Metric:** `returnRate = (COUNT returns APPROVED) / (COUNT orders DELIVERED) * 100`

---

### 2.6 Dashboard Summary Cards

**Mục đích:** Thống kê nhanh cho trang Dashboard admin

| Card                                 | Query                                                |
| ------------------------------------ | ---------------------------------------------------- |
| Doanh thu hôm nay                    | `SUM(total_amount) WHERE created_at >= today`        |
| Đơn hàng hôm nay                     | `COUNT(*) WHERE created_at >= today`                 |
| Đơn chờ xử lý                        | `COUNT(*) WHERE status IN ('PENDING', 'PROCESSING')` |
| Sản phẩm sắp hết hàng                | `COUNT(*) WHERE available_qty <= threshold`          |
| Yêu cầu đổi trả mới                  | `COUNT(*) WHERE status = 'PENDING'`                  |
| Doanh thu tháng này (vs tháng trước) | So sánh 2 khoảng thời gian                           |

---

## 3. API Contract

### `GET /api/admin/analytics/summary` _(ADMIN)_

**Mô tả:** Dashboard summary cards

**Response 200:**

```json
{
  "success": true,
  "data": {
    "revenue": {
      "today": 15000000,
      "todayOrderCount": 8,
      "thisMonth": 450000000,
      "lastMonth": 380000000,
      "monthOverMonthGrowth": 18.4
    },
    "orders": {
      "pendingCount": 12,
      "processingCount": 5,
      "todayNewOrders": 8
    },
    "inventory": {
      "criticalStockCount": 3,
      "lowStockCount": 15
    },
    "returns": {
      "pendingReturnCount": 4
    },
    "generatedAt": "2026-04-22T10:00:00.000Z"
  }
}
```

---

### `GET /api/admin/analytics/revenue` _(ADMIN)_

**Query Params:**

| Param     | Type               | Required          | Mô tả                      |
| --------- | ------------------ | ----------------- | -------------------------- |
| `from`    | `ISO date`         | ✅                | Ngày bắt đầu (YYYY-MM-DD)  |
| `to`      | `ISO date`         | ✅                | Ngày kết thúc (YYYY-MM-DD) |
| `groupBy` | `day\|week\|month` | ❌ (default: day) | Đơn vị nhóm                |

**Constraints:** Khoảng `from → to` tối đa 365 ngày. `groupBy=day` tối đa 90 ngày.

**Response 200:**

```json
{
  "success": true,
  "data": {
    "period": {
      "from": "2026-04-01",
      "to": "2026-04-22",
      "groupBy": "day"
    },
    "totals": {
      "revenue": 245000000,
      "orderCount": 143,
      "avgOrderValue": 1713287
    },
    "chart": {
      "labels": ["01/04", "02/04", "03/04", "04/04"],
      "datasets": [
        {
          "label": "Doanh thu (VNĐ)",
          "data": [8500000, 12000000, 9800000, 15600000]
        },
        {
          "label": "Số đơn hàng",
          "data": [5, 8, 6, 10]
        }
      ]
    }
  }
}
```

---

### `GET /api/admin/analytics/top-products` _(ADMIN)_

**Query Params:**

| Param    | Type                   | Required                  | Mô tả            |
| -------- | ---------------------- | ------------------------- | ---------------- |
| `limit`  | `integer`              | ❌ (default: 10, max: 50) | Số lượng         |
| `period` | `7d\|30d\|90d\|custom` | ❌ (default: 30d)         | Khoảng thời gian |
| `from`   | `ISO date`             | Nếu `period=custom`       |                  |
| `to`     | `ISO date`             | Nếu `period=custom`       |                  |
| `metric` | `units\|revenue`       | ❌ (default: revenue)     | Sắp xếp theo     |

**Response 200:**

```json
{
  "success": true,
  "data": {
    "period": "30d",
    "metric": "revenue",
    "products": [
      {
        "rank": 1,
        "productId": "prod-uuid",
        "productName": "iPhone 15 Pro 128GB",
        "thumbnailUrl": "https://res.cloudinary.com/...",
        "categoryName": "Điện thoại",
        "unitsSold": 45,
        "revenue": 1125000000,
        "avgPrice": 25000000
      },
      {
        "rank": 2,
        "productId": "prod-uuid-2",
        "productName": "AirPods Pro 2nd Gen",
        "thumbnailUrl": "https://res.cloudinary.com/...",
        "categoryName": "Phụ kiện",
        "unitsSold": 89,
        "revenue": 534000000,
        "avgPrice": 5999000
      }
    ]
  }
}
```

---

### `GET /api/admin/analytics/orders` _(ADMIN)_

**Query Params:** `?from=YYYY-MM-DD&to=YYYY-MM-DD`

**Response 200:**

```json
{
  "success": true,
  "data": {
    "period": { "from": "2026-04-01", "to": "2026-04-22" },
    "summary": {
      "total": 156,
      "totalRevenue": 245000000,
      "cancelledCount": 8,
      "cancelRate": 5.1,
      "returnCount": 4,
      "returnRate": 2.6
    },
    "statusDistribution": {
      "chart": {
        "labels": [
          "Đang xử lý",
          "Đang vận chuyển",
          "Đã giao",
          "Đã hủy",
          "Đang đổi trả"
        ],
        "datasets": [
          {
            "label": "Số đơn hàng",
            "data": [12, 35, 97, 8, 4]
          }
        ]
      }
    },
    "paymentMethods": {
      "chart": {
        "labels": ["Stripe (card)", "COD"],
        "datasets": [
          {
            "label": "Số đơn",
            "data": [98, 58]
          }
        ]
      }
    }
  }
}
```

---

### `GET /api/admin/analytics/inventory` _(ADMIN)_

**Query Params:** `?alertLevel=CRITICAL|LOW|ALL` (default: ALL)

**Response 200:**

```json
{
  "success": true,
  "data": {
    "summary": {
      "totalVariants": 245,
      "criticalCount": 3,
      "lowCount": 15,
      "normalCount": 227
    },
    "alertItems": [
      {
        "variantId": "variant-uuid",
        "productId": "prod-uuid",
        "productName": "iPhone 15 Pro",
        "variantInfo": "128GB - Đen tự nhiên",
        "sku": "IP15P-128-BLACK",
        "availableQty": 1,
        "reservedQty": 2,
        "threshold": 5,
        "alertLevel": "CRITICAL",
        "lastRestockedAt": "2026-04-10T00:00:00.000Z"
      }
    ],
    "chart": {
      "labels": ["CRITICAL (≤2)", "LOW (≤threshold)", "NORMAL"],
      "datasets": [
        {
          "label": "Số variants",
          "data": [3, 15, 227]
        }
      ]
    }
  }
}
```

---

### `GET /api/admin/analytics/returns` _(ADMIN)_

**Query Params:** `?from=YYYY-MM-DD&to=YYYY-MM-DD&groupBy=day|month`

**Response 200:**

```json
{
  "success": true,
  "data": {
    "period": { "from": "2026-04-01", "to": "2026-04-22", "groupBy": "day" },
    "summary": {
      "totalReturns": 18,
      "approvedReturns": 12,
      "rejectedReturns": 4,
      "pendingReturns": 2,
      "totalRefundAmount": 25000000
    },
    "topReturnReasons": [
      { "reason": "DEFECTIVE", "count": 7, "percent": 38.9 },
      { "reason": "NOT_AS_DESCRIBED", "count": 5, "percent": 27.8 },
      { "reason": "CHANGED_MIND", "count": 4, "percent": 22.2 },
      { "reason": "OTHER", "count": 2, "percent": 11.1 }
    ],
    "chart": {
      "labels": ["01/04", "02/04", "..."],
      "datasets": [{ "label": "Yêu cầu đổi trả", "data": [1, 0, 2, 1] }]
    }
  }
}
```

---

## 4. Response Format Convention

Tất cả chart data theo chuẩn **Chart.js compatible**:

```typescript
interface ChartData {
  labels: string[]; // X-axis labels
  datasets: Array<{
    label: string; // Legend label
    data: number[]; // Y-axis values
    backgroundColor?: string | string[]; // optional
    borderColor?: string; // optional
  }>;
}
```

**Date label formats:**

- `groupBy=day`: `"DD/MM"` (ví dụ: `"22/04"`)
- `groupBy=week`: `"Tuần DD/MM"` (ví dụ: `"Tuần 21/04"`)
- `groupBy=month`: `"Tháng MM/YYYY"` (ví dụ: `"Tháng 04/2026"`)

**Currency:** Tất cả revenue/amount trả về dạng số nguyên VNĐ (không dấu phẩy, không đơn vị)

---

## 5. Query Strategies & Caching

### Caching với Redis (nếu RAM cho phép) hoặc in-memory cache:

| Endpoint                  | Cache TTL | Key                                                |
| ------------------------- | --------- | -------------------------------------------------- |
| `/analytics/summary`      | 5 phút    | `analytics:summary:{date}`                         |
| `/analytics/revenue`      | 15 phút   | `analytics:revenue:{from}:{to}:{groupBy}`          |
| `/analytics/top-products` | 30 phút   | `analytics:top-products:{period}:{limit}:{metric}` |
| `/analytics/inventory`    | 2 phút    | `analytics:inventory:{alertLevel}`                 |

### Fallback nếu không có Redis:

- Dùng NestJS `@nestjs/cache-manager` với TTL in-memory
- Giới hạn: không share cache giữa các instances (OK vì MVP 1 instance)

### Query optimization:

```sql
-- Revenue query (order-service)
SELECT
  DATE_TRUNC('day', created_at AT TIME ZONE 'Asia/Ho_Chi_Minh') AS period,
  SUM(total_amount) AS revenue,
  COUNT(*) AS order_count
FROM orders
WHERE
  status IN ('CONFIRMED', 'SHIPPING', 'DELIVERED')
  AND created_at >= :from
  AND created_at < :to + INTERVAL '1 day'
GROUP BY DATE_TRUNC('day', created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')
ORDER BY period ASC;

-- Index để tối ưu query này:
CREATE INDEX idx_orders_created_status ON orders(created_at, status);
```

---

## 6. KPI Definitions

| KPI                       | Công thức                                            | Nguồn                                 |
| ------------------------- | ---------------------------------------------------- | ------------------------------------- |
| **Conversion Rate**       | `Orders / Sessions`                                  | Cần frontend tracking (ngoài phạm vi) |
| **AOV (Avg Order Value)** | `Total Revenue / Order Count`                        | `orders` table                        |
| **Return Rate**           | `Return requests APPROVED / Orders DELIVERED × 100%` | `return_requests` + `orders`          |
| **Cancellation Rate**     | `Orders CANCELLED / Total Orders × 100%`             | `orders` table                        |
| **Payment Success Rate**  | `Orders CONFIRMED / Orders CREATED × 100%`           | `orders` table                        |
| **Inventory Turnover**    | Không tính MVP (cần COGS data)                       | —                                     |

---

## 7. Validation Rules

| Param                        | Rule                                             |
| ---------------------------- | ------------------------------------------------ |
| `from`                       | ISO 8601 date, không được > `to`                 |
| `to`                         | ISO 8601 date, không được > today                |
| `from → to` range            | Tối đa **365 ngày**                              |
| `groupBy=day` với date range | Tối đa **90 ngày** (tránh quá nhiều data points) |
| `limit` (top-products)       | 1 đến 50                                         |

---

## 8. Error Catalog

| HTTP | Error Code                | Message (vi)                                         | Điều kiện                     |
| ---- | ------------------------- | ---------------------------------------------------- | ----------------------------- |
| 400  | `INVALID_DATE_FORMAT`     | "Định dạng ngày không hợp lệ, dùng YYYY-MM-DD"       | from/to không phải ISO date   |
| 400  | `DATE_RANGE_INVALID`      | "Ngày bắt đầu phải trước ngày kết thúc"              | from > to                     |
| 400  | `DATE_RANGE_TOO_LARGE`    | "Khoảng thời gian tối đa là 365 ngày"                | Range > 365 ngày              |
| 400  | `GROUPBY_RANGE_TOO_LARGE` | "Khi group theo ngày, tối đa 90 ngày"                | groupBy=day + range > 90 ngày |
| 400  | `INVALID_GROUPBY`         | "groupBy chỉ chấp nhận: day, week, month"            | Giá trị không hợp lệ          |
| 400  | `FUTURE_DATE`             | "Không thể truy vấn dữ liệu tương lai"               | to > today                    |
| 503  | `ANALYTICS_TIMEOUT`       | "Truy vấn mất quá nhiều thời gian, vui lòng thử lại" | Query timeout > 5s            |
