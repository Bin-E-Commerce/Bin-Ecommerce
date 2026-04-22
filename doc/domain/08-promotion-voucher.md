# 🎟️ Domain: Promotion & Voucher

> **Service:** `promotion-service` — Port `3008`
> **Database:** AWS RDS PostgreSQL — schema `promotion`
> **Kafka Topics consumed:** `order.cancelled` · `order.failed`
> **Kafka Topics produced:** `voucher.applied` · `voucher.released`
> **Cập nhật:** 22/04/2026

---

## Mục Lục

1. [Tổng Quan Domain](#1-tổng-quan-domain)
2. [Entities & Data Model](#2-entities--data-model)
3. [Business Rules](#3-business-rules)
4. [API Contract](#4-api-contract)
5. [State Machine — Voucher](#5-state-machine--voucher)
6. [Discount Calculation Logic](#6-discount-calculation-logic)
7. [Luồng Nghiệp Vụ](#7-luồng-nghiệp-vụ)
8. [Validation Rules](#8-validation-rules)
9. [Error Catalog](#9-error-catalog)

---

## 1. Tổng Quan Domain

| Trách nhiệm          | Mô tả                                        |
| -------------------- | -------------------------------------------- |
| Quản lý promotion    | CRUD khuyến mãi (admin)                      |
| Quản lý voucher code | Tạo/phân phối mã giảm giá                    |
| Validate eligibility | Cart/Order service gọi để kiểm tra điều kiện |
| Tracking usage       | Ghi nhận sử dụng, tránh dùng quá giới hạn    |
| Release khi hủy      | Khi order cancel → giải phóng lượt dùng      |

**Ngoài phạm vi MVP:**

- BOGO (Buy One Get One) — planned, not implemented
- Flash sale / countdown timer
- Loyalty points / rewards program
- Tiered discounts (mua nhiều giảm nhiều)
- Bulk voucher import (CSV)

---

## 2. Entities & Data Model

### 2.1 Entity: `promotions`

| Column                    | Type            | Constraint             | Mô tả                                               |
| ------------------------- | --------------- | ---------------------- | --------------------------------------------------- |
| `id`                      | `UUID`          | PK                     |                                                     |
| `name`                    | `VARCHAR(200)`  | NOT NULL               | Tên chương trình                                    |
| `description`             | `TEXT`          | NULLABLE               | Mô tả chi tiết                                      |
| `type`                    | `ENUM`          | NOT NULL               | `PERCENT_DISCOUNT`, `FIXED_AMOUNT`, `FREE_SHIPPING` |
| `value`                   | `NUMERIC(10,2)` | NOT NULL               | Giá trị: % hoặc VNĐ                                 |
| `max_discount_amount`     | `NUMERIC(14,2)` | NULLABLE               | Giới hạn tối đa (dùng với PERCENT)                  |
| `min_order_amount`        | `NUMERIC(14,2)` | NOT NULL DEFAULT 0     | Đơn tối thiểu để áp dụng                            |
| `start_date`              | `TIMESTAMPTZ`   | NOT NULL               | Ngày bắt đầu                                        |
| `end_date`                | `TIMESTAMPTZ`   | NULLABLE               | Ngày kết thúc (null = không giới hạn)               |
| `is_active`               | `BOOLEAN`       | NOT NULL DEFAULT true  |                                                     |
| `applicable_product_ids`  | `UUID[]`        | NULLABLE               | Null = áp dụng tất cả sản phẩm                      |
| `applicable_category_ids` | `UUID[]`        | NULLABLE               | Null = áp dụng tất cả danh mục                      |
| `created_by`              | `UUID`          | NOT NULL               | admin userId                                        |
| `created_at`              | `TIMESTAMPTZ`   | NOT NULL DEFAULT NOW() |                                                     |
| `updated_at`              | `TIMESTAMPTZ`   | NOT NULL DEFAULT NOW() |                                                     |

**ENUM `promotion_type`:**

```sql
CREATE TYPE promotion_type AS ENUM (
  'PERCENT_DISCOUNT',   -- Giảm % (vd: 20%)
  'FIXED_AMOUNT',       -- Giảm tiền cố định (vd: 50,000đ)
  'FREE_SHIPPING'       -- Miễn phí vận chuyển
);
```

```sql
CREATE INDEX idx_promotions_active       ON promotions(is_active) WHERE is_active = true;
CREATE INDEX idx_promotions_date_range   ON promotions(start_date, end_date);
CREATE INDEX idx_promotions_type         ON promotions(type);
```

---

### 2.2 Entity: `vouchers`

| Column           | Type          | Constraint                  | Mô tả                                                  |
| ---------------- | ------------- | --------------------------- | ------------------------------------------------------ |
| `id`             | `UUID`        | PK                          |                                                        |
| `promotion_id`   | `UUID`        | FK → promotions.id NOT NULL |                                                        |
| `code`           | `VARCHAR(50)` | UNIQUE NOT NULL             | Mã voucher (uppercase)                                 |
| `usage_limit`    | `INTEGER`     | NULLABLE                    | Tổng số lượt dùng (null = không giới hạn)              |
| `used_count`     | `INTEGER`     | NOT NULL DEFAULT 0          | Đã sử dụng                                             |
| `per_user_limit` | `SMALLINT`    | NOT NULL DEFAULT 1          | Số lần 1 user được dùng                                |
| `is_active`      | `BOOLEAN`     | NOT NULL DEFAULT true       |                                                        |
| `created_at`     | `TIMESTAMPTZ` | NOT NULL DEFAULT NOW()      |                                                        |
| `expires_at`     | `TIMESTAMPTZ` | NULLABLE                    | Expire riêng của voucher (override promotion.end_date) |

```sql
CREATE UNIQUE INDEX idx_vouchers_code        ON vouchers(UPPER(code));
CREATE        INDEX idx_vouchers_promotion   ON vouchers(promotion_id);
CREATE        INDEX idx_vouchers_active      ON vouchers(is_active) WHERE is_active = true;
```

---

### 2.3 Entity: `voucher_usages`

| Column            | Type            | Constraint                 | Mô tả                                         |
| ----------------- | --------------- | -------------------------- | --------------------------------------------- |
| `id`              | `UUID`          | PK                         |                                               |
| `voucher_id`      | `UUID`          | FK → vouchers.id NOT NULL  |                                               |
| `user_id`         | `UUID`          | NOT NULL                   | User đã dùng                                  |
| `order_id`        | `UUID`          | NULLABLE                   | Order tương ứng (null khi pending trong cart) |
| `discount_amount` | `NUMERIC(14,2)` | NOT NULL                   | Số tiền đã giảm thực tế                       |
| `status`          | `ENUM`          | NOT NULL DEFAULT 'PENDING' | `PENDING`, `CONFIRMED`, `RELEASED`            |
| `used_at`         | `TIMESTAMPTZ`   | NOT NULL DEFAULT NOW()     |                                               |
| `confirmed_at`    | `TIMESTAMPTZ`   | NULLABLE                   | Khi order CONFIRMED                           |
| `released_at`     | `TIMESTAMPTZ`   | NULLABLE                   | Khi order CANCELLED                           |

**ENUM `voucher_usage_status`:**

```sql
CREATE TYPE voucher_usage_status AS ENUM (
  'PENDING',    -- Đã áp dụng trong cart, chờ checkout
  'CONFIRMED',  -- Order đã xác nhận thành công
  'RELEASED'    -- Order bị hủy → lượt dùng được hoàn
);
```

```sql
CREATE INDEX idx_voucher_usages_voucher    ON voucher_usages(voucher_id);
CREATE INDEX idx_voucher_usages_user       ON voucher_usages(user_id);
CREATE INDEX idx_voucher_usages_order      ON voucher_usages(order_id);
-- Chặn dùng 2 lần khi status=CONFIRMED:
CREATE UNIQUE INDEX idx_voucher_usages_confirmed
  ON voucher_usages(voucher_id, user_id) WHERE status = 'CONFIRMED';
```

---

## 3. Business Rules

### BR-PROMO-001: Validation khi áp voucher

Khi `POST /api/cart/voucher`, promotion-service kiểm tra tuần tự:

1. Voucher code tồn tại và `is_active = true`
2. Promotion liên kết `is_active = true`
3. Thời hạn: `now BETWEEN promotion.start_date AND COALESCE(voucher.expires_at, promotion.end_date, 'infinity')`
4. `voucher.usage_limit IS NULL OR voucher.used_count < voucher.usage_limit`
5. Số lần user đã dùng `< voucher.per_user_limit` (đếm status='CONFIRMED')
6. `cartTotal >= promotion.min_order_amount`
7. Nếu `applicable_product_ids` không null: ít nhất 1 cart item phải trong danh sách
8. Nếu `applicable_category_ids` không null: ít nhất 1 cart item phải trong danh mục

### BR-PROMO-002: Không thể stack voucher

- Mỗi cart/order chỉ áp dụng **đúng 1 voucher**
- Khi đã có voucher, phải `DELETE /api/cart/voucher` trước khi áp mã mới

### BR-PROMO-003: Lock khi áp dụng

- Khi validate thành công → `INSERT voucher_usages (status=PENDING)`
- `used_count` **KHÔNG** tăng ngay (chỉ tăng khi CONFIRMED)
- Nếu 2 user cùng apply cùng voucher, chỉ 1 thành công (race condition: dùng `SELECT FOR UPDATE`)
- Timeout PENDING: 30 phút (cart TTL) → auto release

### BR-PROMO-004: Confirm khi order thành công

- Khi Saga step `confirm-order` thành công:
  - `UPDATE voucher_usages SET status='CONFIRMED', order_id=:orderId`
  - `UPDATE vouchers SET used_count = used_count + 1`
  - Publish Kafka `voucher.applied`

### BR-PROMO-005: Release khi hủy

- Khi nhận Kafka `order.cancelled` hoặc `order.failed`:
  - Tìm `voucher_usages` theo `order_id`
  - `UPDATE status = 'RELEASED', released_at = NOW()`
  - `UPDATE vouchers SET used_count = used_count - 1` (nếu đã CONFIRMED)
  - Publish Kafka `voucher.released`

### BR-PROMO-006: Tính discount

- `PERCENT_DISCOUNT`: `discountAmount = MIN(cartTotal × value/100, max_discount_amount ?? ∞)`
- `FIXED_AMOUNT`: `discountAmount = MIN(value, cartTotal)` (không giảm hơn giá trị đơn)
- `FREE_SHIPPING`: `discountAmount = shippingFee` (tính khi biết shipping method)
- `finalAmount = cartTotal - discountAmount` ≥ 0 (floor = 0)

---

## 4. API Contract

### `POST /api/cart/voucher` _(User)_

**Headers:** `Authorization: Bearer <token>`

**Request:**

```json
{
  "code": "SUMMER20"
}
```

**Response 200:**

```json
{
  "success": true,
  "data": {
    "voucherId": "voucher-uuid",
    "code": "SUMMER20",
    "promotionName": "Khuyến mãi hè 2026",
    "type": "PERCENT_DISCOUNT",
    "discountValue": 20,
    "discountAmount": 100000,
    "maxDiscountAmount": 200000,
    "freeShipping": false,
    "message": "Áp dụng mã giảm giá thành công. Tiết kiệm 100,000 VNĐ!"
  }
}
```

**Errors:**

| HTTP | Error Code                    | Message                                                       |
| ---- | ----------------------------- | ------------------------------------------------------------- |
| 400  | `VOUCHER_NOT_FOUND`           | "Mã voucher không tồn tại"                                    |
| 400  | `VOUCHER_EXPIRED`             | "Mã voucher đã hết hạn"                                       |
| 400  | `VOUCHER_USAGE_LIMIT_REACHED` | "Mã voucher đã hết lượt sử dụng"                              |
| 400  | `VOUCHER_ALREADY_USED`        | "Bạn đã sử dụng mã voucher này"                               |
| 400  | `MIN_ORDER_NOT_MET`           | "Đơn hàng chưa đủ điều kiện. Cần thêm {amount} để áp dụng mã" |
| 409  | `CART_ALREADY_HAS_VOUCHER`    | "Giỏ hàng đã có mã giảm giá. Vui lòng xóa mã cũ trước"        |

---

### `DELETE /api/cart/voucher` _(User)_

**Response 200:**

```json
{
  "success": true,
  "message": "Đã xóa mã giảm giá"
}
```

---

### `POST /api/internal/vouchers/validate` _(Internal — Order Service)_

> Endpoint nội bộ, dùng header `X-Internal-Service-Key`

**Request:**

```json
{
  "code": "SUMMER20",
  "userId": "user-uuid",
  "cartTotal": 500000,
  "shippingFee": 35000,
  "cartItems": [
    {
      "productId": "prod-uuid",
      "categoryId": "cat-uuid",
      "quantity": 2,
      "price": 250000
    }
  ]
}
```

**Response 200:**

```json
{
  "valid": true,
  "voucherId": "voucher-uuid",
  "promotionId": "promo-uuid",
  "type": "PERCENT_DISCOUNT",
  "discountAmount": 100000,
  "freeShipping": false,
  "usageId": "usage-uuid"
}
```

---

### `POST /api/internal/vouchers/confirm` _(Internal)_

**Request:** `{ "usageId": "usage-uuid", "orderId": "order-uuid" }`
**Response 200:** `{ "success": true }`

---

### `POST /api/internal/vouchers/release` _(Internal)_

**Request:** `{ "orderId": "order-uuid" }`
**Response 200:** `{ "success": true, "released": true | false }`

---

### Admin APIs

#### `GET /api/admin/promotions` _(ADMIN)_

**Query:** `?page=1&limit=20&type=PERCENT_DISCOUNT&isActive=true`

**Response 200:** paginated promotions

---

#### `POST /api/admin/promotions` _(ADMIN)_

**Request:**

```json
{
  "name": "Khuyến mãi hè 2026",
  "description": "Giảm 20% cho đơn từ 300,000đ",
  "type": "PERCENT_DISCOUNT",
  "value": 20,
  "maxDiscountAmount": 200000,
  "minOrderAmount": 300000,
  "startDate": "2026-06-01T00:00:00.000Z",
  "endDate": "2026-08-31T23:59:59.000Z",
  "isActive": true
}
```

**Response 201:** promotion đã tạo

---

#### `POST /api/admin/promotions/:id/vouchers/generate` _(ADMIN)_

**Mô tả:** Tạo một hoặc nhiều voucher code thuộc promotion

**Request:**

```json
{
  "codes": ["SUMMER20", "SUMMER30"],
  "usageLimit": 100,
  "perUserLimit": 1,
  "expiresAt": "2026-08-31T23:59:59.000Z"
}
```

**Response 201:**

```json
{
  "success": true,
  "data": [
    { "id": "voucher-uuid", "code": "SUMMER20", "usageLimit": 100 },
    { "id": "voucher-uuid-2", "code": "SUMMER30", "usageLimit": 100 }
  ]
}
```

---

#### `GET /api/admin/vouchers` _(ADMIN)_

**Query:** `?promotionId=uuid&isActive=true&page=1&limit=20`

**Response 200:** paginated vouchers với `usedCount / usageLimit`

---

#### `PATCH /api/admin/vouchers/:id` _(ADMIN)_

**Request:** `{ "isActive": false }` hoặc `{ "usageLimit": 50 }`

---

## 5. State Machine — Voucher Usage

```
[User: POST /api/cart/voucher]
          │
          ▼
      ┌─────────┐
      │ PENDING │  ← Lưu trong cart + voucher_usages
      └─────────┘
        /     \
[Checkout OK]   [Cart expire / DELETE /cart/voucher]
    │                   │
    ▼                   ▼
┌───────────┐      ┌──────────┐
│ CONFIRMED │      │ RELEASED │
└───────────┘      └──────────┘
(used_count++)   (used_count not incremented)

CONFIRMED → RELEASED:
[Order CANCELLED / FAILED]
    ↓
RELEASED (used_count--)
```

---

## 6. Discount Calculation Logic

```
Inputs:
  cartTotal        = tổng giá trị sản phẩm (chưa cộng phí ship)
  shippingFee      = phí vận chuyển đã chọn
  promotion.type
  promotion.value
  promotion.maxDiscountAmount  (nullable)
  promotion.minOrderAmount

Calculation:
  if type == PERCENT_DISCOUNT:
    raw = cartTotal * (value / 100)
    discountAmount = maxDiscountAmount ? MIN(raw, maxDiscountAmount) : raw

  if type == FIXED_AMOUNT:
    discountAmount = MIN(value, cartTotal)

  if type == FREE_SHIPPING:
    discountAmount = shippingFee
    freeShipping = true

Output:
  discountAmount     (áp vào cart/order)
  finalAmount        = cartTotal + shippingFee - discountAmount
  finalAmount        = MAX(finalAmount, 0)
```

---

## 7. Luồng Nghiệp Vụ

### 7.1 Apply Voucher tại Cart

```
User          Cart Service         Promotion Service       DB
  │                │                      │                │
  ├─ POST /cart/voucher ──────────────────▶│                │
  │  { code: "SUMMER20" }         ├─ SELECT voucher        │
  │                │              ├─ check eligibility     │
  │                │              ├─ SELECT FOR UPDATE vouchers│
  │                │              ├─ INSERT voucher_usages (PENDING)│
  │                │◀─ { discountAmount, usageId } ─│      │
  │                ├─ UPDATE cart document (MongoDB)        │
  │                │  { voucherId, discountAmount }         │
  │◀─ 200 ─────────│                      │                │
```

### 7.2 Confirm khi Checkout

```
Order Service (Saga)     Promotion Service
       │                       │
       ├─ POST /internal/vouchers/confirm
       │  { usageId, orderId }  │
       │                       ├─ UPDATE usage status=CONFIRMED
       │                       ├─ UPDATE vouchers.used_count++
       │                       ├─ Kafka: voucher.applied
       │◀─ { success: true } ──│
```

### 7.3 Release khi Order Cancel

```
Kafka: order.cancelled    Promotion Service
          │                     │
          ├─── consumed ────────▶│
          │                     ├─ FIND usage by orderId
          │                     ├─ UPDATE status=RELEASED
          │                     ├─ UPDATE used_count-- (nếu CONFIRMED)
          │                     ├─ Kafka: voucher.released
```

---

## 8. Validation Rules

| Field                      | Rule                                        |
| -------------------------- | ------------------------------------------- |
| `code`                     | Required, max 50 chars, uppercase normalize |
| `promotion.value`          | > 0; nếu PERCENT_DISCOUNT thì ≤ 100         |
| `promotion.startDate`      | Phải < `endDate`                            |
| `promotion.minOrderAmount` | ≥ 0                                         |
| `voucher.perUserLimit`     | ≥ 1                                         |
| `voucher.usageLimit`       | ≥ 1 (null = không giới hạn)                 |

---

## 9. Error Catalog

| HTTP | Error Code                    | Message (vi)                                         | Điều kiện                          |
| ---- | ----------------------------- | ---------------------------------------------------- | ---------------------------------- |
| 400  | `VOUCHER_NOT_FOUND`           | "Mã voucher không tồn tại hoặc không còn hiệu lực"   | Code sai / inactive                |
| 400  | `VOUCHER_EXPIRED`             | "Mã voucher đã hết hạn sử dụng"                      | Quá `end_date`                     |
| 400  | `VOUCHER_NOT_YET_VALID`       | "Mã voucher chưa đến ngày kích hoạt"                 | Trước `start_date`                 |
| 400  | `VOUCHER_USAGE_LIMIT_REACHED` | "Mã voucher đã được sử dụng hết"                     | `used_count >= usage_limit`        |
| 400  | `VOUCHER_USER_LIMIT_REACHED`  | "Bạn đã sử dụng tối đa số lần cho phép với mã này"   | User dùng quá `per_user_limit`     |
| 400  | `MIN_ORDER_NOT_MET`           | "Đơn hàng tối thiểu {minAmount} VNĐ để dùng mã này"  | cartTotal < minOrderAmount         |
| 400  | `PRODUCT_NOT_ELIGIBLE`        | "Không có sản phẩm nào trong giỏ đủ điều kiện áp mã" | applicable_product_ids không match |
| 409  | `CART_ALREADY_HAS_VOUCHER`    | "Vui lòng xóa mã giảm giá hiện tại trước"            | Đã có voucher pending              |
| 422  | `VOUCHER_CONFIRM_FAILED`      | "Không thể xác nhận mã giảm giá"                     | DB error khi confirm               |
