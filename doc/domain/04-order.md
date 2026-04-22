# 📋 Domain: Order Management & Saga

> **Service:** `order-service` — Port `3004`
> **Database:** AWS RDS PostgreSQL — schema `orders`
> **Workflow Engine:** Camunda 8 SaaS — Zeebe gRPC `:26500`
> **Kafka Topics:** `order.created` · `order.paid` · `order.failed` · `order.shipped`
> **Cập nhật:** 22/04/2026

---

## Mục Lục

1. [Tổng Quan Domain](#1-tổng-quan-domain)
2. [Entities & Data Model](#2-entities--data-model)
3. [Business Rules](#3-business-rules)
4. [API Contract](#4-api-contract)
5. [State Machine — Order](#5-state-machine--order)
6. [Order Fulfillment Saga (Camunda BPMN)](#6-order-fulfillment-saga-camunda-bpmn)
7. [Luồng Nghiệp Vụ](#7-luồng-nghiệp-vụ)
8. [Validation Rules](#8-validation-rules)
9. [Error Catalog](#9-error-catalog)

---

## 1. Tổng Quan Domain

| Trách nhiệm         | Mô tả                                                     |
| ------------------- | --------------------------------------------------------- |
| Tạo đơn hàng        | Nhận request từ user, validate, persist, khởi động Saga   |
| Orchestrate Saga    | Kết nối Camunda 8 Zeebe — thực hiện các Zeebe Job Workers |
| Tracking trạng thái | Cập nhật `status` theo từng bước của Saga                 |
| Xem đơn hàng        | User xem lịch sử đơn, chi tiết đơn; Admin xem tất cả      |
| Hủy đơn             | User/Admin hủy đơn trong các trạng thái cho phép          |
| Publish events      | Kafka producer: thông báo kết quả cho các service khác    |

**Zeebe Job Workers (chạy trong Order Service):**

- `validate-order` — kiểm tra user, items, địa chỉ
- `reserve-inventory` — gọi Inventory Service
- `process-payment` — gọi Stripe
- `confirm-order` — update status → CONFIRMED
- `trigger-shipment` — tạo shipment record
- `release-inventory` (compensation) — gọi Inventory Service rollback
- `refund-payment` (compensation) — gọi Stripe refund

---

## 2. Entities & Data Model

### 2.1 Entity: `orders`

| Column              | Type                   | Constraint                 | Mô tả                             |
| ------------------- | ---------------------- | -------------------------- | --------------------------------- |
| `id`                | `UUID`                 | PK                         |                                   |
| `user_id`           | `UUID`                 | NOT NULL FK → users.id     | Người đặt hàng                    |
| `address_id`        | `UUID`                 | NULLABLE                   | Snapshot address ID (lúc đặt)     |
| `shipping_address`  | `JSONB`                | NOT NULL                   | Snapshot địa chỉ giao hàng đầy đủ |
| `status`            | `ENUM`                 | NOT NULL DEFAULT 'PENDING' | Xem state machine                 |
| `total_amount`      | `NUMERIC(14,2)`        | NOT NULL CHECK > 0         | Tổng tiền (VNĐ)                   |
| `shipping_fee`      | `NUMERIC(10,2)`        | NOT NULL DEFAULT 0         | Phí vận chuyển                    |
| `note`              | `TEXT`                 | NULLABLE                   | Ghi chú của khách                 |
| `payment_method`    | `ENUM('STRIPE','COD')` | NOT NULL                   | Phương thức thanh toán            |
| `payment_intent_id` | `VARCHAR(255)`         | NULLABLE                   | Stripe Payment Intent ID          |
| `zeebe_process_key` | `BIGINT`               | NULLABLE                   | Camunda process instance key      |
| `cancel_reason`     | `TEXT`                 | NULLABLE                   | Lý do hủy                         |
| `cancelled_by`      | `UUID`                 | NULLABLE                   | User hủy (admin hay chính user)   |
| `created_at`        | `TIMESTAMPTZ`          | NOT NULL DEFAULT NOW()     |                                   |
| `updated_at`        | `TIMESTAMPTZ`          | NOT NULL DEFAULT NOW()     |                                   |
| `confirmed_at`      | `TIMESTAMPTZ`          | NULLABLE                   |                                   |
| `shipped_at`        | `TIMESTAMPTZ`          | NULLABLE                   |                                   |
| `delivered_at`      | `TIMESTAMPTZ`          | NULLABLE                   |                                   |
| `cancelled_at`      | `TIMESTAMPTZ`          | NULLABLE                   |                                   |

**ENUM `order_status`:**

```sql
CREATE TYPE order_status AS ENUM (
  'PENDING',
  'VALIDATING',
  'INVENTORY_RESERVED',
  'PAYMENT_PROCESSING',
  'CONFIRMED',
  'SHIPPING',
  'DELIVERED',
  'CANCELLED',
  'FAILED'
);
```

```sql
CREATE INDEX idx_orders_user_id    ON orders(user_id);
CREATE INDEX idx_orders_status     ON orders(status);
CREATE INDEX idx_orders_created_at ON orders(created_at DESC);
```

---

### 2.2 Entity: `order_items`

| Column          | Type            | Constraint                       | Mô tả                       |
| --------------- | --------------- | -------------------------------- | --------------------------- |
| `id`            | `UUID`          | PK                               |                             |
| `order_id`      | `UUID`          | FK → orders.id ON DELETE CASCADE |                             |
| `product_id`    | `UUID`          | NOT NULL                         | FK → products.id (soft ref) |
| `product_name`  | `VARCHAR(255)`  | NOT NULL                         | Snapshot tên                |
| `product_sku`   | `VARCHAR(100)`  | NULLABLE                         | Snapshot SKU                |
| `thumbnail_url` | `TEXT`          | NULLABLE                         | Snapshot ảnh                |
| `unit_price`    | `NUMERIC(12,2)` | NOT NULL                         | Giá tại thời điểm đặt       |
| `quantity`      | `INT`           | NOT NULL CHECK > 0               | Số lượng                    |
| `subtotal`      | `NUMERIC(14,2)` | NOT NULL                         | `unit_price × quantity`     |

```sql
CREATE INDEX idx_order_items_order_id   ON order_items(order_id);
CREATE INDEX idx_order_items_product_id ON order_items(product_id);
```

---

### 2.3 Entity: `order_status_history`

| Column        | Type           | Constraint                       | Mô tả                   |
| ------------- | -------------- | -------------------------------- | ----------------------- |
| `id`          | `UUID`         | PK                               |                         |
| `order_id`    | `UUID`         | FK → orders.id ON DELETE CASCADE |                         |
| `from_status` | `order_status` | NULLABLE                         | Trạng thái trước        |
| `to_status`   | `order_status` | NOT NULL                         | Trạng thái mới          |
| `changed_by`  | `VARCHAR(100)` | NOT NULL                         | `user_id` hoặc `system` |
| `reason`      | `TEXT`         | NULLABLE                         | Lý do thay đổi          |
| `created_at`  | `TIMESTAMPTZ`  | NOT NULL DEFAULT NOW()           |                         |

---

## 3. Business Rules

### BR-ORDER-001: Tạo đơn hàng

- User phải đăng nhập (`status = ACTIVE`)
- `items` không được rỗng
- Tất cả `productId` trong items phải đang `ACTIVE`
- `quantity` của mỗi item phải là integer 1–99
- `shippingAddressId` phải thuộc về user đang đặt hàng
- `totalAmount` = Σ(`unitPrice × quantity`) + `shippingFee` — tính lại server-side, không tin giá từ client
- `unitPrice` lấy từ Product Service (giá hiện tại, không phải giá trong cart)
- Sau khi tạo: status = `PENDING`, publish Kafka `order.created`, khởi động Zeebe process

### BR-ORDER-002: Snapshot data

- Tại thời điểm tạo đơn: snapshot `productName`, `sku`, `thumbnailUrl`, `unitPrice` vào `order_items`
- Snapshot `shippingAddress` (full JSON: tên, SĐT, địa chỉ) vào `orders.shipping_address`
- Sau này dù admin sửa giá hay user sửa địa chỉ → đơn hàng cũ không bị ảnh hưởng

### BR-ORDER-003: Saga flow

- Mọi bước chuyển trạng thái do **Camunda Zeebe** orchestrate, không do API trực tiếp
- Thứ tự: `PENDING` → `VALIDATING` → `INVENTORY_RESERVED` → `PAYMENT_PROCESSING` → `CONFIRMED` → `SHIPPING` → `DELIVERED`
- Nếu reserve inventory fail: → `FAILED` (không cần compensate vì chưa thanh toán)
- Nếu payment fail: → compensate (release inventory) → `FAILED`
- Nếu bất kỳ bước nào timeout sau 10 phút: → `FAILED` (Zeebe timer boundary event)

### BR-ORDER-004: Hủy đơn

- User chỉ được hủy khi `status IN ('PENDING', 'VALIDATING', 'INVENTORY_RESERVED')`
- ADMIN được hủy khi `status IN ('PENDING', 'VALIDATING', 'INVENTORY_RESERVED', 'PAYMENT_PROCESSING', 'CONFIRMED')`
- Khi hủy đơn `INVENTORY_RESERVED`: phải trigger compensate `release-inventory`
- Khi hủy đơn `PAYMENT_PROCESSING`/`CONFIRMED`: phải trigger `refund-payment`
- Sau khi hủy: publish Kafka `order.cancelled`

### BR-ORDER-005: Xem đơn hàng

- User chỉ xem được đơn của chính mình
- ADMIN xem được tất cả đơn
- Đơn hàng không bị xóa — giữ lại để audit trail

### BR-ORDER-006: Tiền hàng

- `totalAmount` và `subtotal` phải nhất quán: `totalAmount = Σ(order_items.subtotal) + shippingFee`
- `shippingFee` MVP = 0 (free shipping) hoặc flat fee 30,000đ
- Không cho phép `totalAmount = 0` (ngay cả khi promo)

---

## 4. API Contract

### `POST /api/orders` _(User)_

**Headers:** `Authorization: Bearer <accessToken>`

**Request:**

```json
{
  "items": [
    { "productId": "prod-uuid-1", "quantity": 2 },
    { "productId": "prod-uuid-2", "quantity": 1 }
  ],
  "shippingAddressId": "addr-uuid",
  "paymentMethod": "STRIPE",
  "note": "Giao giờ hành chính"
}
```

| Field               | Required | Rule                      |
| ------------------- | -------- | ------------------------- |
| `items`             | ✅       | Array, min 1 item         |
| `items[].productId` | ✅       | UUID, product phải ACTIVE |
| `items[].quantity`  | ✅       | Integer 1–99              |
| `shippingAddressId` | ✅       | UUID, thuộc về user       |
| `paymentMethod`     | ✅       | `STRIPE` hoặc `COD`       |
| `note`              | ❌       | max 500 chars             |

**Response 201:**

```json
{
  "success": true,
  "data": {
    "id": "order-uuid",
    "status": "PENDING",
    "totalAmount": 101970000,
    "shippingFee": 0,
    "paymentMethod": "STRIPE",
    "items": [
      {
        "id": "item-uuid",
        "productId": "prod-uuid-1",
        "productName": "iPhone 15 Pro Max 256GB",
        "quantity": 2,
        "unitPrice": 33990000,
        "subtotal": 67980000
      }
    ],
    "shippingAddress": {
      "fullName": "Nguyễn Văn A",
      "phone": "0901234567",
      "province": "TP. Hồ Chí Minh",
      "district": "Quận 1",
      "ward": "Phường Bến Nghé",
      "street": "123 Đường Lê Lợi"
    },
    "createdAt": "2026-04-22T09:00:00.000Z"
  }
}
```

**Errors:** `400` validation | `401` | `404` product/address không tồn tại | `422` product không ACTIVE | `422` totalAmount = 0

---

### `GET /api/orders` _(User)_

**Headers:** `Authorization: Bearer <accessToken>`

**Query Params:**

```
?page=1&limit=10&status=CONFIRMED&sort=createdAt&order=desc
```

**Response 200:**

```json
{
  "success": true,
  "data": [
    {
      "id": "order-uuid",
      "status": "CONFIRMED",
      "totalAmount": 101970000,
      "itemCount": 2,
      "paymentMethod": "STRIPE",
      "createdAt": "2026-04-22T09:00:00.000Z",
      "confirmedAt": "2026-04-22T09:02:30.000Z"
    }
  ],
  "meta": { "total": 15, "page": 1, "limit": 10, "totalPages": 2 }
}
```

---

### `GET /api/orders/:id` _(User)_

**Headers:** `Authorization: Bearer <accessToken>`

**Response 200:**

```json
{
  "success": true,
  "data": {
    "id": "order-uuid",
    "status": "CONFIRMED",
    "totalAmount": 101970000,
    "shippingFee": 0,
    "paymentMethod": "STRIPE",
    "paymentIntentId": "pi_3xxx",
    "note": "Giao giờ hành chính",
    "items": [...],
    "shippingAddress": {...},
    "statusHistory": [
      { "fromStatus": null, "toStatus": "PENDING", "changedBy": "user-uuid", "createdAt": "..." },
      { "fromStatus": "PENDING", "toStatus": "VALIDATING", "changedBy": "system", "createdAt": "..." },
      { "fromStatus": "VALIDATING", "toStatus": "INVENTORY_RESERVED", "changedBy": "system", "createdAt": "..." },
      { "fromStatus": "INVENTORY_RESERVED", "toStatus": "PAYMENT_PROCESSING", "changedBy": "system", "createdAt": "..." },
      { "fromStatus": "PAYMENT_PROCESSING", "toStatus": "CONFIRMED", "changedBy": "system", "createdAt": "..." }
    ],
    "createdAt": "2026-04-22T09:00:00.000Z",
    "confirmedAt": "2026-04-22T09:02:30.000Z"
  }
}
```

**Errors:** `401` | `403` đơn không thuộc user | `404`

---

### `POST /api/orders/:id/cancel` _(User)_

**Headers:** `Authorization: Bearer <accessToken>`

**Request:**

```json
{ "reason": "Tôi muốn thay đổi địa chỉ giao hàng" }
```

**Response 200:**

```json
{
  "success": true,
  "data": {
    "id": "order-uuid",
    "status": "CANCELLED",
    "cancelReason": "Tôi muốn thay đổi địa chỉ giao hàng",
    "cancelledAt": "2026-04-22T09:05:00.000Z"
  }
}
```

**Errors:** `404` | `403` đơn không thuộc user | `409` không thể hủy ở trạng thái hiện tại

---

### `GET /api/admin/orders` _(ADMIN only)_

**Query Params:**

```
?page=1&limit=20&status=PENDING&userId=uuid&fromDate=2026-04-01&toDate=2026-04-30
```

**Response 200:** list orders với `meta` pagination

---

### `PATCH /api/admin/orders/:id/status` _(ADMIN only)_

**Mô tả:** Admin cập nhật trạng thái thủ công (ví dụ: đánh dấu DELIVERED)

**Request:**

```json
{ "status": "DELIVERED", "reason": "Đã giao thành công" }
```

**Allowed transitions (admin manual):**

| From        | To          | Ghi chú                          |
| ----------- | ----------- | -------------------------------- |
| `CONFIRMED` | `SHIPPING`  | Bắt đầu giao hàng                |
| `SHIPPING`  | `DELIVERED` | Xác nhận đã giao                 |
| `CONFIRMED` | `CANCELLED` | Hủy sau confirm (trigger refund) |

---

### `POST /api/admin/orders/:id/cancel` _(ADMIN only)_

**Request:**

```json
{ "reason": "Khách không liên lạc được" }
```

---

## 5. State Machine — Order

```
            [User tạo đơn]
                  │
                  ▼
            ┌──────────┐
            │ PENDING  │
            └──────────┘
                  │
          [Saga: validate-order job]
                  │
                  ▼
          ┌─────────────┐
          │ VALIDATING  │
          └─────────────┘
                  │ ✅
          [Saga: reserve-inventory job]
                  │
                  ▼
      ┌─────────────────────┐
      │ INVENTORY_RESERVED  │
      └─────────────────────┘
                  │ ✅
       [Saga: process-payment job]
                  │
                  ▼
      ┌──────────────────────┐
      │ PAYMENT_PROCESSING   │
      └──────────────────────┘
           /            \
         ✅ paid       ❌ failed
          │                │
          ▼                ▼
    ┌───────────┐    ┌─────────┐
    │ CONFIRMED │    │ FAILED  │◀─── (release inventory compensate)
    └───────────┘    └─────────┘
          │
  [Admin: trigger shipping]
          │
          ▼
    ┌──────────┐
    │ SHIPPING │
    └──────────┘
          │
  [Admin: mark delivered]
          │
          ▼
    ┌───────────┐
    │ DELIVERED │  (terminal ✅)
    └───────────┘
```

**Hủy đơn (CANCELLED) có thể xảy ra từ:**

- `PENDING`, `VALIDATING`, `INVENTORY_RESERVED` → User hoặc Admin
- `PAYMENT_PROCESSING`, `CONFIRMED` → Admin only (trigger refund)

```
Bất kỳ non-terminal state + timeout 10 phút → FAILED (Zeebe timer)
```

**Terminal states:** `DELIVERED`, `CANCELLED`, `FAILED` — không chuyển trạng thái tiếp theo.

---

## 6. Order Fulfillment Saga (Camunda BPMN)

### BPMN Process: `order-fulfillment`

```
Start Event
    │
    ▼
[Service Task: validate-order]
  Worker: order-service
  Input:  { orderId, userId, items, addressId }
  Output: { valid: boolean, reason?: string }
    │
    ▼ (valid = true)
[Service Task: reserve-inventory]
  Worker: order-service → gọi inventory-service POST /reserve
  Input:  { orderId, items: [{productId, quantity}] }
  Output: { reserved: boolean }
    │
    ▼ (reserved = true)
[Service Task: process-payment]
  Worker: order-service → tạo Stripe PaymentIntent
  Input:  { orderId, amount, currency: 'vnd', paymentMethod }
  Output: { paid: boolean, paymentIntentId }
    │
    ├─── paid = true ───────────────────────────────────────────┐
    │                                                           │
[Error/Gateway: payment failed]                     [Service Task: confirm-order]
    │                                                  Worker: order-service
    ▼                                                  Output: status = CONFIRMED
[Compensation: release-inventory]                          │
  Worker: order-service → gọi inventory-service           ▼
  POST /release                               [Service Task: trigger-shipment]
    │                                           Worker: order-service
    ▼                                           Output: shipment created
[End Event: FAILED]                                        │
                                                           ▼
                                                  [End Event: SUCCESS ✅]
```

### Zeebe Job Types & SLA

| Job Type            | SLA (timeout) | Retry | Backoff |
| ------------------- | ------------- | ----- | ------- |
| `validate-order`    | 30 giây       | 2 lần | 5 giây  |
| `reserve-inventory` | 30 giây       | 2 lần | 5 giây  |
| `process-payment`   | 60 giây       | 1 lần | 10 giây |
| `confirm-order`     | 30 giây       | 3 lần | 5 giây  |
| `trigger-shipment`  | 30 giây       | 3 lần | 5 giây  |
| `release-inventory` | 30 giây       | 3 lần | 5 giây  |
| `refund-payment`    | 60 giây       | 2 lần | 15 giây |

**Global timeout:** Timer Boundary Event 10 phút trên toàn process → FAILED nếu chưa hoàn thành.

---

## 7. Luồng Nghiệp Vụ

### 7.1 Happy Path — Đặt hàng thành công

```
User      API Gateway     Order Service      Camunda Zeebe      Inventory     Stripe
  │            │                │                  │                │            │
  ├─POST/orders▶│                │                  │                │            │
  │            ├─JWT verify ───▶│                  │                │            │
  │            │                ├─validate input   │                │            │
  │            │                ├─fetch prices ──▶(Product Service) │            │
  │            │                ├─calculate total  │                │            │
  │            │                ├─INSERT order (PENDING)            │            │
  │            │                ├─startProcess ───▶│                │            │
  │◀──201 ─────────────────────│                  │                │            │
  │                             │                  │                │            │
  │                             │◀─Job:validate ───│                │            │
  │                             ├─check user/addr  │                │            │
  │                             ├─UPDATE VALIDATING│                │            │
  │                             ├─completeJob ────▶│                │            │
  │                             │                  │                │            │
  │                             │◀─Job:reserve ────│                │            │
  │                             ├─POST /reserve ──────────────────▶│            │
  │                             │◀─ reserved OK ───────────────────│            │
  │                             ├─UPDATE INVENTORY_RESERVED         │            │
  │                             ├─completeJob ────▶│                │            │
  │                             │                  │                │            │
  │                             │◀─Job:payment ────│                │            │
  │                             ├─Stripe PaymentIntent ────────────────────────▶│
  │                             │◀─ paid OK ───────────────────────────────────│
  │                             ├─UPDATE CONFIRMED │                │            │
  │                             ├─Kafka: order.paid│                │            │
  │                             ├─completeJob ────▶│                │            │
  │                             │                  │                │            │
  │                             │◀─Job:shipment ───│                │            │
  │                             ├─create shipment record            │            │
  │                             ├─UPDATE SHIPPING  │                │            │
  │                             ├─completeJob ────▶│                │            │
  │                             │                  │                │            │
```

### 7.2 Compensation Path — Payment Failed

```
Order Service          Camunda Zeebe        Inventory Service
     │                       │                     │
     │◀─ Job: process-payment│                     │
     ├─ Stripe → FAILED      │                     │
     ├─ completeJob(paid=false)──▶│                │
     │                       │                     │
     │◀─ Job: release-inventory ──│                │
     ├─ POST /inventory/release ─────────────────▶│
     │◀─ released OK ─────────────────────────────│
     ├─ completeJob ──────────────▶│               │
     │                       │                     │
     ├─ UPDATE status=FAILED  │                     │
     ├─ Kafka: order.failed   │                     │
```

---

## 8. Validation Rules

| Field                    | Rule                                        |
| ------------------------ | ------------------------------------------- |
| `items`                  | Array, min 1 phần tử, max 50 phần tử        |
| `items[].productId`      | UUID v4 format                              |
| `items[].quantity`       | Integer, 1 ≤ quantity ≤ 99                  |
| `shippingAddressId`      | UUID v4 format, thuộc về `userId` trong JWT |
| `paymentMethod`          | Enum: `STRIPE`, `COD`                       |
| `note`                   | max 500 chars, optional                     |
| `totalAmount` (computed) | Phải > 0                                    |

---

## 9. Error Catalog

| HTTP | Error Code                   | Message (vi)                              | Điều kiện                           |
| ---- | ---------------------------- | ----------------------------------------- | ----------------------------------- |
| 400  | `VALIDATION_ERROR`           | "Dữ liệu không hợp lệ"                    | Field validation fail               |
| 400  | `EMPTY_ORDER`                | "Đơn hàng phải có ít nhất 1 sản phẩm"     | `items` rỗng                        |
| 401  | `UNAUTHORIZED`               | "Vui lòng đăng nhập"                      | Không có JWT                        |
| 403  | `ORDER_NOT_OWNED`            | "Bạn không có quyền xem đơn hàng này"     | User xem đơn người khác             |
| 404  | `ORDER_NOT_FOUND`            | "Không tìm thấy đơn hàng"                 | Order ID không tồn tại              |
| 404  | `PRODUCT_NOT_FOUND`          | "Sản phẩm không tồn tại"                  | productId trong items không tồn tại |
| 404  | `ADDRESS_NOT_FOUND`          | "Địa chỉ giao hàng không tồn tại"         | addressId không thuộc user          |
| 409  | `CANNOT_CANCEL_STATUS`       | "Không thể hủy đơn hàng ở trạng thái này" | Hủy DELIVERED/FAILED/CANCELLED      |
| 422  | `PRODUCT_UNAVAILABLE`        | "Sản phẩm [name] hiện không thể mua"      | product không ACTIVE                |
| 422  | `ZERO_TOTAL_AMOUNT`          | "Tổng tiền đơn hàng không hợp lệ"         | totalAmount ≤ 0                     |
| 422  | `INVENTORY_INSUFFICIENT`     | "Không đủ hàng cho sản phẩm [name]"       | Saga reserve-inventory fail         |
| 422  | `PAYMENT_FAILED`             | "Thanh toán thất bại, vui lòng thử lại"   | Stripe charge fail                  |
| 422  | `PAYMENT_METHOD_UNAVAILABLE` | "Phương thức thanh toán không khả dụng"   | COD chưa hỗ trợ (future)            |

---

## 10. Order Code Generation

### 10.1 Định dạng

```
ORD-{YYYYMMDD}-{NNNNN}
```

| Phần         | Ý nghĩa                                    | Ví dụ      |
| ------------ | ------------------------------------------ | ---------- |
| `ORD`        | Prefix cố định                             | `ORD`      |
| `{YYYYMMDD}` | Ngày đặt hàng (UTC+7)                      | `20260422` |
| `{NNNNN}`    | Số thứ tự trong ngày, 5 chữ số zero-padded | `00001`    |

**Ví dụ:** `ORD-20260422-00001`, `ORD-20260422-00099`

### 10.2 Cập nhật bảng `orders`

```sql
ALTER TABLE orders ADD COLUMN order_code VARCHAR(20) UNIQUE NOT NULL;

CREATE UNIQUE INDEX idx_orders_order_code ON orders(order_code);
```

### 10.3 Cơ chế Sinh Order Code

**Phương án: Redis counter + daily reset**

```
Key: order:seq:{YYYYMMDD}
TTL: 48 giờ (reset tự động, dư 1 ngày để tránh edge case)

Mỗi khi tạo order mới:
1. Lấy ngày hiện tại UTC+7 → dateStr = "20260422"
2. INCR order:seq:20260422 → trả về seq (integer)
3. order_code = "ORD-" + dateStr + "-" + zeroPad(seq, 5)
4. Lưu vào orders.order_code

Khi Redis không available:
→ Fallback: PostgreSQL sequence + trigger (xem dưới)
```

**Fallback: PostgreSQL daily sequence**

```sql
-- Bảng daily sequence
CREATE TABLE order_code_sequences (
  date_str CHAR(8) PRIMARY KEY,   -- "20260422"
  last_seq INTEGER NOT NULL DEFAULT 0
);

-- Function sinh order code
CREATE OR REPLACE FUNCTION generate_order_code()
RETURNS VARCHAR(20) AS $$
DECLARE
  v_date CHAR(8);
  v_seq  INTEGER;
BEGIN
  v_date := TO_CHAR(NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYYMMDD');
  INSERT INTO order_code_sequences (date_str, last_seq)
  VALUES (v_date, 1)
  ON CONFLICT (date_str)
  DO UPDATE SET last_seq = order_code_sequences.last_seq + 1
  RETURNING last_seq INTO v_seq;
  RETURN 'ORD-' || v_date || '-' || LPAD(v_seq::TEXT, 5, '0');
END;
$$ LANGUAGE plpgsql;
```

### 10.4 Business Rules

**BR-ORDER-CODE-001:** `order_code` là UNIQUE, immutable sau khi tạo.

**BR-ORDER-CODE-002:** Nếu cùng ngày có >99,999 đơn → sequence tiếp tục tăng (NNNNN trở thành 6+ chữ số). Hiếm gặp ở MVP.

**BR-ORDER-CODE-003:** `order_code` hiển thị với user (thay vì UUID) trong mọi UI, email, invoice.

### 10.5 API Update

`GET /api/orders` và `GET /api/orders/:id` trả về thêm `orderCode`:

```json
{
  "id": "order-uuid",
  "orderCode": "ORD-20260422-00001",
  "status": "CONFIRMED",
  "totalAmount": 67980000,
  ...
}
```

`GET /api/orders?orderCode=ORD-20260422-00001` — cho phép tìm theo order code (Admin API).

---

## 11. COD Payment Flow (Cash on Delivery)

### 11.1 Tổng Quan

COD (thanh toán khi nhận hàng) là phương thức thanh toán phổ biến tại Việt Nam. Khi user chọn COD:

- Không có Stripe PaymentIntent
- Tiền được thu tại thời điểm shipper giao hàng thành công
- Order xác nhận thanh toán khi nhận webhook `DELIVERED` từ shipping service

### 11.2 Cập nhật bảng `orders`

```sql
ALTER TABLE orders ADD COLUMN cod_collected_at TIMESTAMPTZ;
```

| Column thêm        | Type          | Constraint | Mô tả                                            |
| ------------------ | ------------- | ---------- | ------------------------------------------------ |
| `cod_collected_at` | `TIMESTAMPTZ` | NULLABLE   | Timestamp thu tiền COD (set khi DELIVERED + COD) |

### 11.3 Camunda Saga — COD Path

```
Saga step: process-payment
  if paymentMethod == "STRIPE":
    → Tạo Stripe PaymentIntent, confirm, chờ webhook
  if paymentMethod == "COD":
    → Ghi nhận intent COD (INSERT cod_intent vào DB)
    → completeJob({ paid: true, method: "COD" })
    → KHÔNG tạo Stripe record
    → Tiếp tục Saga → confirm-order → trigger-shipment
```

```
Saga step: confirm-cod (sau DELIVERED webhook)
  Khi shipping-service publish Kafka: shipping.delivered
    → order-service nhận event
    → UPDATE orders SET
        cod_collected_at = NOW(),
        status = 'DELIVERED'
      WHERE id = orderId
        AND payment_method = 'COD'
    → Publish Kafka: order.cod.collected
```

### 11.4 Luồng COD End-to-End

```
User           Order Service      Camunda        Shipping Svc    Kafka
  │                 │                 │               │             │
  ├─ POST /orders ─▶│                 │               │             │
  │   paymentMethod: "COD"            │               │             │
  │                 ├─ INSERT order ──│               │             │
  │                 ├─ Start Saga ───▶│               │             │
  │                 │                 │               │             │
  │                 │   [reserve-inventory: OK]        │             │
  │                 │   [process-payment: COD → skip Stripe]        │
  │                 │   [confirm-order: status=CONFIRMED]            │
  │                 │   [trigger-shipment: create shipment record]   │
  │◀─ 201 { order } │                 │               │             │
  │   orderCode: ORD-xxx              │               │             │
  │                 │                 │               │             │
  │                                   │  Shipper giao hàng          │
  │                                   │               ├─ DELIVERED ─▶│
  │                                   │               │     shipping.delivered
  │                 ├─ Nhận event ─────────────────────────────────│
  │                 ├─ cod_collected_at = NOW()        │             │
  │                 ├─ status = DELIVERED              │             │
  │                 ├─ Publish order.cod.collected ──────────────── ▶│
```

### 11.5 Business Rules COD

**BR-COD-001:** COD không tạo Stripe PaymentIntent. `payment_intent_id = NULL`.

**BR-COD-002:** Order COD có trạng thái `CONFIRMED` (không phải `PAYMENT_PROCESSING`) sau khi reserve inventory thành công.

**BR-COD-003:** COD order không thể thanh toán online sau đó (không chuyển đổi method được).

**BR-COD-004:** Nếu shipping FAILED_DELIVERY và trả hàng: `cod_collected_at` giữ NULL, order chuyển về `CANCELLED` sau khi return process xong.

**BR-COD-005:** Hủy order COD chỉ cho phép trước khi SHIPPING (trạng thái CONFIRMED). Sau khi shipper đã pickup → không hủy được.

### 11.6 Invoice API

**`GET /api/orders/:id/invoice`** _(User — requires JWT, phải là chủ đơn)_

```json
{
  "success": true,
  "data": {
    "invoiceNumber": "INV-ORD-20260422-00001",
    "orderCode": "ORD-20260422-00001",
    "createdAt": "2026-04-22T09:00:00Z",
    "customer": {
      "name": "Nguyễn Văn A",
      "email": "nguyen.van.a@example.com",
      "phone": "0901234567"
    },
    "shippingAddress": {
      "fullName": "Nguyễn Văn A",
      "phone": "0901234567",
      "addressLine": "123 Đường ABC",
      "district": "Quận 1",
      "city": "TP. Hồ Chí Minh"
    },
    "items": [
      {
        "productName": "iPhone 15 Pro Max 256GB",
        "sku": "IPHONE-15PM-256-BLK",
        "quantity": 1,
        "unitPrice": 33990000,
        "subtotal": 33990000
      }
    ],
    "subtotal": 33990000,
    "shippingFee": 30000,
    "discountAmount": 0,
    "totalAmount": 34020000,
    "paymentMethod": "COD",
    "paymentStatus": "PENDING_COLLECTION",
    "codCollectedAt": null
  }
}
```

**Error:** `403` không phải chủ đơn | `404` order không tồn tại
| 500 | `SAGA_START_FAILED` | "Lỗi khởi động quy trình xử lý đơn hàng" | Zeebe gRPC fail |
| 500 | `ORDER_CREATION_FAILED` | "Lỗi tạo đơn hàng, vui lòng thử lại" | DB error |
