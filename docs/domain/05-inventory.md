# 🏭 Domain: Inventory Management

> **Service:** `inventory-service` — Port `3005`
> **Database:** AWS RDS PostgreSQL — schema `inventory`
> **Kafka Topics consumed:** `order.created` · `order.cancelled` · `order.failed`
> **Kafka Topics produced:** `inventory.low` · `inventory.reserved` · `inventory.released`
> **Cập nhật:** 22/04/2026

---

## Mục Lục

1. [Tổng Quan Domain](#1-tổng-quan-domain)
2. [Entities & Data Model](#2-entities--data-model)
3. [Business Rules](#3-business-rules)
4. [API Contract](#4-api-contract)
5. [State Machine — Inventory Reservation](#5-state-machine--inventory-reservation)
6. [Luồng Nghiệp Vụ](#6-luồng-nghiệp-vụ)
7. [Locking & Concurrency Strategy](#7-locking--concurrency-strategy)
8. [Validation Rules](#8-validation-rules)
9. [Error Catalog](#9-error-catalog)

---

## 1. Tổng Quan Domain

| Trách nhiệm        | Mô tả                                                   |
| ------------------ | ------------------------------------------------------- |
| Quản lý tồn kho    | CRUD số lượng `availableQty` per product                |
| Reserve / Release  | Giữ chỗ hàng khi có đơn; release khi hủy/fail           |
| Ghi nhận lịch sử   | Mọi thay đổi tồn kho đều có `inventory_transactions`    |
| Cảnh báo hàng thấp | Khi tồn kho ≤ ngưỡng → publish Kafka `inventory.low`    |
| Admin điều chỉnh   | ADMIN điều chỉnh số lượng thủ công (nhập hàng, kiểm kê) |

**Ngoài phạm vi:**

- Multi-warehouse (1 kho duy nhất — scope MVP)
- Lô hàng (batch) / serial number tracking — future

---

## 2. Entities & Data Model

### 2.1 Entity: `inventory_items`

| Column                | Type          | Constraint                   | Mô tả                          |
| --------------------- | ------------- | ---------------------------- | ------------------------------ |
| `id`                  | `UUID`        | PK                           |                                |
| `product_id`          | `UUID`        | UNIQUE NOT NULL              | FK → products.id (1:1)         |
| `available_qty`       | `INT`         | NOT NULL DEFAULT 0 CHECK ≥ 0 | Số lượng hiện có thể bán       |
| `reserved_qty`        | `INT`         | NOT NULL DEFAULT 0 CHECK ≥ 0 | Đang được giữ chỗ bởi đơn chờ  |
| `total_qty`           | `INT`         | NOT NULL DEFAULT 0 CHECK ≥ 0 | `available_qty + reserved_qty` |
| `low_stock_threshold` | `INT`         | NOT NULL DEFAULT 5           | Ngưỡng cảnh báo hàng thấp      |
| `created_at`          | `TIMESTAMPTZ` | NOT NULL DEFAULT NOW()       |                                |
| `updated_at`          | `TIMESTAMPTZ` | NOT NULL DEFAULT NOW()       |                                |

```sql
CREATE UNIQUE INDEX idx_inventory_product_id ON inventory_items(product_id);
CREATE        INDEX idx_inventory_low_stock
  ON inventory_items(product_id)
  WHERE available_qty <= low_stock_threshold;
```

**Bất biến (invariant):**

- `available_qty + reserved_qty = total_qty` — luôn đúng sau mọi transaction
- `available_qty ≥ 0` — CHECK constraint tại DB level

---

### 2.2 Entity: `inventory_reservations`

> Theo dõi từng đơn hàng đang giữ chỗ bao nhiêu hàng

| Column       | Type                                      | Constraint                  | Mô tả                                        |
| ------------ | ----------------------------------------- | --------------------------- | -------------------------------------------- |
| `id`         | `UUID`                                    | PK                          |                                              |
| `order_id`   | `UUID`                                    | NOT NULL                    | FK → orders.id                               |
| `product_id` | `UUID`                                    | NOT NULL                    | FK → inventory_items.product_id              |
| `quantity`   | `INT`                                     | NOT NULL CHECK > 0          | Số lượng đang giữ                            |
| `status`     | `ENUM('RESERVED','RELEASED','COMMITTED')` | NOT NULL DEFAULT 'RESERVED' |                                              |
| `expires_at` | `TIMESTAMPTZ`                             | NOT NULL                    | Thời điểm tự động release nếu chưa committed |
| `created_at` | `TIMESTAMPTZ`                             | NOT NULL DEFAULT NOW()      |                                              |
| `updated_at` | `TIMESTAMPTZ`                             | NOT NULL DEFAULT NOW()      |                                              |

```sql
CREATE INDEX idx_reservations_order_id   ON inventory_reservations(order_id);
CREATE INDEX idx_reservations_product_id ON inventory_reservations(product_id);
CREATE INDEX idx_reservations_status     ON inventory_reservations(status);
CREATE INDEX idx_reservations_expires    ON inventory_reservations(expires_at)
  WHERE status = 'RESERVED';
```

---

### 2.3 Entity: `inventory_transactions`

> Immutable audit log — không bao giờ UPDATE hay DELETE

| Column             | Type           | Constraint             | Mô tả                                 |
| ------------------ | -------------- | ---------------------- | ------------------------------------- |
| `id`               | `UUID`         | PK                     |                                       |
| `product_id`       | `UUID`         | NOT NULL               |                                       |
| `transaction_type` | `ENUM`         | NOT NULL               | Xem bên dưới                          |
| `quantity_delta`   | `INT`          | NOT NULL               | Dương = thêm, âm = bớt                |
| `quantity_before`  | `INT`          | NOT NULL               | `available_qty` trước khi thay đổi    |
| `quantity_after`   | `INT`          | NOT NULL               | `available_qty` sau khi thay đổi      |
| `reference_id`     | `VARCHAR(255)` | NULLABLE               | orderId / admin note ID               |
| `reference_type`   | `VARCHAR(50)`  | NULLABLE               | `ORDER`, `ADMIN_ADJUSTMENT`, `SYSTEM` |
| `note`             | `TEXT`         | NULLABLE               |                                       |
| `created_at`       | `TIMESTAMPTZ`  | NOT NULL DEFAULT NOW() |                                       |

**ENUM `inventory_transaction_type`:**

```sql
CREATE TYPE inventory_transaction_type AS ENUM (
  'RESERVE',        -- giữ chỗ khi tạo đơn
  'RELEASE',        -- giải phóng khi hủy / hết hạn
  'COMMIT',         -- xác nhận bán (order CONFIRMED)
  'RESTOCK',        -- nhập hàng thêm (admin)
  'ADJUSTMENT',     -- điều chỉnh kiểm kê (admin)
  'EXPIRE_RELEASE'  -- tự động release khi reservation hết hạn
);
```

```sql
CREATE INDEX idx_inv_txn_product_id ON inventory_transactions(product_id);
CREATE INDEX idx_inv_txn_created_at ON inventory_transactions(created_at DESC);
CREATE INDEX idx_inv_txn_reference  ON inventory_transactions(reference_id, reference_type);
```

---

## 3. Business Rules

### BR-INV-001: Reserve tồn kho

- Được gọi bởi Order Saga Job `reserve-inventory` (qua REST)
- Với mỗi item trong đơn: `available_qty` phải ≥ `requestedQty`
- Nếu đủ hàng cho TẤT CẢ items: thực hiện trong 1 transaction
  - `available_qty -= requestedQty`
  - `reserved_qty += requestedQty`
  - Tạo `inventory_reservations` record với `status = RESERVED`
  - `expires_at = NOW() + 15 phút`
- Nếu bất kỳ item nào không đủ: rollback toàn bộ → trả về lỗi `INVENTORY_INSUFFICIENT`

### BR-INV-002: Release tồn kho (manual / compensation)

- Được gọi khi đơn hàng bị hủy hoặc payment fail (Saga compensation job)
- Tìm `inventory_reservations` với `orderId` và `status = RESERVED`
- Với mỗi reservation:
  - `available_qty += quantity`
  - `reserved_qty -= quantity`
  - Cập nhật reservation `status = RELEASED`
  - Ghi `inventory_transactions` type `RELEASE`

### BR-INV-003: Commit tồn kho

- Được gọi sau khi đơn hàng `CONFIRMED` (payment success)
- `reserved_qty -= quantity` (hàng đã bán, không còn reserved)
- `total_qty -= quantity` (total giảm)
- Cập nhật reservation `status = COMMITTED`
- Ghi `inventory_transactions` type `COMMIT`

### BR-INV-004: Tự động release khi hết hạn

- Background job chạy mỗi **5 phút**: `SELECT * FROM inventory_reservations WHERE status = 'RESERVED' AND expires_at < NOW()`
- Với mỗi expired reservation: thực hiện release (giống BR-INV-002)
- Ghi transaction type `EXPIRE_RELEASE`
- Dùng khi Saga bị timeout và không trigger compensation

### BR-INV-005: Cảnh báo hàng thấp

- Sau mỗi lần RESERVE hoặc COMMIT: kiểm tra `available_qty <= low_stock_threshold`
- Nếu đúng: publish Kafka topic `inventory.low` với payload `{ productId, productName, availableQty, threshold }`
- Notification Service nhận event này → gửi email cho ADMIN

### BR-INV-006: Admin điều chỉnh tồn kho

- ADMIN có thể:
  - **Restock:** `POST /api/admin/inventory/:productId/restock` — tăng `available_qty`
  - **Adjustment:** `POST /api/admin/inventory/:productId/adjust` — tăng hoặc giảm (kiểm kê)
- Mọi thay đổi phải ghi vào `inventory_transactions`
- Không được phép giảm `available_qty` xuống âm (validation)

### BR-INV-007: Khởi tạo inventory

- Khi ADMIN tạo product mới (Product Service): tự động tạo `inventory_items` với `available_qty = 0`
- Hoặc ADMIN tạo thủ công qua `POST /api/admin/inventory`

---

## 4. API Contract

### `POST /api/inventory/reserve` _(Internal — Order Service only)_

> **Chú ý:** Endpoint này **chỉ cho internal** (không expose ra public hoặc user). Gọi từ Order Service trong Zeebe Job Worker `reserve-inventory`.

**Headers:** `X-Internal-Service-Key: <secret>` (header nội bộ, không phải JWT)

**Request:**

```json
{
  "orderId": "order-uuid",
  "items": [
    { "productId": "prod-uuid-1", "quantity": 2 },
    { "productId": "prod-uuid-2", "quantity": 1 }
  ]
}
```

**Response 200:**

```json
{
  "success": true,
  "data": {
    "orderId": "order-uuid",
    "reservations": [
      {
        "productId": "prod-uuid-1",
        "quantity": 2,
        "expiresAt": "2026-04-22T09:15:00.000Z"
      },
      {
        "productId": "prod-uuid-2",
        "quantity": 1,
        "expiresAt": "2026-04-22T09:15:00.000Z"
      }
    ]
  }
}
```

**Errors:** `422` INVENTORY_INSUFFICIENT (với danh sách sản phẩm thiếu hàng) | `404` productId không tồn tại

**Response 422 (insufficient):**

```json
{
  "success": false,
  "error": {
    "code": "INVENTORY_INSUFFICIENT",
    "message": "Không đủ hàng",
    "details": [
      {
        "productId": "prod-uuid-1",
        "requested": 2,
        "available": 1,
        "productName": "iPhone 15"
      }
    ]
  }
}
```

---

### `POST /api/inventory/release` _(Internal — Order Service only)_

**Request:**

```json
{ "orderId": "order-uuid" }
```

**Response 200:**

```json
{
  "success": true,
  "data": {
    "orderId": "order-uuid",
    "releasedItems": [{ "productId": "prod-uuid-1", "releasedQty": 2 }]
  }
}
```

**Errors:** `404` orderId không có reservation nào

---

### `POST /api/inventory/commit` _(Internal — Order Service only)_

**Mô tả:** Gọi sau khi đơn CONFIRMED — hàng đã bán chính thức

**Request:**

```json
{ "orderId": "order-uuid" }
```

**Response 200:**

```json
{ "success": true }
```

---

### `GET /api/admin/inventory` _(ADMIN only)_

**Query Params:** `?page=1&limit=20&lowStock=true&productId=uuid`

**Response 200:**

```json
{
  "success": true,
  "data": [
    {
      "id": "inv-uuid",
      "productId": "prod-uuid",
      "productName": "iPhone 15 Pro Max 256GB",
      "availableQty": 12,
      "reservedQty": 3,
      "totalQty": 15,
      "lowStockThreshold": 5,
      "isLowStock": false,
      "updatedAt": "2026-04-22T09:00:00.000Z"
    }
  ],
  "meta": { "total": 50, "page": 1, "limit": 20, "totalPages": 3 }
}
```

---

### `GET /api/admin/inventory/:productId` _(ADMIN only)_

**Response 200:** Full inventory record + recent 20 transactions

```json
{
  "success": true,
  "data": {
    "productId": "prod-uuid",
    "availableQty": 12,
    "reservedQty": 3,
    "totalQty": 15,
    "transactions": [
      {
        "id": "txn-uuid",
        "type": "RESERVE",
        "quantityDelta": -2,
        "quantityBefore": 14,
        "quantityAfter": 12,
        "referenceId": "order-uuid",
        "referenceType": "ORDER",
        "createdAt": "2026-04-22T09:00:00.000Z"
      }
    ]
  }
}
```

---

### `POST /api/admin/inventory/:productId/restock` _(ADMIN only)_

**Request:**

```json
{
  "quantity": 50,
  "note": "Nhập hàng từ nhà cung cấp ABC"
}
```

**Response 200:**

```json
{
  "success": true,
  "data": {
    "productId": "prod-uuid",
    "previousQty": 5,
    "addedQty": 50,
    "currentQty": 55
  }
}
```

**Errors:** `400` quantity ≤ 0 | `404` product không tồn tại

---

### `POST /api/admin/inventory/:productId/adjust` _(ADMIN only)_

**Mô tả:** Điều chỉnh số lượng sau kiểm kê (có thể âm để giảm)

**Request:**

```json
{
  "newAvailableQty": 48,
  "note": "Kiểm kê tháng 4 — thực tế thiếu 2 cái"
}
```

**Response 200:**

```json
{
  "success": true,
  "data": {
    "productId": "prod-uuid",
    "previousQty": 50,
    "adjustedQty": 48,
    "delta": -2
  }
}
```

**Errors:** `400` newAvailableQty < 0 | `422` newAvailableQty < reservedQty (không thể set nhỏ hơn số đang reserved)

---

### `PATCH /api/admin/inventory/:productId/threshold` _(ADMIN only)_

**Mô tả:** Cập nhật ngưỡng cảnh báo hàng thấp

**Request:**

```json
{ "lowStockThreshold": 10 }
```

**Response 200:** inventory record đã cập nhật

---

## 5. State Machine — Inventory Reservation

```
[Order Saga: reserve-inventory job]
             │
             ▼
        ┌──────────┐
        │ RESERVED │──── expiresAt = NOW() + 15 min ────┐
        └──────────┘                                    │
         /        \                              [Timer expired]
     [CONFIRMED]  [Hủy/Fail]                           │
         │               │                              ▼
         ▼               ▼                       ┌──────────────┐
   ┌───────────┐  ┌──────────┐                  │EXPIRE_RELEASE│
   │ COMMITTED │  │ RELEASED │                  └──────────────┘
   └───────────┘  └──────────┘               (background job, mỗi 5 phút)
   (terminal ✅)  (terminal ✅)
```

---

## 6. Luồng Nghiệp Vụ

### 6.1 Reserve → Commit (Happy Path)

```
Order Service         Inventory Service              PostgreSQL
     │                      │                             │
     ├─ POST /reserve ──────▶│                             │
     │                      ├─ BEGIN TRANSACTION ─────────▶│
     │                      ├─ SELECT * FROM inventory_items
     │                      │  WHERE product_id IN (...)   │
     │                      │  FOR UPDATE ────────────────▶│ (pessimistic lock)
     │                      │◀─ locked rows ───────────────│
     │                      ├─ validate available_qty      │
     │                      ├─ UPDATE inventory_items      │
     │                      │  SET available_qty -= qty    │
     │                      │  reserved_qty += qty ───────▶│
     │                      ├─ INSERT inventory_reservations│
     │                      ├─ INSERT inventory_transactions│
     │                      ├─ COMMIT ────────────────────▶│
     │◀─ 200 { reserved } ───│
     │
     (... Order CONFIRMED ...)
     │
     ├─ POST /commit ────────▶│
     │                      ├─ UPDATE reserved_qty -= qty  │
     │                      ├─ total_qty -= qty            │
     │                      ├─ reservation.status = COMMITTED
     │                      ├─ INSERT transaction COMMIT   │
     │◀─ 200 ────────────────│
```

### 6.2 Auto-release khi Reservation Expired

```
Background Job (cron 5 phút)    Inventory Service    Kafka
          │                            │               │
          ├─ trigger check ───────────▶│               │
          │                            ├─ SELECT expired reservations
          │                            │  (status=RESERVED, expires_at < NOW())
          │                            ├─ for each reservation:
          │                            │  UPDATE available_qty += qty
          │                            │  UPDATE reserved_qty -= qty
          │                            │  reservation.status = RELEASED
          │                            │  INSERT transaction EXPIRE_RELEASE
          │                            ├─ check low_stock_threshold
          │                            ├─ if low: publish inventory.low ─▶│
```

---

## 7. Locking & Concurrency Strategy

### Pessimistic Locking — `SELECT ... FOR UPDATE`

```sql
-- Trong 1 transaction khi reserve
BEGIN;

SELECT id, available_qty, reserved_qty
FROM inventory_items
WHERE product_id = ANY($1::uuid[])
FOR UPDATE;                              -- Block concurrent writes

-- Sau đó validate và UPDATE trong cùng transaction
UPDATE inventory_items
SET
  available_qty = available_qty - $2,
  reserved_qty  = reserved_qty  + $2,
  updated_at    = NOW()
WHERE product_id = $1
  AND available_qty >= $2;              -- Double-check trong query

COMMIT;
```

**Lý do chọn Pessimistic Lock thay vì Optimistic:**

- Inventory là **critical resource** — oversell gây ảnh hưởng trực tiếp đến business
- Throughput MVP thấp (< 100 concurrent orders) → pessimistic lock không gây bottleneck
- Optimistic lock phức tạp hơn (retry logic, version column) — over-engineering với scale hiện tại

**Dead Lock Prevention:**

- Luôn lock theo thứ tự `product_id ORDER BY product_id` để tránh deadlock khi nhiều orders cùng reserve nhiều products

---

## 8. Validation Rules

| Field               | Rule                                       |
| ------------------- | ------------------------------------------ |
| `orderId`           | UUID v4 format, required                   |
| `items[].productId` | UUID v4 format                             |
| `items[].quantity`  | Integer > 0, ≤ 999                         |
| `restockQty`        | Integer > 0, max 10,000 per request        |
| `newAvailableQty`   | Integer ≥ 0; phải ≥ `reservedQty` hiện tại |
| `lowStockThreshold` | Integer ≥ 0, max 1000                      |

---

## 9. Error Catalog

| HTTP | Error Code                | Message (vi)                                                  | Điều kiện                          |
| ---- | ------------------------- | ------------------------------------------------------------- | ---------------------------------- |
| 400  | `VALIDATION_ERROR`        | "Dữ liệu không hợp lệ"                                        | Field validation fail              |
| 400  | `INVALID_QUANTITY`        | "Số lượng không hợp lệ"                                       | quantity ≤ 0 hoặc sai type         |
| 401  | `UNAUTHORIZED`            | "Vui lòng đăng nhập"                                          | Thiếu JWT (public)                 |
| 403  | `FORBIDDEN`               | "Không có quyền truy cập"                                     | Thiếu ADMIN role                   |
| 403  | `INVALID_SERVICE_KEY`     | "Service key không hợp lệ"                                    | Header X-Internal-Service-Key sai  |
| 404  | `PRODUCT_NOT_FOUND`       | "Không tìm thấy sản phẩm trong kho"                           | productId không có inventory_items |
| 404  | `RESERVATION_NOT_FOUND`   | "Không tìm thấy reservation cho đơn hàng này"                 | orderId không có reservation       |
| 409  | `ALREADY_RESERVED`        | "Đơn hàng này đã được giữ hàng"                               | Gọi reserve 2 lần cùng 1 orderId   |
| 422  | `INVENTORY_INSUFFICIENT`  | "Không đủ hàng trong kho"                                     | available_qty < requestedQty       |
| 422  | `ADJUST_BELOW_RESERVED`   | "Không thể điều chỉnh tồn kho xuống thấp hơn số đang giữ chỗ" | newQty < reservedQty               |
| 500  | `LOCK_TIMEOUT`            | "Hệ thống đang bận, vui lòng thử lại"                         | DB lock timeout                    |
| 500  | `INVENTORY_UPDATE_FAILED` | "Lỗi cập nhật tồn kho"                                        | DB transaction fail                |

---

## 10. Hỗ Trợ Product Variants

### 10.1 Tổng Quan

Khi product có variants (xem `02-product-catalog.md` Section 9), tồn kho được quản lý ở cấp **variant** (không phải product). Mỗi variant có 1 bản ghi riêng trong `inventory_items`.

**Nguyên tắc:**

- Product **không có** variant: dùng `product_id` trực tiếp (tương thích ngược)
- Product **có** variant: dùng `variant_id`; `product_id` là denormalized reference để query nhanh

### 10.2 Cập nhật Entity `inventory_items`

**Thay đổi schema:**

```sql
-- Thêm variant_id column
ALTER TABLE inventory_items
  ADD COLUMN variant_id UUID REFERENCES product_variants(id) ON DELETE CASCADE;

-- Thêm product_id denormalized (vẫn giữ để backward compat + JOIN nhanh)
-- product_id cũ vẫn còn, nhưng bỏ UNIQUE constraint nếu có variant
ALTER TABLE inventory_items
  DROP CONSTRAINT inventory_items_product_id_key;   -- bỏ UNIQUE cũ

-- Index mới
CREATE UNIQUE INDEX idx_inventory_variant_id
  ON inventory_items(variant_id)
  WHERE variant_id IS NOT NULL;

CREATE UNIQUE INDEX idx_inventory_product_id_no_variant
  ON inventory_items(product_id)
  WHERE variant_id IS NULL;   -- Unique chỉ khi không có variant
```

**Schema sau cập nhật:**

| Column                | Type          | Constraint                   | Mô tả                                              |
| --------------------- | ------------- | ---------------------------- | -------------------------------------------------- |
| `id`                  | `UUID`        | PK                           |                                                    |
| `product_id`          | `UUID`        | NOT NULL                     | FK → products.id (denormalized, dùng để JOIN)      |
| `variant_id`          | `UUID`        | NULLABLE                     | FK → product_variants.id (NULL nếu simple product) |
| `available_qty`       | `INT`         | NOT NULL DEFAULT 0 CHECK ≥ 0 |                                                    |
| `reserved_qty`        | `INT`         | NOT NULL DEFAULT 0 CHECK ≥ 0 |                                                    |
| `total_qty`           | `INT`         | NOT NULL DEFAULT 0 CHECK ≥ 0 |                                                    |
| `low_stock_threshold` | `INT`         | NOT NULL DEFAULT 5           |                                                    |
| `created_at`          | `TIMESTAMPTZ` | NOT NULL DEFAULT NOW()       |                                                    |
| `updated_at`          | `TIMESTAMPTZ` | NOT NULL DEFAULT NOW()       |                                                    |

### 10.3 Cập nhật `inventory_reservations`

```sql
ALTER TABLE inventory_reservations
  ADD COLUMN variant_id UUID REFERENCES product_variants(id);

-- product_id giữ nguyên cho simple products
-- variant_id set khi reserve variant
```

### 10.4 Cập nhật `inventory_transactions`

```sql
ALTER TABLE inventory_transactions
  ADD COLUMN variant_id UUID REFERENCES product_variants(id);
```

### 10.5 Cập nhật API Paths

| Old Path                                        | New Path                                                | Ghi chú         |
| ----------------------------------------------- | ------------------------------------------------------- | --------------- |
| `GET /api/admin/inventory/:productId`           | `GET /api/admin/inventory/product/:productId`           | Simple product  |
| `PATCH /api/admin/inventory/:productId/restock` | `PATCH /api/admin/inventory/variant/:variantId/restock` | Variant restock |
| `POST /api/internal/inventory/reserve`          | Không đổi — body thêm `variantId`                       |                 |

**`POST /api/internal/inventory/reserve`** — Request body cập nhật:

```json
{
  "orderId": "order-uuid",
  "items": [
    {
      "productId": "prod-uuid",
      "variantId": "variant-uuid",   ← NEW (null nếu simple product)
      "quantity": 2
    }
  ]
}
```

**`GET /api/admin/inventory/product/:productId/variants`** _(ADMIN)_

```json
{
  "success": true,
  "data": [
    {
      "variantId": "variant-uuid-1",
      "sku": "SHIRT-M-RED",
      "attributes": { "size": "M", "color": "Đỏ" },
      "availableQty": 45,
      "reservedQty": 5,
      "totalQty": 50,
      "lowStockThreshold": 5,
      "alertLevel": "NORMAL"
    },
    {
      "variantId": "variant-uuid-2",
      "sku": "SHIRT-S-BLACK",
      "attributes": { "size": "S", "color": "Đen" },
      "availableQty": 2,
      "reservedQty": 1,
      "totalQty": 3,
      "lowStockThreshold": 5,
      "alertLevel": "CRITICAL"
    }
  ]
}
```

---

## 11. Bulk Import CSV

### 11.1 Tổng Quan

Admin có thể import tồn kho hàng loạt bằng file CSV. Thường dùng khi nhập hàng nhiều variant cùng lúc.

### 11.2 CSV Format

| Column        | Required | Mô tả                                                   |
| ------------- | -------- | ------------------------------------------------------- |
| `variant_sku` | ✅       | SKU của variant (hoặc product SKU nếu simple)           |
| `quantity`    | ✅       | Số lượng nhập thêm (dương = nhập, âm = điều chỉnh giảm) |
| `note`        | ❌       | Ghi chú cho transaction này                             |

**Ví dụ file CSV:**

```csv
variant_sku,quantity,note
SHIRT-M-RED,100,Nhập hàng tháng 5
SHIRT-S-BLACK,50,Nhập hàng tháng 5
IPHONE-15PM-256-BLK,20,Hàng về từ nhà cung cấp XYZ
```

### 11.3 API Endpoint

**`POST /api/admin/inventory/import`** _(ADMIN)_

**Request:** `multipart/form-data`

| Field  | Type     | Mô tả                                                    |
| ------ | -------- | -------------------------------------------------------- |
| `file` | `File`   | CSV file, max 5MB                                        |
| `mode` | `String` | `"ADD"` (cộng thêm) hoặc `"SET"` (đặt về giá trị cụ thể) |

**Response 200:**

```json
{
  "success": true,
  "data": {
    "totalRows": 3,
    "successCount": 2,
    "failedCount": 1,
    "errors": [
      {
        "row": 3,
        "sku": "IPHONE-15PM-256-BLK",
        "reason": "SKU không tồn tại trong hệ thống"
      }
    ]
  }
}
```

### 11.4 Xử lý Import

```
1. Parse CSV, validate header row
2. Với mỗi row:
   a. Lookup variant/product bằng sku
   b. Nếu không tìm thấy → record error, skip row
   c. Nếu mode=ADD: available_qty += quantity
   d. Nếu mode=SET: available_qty = quantity
   e. INSERT inventory_transaction (type=RESTOCK)
3. Trả về summary: success, failed, errors[]
4. Partial success: commit các row thành công, rollback individual failed rows
```

**Business Rules:**

- Max **1,000 rows** mỗi import request
- Các row thành công được commit ngay (không rollback toàn bộ khi có 1 row lỗi)
- Import log được lưu trong `inventory_transactions` với `reference_type = 'CSV_IMPORT'`

| HTTP | Error Code           | Message                                                                    |
| ---- | -------------------- | -------------------------------------------------------------------------- |
| 400  | `INVALID_CSV_FORMAT` | "File CSV không đúng format. Kiểm tra header: variant_sku, quantity, note" |
| 400  | `CSV_TOO_LARGE`      | "File CSV quá lớn (max 5MB)"                                               |
| 400  | `CSV_TOO_MANY_ROWS`  | "CSV tối đa 1,000 dòng mỗi lần import"                                     |
| 422  | `ALL_ROWS_FAILED`    | "Tất cả dòng import đều thất bại"                                          |

---

## 12. Alert Level Matrix

### 12.1 Định nghĩa

| Alert Level | Điều kiện                                                   | Hành động                                                                      |
| ----------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `CRITICAL`  | `available_qty ≤ 2`                                         | Gửi email alert tới admin + Prometheus counter `inventory_critical_total` tăng |
| `LOW`       | `available_qty ≤ low_stock_threshold AND available_qty > 2` | Publish Kafka `inventory.low` event                                            |
| `NORMAL`    | `available_qty > low_stock_threshold`                       | Không hành động                                                                |

### 12.2 Kafka Event: `inventory.low`

```json
{
  "event": "inventory.low",
  "timestamp": "2026-04-22T09:00:00Z",
  "payload": {
    "variantId": "variant-uuid",
    "productId": "prod-uuid",
    "sku": "SHIRT-M-RED",
    "productName": "Áo phông Unisex",
    "alertLevel": "LOW",
    "availableQty": 3,
    "lowStockThreshold": 5
  }
}
```

### 12.3 Alert Level được tính ở đâu

Alert level được tính **sau mỗi thao tác** thay đổi `available_qty`:

- Sau `COMMIT` (order confirmed → qty giảm)
- Sau `RESERVE` (giảm available)
- Sau import CSV

```
Mỗi sau update:
  qty = new available_qty
  if qty ≤ 2:
    → EMAIL admin (qua notification-service)
    → Prometheus: inventory_critical_total.inc({ sku })
  else if qty ≤ threshold:
    → Kafka: inventory.low
```

### 12.4 Response bổ sung — `alertLevel` field

Tất cả API trả về inventory record nay bổ sung field `alertLevel`:

```json
{
  "variantId": "variant-uuid",
  "sku": "SHIRT-M-RED",
  "availableQty": 2,
  "reservedQty": 0,
  "totalQty": 2,
  "lowStockThreshold": 5,
  "alertLevel": "CRITICAL"
}
```
