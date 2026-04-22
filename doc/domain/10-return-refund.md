# 🔄 Domain: Return & Refund

> **Service:** `return-service` — Port `3009`
> **Database:** AWS RDS PostgreSQL — schema `return_refund`
> **Kafka Topics consumed:** — (validate qua internal API call to order-service)
> **Kafka Topics produced:** `return.requested` · `return.approved` · `return.rejected` · `return.refund.processed`
> **Cập nhật:** 22/04/2026

---

## Mục Lục

1. [Tổng Quan Domain](#1-tổng-quan-domain)
2. [Entities & Data Model](#2-entities--data-model)
3. [Business Rules](#3-business-rules)
4. [API Contract](#4-api-contract)
5. [State Machine — Return Request](#5-state-machine--return-request)
6. [Camunda Saga — Return Saga](#6-camunda-saga--return-saga)
7. [Luồng Nghiệp Vụ](#7-luồng-nghiệp-vụ)
8. [Validation Rules](#8-validation-rules)
9. [Error Catalog](#9-error-catalog)

---

## 1. Tổng Quan Domain

| Trách nhiệm       | Mô tả                                            |
| ----------------- | ------------------------------------------------ |
| Tiếp nhận đổi trả | User tạo yêu cầu trong vòng 7 ngày sau DELIVERED |
| Xét duyệt         | Admin approve/reject với ghi chú                 |
| Hoàn kho          | Sau approve → inventory-service restock variant  |
| Hoàn tiền         | Sau restock → Stripe refund (full/partial)       |
| Saga bù           | Camunda orchestrate toàn bộ return flow          |
| Lịch sử           | Log mọi thay đổi trạng thái                      |

**Ngoài phạm vi MVP:**

- Đổi hàng (exchange — chỉ hỗ trợ hoàn tiền)
- Return label in tại nhà
- Automated return approval (rule-based)
- Multi-item partial return shipping

---

## 2. Entities & Data Model

### 2.1 Entity: `return_requests`

| Column                | Type            | Constraint                  | Mô tả                                                                     |
| --------------------- | --------------- | --------------------------- | ------------------------------------------------------------------------- |
| `id`                  | `UUID`          | PK                          |                                                                           |
| `return_code`         | `VARCHAR(30)`   | UNIQUE NOT NULL             | Format: `RET-{YYYYMMDD}-{NNNNN}`                                          |
| `order_id`            | `UUID`          | NOT NULL                    | FK → orders.id                                                            |
| `user_id`             | `UUID`          | NOT NULL                    |                                                                           |
| `status`              | `ENUM`          | NOT NULL DEFAULT 'PENDING'  | Xem state machine                                                         |
| `reason`              | `ENUM`          | NOT NULL                    | `WRONG_PRODUCT`, `DEFECTIVE`, `NOT_AS_DESCRIBED`, `CHANGED_MIND`, `OTHER` |
| `reason_detail`       | `TEXT`          | NULLABLE                    | Mô tả chi tiết (required nếu reason=OTHER)                                |
| `refund_type`         | `ENUM`          | NOT NULL DEFAULT 'FULL'     | `FULL`, `PARTIAL`                                                         |
| `refund_amount`       | `NUMERIC(14,2)` | NULLABLE                    | Số tiền hoàn (admin điền khi approve)                                     |
| `refund_method`       | `ENUM`          | NOT NULL DEFAULT 'ORIGINAL' | `ORIGINAL` (Stripe), `STORE_CREDIT` (v2)                                  |
| `stripe_refund_id`    | `VARCHAR(200)`  | NULLABLE                    | Stripe refund ID                                                          |
| `admin_note`          | `TEXT`          | NULLABLE                    | Ghi chú từ admin                                                          |
| `approved_at`         | `TIMESTAMPTZ`   | NULLABLE                    |                                                                           |
| `approved_by`         | `UUID`          | NULLABLE                    | Admin userId                                                              |
| `rejected_at`         | `TIMESTAMPTZ`   | NULLABLE                    |                                                                           |
| `rejected_reason`     | `TEXT`          | NULLABLE                    |                                                                           |
| `items_received_at`   | `TIMESTAMPTZ`   | NULLABLE                    | Admin xác nhận nhận hàng về                                               |
| `refund_processed_at` | `TIMESTAMPTZ`   | NULLABLE                    |                                                                           |
| `created_at`          | `TIMESTAMPTZ`   | NOT NULL DEFAULT NOW()      |                                                                           |
| `updated_at`          | `TIMESTAMPTZ`   | NOT NULL DEFAULT NOW()      |                                                                           |

**ENUM `return_status`:**

```sql
CREATE TYPE return_status AS ENUM (
  'PENDING',           -- Chờ xét duyệt
  'APPROVED',          -- Đã duyệt, chờ nhận hàng về
  'ITEMS_RECEIVED',    -- Đã nhận hàng, đang xử lý hoàn tiền
  'REFUND_PROCESSED',  -- Hoàn tiền thành công (terminal ✅)
  'REJECTED'           -- Từ chối (terminal ❌)
);
```

**ENUM `return_reason`:**

```sql
CREATE TYPE return_reason AS ENUM (
  'WRONG_PRODUCT',      -- Giao sai sản phẩm
  'DEFECTIVE',          -- Sản phẩm bị lỗi
  'NOT_AS_DESCRIBED',   -- Không đúng mô tả
  'CHANGED_MIND',       -- Đổi ý
  'OTHER'               -- Khác
);
```

```sql
CREATE UNIQUE INDEX idx_return_code          ON return_requests(return_code);
CREATE        INDEX idx_return_order_id      ON return_requests(order_id);
CREATE        INDEX idx_return_user_id       ON return_requests(user_id);
CREATE        INDEX idx_return_status        ON return_requests(status);
-- Giới hạn 1 return request PENDING hoặc APPROVED per order:
CREATE UNIQUE INDEX idx_return_active_per_order
  ON return_requests(order_id) WHERE status IN ('PENDING', 'APPROVED', 'ITEMS_RECEIVED');
```

---

### 2.2 Entity: `return_items`

> Chi tiết từng sản phẩm trong yêu cầu đổi trả

| Column              | Type            | Constraint                       | Mô tả                    |
| ------------------- | --------------- | -------------------------------- | ------------------------ |
| `id`                | `UUID`          | PK                               |                          |
| `return_request_id` | `UUID`          | FK → return_requests.id NOT NULL |                          |
| `order_item_id`     | `UUID`          | NOT NULL                         | FK → order_items.id      |
| `product_id`        | `UUID`          | NOT NULL                         | Snapshot                 |
| `variant_id`        | `UUID`          | NULLABLE                         | Snapshot                 |
| `product_name`      | `VARCHAR(500)`  | NOT NULL                         | Snapshot tên sản phẩm    |
| `variant_info`      | `VARCHAR(200)`  | NULLABLE                         | Snapshot "Size M - Đỏ"   |
| `quantity`          | `SMALLINT`      | NOT NULL CHECK > 0               | Số lượng trả             |
| `unit_price`        | `NUMERIC(14,2)` | NOT NULL                         | Snapshot giá lúc mua     |
| `reason`            | `TEXT`          | NULLABLE                         | Lý do riêng cho item này |

```sql
CREATE INDEX idx_return_items_request ON return_items(return_request_id);
CREATE INDEX idx_return_items_order_item ON return_items(order_item_id);
```

---

### 2.3 Entity: `return_status_history`

> Immutable audit log

| Column              | Type            | Constraint              | Mô tả                     |
| ------------------- | --------------- | ----------------------- | ------------------------- |
| `id`                | `UUID`          | PK                      |                           |
| `return_request_id` | `UUID`          | FK → return_requests.id |                           |
| `from_status`       | `return_status` | NULLABLE                |                           |
| `to_status`         | `return_status` | NOT NULL                |                           |
| `changed_by`        | `UUID`          | NOT NULL                | userId hoặc system        |
| `changed_by_type`   | `ENUM`          | NOT NULL                | `USER`, `ADMIN`, `SYSTEM` |
| `note`              | `TEXT`          | NULLABLE                |                           |
| `created_at`        | `TIMESTAMPTZ`   | NOT NULL DEFAULT NOW()  |                           |

```sql
CREATE INDEX idx_return_history_request ON return_status_history(return_request_id);
```

---

## 3. Business Rules

### BR-RET-001: Cửa sổ đổi trả

- User chỉ được tạo return request trong **7 ngày** kể từ `order.delivered_at`
- Sau 7 ngày → 403 "Thời hạn 7 ngày đổi trả đã qua"
- Chỉ áp dụng cho order có `status = DELIVERED`

### BR-RET-002: Một return request per order

- Một order chỉ có tối đa 1 return request ở trạng thái PENDING/APPROVED/ITEMS_RECEIVED
- Nếu lần trước REJECTED: có thể tạo request mới
- Nếu đang có request active: 409

### BR-RET-003: Số lượng trả

- `return_items.quantity` ≤ `order_items.quantity`
- Tổng số sản phẩm trả ≥ 1
- Không thể trả item không có trong order

### BR-RET-004: Refund amount

- `FULL`: `refund_amount = order.total_amount` (bao gồm shipping fee nếu áp dụng)
- `PARTIAL`: Admin nhập `refund_amount` tùy ý ≤ `order.total_amount`
- Tiền hoàn trả về phương thức thanh toán gốc (Stripe refund)
- COD orders: Hoàn tiền qua chuyển khoản ngân hàng (manual process MVP — ghi chú trong admin note)

### BR-RET-005: Restock inventory

- Sau `APPROVED` → admin xác nhận `ITEMS_RECEIVED` → inventory-service restock
- Restock từng `return_item`: `inventory_items.available_qty += return_item.quantity`
- Publish Kafka `return.approved` với danh sách items để inventory-service lắng nghe

### BR-RET-006: Stripe Refund

- Chỉ sau `ITEMS_RECEIVED` → trigger Stripe refund
- Dùng `order.stripe_payment_intent_id` để refund
- Stripe API: `stripe.refunds.create({ payment_intent: ..., amount: ... })`
- Lưu `stripe_refund_id`, set `status = REFUND_PROCESSED`
- Publish Kafka `return.refund.processed`

### BR-RET-007: Return Code Generation

- Format: `RET-{YYYYMMDD}-{NNNNN}` (5 chữ số, daily sequence reset)
- Ví dụ: `RET-20260422-00001`
- Implement: DB sequence hoặc Redis counter reset lúc 00:00 UTC+7

---

## 4. API Contract

### `POST /api/returns` _(User)_

**Headers:** `Authorization: Bearer <token>`

**Request:**

```json
{
  "orderId": "order-uuid",
  "reason": "DEFECTIVE",
  "reasonDetail": "Màn hình bị chết điểm ảnh tại góc trên bên phải",
  "refundType": "FULL",
  "items": [
    {
      "orderItemId": "order-item-uuid",
      "quantity": 1,
      "reason": "Sản phẩm lỗi từ nhà máy"
    }
  ]
}
```

**Response 201:**

```json
{
  "success": true,
  "data": {
    "id": "return-uuid",
    "returnCode": "RET-20260422-00001",
    "orderId": "order-uuid",
    "status": "PENDING",
    "reason": "DEFECTIVE",
    "refundType": "FULL",
    "items": [
      {
        "orderItemId": "order-item-uuid",
        "productName": "iPhone 15 Pro",
        "variantInfo": "128GB - Đen tự nhiên",
        "quantity": 1
      }
    ],
    "message": "Yêu cầu đổi trả đã được ghi nhận. Chúng tôi sẽ xem xét trong 1-2 ngày làm việc.",
    "createdAt": "2026-04-22T10:00:00.000Z"
  }
}
```

**Errors:**

| HTTP | Error Code              | Message                                         |
| ---- | ----------------------- | ----------------------------------------------- |
| 400  | `INVALID_ORDER`         | "Đơn hàng không hợp lệ"                         |
| 403  | `ORDER_NOT_DELIVERED`   | "Chỉ có thể đổi trả đơn đã giao thành công"     |
| 403  | `RETURN_WINDOW_EXPIRED` | "Thời hạn 7 ngày đổi trả đã qua"                |
| 409  | `RETURN_ALREADY_EXISTS` | "Đơn hàng này đã có yêu cầu đổi trả đang xử lý" |

---

### `GET /api/returns` _(User)_

**Query:** `?page=1&limit=10&status=PENDING`

**Response 200:** danh sách return requests của user hiện tại

---

### `GET /api/returns/:id` _(User)_

**Response 200:** chi tiết return request + items + status history

```json
{
  "success": true,
  "data": {
    "id": "return-uuid",
    "returnCode": "RET-20260422-00001",
    "status": "APPROVED",
    "reason": "DEFECTIVE",
    "items": [...],
    "statusHistory": [
      { "fromStatus": null, "toStatus": "PENDING", "changedAt": "2026-04-22T10:00:00Z", "changedByType": "USER" },
      { "fromStatus": "PENDING", "toStatus": "APPROVED", "changedAt": "2026-04-23T09:00:00Z", "changedByType": "ADMIN", "note": "Đã kiểm tra, sản phẩm bị lỗi. Đồng ý hoàn trả." }
    ]
  }
}
```

---

### `GET /api/admin/returns` _(ADMIN)_

**Query:** `?status=PENDING&page=1&limit=20&userId=uuid&orderId=uuid&from=2026-04-01&to=2026-04-30`

**Response 200:** paginated return requests

---

### `GET /api/admin/returns/:id` _(ADMIN)_

**Response 200:** full detail (giống user nhưng có `adminNote`, `refundAmount`, `stripeRefundId`)

---

### `PATCH /api/admin/returns/:id/approve` _(ADMIN)_

**Request:**

```json
{
  "refundType": "FULL",
  "refundAmount": 1500000,
  "adminNote": "Đã kiểm tra hình ảnh, xác nhận sản phẩm bị lỗi. Duyệt hoàn tiền đầy đủ."
}
```

**Response 200:**

```json
{
  "success": true,
  "data": {
    "returnCode": "RET-20260422-00001",
    "status": "APPROVED",
    "refundAmount": 1500000,
    "message": "Đã duyệt yêu cầu đổi trả. Vui lòng chờ nhận hàng về kho."
  }
}
```

---

### `PATCH /api/admin/returns/:id/reject` _(ADMIN)_

**Request:** `{ "rejectedReason": "Sản phẩm không có dấu hiệu lỗi, không đủ điều kiện đổi trả" }`

**Response 200:** `{ "success": true, "status": "REJECTED" }`

---

### `PATCH /api/admin/returns/:id/receive-items` _(ADMIN)_

**Mô tả:** Admin xác nhận đã nhận hàng về kho → trigger Camunda: restock + refund

**Response 200:**

```json
{
  "success": true,
  "status": "ITEMS_RECEIVED",
  "message": "Đã xác nhận nhận hàng. Đang xử lý hoàn kho và hoàn tiền..."
}
```

---

## 5. State Machine — Return Request

```
[User: POST /api/returns]
          │
          ▼
      ┌─────────┐
      │ PENDING │ ← Email notification gửi cho admin + user
      └─────────┘
       /         \
[Admin APPROVE]   [Admin REJECT]
     │                 │
     ▼                 ▼
┌──────────┐     ┌──────────┐
│ APPROVED │     │ REJECTED │ (terminal ❌)
└──────────┘     └──────────┘
     │            User nhận email lý do từ chối
     │            (có thể submit lại nếu chưa hết 7 ngày)
[Admin xác nhận nhận hàng: receive-items]
     │
     ▼
┌───────────────┐
│ITEMS_RECEIVED │ → trigger Camunda Return Saga
└───────────────┘
     │
     │ [Saga: restock-inventory + process-refund]
     │
     ▼
┌──────────────────┐
│ REFUND_PROCESSED │ (terminal ✅)
└──────────────────┘
  User nhận email xác nhận hoàn tiền
```

---

## 6. Camunda Saga — Return Saga

**Process ID:** `return-refund-process`

```
START: return_request_id, items[], refundAmount, stripePaymentIntentId
          │
          ▼
    ┌──────────────────────┐
    │   restock-inventory  │  Job Worker: gọi inventory-service
    │                      │  restock mỗi variant theo return_items
    └──────────────────────┘
          │ success      │ failed
          ▼              ▼
    ┌──────────────┐  [Retry 3 lần]
    │process-refund│  Sau 3 lần fail:
    │              │  → FAILED state
    │ Stripe refund│  → notify admin
    └──────────────┘
          │
          ▼
    ┌──────────────────┐
    │ complete-return  │  UPDATE return_requests.status = REFUND_PROCESSED
    │                  │  Kafka: return.refund.processed
    └──────────────────┘
          │
         END

Compensation (nếu process-refund fail sau restock thành công):
  → NOT auto-rollback (không thể "un-restock" hàng đã nhận về)
  → Gửi alert cho admin để xử lý thủ công
  → Set return status = REFUND_FAILED (thêm state nếu cần)
```

**Zeebe Job Workers:**

| Job Type                       | Service           | Mô tả                    |
| ------------------------------ | ----------------- | ------------------------ |
| `restock-inventory-for-return` | inventory-service | Hoàn kho từng variant    |
| `process-stripe-refund`        | return-service    | Gọi Stripe API refund    |
| `complete-return-request`      | return-service    | Cập nhật trạng thái cuối |

---

## 7. Luồng Nghiệp Vụ

### 7.1 Tạo Return Request

```
User           Return Service         Order Service          DB
  │                  │                     │                  │
  ├─ POST /returns ──▶│                     │                  │
  │                  ├─ GET /internal/orders/:orderId/verify  │
  │                  │─────────────────────▶│                  │
  │                  │◀─ { status, deliveredAt, userId, items }
  │                  │                     │                  │
  │                  ├─ validate: DELIVERED, 7-day window, user match
  │                  ├─ generate return_code                  │
  │                  ├─ INSERT return_request (PENDING)       │
  │                  ├─ INSERT return_items                   │
  │                  ├─ INSERT return_status_history          │
  │                  ├─ Kafka: return.requested               │
  │◀─ 201 ───────────│                     │                  │
```

### 7.2 Admin Approve & Xử lý

```
Admin        Return Service         Kafka        Camunda        Inventory Svc   Stripe
  │               │                   │              │               │              │
  ├─ PATCH /admin/returns/:id/approve ▶│              │               │              │
  │               ├─ UPDATE status=APPROVED           │               │              │
  │               ├─ INSERT status_history            │               │              │
  │◀─ 200 ─────── │                   │              │               │              │
  │               │                   │              │               │              │
  ├─ PATCH /receive-items ────────────▶│              │               │              │
  │               ├─ UPDATE status=ITEMS_RECEIVED    │               │              │
  │               ├─ Start Camunda Process ──────────▶│               │              │
  │◀─ 200 ─────── │                                  │               │              │
  │               │                  [restock-inventory-for-return]   │              │
  │               │                                  ├───────────────▶│              │
  │               │                                  │◀─ success ─────│              │
  │               │                                  │                              │
  │               │                                  [process-stripe-refund]         │
  │               │                                  ├──────────────────────────────▶│
  │               │                                  │◀─ { refundId: "re_xxx" } ─────│
  │               │                                  │                              │
  │               │                                  [complete-return-request]       │
  │               │◀──────────────────────────────── │                              │
  │               ├─ UPDATE status=REFUND_PROCESSED                                  │
  │               ├─ Kafka: return.refund.processed                                  │
  │               │ → notification-service gửi email user                            │
```

---

## 8. Validation Rules

| Field                    | Rule                                                                                     |
| ------------------------ | ---------------------------------------------------------------------------------------- |
| `orderId`                | UUID, required, phải thuộc user đang request                                             |
| `reason`                 | Enum required: `WRONG_PRODUCT`, `DEFECTIVE`, `NOT_AS_DESCRIBED`, `CHANGED_MIND`, `OTHER` |
| `reasonDetail`           | Required nếu `reason = OTHER`, max 500 ký tự                                             |
| `refundType`             | Enum: `FULL` hoặc `PARTIAL`                                                              |
| `items`                  | Mảng ít nhất 1 phần tử                                                                   |
| `items[].orderItemId`    | UUID, phải thuộc `orderId`                                                               |
| `items[].quantity`       | Integer ≥ 1, ≤ `orderItem.quantity`                                                      |
| `refundAmount` (admin)   | > 0, ≤ `order.total_amount`                                                              |
| `rejectedReason` (admin) | Required khi REJECT, max 1000 ký tự                                                      |

---

## 9. Error Catalog

| HTTP | Error Code                | Message (vi)                                         | Điều kiện                                        |
| ---- | ------------------------- | ---------------------------------------------------- | ------------------------------------------------ |
| 400  | `INVALID_ORDER`           | "Đơn hàng không hợp lệ hoặc không thuộc về bạn"      | orderId sai / không phải của user                |
| 400  | `INVALID_ITEM_QUANTITY`   | "Số lượng hoàn trả vượt quá số lượng đã mua"         | items[].quantity > orderItem.quantity            |
| 400  | `ITEM_NOT_IN_ORDER`       | "Sản phẩm không có trong đơn hàng này"               | orderItemId không khớp orderId                   |
| 403  | `ORDER_NOT_DELIVERED`     | "Chỉ được đổi trả đơn hàng đã giao thành công"       | status != DELIVERED                              |
| 403  | `RETURN_WINDOW_EXPIRED`   | "Đã quá 7 ngày kể từ khi nhận hàng"                  | > 7 ngày                                         |
| 404  | `RETURN_NOT_FOUND`        | "Không tìm thấy yêu cầu đổi trả"                     | returnId sai                                     |
| 409  | `RETURN_ALREADY_ACTIVE`   | "Đơn hàng này đang có yêu cầu đổi trả chờ xử lý"     | unique constraint vi phạm                        |
| 409  | `RETURN_ALREADY_TERMINAL` | "Yêu cầu đổi trả đã ở trạng thái cuối"               | cố approve/reject REFUND_PROCESSED hoặc REJECTED |
| 422  | `STRIPE_REFUND_FAILED`    | "Không thể hoàn tiền, vui lòng liên hệ hỗ trợ"       | Stripe API error                                 |
| 500  | `SAGA_START_FAILED`       | "Lỗi khởi động quy trình hoàn trả, vui lòng thử lại" | Camunda Zeebe error                              |
