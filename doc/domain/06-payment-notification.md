# 💳 Domain: Payment & Notification

> **Payment logic:** tích hợp trong `order-service` — Port `3004`
> **Notification Service:** `notification-service` — Port `3006`
> **Payment Provider:** Stripe (Test Mode)
> **Email Provider:** SendGrid (100 emails/day Free Tier)
> **Kafka Topics consumed:** `order.paid` · `order.failed` · `order.cancelled` · `order.shipped` · `inventory.low`
> **Cập nhật:** 22/04/2026

---

## Mục Lục

1. [Tổng Quan Domain](#1-tổng-quan-domain)
2. [Entities & Data Model](#2-entities--data-model)
3. [Business Rules — Payment](#3-business-rules--payment)
4. [Business Rules — Notification](#4-business-rules--notification)
5. [API Contract — Payment](#5-api-contract--payment)
6. [Stripe Integration Flow](#6-stripe-integration-flow)
7. [Notification Flow](#7-notification-flow)
8. [Kafka Event Schema](#8-kafka-event-schema)
9. [Email Templates](#9-email-templates)
10. [Validation Rules](#10-validation-rules)
11. [Error Catalog](#11-error-catalog)

---

## 1. Tổng Quan Domain

### 1.1 Payment Domain

| Trách nhiệm         | Mô tả                                                                      |
| ------------------- | -------------------------------------------------------------------------- |
| Tạo Payment Intent  | Gọi Stripe API tạo PaymentIntent khi đơn hàng ở bước payment               |
| Nhận Stripe Webhook | Xử lý webhook `payment_intent.succeeded` / `payment_intent.payment_failed` |
| Idempotency         | Mỗi orderId chỉ được charge 1 lần — dùng Stripe Idempotency Key            |
| Ghi nhận giao dịch  | Lưu `payment_transactions` để audit trail                                  |

### 1.2 Notification Domain

| Trách nhiệm          | Mô tả                                              |
| -------------------- | -------------------------------------------------- |
| Consume Kafka events | Lắng nghe các topic từ Order/Inventory Service     |
| Gửi email            | Dùng SendGrid gửi email theo template              |
| Retry logic          | 3 lần retry → Dead Letter Topic (DLT)              |
| Ghi nhận             | Lưu `notification_logs` để debug và track delivery |

---

## 2. Entities & Data Model

### 2.1 Entity: `payment_transactions` (PostgreSQL — schema `orders`)

| Column                     | Type            | Constraint              | Mô tả                          |
| -------------------------- | --------------- | ----------------------- | ------------------------------ |
| `id`                       | `UUID`          | PK                      |                                |
| `order_id`                 | `UUID`          | NOT NULL FK → orders.id |                                |
| `stripe_payment_intent_id` | `VARCHAR(255)`  | UNIQUE NOT NULL         | `pi_xxx`                       |
| `stripe_charge_id`         | `VARCHAR(255)`  | NULLABLE                | `ch_xxx` — điền sau khi charge |
| `amount`                   | `NUMERIC(14,2)` | NOT NULL                | Số tiền tính phí (VNĐ)         |
| `currency`                 | `CHAR(3)`       | NOT NULL DEFAULT 'vnd'  | ISO 4217                       |
| `status`                   | `ENUM`          | NOT NULL                | Xem bên dưới                   |
| `failure_code`             | `VARCHAR(100)`  | NULLABLE                | Stripe failure code            |
| `failure_message`          | `TEXT`          | NULLABLE                | Stripe failure message (EN)    |
| `stripe_event_id`          | `VARCHAR(255)`  | NULLABLE                | Webhook event ID (idempotency) |
| `created_at`               | `TIMESTAMPTZ`   | NOT NULL DEFAULT NOW()  |                                |
| `updated_at`               | `TIMESTAMPTZ`   | NOT NULL DEFAULT NOW()  |                                |

**ENUM `payment_status`:**

```sql
CREATE TYPE payment_status AS ENUM (
  'PENDING',
  'PROCESSING',
  'SUCCEEDED',
  'FAILED',
  'REFUNDED',
  'PARTIALLY_REFUNDED'
);
```

```sql
CREATE UNIQUE INDEX idx_payment_intent_id ON payment_transactions(stripe_payment_intent_id);
CREATE        INDEX idx_payment_order_id  ON payment_transactions(order_id);
CREATE        INDEX idx_payment_status    ON payment_transactions(status);
```

---

### 2.2 Entity: `notification_logs` (MongoDB Atlas — collection `notification_logs`)

```json
{
  "_id": "ObjectId",
  "notificationType": "ORDER_CONFIRMED | ORDER_SHIPPED | ORDER_CANCELLED | LOW_STOCK",
  "recipientEmail": "user@example.com",
  "recipientUserId": "uuid or null",
  "subject": "Đơn hàng #ORD-001 đã được xác nhận",
  "templateId": "d-sendgrid-template-id",
  "templateData": { "orderCode": "ORD-001", "totalAmount": "101,970,000 VNĐ" },
  "sendgridMessageId": "<msg-id>@smtp.sendgrid.net",
  "status": "SENT | FAILED | RETRYING",
  "attemptCount": 1,
  "lastAttemptAt": "ISODate",
  "errorMessage": null,
  "sourceEvent": {
    "topic": "order.paid",
    "partition": 0,
    "offset": 12345
  },
  "createdAt": "ISODate"
}
```

```javascript
db.notification_logs.createIndex({ recipientUserId: 1 });
db.notification_logs.createIndex({ status: 1, attemptCount: 1 });
db.notification_logs.createIndex(
  { createdAt: 1 },
  { expireAfterSeconds: 2592000 },
); // TTL 30 ngày
```

---

## 3. Business Rules — Payment

### BR-PAY-001: Tạo Payment Intent

- Payment Intent được tạo bởi Zeebe Job Worker `process-payment` trong Order Service
- 1 orderId chỉ có đúng **1 PaymentIntent** (idempotency)
- Sử dụng Stripe **Idempotency Key** = `order-{orderId}` trong header request
- `currency = 'vnd'` — Stripe hỗ trợ VNĐ (không có decimal)
- `amount` truyền vào Stripe = `totalAmount` (VNĐ, không nhân 100 vì VNĐ là zero-decimal currency)
- PaymentIntent được tạo ở trạng thái `requires_payment_method` → Frontend confirm bằng Stripe.js

### BR-PAY-002: Xử lý Stripe Webhook

- Endpoint: `POST /api/webhooks/stripe`
- **Bắt buộc verify signature** Stripe bằng `stripe.webhooks.constructEvent(payload, sig, secret)`
- Không xử lý event mà không verify signature → bảo mật chống giả mạo
- Xử lý idempotency: kiểm tra `stripe_event_id` trong `payment_transactions` trước khi xử lý → skip nếu đã xử lý
- Event quan tâm:
  - `payment_intent.succeeded` → cập nhật `payment_transactions.status = SUCCEEDED` → trigger Saga tiếp theo
  - `payment_intent.payment_failed` → cập nhật `status = FAILED` → trigger Saga compensation

### BR-PAY-003: Hoàn tiền (Refund)

- Hoàn tiền được trigger khi đơn bị hủy sau khi đã thanh toán thành công
- Gọi Stripe `refunds.create({ payment_intent: paymentIntentId })` — refund toàn bộ
- Cập nhật `payment_transactions.status = REFUNDED`
- Ghi `stripe_charge_id` nếu chưa có

### BR-PAY-004: Currency

- MVP chỉ hỗ trợ **VNĐ** (`vnd`)
- Stripe VNĐ là **zero-decimal currency** → `amount` truyền thẳng, không nhân 100

### BR-PAY-005: Không lưu thông tin thẻ

- Không lưu số thẻ, CVV, expiry trên server
- Tất cả thông tin thẻ xử lý tại Stripe.js ở Frontend — server chỉ nhận `paymentMethodId`

---

## 4. Business Rules — Notification

### BR-NOTIF-001: Trigger events

| Kafka Topic                          | Loại thông báo        | Người nhận             |
| ------------------------------------ | --------------------- | ---------------------- |
| `order.paid` (a.k.a order CONFIRMED) | Order Confirmed email | User                   |
| `order.shipped`                      | Order Shipped email   | User                   |
| `order.cancelled`                    | Order Cancelled email | User                   |
| `order.failed`                       | Order Failed email    | User                   |
| `inventory.low`                      | Low Stock Alert       | Admin (email cấu hình) |

### BR-NOTIF-002: Retry logic

- Nếu SendGrid API fail: retry tối đa **3 lần** với backoff `5s → 15s → 45s`
- Sau 3 lần fail: publish message vào Dead Letter Topic `notification.dlq`
- Cập nhật `notification_logs.status = FAILED`, `errorMessage` = lỗi cuối
- Alert thủ công từ DLQ (future: Grafana alert)

### BR-NOTIF-003: Idempotency

- Trước khi gửi: check `notification_logs` theo `sourceEvent.topic + partition + offset`
- Nếu đã có record `status = SENT` với cùng offset: skip (không gửi lại)
- Tránh trường hợp Kafka redelivery gây gửi email trùng

### BR-NOTIF-004: Rate limit (SendGrid Free)

- SendGrid Free: 100 emails/day
- MVP dự kiến: ~20 orders/day → đủ budget
- Không implement queue throttling ở MVP — nếu vượt 100: email sẽ bị reject và rơi vào DLQ

### BR-NOTIF-005: Unsubscribe

- MVP không implement unsubscribe (tất cả email là transactional, không phải marketing)
- Transactional email không cần unsubscribe theo quy định CAN-SPAM/GDPR (đây là xác nhận giao dịch)

---

## 5. API Contract — Payment

### `POST /api/webhooks/stripe` _(Public — Stripe only)_

> Endpoint này **public** nhưng bảo vệ bằng **Stripe Signature Verification**

**Headers:** `Stripe-Signature: t=xxx,v1=xxx`

**Request body:** Raw payload (không parse JSON trước — cần raw buffer để verify signature)

**Response 200:**

```json
{ "received": true }
```

> **Luôn** trả `200` nhanh nhất có thể để Stripe không retry. Xử lý bất đồng bộ sau khi verify.

**Errors:** `400` signature invalid | `400` unknown event type

---

### `GET /api/orders/:id/payment` _(User)_

**Headers:** `Authorization: Bearer <accessToken>`

**Mô tả:** Lấy thông tin thanh toán của đơn hàng

**Response 200:**

```json
{
  "success": true,
  "data": {
    "orderId": "order-uuid",
    "paymentIntentId": "pi_3xxx",
    "clientSecret": "pi_3xxx_secret_xxx",
    "amount": 101970000,
    "currency": "vnd",
    "status": "SUCCEEDED",
    "createdAt": "2026-04-22T09:00:00.000Z"
  }
}
```

> `clientSecret` chỉ trả về khi `payment_status = PENDING/PROCESSING` (dùng để Frontend confirm)

---

### `GET /api/admin/notifications` _(ADMIN only)_

**Query Params:** `?page=1&limit=20&status=FAILED&type=ORDER_CONFIRMED`

**Response 200:** danh sách `notification_logs`

---

## 6. Stripe Integration Flow

### 6.1 Luồng thanh toán Frontend → Backend → Stripe

```
Frontend (Next.js)           Order Service          Stripe API
       │                          │                      │
       ├─ POST /api/orders ───────▶│                      │
       │                          ├─ (Saga bắt đầu)      │
       │                          │                      │
       │  (Saga: process-payment) │                      │
       │                          ├─ stripe.paymentIntents.create({
       │                          │    amount: 101970000,│
       │                          │    currency: 'vnd',  │
       │                          │    idempotencyKey: 'order-uuid'
       │                          │  }) ────────────────▶│
       │                          │◀─ { id: pi_3xxx,     │
       │                          │    client_secret }   │
       │                          │                      │
       │◀─ 201 { orderId,          │                      │
       │   clientSecret: pi_3xxx_secret } ──              │
       │                          │                      │
       ├─ stripe.confirmCardPayment(clientSecret, {       │
       │    payment_method: { card: cardElement }         │
       │  }) ──────────────────────────────────────────▶ │
       │                                                  │
       │  (Stripe xử lý thẻ)                             │
       │                                                  │
       │               ┌─── Stripe gửi Webhook ──────────┘
       │               ▼
Order Service: POST /api/webhooks/stripe
                  ├─ verify signature ✅
                  ├─ event: payment_intent.succeeded
                  ├─ UPDATE payment_transactions status=SUCCEEDED
                  ├─ Zeebe: complete job process-payment (paid=true)
                  └─ Kafka: publish order.paid
```

### 6.2 Stripe Test Cards (Development)

| Card Number           | Scenario                         |
| --------------------- | -------------------------------- |
| `4242 4242 4242 4242` | Thanh toán thành công            |
| `4000 0000 0000 9995` | Thất bại — insufficient_funds    |
| `4000 0025 0000 3155` | Yêu cầu 3D Secure authentication |
| `4000 0000 0000 0002` | Thất bại — card_declined         |

- Expiry: bất kỳ ngày tương lai (vd: `12/34`)
- CVV: bất kỳ 3 chữ số (vd: `123`)
- ZIP: bất kỳ (vd: `00000`)

---

## 7. Notification Flow

### 7.1 Order Confirmed Email

```
Order Service       Kafka Broker          Notification Service        SendGrid
     │                  │                        │                       │
     ├─ publish ────────▶│                        │                       │
     │  order.paid       │                        │                       │
     │  { orderId,       │                        │                       │
     │    userId,        │                        │                       │
     │    email,         │◀─ consume ─────────────│                       │
     │    total,         │                        │                       │
     │    items }        │                        ├─ check idempotency    │
     │                   │                        │  (notification_logs)  │
     │                   │                        ├─ build template data  │
     │                   │                        ├─ sendgrid.send() ─────▶│
     │                   │                        │◀─ { messageId } ──────│
     │                   │                        ├─ INSERT notification_logs
     │                   │                        │  status=SENT          │
```

### 7.2 Retry với Dead Letter Topic

```
Notification Service           Kafka                   SendGrid
       │                         │                         │
       ├─ consume order.paid ────◀│                         │
       ├─ send email ────────────────────────────────────▶ │
       │                         │                   [ERROR: 503]
       │◀─ error ────────────────────────────────────────  │
       │                         │                         │
       ├─ retry 1 (5s delay) ───────────────────────────▶ │ [ERROR again]
       ├─ retry 2 (15s delay) ──────────────────────────▶ │ [ERROR again]
       ├─ retry 3 (45s delay) ──────────────────────────▶ │ [ERROR again]
       │
       ├─ publish ──────────────▶│
       │  notification.dlq       │
       │  { originalTopic, payload, error, attemptCount }
       ├─ UPDATE notification_logs status=FAILED
```

---

## 8. Kafka Event Schema

### 8.1 `order.paid`

```json
{
  "eventId": "evt-uuid",
  "eventType": "order.paid",
  "timestamp": "2026-04-22T09:02:30.000Z",
  "payload": {
    "orderId": "order-uuid",
    "orderCode": "ORD-20260422-001",
    "userId": "user-uuid",
    "userEmail": "user@example.com",
    "userFullName": "Nguyễn Văn A",
    "totalAmount": 101970000,
    "currency": "vnd",
    "paymentMethod": "STRIPE",
    "paymentIntentId": "pi_3xxx",
    "items": [
      {
        "productName": "iPhone 15 Pro Max 256GB",
        "quantity": 2,
        "unitPrice": 33990000,
        "subtotal": 67980000
      }
    ],
    "shippingAddress": {
      "fullName": "Nguyễn Văn A",
      "phone": "0901234567",
      "fullAddress": "123 Đường Lê Lợi, Phường Bến Nghé, Quận 1, TP. Hồ Chí Minh"
    }
  }
}
```

---

### 8.2 `order.shipped`

```json
{
  "eventId": "evt-uuid",
  "eventType": "order.shipped",
  "timestamp": "2026-04-23T08:00:00.000Z",
  "payload": {
    "orderId": "order-uuid",
    "orderCode": "ORD-20260422-001",
    "userId": "user-uuid",
    "userEmail": "user@example.com",
    "userFullName": "Nguyễn Văn A",
    "shippingAddress": { "...": "..." }
  }
}
```

---

### 8.3 `order.cancelled`

```json
{
  "eventId": "evt-uuid",
  "eventType": "order.cancelled",
  "timestamp": "2026-04-22T09:10:00.000Z",
  "payload": {
    "orderId": "order-uuid",
    "orderCode": "ORD-20260422-001",
    "userId": "user-uuid",
    "userEmail": "user@example.com",
    "cancelReason": "Tôi muốn thay đổi địa chỉ",
    "totalAmount": 101970000,
    "refundStatus": "REFUNDED"
  }
}
```

---

### 8.4 `inventory.low`

```json
{
  "eventId": "evt-uuid",
  "eventType": "inventory.low",
  "timestamp": "2026-04-22T09:05:00.000Z",
  "payload": {
    "productId": "prod-uuid",
    "productName": "iPhone 15 Pro Max 256GB",
    "availableQty": 3,
    "lowStockThreshold": 5
  }
}
```

---

## 9. Email Templates

### Templates gửi qua SendGrid Dynamic Templates

| Template ID         | Loại            | Subject                                              | Người nhận |
| ------------------- | --------------- | ---------------------------------------------------- | ---------- |
| `d-order-confirmed` | ORDER_CONFIRMED | "✅ Đơn hàng #{{orderCode}} đã được xác nhận"        | User       |
| `d-order-shipped`   | ORDER_SHIPPED   | "🚚 Đơn hàng #{{orderCode}} đang được giao"          | User       |
| `d-order-cancelled` | ORDER_CANCELLED | "❌ Đơn hàng #{{orderCode}} đã bị hủy"               | User       |
| `d-order-failed`    | ORDER_FAILED    | "⚠️ Thanh toán thất bại cho đơn hàng #{{orderCode}}" | User       |
| `d-low-stock-alert` | LOW_STOCK       | "⚠️ Cảnh báo hàng thấp: {{productName}}"             | Admin      |

### Template Data Mapping

**ORDER_CONFIRMED:**

```json
{
  "orderCode": "ORD-20260422-001",
  "userFullName": "Nguyễn Văn A",
  "totalAmount": "101,970,000 VNĐ",
  "items": [...],
  "shippingAddress": "123 Đường Lê Lợi, Quận 1, TP.HCM",
  "estimatedDelivery": "3-5 ngày làm việc"
}
```

**LOW_STOCK_ALERT:**

```json
{
  "productName": "iPhone 15 Pro Max 256GB",
  "productId": "prod-uuid",
  "availableQty": "3",
  "threshold": "5",
  "adminLink": "https://admin.example.com/inventory/prod-uuid"
}
```

---

## 10. Validation Rules

### Payment

| Rule                     | Giá trị                                 |
| ------------------------ | --------------------------------------- |
| Stripe webhook signature | Bắt buộc verify, 400 nếu fail           |
| Idempotency key          | `order-{orderId}` — max 255 chars       |
| Currency                 | Chỉ `vnd`                               |
| Amount                   | Phải khớp với `orders.total_amount`     |
| Event idempotency        | Check `stripe_event_id` trước khi xử lý |

### Notification

| Rule                  | Giá trị                          |
| --------------------- | -------------------------------- |
| Retry count           | Max 3 lần                        |
| Retry backoff         | 5s → 15s → 45s                   |
| DLQ topic             | `notification.dlq`               |
| TTL notification_logs | 30 ngày (MongoDB TTL index)      |
| Idempotency check     | Kafka topic + partition + offset |

---

## 11. Error Catalog

### Payment Errors

| HTTP | Error Code                  | Message (vi)                            | Điều kiện                        |
| ---- | --------------------------- | --------------------------------------- | -------------------------------- |
| 400  | `STRIPE_SIGNATURE_INVALID`  | "Webhook signature không hợp lệ"        | Verify Stripe signature fail     |
| 400  | `UNKNOWN_STRIPE_EVENT`      | "Loại event không được hỗ trợ"          | event.type không trong whitelist |
| 404  | `PAYMENT_NOT_FOUND`         | "Không tìm thấy thông tin thanh toán"   | orderId không có payment record  |
| 409  | `PAYMENT_ALREADY_PROCESSED` | "Giao dịch đã được xử lý"               | stripe_event_id đã tồn tại       |
| 422  | `AMOUNT_MISMATCH`           | "Số tiền thanh toán không khớp"         | amount ≠ order.totalAmount       |
| 422  | `REFUND_NOT_ELIGIBLE`       | "Đơn hàng không đủ điều kiện hoàn tiền" | status ≠ SUCCEEDED               |
| 500  | `STRIPE_API_ERROR`          | "Lỗi cổng thanh toán, vui lòng thử lại" | Stripe API timeout/500           |

### Notification Errors (internal — logged, không trả về HTTP)

| Code                          | Mô tả                    | Hành động               |
| ----------------------------- | ------------------------ | ----------------------- |
| `SENDGRID_RATE_LIMIT`         | Vượt 100 email/ngày      | Retry sau 24h, ghi DLQ  |
| `SENDGRID_INVALID_EMAIL`      | Email không hợp lệ       | Ghi FAILED, không retry |
| `SENDGRID_TEMPLATE_NOT_FOUND` | Template ID sai          | Alert dev, ghi DLQ      |
| `SENDGRID_TIMEOUT`            | API timeout              | Retry 3 lần             |
| `KAFKA_CONSUMER_ERROR`        | Không parse được message | Ghi DLQ với raw payload |
