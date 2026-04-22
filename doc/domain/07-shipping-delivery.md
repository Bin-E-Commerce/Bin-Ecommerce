# 🚚 Domain: Shipping & Delivery

> **Service:** `shipping-service` — Port `3007`
> **Database:** AWS RDS PostgreSQL — schema `shipping`
> **Carrier Integration:** GHN (Giao Hàng Nhanh) — Mock mode MVP / Webhook thật
> **Kafka Topics consumed:** `order.paid`
> **Kafka Topics produced:** `shipment.created` · `shipment.picked_up` · `shipment.in_transit` · `shipment.delivered` · `shipment.failed`
> **Cập nhật:** 22/04/2026

---

## Mục Lục

1. [Tổng Quan Domain](#1-tổng-quan-domain)
2. [Entities & Data Model](#2-entities--data-model)
3. [Business Rules](#3-business-rules)
4. [API Contract](#4-api-contract)
5. [State Machine — Shipment](#5-state-machine--shipment)
6. [Carrier Integration (GHN)](#6-carrier-integration-ghn)
7. [Luồng Nghiệp Vụ](#7-luồng-nghiệp-vụ)
8. [Validation Rules](#8-validation-rules)
9. [Error Catalog](#9-error-catalog)

---

## 1. Tổng Quan Domain

| Trách nhiệm              | Mô tả                                                    |
| ------------------------ | -------------------------------------------------------- |
| Tạo vận đơn              | Sau khi order CONFIRMED → gọi GHN API tạo đơn vận chuyển |
| Quản lý phương thức ship | Các gói ship với phí + thời gian dự kiến                 |
| Tracking                 | Nhận webhook từ GHN/GHTK → cập nhật trạng thái           |
| Xác nhận giao hàng       | Khi DELIVERED → publish Kafka `shipment.delivered`       |
| Thất bại giao hàng       | Retry 2 lần → FAILED_DELIVERY → thông báo admin          |

**Ngoài phạm vi:**

- Tự vận hành đội giao hàng
- Real-time GPS tracking
- Multi-carrier routing optimization
- International shipping

**GHN Mode (MVP):**

- `MOCK`: Tự động chuyển trạng thái theo thời gian giả lập (test/dev)
- `LIVE`: Gọi GHN API thật, nhận webhook thật (production)
- Toggle qua env: `GHN_MODE=mock|live`

---

## 2. Entities & Data Model

### 2.1 Entity: `shipping_methods`

| Column                | Type            | Constraint             | Mô tả                                        |
| --------------------- | --------------- | ---------------------- | -------------------------------------------- |
| `id`                  | `UUID`          | PK                     |                                              |
| `code`                | `VARCHAR(50)`   | UNIQUE NOT NULL        | `GHN_STANDARD`, `GHN_EXPRESS`, `FREE`, `COD` |
| `name`                | `VARCHAR(100)`  | NOT NULL               | Tên hiển thị                                 |
| `description`         | `TEXT`          | NULLABLE               | Mô tả chi tiết                               |
| `fee`                 | `NUMERIC(10,2)` | NOT NULL DEFAULT 0     | Phí vận chuyển (VNĐ)                         |
| `estimated_days_min`  | `SMALLINT`      | NOT NULL               | Thời gian giao tối thiểu (ngày)              |
| `estimated_days_max`  | `SMALLINT`      | NOT NULL               | Thời gian giao tối đa (ngày)                 |
| `is_active`           | `BOOLEAN`       | NOT NULL DEFAULT true  |                                              |
| `min_order_amount`    | `NUMERIC(14,2)` | NULLABLE               | Áp dụng khi đơn ≥ mức này                    |
| `free_ship_threshold` | `NUMERIC(14,2)` | NULLABLE               | Miễn phí nếu đơn ≥ mức này                   |
| `created_at`          | `TIMESTAMPTZ`   | NOT NULL DEFAULT NOW() |                                              |

**Dữ liệu mặc định:**

```sql
INSERT INTO shipping_methods VALUES
  ('...', 'GHN_EXPRESS', 'Giao hàng nhanh (GHN Express)', NULL, 35000, 1, 2, true, 0, NULL),
  ('...', 'GHN_STANDARD', 'Giao hàng tiêu chuẩn (GHN)', NULL, 20000, 3, 5, true, 0, 300000),
  ('...', 'FREE_SHIP', 'Miễn phí vận chuyển', NULL, 0, 3, 5, true, 500000, NULL);
```

---

### 2.2 Entity: `shipments`

| Column               | Type            | Constraint                 | Mô tả                       |
| -------------------- | --------------- | -------------------------- | --------------------------- |
| `id`                 | `UUID`          | PK                         |                             |
| `order_id`           | `UUID`          | UNIQUE NOT NULL            | FK → orders.id (1:1)        |
| `shipping_method_id` | `UUID`          | FK → shipping_methods.id   |                             |
| `carrier_code`       | `VARCHAR(50)`   | NOT NULL                   | `GHN`, `GHTK`, `MOCK`       |
| `tracking_number`    | `VARCHAR(100)`  | UNIQUE NULLABLE            | Mã vận đơn từ carrier       |
| `carrier_order_code` | `VARCHAR(100)`  | NULLABLE                   | Mã nội bộ carrier           |
| `status`             | `ENUM`          | NOT NULL DEFAULT 'PENDING' | Xem state machine           |
| `fee`                | `NUMERIC(10,2)` | NOT NULL                   | Phí vận chuyển thực tế      |
| `estimated_delivery` | `DATE`          | NULLABLE                   | Ngày giao hàng dự kiến      |
| `delivered_at`       | `TIMESTAMPTZ`   | NULLABLE                   | Thời điểm giao hàng thực tế |
| `failed_at`          | `TIMESTAMPTZ`   | NULLABLE                   |                             |
| `fail_reason`        | `TEXT`          | NULLABLE                   |                             |
| `delivery_attempt`   | `SMALLINT`      | NOT NULL DEFAULT 0         | Số lần thử giao             |
| `recipient_name`     | `VARCHAR(255)`  | NOT NULL                   | Snapshot từ order           |
| `recipient_phone`    | `VARCHAR(20)`   | NOT NULL                   | Snapshot từ order           |
| `recipient_address`  | `TEXT`          | NOT NULL                   | Snapshot địa chỉ full       |
| `created_at`         | `TIMESTAMPTZ`   | NOT NULL DEFAULT NOW()     |                             |
| `updated_at`         | `TIMESTAMPTZ`   | NOT NULL DEFAULT NOW()     |                             |

**ENUM `shipment_status`:**

```sql
CREATE TYPE shipment_status AS ENUM (
  'PENDING',           -- Chờ lấy hàng
  'WAITING_PICKUP',    -- Đã tạo vận đơn, chờ GHN đến lấy
  'PICKED_UP',         -- GHN đã lấy hàng
  'IN_TRANSIT',        -- Đang vận chuyển
  'OUT_FOR_DELIVERY',  -- Đang giao cho khách
  'DELIVERED',         -- Giao thành công
  'FAILED_DELIVERY',   -- Giao thất bại (retry)
  'RETURNED',          -- Hàng hoàn về kho
  'CANCELLED'          -- Hủy vận đơn
);
```

```sql
CREATE UNIQUE INDEX idx_shipments_order_id      ON shipments(order_id);
CREATE UNIQUE INDEX idx_shipments_tracking_no   ON shipments(tracking_number) WHERE tracking_number IS NOT NULL;
CREATE        INDEX idx_shipments_status        ON shipments(status);
CREATE        INDEX idx_shipments_carrier_code  ON shipments(carrier_code);
```

---

### 2.3 Entity: `shipment_tracking_events`

> Immutable log của mọi cập nhật từ carrier

| Column        | Type           | Constraint             | Mô tả               |
| ------------- | -------------- | ---------------------- | ------------------- |
| `id`          | `UUID`         | PK                     |                     |
| `shipment_id` | `UUID`         | FK → shipments.id      |                     |
| `event_type`  | `VARCHAR(100)` | NOT NULL               | Mã event từ carrier |
| `description` | `TEXT`         | NOT NULL               | Mô tả sự kiện       |
| `location`    | `VARCHAR(255)` | NULLABLE               | Vị trí hiện tại     |
| `event_time`  | `TIMESTAMPTZ`  | NOT NULL               | Thời điểm sự kiện   |
| `raw_payload` | `JSONB`        | NULLABLE               | Raw webhook payload |
| `created_at`  | `TIMESTAMPTZ`  | NOT NULL DEFAULT NOW() |                     |

```sql
CREATE INDEX idx_tracking_shipment_id  ON shipment_tracking_events(shipment_id);
CREATE INDEX idx_tracking_event_time   ON shipment_tracking_events(event_time DESC);
```

---

## 3. Business Rules

### BR-SHIP-001: Tạo shipment

- Shipment được tạo tự động khi Zeebe Job Worker `trigger-shipment` chạy (sau order CONFIRMED)
- Snapshot `recipientName`, `recipientPhone`, `recipientAddress` từ `orders.shipping_address`
- Nếu `GHN_MODE=live`: gọi GHN Create Order API → nhận `tracking_number`
- Nếu `GHN_MODE=mock`: gán `tracking_number = MOCK-{orderId}-{timestamp}`, tự chuyển trạng thái
- Publish Kafka `shipment.created`

### BR-SHIP-002: Phương thức vận chuyển

- User chọn shipping method khi checkout (danh sách lấy từ `GET /api/shipping/methods`)
- `fee` được tính dựa trên `shipping_method.fee`; nếu đơn đủ điều kiện `free_ship_threshold` → fee = 0
- `fee` được lock vào `shipments.fee` tại thời điểm tạo order (không thay đổi sau đó)
- `totalAmount` của order = Σ(items) + `shippingFee`

### BR-SHIP-003: Cập nhật trạng thái từ webhook

- GHN gửi webhook POST đến `/api/webhooks/shipping`
- Verify bằng GHN webhook secret (header `X-GHN-Token`)
- Map GHN event code → `shipment_status` enum của hệ thống
- Lưu raw payload vào `shipment_tracking_events`
- Khi `DELIVERED`: publish Kafka `shipment.delivered` → Order Service cập nhật order status → DELIVERED
- Khi `FAILED_DELIVERY`: tăng `delivery_attempt`, nếu `delivery_attempt ≥ 3` → publish `shipment.failed`

### BR-SHIP-004: Giao hàng thất bại

- Sau **3 lần** giao thất bại: `status = RETURNED` (hàng hoàn kho)
- Publish Kafka `shipment.failed`
- Admin nhận email cảnh báo via notification-service
- Order status chuyển về state riêng (xem Order domain)

### BR-SHIP-005: Hủy vận đơn

- Khi order bị hủy (Saga compensation hoặc admin cancel):
  - Nếu `status = PENDING / WAITING_PICKUP`: gọi GHN Cancel API, set `status = CANCELLED`
  - Nếu `status = PICKED_UP` trở đi: không thể hủy vận đơn — phải chờ hàng về

### BR-SHIP-006: Free Shipping

- Áp dụng khi `orders.totalAmount ≥ shippingMethod.freeShipThreshold`
- Hoặc khi voucher loại `FREE_SHIPPING` được áp dụng (xem Promotion domain)
- Khi free ship: `shipments.fee = 0`, không phụ thuộc vào `shippingMethod.fee`

---

## 4. API Contract

### `GET /api/shipping/methods` _(Public)_

**Mô tả:** Lấy danh sách phương thức vận chuyển (dùng khi checkout)

**Query Params:** `?orderAmount=500000` (optional — để tính eligibility free ship)

**Response 200:**

```json
{
  "success": true,
  "data": [
    {
      "id": "method-uuid",
      "code": "GHN_EXPRESS",
      "name": "Giao hàng nhanh (GHN Express)",
      "fee": 35000,
      "estimatedDaysMin": 1,
      "estimatedDaysMax": 2,
      "estimatedDelivery": "Nhận hàng vào 23/04/2026 - 24/04/2026",
      "isFreeShip": false
    },
    {
      "id": "method-uuid-2",
      "code": "GHN_STANDARD",
      "name": "Giao hàng tiêu chuẩn",
      "fee": 0,
      "originalFee": 20000,
      "estimatedDaysMin": 3,
      "estimatedDaysMax": 5,
      "estimatedDelivery": "Nhận hàng vào 25/04/2026 - 27/04/2026",
      "isFreeShip": true,
      "freeShipReason": "Đơn hàng từ 300,000 VNĐ được miễn phí ship tiêu chuẩn"
    }
  ]
}
```

---

### `GET /api/orders/:id/shipment` _(User)_

**Headers:** `Authorization: Bearer <accessToken>`

**Mô tả:** Xem thông tin vận chuyển của đơn hàng

**Response 200:**

```json
{
  "success": true,
  "data": {
    "id": "shipment-uuid",
    "orderId": "order-uuid",
    "carrier": "GHN",
    "trackingNumber": "GHN-123456789",
    "status": "IN_TRANSIT",
    "fee": 35000,
    "estimatedDelivery": "2026-04-24",
    "deliveredAt": null,
    "trackingEvents": [
      {
        "eventType": "PICKED_UP",
        "description": "Giao Hàng Nhanh đã lấy hàng",
        "location": "Bưu cục Quận 1, TP.HCM",
        "eventTime": "2026-04-22T14:00:00.000Z"
      },
      {
        "eventType": "IN_TRANSIT",
        "description": "Đang trên đường vận chuyển",
        "location": "Trung tâm phân loại TP.HCM",
        "eventTime": "2026-04-22T20:00:00.000Z"
      }
    ]
  }
}
```

**Errors:** `401` | `403` không phải chủ đơn | `404` shipment chưa tạo

---

### `POST /api/webhooks/shipping` _(Public — Carrier only)_

**Headers:** `X-GHN-Token: <webhook-secret>`

**Request (GHN webhook format):**

```json
{
  "CODAmount": 0,
  "CODTransferDate": null,
  "ClientOrderCode": "order-uuid",
  "ConvertedWeight": 200,
  "Description": "Đang giao hàng",
  "Fee": {
    "Coupon": 0,
    "Insurance": 0,
    "MainService": 35000,
    "Return": 0,
    "StationDO": 0
  },
  "Label": "GHN-123456789",
  "OrderCode": "GHN-123456789",
  "ShopID": 123456,
  "Status": "delivering",
  "Time": "2026-04-23T08:00:00+07:00",
  "Timestamp": 1714024800,
  "Type": "status_update",
  "Warehouse": "Kho Quận 1"
}
```

**Response 200:**

```json
{ "code": 200, "message": "Success" }
```

> Luôn trả 200 nhanh để carrier không retry. Xử lý async.

**GHN Status Mapping:**

| GHN Status      | `shipment_status`  | Kafka Event           |
| --------------- | ------------------ | --------------------- |
| `ready_to_pick` | `WAITING_PICKUP`   | —                     |
| `picked`        | `PICKED_UP`        | `shipment.picked_up`  |
| `storing`       | `IN_TRANSIT`       | —                     |
| `transporting`  | `IN_TRANSIT`       | `shipment.in_transit` |
| `sorting`       | `IN_TRANSIT`       | —                     |
| `delivering`    | `OUT_FOR_DELIVERY` | —                     |
| `delivered`     | `DELIVERED`        | `shipment.delivered`  |
| `delivery_fail` | `FAILED_DELIVERY`  | — (retry)             |
| `return`        | `RETURNED`         | `shipment.failed`     |
| `cancel`        | `CANCELLED`        | —                     |

---

### `GET /api/admin/shipments` _(ADMIN only)_

**Query Params:** `?page=1&limit=20&status=IN_TRANSIT&carrier=GHN&orderId=uuid`

**Response 200:** paginated list shipments

---

### `GET /api/admin/shipments/:id` _(ADMIN only)_

**Response 200:** chi tiết shipment + full tracking events

---

### `POST /api/admin/shipments/:id/cancel` _(ADMIN only)_

**Mô tả:** Admin hủy vận đơn (chỉ khi PENDING/WAITING_PICKUP)

**Response 200:**

```json
{ "success": true, "message": "Vận đơn đã hủy thành công" }
```

**Errors:** `409` không thể hủy ở trạng thái này

---

## 5. State Machine — Shipment

```
[Order CONFIRMED → Saga: trigger-shipment]
              │
              ▼
         ┌─────────┐
         │ PENDING │
         └─────────┘
              │
  [GHN API: Create Order thành công]
              │
              ▼
      ┌──────────────────┐
      │ WAITING_PICKUP   │
      └──────────────────┘
              │
      [GHN đến lấy hàng — webhook: picked]
              │
              ▼
        ┌────────────┐
        │ PICKED_UP  │
        └────────────┘
              │
     [Đang vận chuyển — webhook: transporting]
              │
              ▼
        ┌────────────┐
        │ IN_TRANSIT │
        └────────────┘
              │
   [Đang giao cuối — webhook: delivering]
              │
              ▼
     ┌────────────────────┐
     │ OUT_FOR_DELIVERY   │
     └────────────────────┘
         /            \
 [Giao OK]       [Giao thất bại]
     │                  │
     ▼                  ▼
┌──────────┐     ┌─────────────────┐
│DELIVERED │     │ FAILED_DELIVERY │ ← delivery_attempt++
└──────────┘     └─────────────────┘
(terminal ✅)          │
                  [attempt < 3: retry ngay hôm sau]
                  [attempt ≥ 3:]
                       │
                       ▼
                  ┌──────────┐
                  │ RETURNED │ (hàng hoàn kho)
                  └──────────┘
                  (terminal — cần xử lý thủ công)

Admin cancel (PENDING/WAITING_PICKUP):
     → ┌────────────┐
       │ CANCELLED  │ (terminal)
       └────────────┘
```

---

## 6. Carrier Integration (GHN)

### 6.1 GHN Create Order API (LIVE mode)

```
POST https://online-gateway.ghn.vn/shiip/public-api/v2/shipping-order/create
Headers:
  Token: <GHN_API_TOKEN>
  ShopId: <GHN_SHOP_ID>
  Content-Type: application/json

Request:
{
  "payment_type_id": 2,        // 1=Shop trả, 2=Khách trả
  "note": "Ghi chú...",
  "required_note": "KHONGCHOXEM",
  "to_name": "Nguyễn Văn A",
  "to_phone": "0901234567",
  "to_address": "123 Đường Lê Lợi",
  "to_ward_name": "Phường Bến Nghé",
  "to_district_name": "Quận 1",
  "to_province_name": "TP Hồ Chí Minh",
  "cod_amount": 0,
  "weight": 200,               // gram
  "length": 20, "width": 20, "height": 10,
  "service_type_id": 2,        // 2=E-commerce
  "items": [{ "name": "iPhone 15", "quantity": 1 }]
}

Response:
{
  "code": 200,
  "message": "Success",
  "data": {
    "order_code": "GHN-123456789",
    "total_fee": 35000,
    "expected_delivery_time": "2026-04-24T23:59:59+07:00"
  }
}
```

### 6.2 MOCK Mode — Auto State Transition

```javascript
// Khi GHN_MODE=mock, sau khi tạo shipment:
// T+0min:  PENDING → WAITING_PICKUP
// T+5min:  WAITING_PICKUP → PICKED_UP
// T+10min: PICKED_UP → IN_TRANSIT
// T+15min: IN_TRANSIT → OUT_FOR_DELIVERY
// T+20min: OUT_FOR_DELIVERY → DELIVERED (90%) | FAILED_DELIVERY (10%)
```

---

## 7. Luồng Nghiệp Vụ

### 7.1 Tạo Shipment sau Order Confirmed

```
Order Service       Shipping Service         GHN API           Kafka
     │                    │                     │                 │
     │ (Saga: trigger-shipment job)              │                 │
     ├─ call shipping-svc─▶│                     │                 │
     │                    ├─ INSERT shipment (PENDING)             │
     │                    ├─ [LIVE] Create Order▶│                 │
     │                    │◀─ { order_code, fee }│                 │
     │                    ├─ UPDATE tracking_number, status=WAITING_PICKUP
     │                    ├─ publish ─────────────────────────────▶│
     │                    │  shipment.created                       │
     ├◀─ { shipmentId } ──│                     │                 │
     │ (complete Zeebe job)│                     │                 │
```

### 7.2 GHN Webhook → Kafka Flow

```
GHN Server          Shipping Service         Kafka            Order Service
    │                     │                    │                   │
    ├─ POST /webhooks/shipping ─▶│                │                   │
    │  X-GHN-Token: secret │                    │                   │
    │                    ├─ verify token        │                   │
    │                    ├─ map GHN status      │                   │
    │                    ├─ INSERT tracking_event│                   │
    │                    ├─ UPDATE shipment status│                  │
    │                    │                    │                   │
    │                    │ [if DELIVERED:]     │                   │
    │◀─ 200 OK ──────────│                    │                   │
    │                    ├─ publish shipment.delivered ───────────▶│
    │                    │                    │          UPDATE orders.status=DELIVERED
    │                    │                    │          publish order.delivered
```

---

## 8. Validation Rules

| Field              | Rule                                             |
| ------------------ | ------------------------------------------------ |
| `shippingMethodId` | UUID, phải tồn tại và `is_active = true`         |
| GHN Token header   | Required, phải khớp với `GHN_WEBHOOK_SECRET` env |
| `delivery_attempt` | Max 3, sau đó chuyển RETURNED                    |
| `fee` snapshot     | Lấy tại thời điểm tạo đơn, không tính lại        |

---

## 9. Error Catalog

| HTTP | Error Code                 | Message (vi)                                      | Điều kiện                       |
| ---- | -------------------------- | ------------------------------------------------- | ------------------------------- |
| 400  | `INVALID_SHIPPING_METHOD`  | "Phương thức vận chuyển không hợp lệ"             | ID không tồn tại hoặc inactive  |
| 400  | `GHN_WEBHOOK_INVALID`      | "Webhook token không hợp lệ"                      | Header X-GHN-Token sai          |
| 404  | `SHIPMENT_NOT_FOUND`       | "Không tìm thấy thông tin vận chuyển"             | orderId không có shipment       |
| 409  | `SHIPMENT_ALREADY_EXISTS`  | "Vận đơn đã được tạo cho đơn hàng này"            | Tạo shipment 2 lần cùng orderId |
| 409  | `CANNOT_CANCEL_SHIPMENT`   | "Không thể hủy vận đơn đang trong quá trình giao" | status ≥ PICKED_UP              |
| 422  | `GHN_API_ERROR`            | "Lỗi tạo vận đơn, vui lòng thử lại"               | GHN API trả lỗi                 |
| 500  | `SHIPMENT_CREATION_FAILED` | "Lỗi tạo thông tin vận chuyển"                    | DB error                        |
