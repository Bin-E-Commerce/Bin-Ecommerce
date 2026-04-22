# 🛒 Domain: Cart Management

> **Service:** `cart-service` — Port `3003`
> **Database:** MongoDB Atlas M0 — collection `carts`
> **Lý do MongoDB:** Schema-less + TTL index native → phù hợp với cart session linh hoạt
> **Cập nhật:** 22/04/2026

---

## Mục Lục

1. [Tổng Quan Domain](#1-tổng-quan-domain)
2. [Data Model (MongoDB)](#2-data-model-mongodb)
3. [Business Rules](#3-business-rules)
4. [API Contract](#4-api-contract)
5. [State Machine — Cart Session](#5-state-machine--cart-session)
6. [Luồng Nghiệp Vụ](#6-luồng-nghiệp-vụ)
7. [Validation Rules](#7-validation-rules)
8. [Error Catalog](#8-error-catalog)

---

## 1. Tổng Quan Domain

| Trách nhiệm        | Mô tả                                                                    |
| ------------------ | ------------------------------------------------------------------------ |
| Lưu giỏ hàng       | Mỗi user có 1 cart document, tồn tại trong MongoDB                       |
| Thêm / sửa / xóa   | CRUD cart items theo `productId` + `quantity`                            |
| TTL (tự hết hạn)   | Cart tự động xóa sau 7 ngày không có activity                            |
| Snapshot giá       | Lưu `price` tại thời điểm add vào giỏ (không cập nhật khi admin sửa giá) |
| Tổng tiền realtime | Tính `totalAmount` khi trả về response (không persist)                   |

**Ngoài phạm vi:**

- Tồn kho (kiểm tra tại Checkout, không tại Add-to-cart)
- Voucher / discount code (tính năng future)
- Cart chia sẻ (share link) — future

**Quyết định kiến trúc:** Cart **không** kiểm tra tồn kho khi add to cart → UX tốt hơn (không block user ngay). Tồn kho chỉ được kiểm tra và reserve tại bước **Checkout → Tạo đơn hàng**.

---

## 2. Data Model (MongoDB)

### Collection: `carts`

```json
{
  "_id": "ObjectId",
  "userId": "550e8400-e29b-41d4-a716-446655440000",
  "items": [
    {
      "itemId": "ObjectId (local sub-document ID)",
      "productId": "prod-uuid",
      "productName": "iPhone 15 Pro Max 256GB",
      "thumbnailUrl": "https://res.cloudinary.com/...",
      "priceAtAdded": 33990000,
      "quantity": 2,
      "addedAt": "ISODate"
    }
  ],
  "createdAt": "ISODate",
  "updatedAt": "ISODate",
  "expiresAt": "ISODate"
}
```

### Indexes

```javascript
// 1 cart per user
db.carts.createIndex({ userId: 1 }, { unique: true });

// TTL index — MongoDB tự xóa document khi expiresAt < now
db.carts.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
```

### Schema Constraints

| Field                  | Type            | Rule                                      |
| ---------------------- | --------------- | ----------------------------------------- |
| `userId`               | `String (UUID)` | Unique, required, FK về users.id (RDS)    |
| `items[]`              | `Array`         | Max 50 items                              |
| `items[].productId`    | `String (UUID)` | Required                                  |
| `items[].productName`  | `String`        | Snapshot tại thời điểm add, max 255 chars |
| `items[].thumbnailUrl` | `String`        | Snapshot URL, NULLABLE                    |
| `items[].priceAtAdded` | `Number`        | Giá tại thời điểm add, > 0                |
| `items[].quantity`     | `Number`        | Integer, 1–99                             |
| `items[].addedAt`      | `Date`          | Tự set khi add                            |
| `expiresAt`            | `Date`          | updatedAt + 7 ngày                        |

---

## 3. Business Rules

### BR-CART-001: Ownership

- Mỗi user chỉ có **1 cart document** (unique index `userId`)
- Cart được tạo tự động khi user add item lần đầu (upsert pattern)
- User không thể xem hoặc sửa cart của người khác

### BR-CART-002: Snapshot giá

- Khi add sản phẩm vào giỏ: lưu `priceAtAdded` từ Product Service tại thời điểm đó
- `priceAtAdded` **không cập nhật** khi admin sau đó thay đổi giá sản phẩm
- Người dùng thấy giá cũ khi xem giỏ → đây là hành vi đúng (cảnh báo nếu có chênh lệch là tính năng future)
- Khi tạo đơn hàng (`POST /orders`): Order Service lấy giá **mới nhất** từ Product Service để tính `totalAmount`

### BR-CART-003: Add item

- Nếu `productId` đã tồn tại trong cart: **cộng dồn** `quantity` (không tạo item mới)
- Sau khi cộng, nếu `quantity` > 99: cắt về 99 (không báo lỗi, chỉ cap)
- Cập nhật `updatedAt` và tính lại `expiresAt = updatedAt + 7 ngày`
- Sản phẩm phải ở trạng thái `ACTIVE` mới được add (gọi Product Service để verify)

### BR-CART-004: Update quantity

- `quantity` mới phải là integer từ **1 đến 99**
- Set `quantity = 0` → tương đương xóa item khỏi giỏ (convenience rule)

### BR-CART-005: Remove item

- Xóa theo `itemId` (sub-document ID) hoặc `productId`
- Nếu xóa item cuối cùng: cart document vẫn tồn tại (rỗng), không bị xóa ngay

### BR-CART-006: TTL (Time-to-Live)

- Mỗi khi có thay đổi (add/update/remove): `expiresAt = NOW() + 7 ngày`
- Cart không có activity 7 ngày → MongoDB TTL index tự xóa
- Cart bị clear sau khi đặt hàng thành công (`status = CONFIRMED`)

### BR-CART-007: Giới hạn items

- Tối đa **50 items** khác nhau trong 1 cart
- Thêm item thứ 51 → 422 `CART_ITEM_LIMIT_EXCEEDED`

---

## 4. API Contract

### `GET /api/cart` _(User)_

**Headers:** `Authorization: Bearer <accessToken>`

**Mô tả:** Lấy giỏ hàng của user hiện tại

**Response 200:**

```json
{
  "success": true,
  "data": {
    "id": "mongo-object-id",
    "userId": "user-uuid",
    "items": [
      {
        "itemId": "mongo-item-id",
        "productId": "prod-uuid",
        "productName": "iPhone 15 Pro Max 256GB",
        "thumbnailUrl": "https://res.cloudinary.com/...",
        "priceAtAdded": 33990000,
        "quantity": 2,
        "subtotal": 67980000,
        "addedAt": "2026-04-22T09:00:00.000Z"
      }
    ],
    "totalItems": 2,
    "totalAmount": 67980000,
    "expiresAt": "2026-04-29T09:00:00.000Z",
    "updatedAt": "2026-04-22T09:00:00.000Z"
  }
}
```

> Nếu user chưa có cart: trả về cart rỗng (không phải 404):

```json
{
  "success": true,
  "data": {
    "items": [],
    "totalItems": 0,
    "totalAmount": 0
  }
}
```

---

### `POST /api/cart/items` _(User)_

**Headers:** `Authorization: Bearer <accessToken>`

**Mô tả:** Thêm sản phẩm vào giỏ hàng

**Request:**

```json
{
  "productId": "prod-uuid",
  "quantity": 1
}
```

| Field       | Required | Rule                         |
| ----------- | -------- | ---------------------------- |
| `productId` | ✅       | UUID, phải là product ACTIVE |
| `quantity`  | ✅       | Integer 1–99                 |

**Response 200** (trả về cart sau khi cập nhật):

```json
{
  "success": true,
  "data": {
    "cart": {
      "items": [...],
      "totalItems": 3,
      "totalAmount": 101970000
    },
    "addedItem": {
      "itemId": "mongo-item-id",
      "productId": "prod-uuid",
      "productName": "iPhone 15 Pro Max 256GB",
      "quantity": 1,
      "priceAtAdded": 33990000
    }
  }
}
```

**Errors:** `400` validation | `404` product không tồn tại | `422` product không ACTIVE | `422` cart đã đủ 50 items

---

### `PATCH /api/cart/items/:itemId` _(User)_

**Headers:** `Authorization: Bearer <accessToken>`

**Mô tả:** Cập nhật số lượng item

**Request:**

```json
{ "quantity": 3 }
```

**Response 200:** cart object đã cập nhật

**Errors:** `400` quantity < 1 hoặc > 99 | `404` itemId không tồn tại trong cart của user

---

### `DELETE /api/cart/items/:itemId` _(User)_

**Headers:** `Authorization: Bearer <accessToken>`

**Mô tả:** Xóa 1 item khỏi giỏ hàng

**Response 200:** cart object sau khi xóa

**Errors:** `404` itemId không tồn tại trong cart

---

### `DELETE /api/cart` _(User)_

**Headers:** `Authorization: Bearer <accessToken>`

**Mô tả:** Xóa toàn bộ giỏ hàng (clear cart)

**Response 200:**

```json
{ "success": true, "message": "Cart cleared" }
```

---

### `GET /api/cart/count` _(User)_

**Headers:** `Authorization: Bearer <accessToken>`

**Mô tả:** Lấy tổng số items (dùng cho badge icon trên navbar, lightweight call)

**Response 200:**

```json
{
  "success": true,
  "data": { "totalItems": 5 }
}
```

---

## 5. State Machine — Cart Session

```
             [User đăng nhập lần đầu / add item]
                           │
                           ▼
                     ┌───────────┐
                     │  ACTIVE   │◀──────────────────┐
                     └───────────┘                   │
                    /             \                   │
          [Add/Update/Remove]    [7 ngày không dùng] │
                    │                   │             │
                    │ (reset expiry)    ▼             │
                    │             ┌─────────┐         │
                    │             │ EXPIRED │ (MongoDB│
                    │             │ (deleted│  tự xóa)│
                    │             └─────────┘         │
                    │                                  │
          [Order CONFIRMED]              [User quay lại add item]
                    │                            (tạo cart mới)
                    ▼
               ┌─────────┐
               │ CLEARED │  (items = [], vẫn tồn tại document)
               └─────────┘
```

---

## 6. Luồng Nghiệp Vụ

### 6.1 Add to Cart

```
Frontend (Next.js)     API Gateway      Cart Service     Product Service
        │                   │                │                  │
        ├─ POST /cart/items─▶│                │                  │
        │                   ├─ JWT verify ──▶│                  │
        │                   │                ├─ GET product ───▶│
        │                   │                │◀── { price, status, name } ─│
        │                   │                │                  │
        │                   │                ├─ validate product ACTIVE
        │                   │                ├─ upsert cart (MongoDB)
        │                   │                │  (cộng dồn qty nếu exists)
        │                   │                ├─ set expiresAt = now + 7d
        │◀─ 200 { cart } ────────────────────│
```

### 6.2 Chuyển Cart sang Order (khi Checkout)

```
Frontend          Cart Service         Order Service        Inventory Service
    │                  │                    │                      │
    ├─ POST /orders ──▶│ (qua API Gateway)  │                      │
    │                  │                    │                      │
    │              GET /api/cart ──────────▶│                      │
    │                  │◀── { items } ──────│                      │
    │                  │                    │                      │
    │                  │          (Order Service tự gọi Product    │
    │                  │           Service lấy giá mới nhất)       │
    │                  │                    │                      │
    │                  │                    ├─ reserve inventory ──▶│
    │                  │                    │                      │
    │ (nếu order CONFIRMED)                 │                      │
    │                  │◀─ DELETE /cart ────│                      │
    │◀─ 201 { order } ──────────────────────│
```

---

## 7. Validation Rules

| Field            | Rule                                          |
| ---------------- | --------------------------------------------- |
| `productId`      | UUID v4 format, required                      |
| `quantity`       | Integer, min 1, max 99                        |
| Cart items count | Tối đa 50 items/cart                          |
| Item per product | Chỉ 1 entry per productId (quantity cộng dồn) |

---

## 8. Error Catalog

| HTTP | Error Code                 | Message (vi)                              | Điều kiện                                  |
| ---- | -------------------------- | ----------------------------------------- | ------------------------------------------ |
| 400  | `VALIDATION_ERROR`         | "Dữ liệu không hợp lệ"                    | productId sai format, quantity ngoài range |
| 401  | `UNAUTHORIZED`             | "Vui lòng đăng nhập"                      | Không có JWT                               |
| 404  | `PRODUCT_NOT_FOUND`        | "Sản phẩm không tồn tại"                  | productId không tồn tại                    |
| 404  | `ITEM_NOT_FOUND`           | "Không tìm thấy sản phẩm trong giỏ hàng"  | itemId không tồn tại trong cart user       |
| 422  | `PRODUCT_UNAVAILABLE`      | "Sản phẩm này tạm thời không thể mua"     | Product không ACTIVE                       |
| 422  | `CART_ITEM_LIMIT_EXCEEDED` | "Giỏ hàng tối đa 50 loại sản phẩm"        | Vượt 50 items                              |
| 500  | `CART_OPERATION_FAILED`    | "Lỗi cập nhật giỏ hàng, vui lòng thử lại" | MongoDB operation fail                     |

---

## 9. Guest Cart

### 9.1 Tổng Quan

Cho phép khách (chưa đăng nhập) add sản phẩm vào giỏ. Guest cart được lưu trong MongoDB với `userId: null` và định danh bằng `sessionId` trong cookie.

**Khi nào dùng:** User chưa có JWT (chưa đăng nhập).
**Cookie:** `guest_cart_id` — httpOnly, SameSite=Strict, TTL 7 ngày, reset mỗi lần có activity.

### 9.2 Schema Guest Cart

```json
{
  "_id": "ObjectId",
  "userId": null,
  "sessionId": "random-uuid-v4",
  "items": [
    {
      "itemId": "ObjectId",
      "productId": "prod-uuid",
      "productName": "iPhone 15 Pro Max",
      "thumbnailUrl": "...",
      "priceAtAdded": 33990000,
      "quantity": 1,
      "addedAt": "ISODate"
    }
  ],
  "createdAt": "ISODate",
  "updatedAt": "ISODate",
  "expiresAt": "ISODate"
}
```

```javascript
// Index cho guest cart
db.carts.createIndex({ sessionId: 1 }, { sparse: true });
// Unique chỉ khi có sessionId (sparse = bỏ qua null)
db.carts.createIndex({ sessionId: 1 }, { unique: true, sparse: true });
```

### 9.3 Business Rules Guest Cart

**BR-CART-GUEST-001:** Guest cart dùng `sessionId` (UUID v4) từ cookie `guest_cart_id`. Nếu chưa có cookie, server tạo mới và set cookie.

**BR-CART-GUEST-002:** Guest cart có cùng giới hạn: tối đa 50 items, quantity 1–99.

**BR-CART-GUEST-003:** Guest cart TTL = 7 ngày (tương tự user cart).

**BR-CART-GUEST-004: Merge khi đăng nhập**

```
1. User đăng nhập → auth-service trả JWT
2. Frontend gọi POST /api/cart/merge với:
   - Authorization: Bearer <newJWT>
   - Cookie: guest_cart_id=<sessionId>
3. Cart Service:
   a. Load guest cart bằng sessionId
   b. Load user cart bằng userId (tạo mới nếu chưa có)
   c. Với mỗi item trong guest cart:
      - Nếu productId đã có trong user cart: cộng dồn qty (cap 99)
      - Nếu chưa có: push item vào user cart (giữ priceAtAdded từ guest cart)
   d. Tổng items sau merge tối đa 50 (dư → bỏ items cũ nhất của guest)
   e. DELETE guest cart document
   f. Xóa cookie guest_cart_id (set Max-Age=0)
4. Trả về user cart đã merge
```

**BR-CART-GUEST-005:** Nếu user đăng nhập nhưng không có guest cart (cookie trống) → bỏ qua merge, trả về user cart bình thường.

### 9.4 API Endpoints Guest Cart

**Các endpoint GET/POST/PATCH/DELETE `/api/cart/*`** đã có hoạt động với cả guest (dùng `sessionId` cookie) và user (dùng JWT). Logic phân biệt:

```
Xác định cart owner:
  if Authorization header có JWT:
    → user cart (userId)
  else if cookie guest_cart_id tồn tại:
    → guest cart (sessionId)
  else:
    → tạo sessionId mới, set cookie, dùng guest cart
```

**`POST /api/cart/merge`** _(User — requires JWT)_

```json
// No request body needed, sessionId từ cookie

// Response 200
{
  "success": true,
  "data": {
    "mergedItemsCount": 3,
    "cart": {
      "items": [...],
      "totalItems": 5,
      "totalAmount": 169950000
    }
  }
}
```

| HTTP | Error Code     | Message                                       |
| ---- | -------------- | --------------------------------------------- |
| 401  | `UNAUTHORIZED` | "Vui lòng đăng nhập trước khi merge giỏ hàng" |

---

## 10. Voucher trong Giỏ Hàng

### 10.1 Tổng Quan

User có thể áp dụng voucher code trực tiếp tại giỏ hàng để xem giá sau giảm trước khi checkout. Thông tin voucher được lưu tạm trong cart document.

### 10.2 Cập nhật Schema Cart

```json
{
  "_id": "ObjectId",
  "userId": "user-uuid",
  "items": [...],
  "appliedVoucher": {
    "voucherId": "voucher-uuid",
    "code": "SUMMER20",
    "discountType": "PERCENT_DISCOUNT",
    "discountValue": 20,
    "discountAmount": 13596000,
    "appliedAt": "ISODate"
  },
  "totalAmount": 101970000,
  "discountAmount": 13596000,
  "finalAmount": 88374000,
  "expiresAt": "ISODate",
  "updatedAt": "ISODate"
}
```

**Computed fields (không persist, tính khi GET):**

- `totalAmount` = sum(item.priceAtAdded \* item.quantity)
- `discountAmount` = lấy từ `appliedVoucher.discountAmount`
- `finalAmount` = `totalAmount - discountAmount`

### 10.3 Business Rules Voucher

**BR-CART-VOUCHER-001:** Mỗi cart chỉ áp dụng **1 voucher** tại 1 thời điểm.

**BR-CART-VOUCHER-002:** Khi apply voucher: gọi `promotion-service` để validate (voucher còn hiệu lực, đủ điều kiện min_order_amount, user chưa dùng quá số lần).

**BR-CART-VOUCHER-003:** Voucher chỉ được **reserve** tại bước tạo đơn hàng (`POST /orders`), không reserve khi apply vào cart. Có thể có race condition nếu nhiều user cùng checkout, nhưng đây là tradeoff chấp nhận được ở MVP.

**BR-CART-VOUCHER-004:** Khi items trong cart thay đổi (add/update/remove) → `discountAmount` được tính lại với voucher hiện tại. Nếu cart không còn đủ `min_order_amount` → tự động xóa voucher khỏi cart + cảnh báo.

**BR-CART-VOUCHER-005:** Voucher trong cart **không đảm bảo** sẽ dùng được khi checkout (có thể hết lượt, hết hạn, người khác dùng mất). Kiểm tra final tại order-service.

### 10.4 API Endpoints Voucher

**`POST /api/cart/voucher`** _(User — requires JWT)_

```json
// Request
{ "code": "SUMMER20" }

// Response 200
{
  "success": true,
  "data": {
    "appliedVoucher": {
      "code": "SUMMER20",
      "discountType": "PERCENT_DISCOUNT",
      "discountValue": 20,
      "discountAmount": 13596000
    },
    "totalAmount": 67980000,
    "discountAmount": 13596000,
    "finalAmount": 54384000
  }
}
```

**`DELETE /api/cart/voucher`** _(User — requires JWT)_

```json
// Response 200
{
  "success": true,
  "message": "Đã xóa voucher khỏi giỏ hàng",
  "data": {
    "totalAmount": 67980000,
    "discountAmount": 0,
    "finalAmount": 67980000
  }
}
```

**`GET /api/cart`** — Response bổ sung khi có voucher:

```json
{
  "success": true,
  "data": {
    "items": [...],
    "totalItems": 2,
    "totalAmount": 67980000,
    "appliedVoucher": {
      "code": "SUMMER20",
      "discountType": "PERCENT_DISCOUNT",
      "discountValue": 20,
      "discountAmount": 13596000
    },
    "discountAmount": 13596000,
    "finalAmount": 54384000,
    "expiresAt": "2026-04-29T09:00:00Z"
  }
}
```

### 10.5 Error Catalog bổ sung Voucher

| HTTP | Error Code               | Message (vi)                                             | Điều kiện                      |
| ---- | ------------------------ | -------------------------------------------------------- | ------------------------------ |
| 400  | `VOUCHER_NOT_FOUND`      | "Mã voucher không tồn tại"                               | Code không có trong hệ thống   |
| 400  | `VOUCHER_EXPIRED`        | "Mã voucher đã hết hạn"                                  | Voucher quá end_date           |
| 400  | `VOUCHER_NOT_YET_ACTIVE` | "Mã voucher chưa có hiệu lực"                            | Trước start_date               |
| 400  | `VOUCHER_DEPLETED`       | "Mã voucher đã hết lượt sử dụng"                         | usage_count >= max_usage       |
| 400  | `VOUCHER_ALREADY_USED`   | "Bạn đã sử dụng mã voucher này rồi"                      | User đã dùng hết quota         |
| 422  | `CART_BELOW_MINIMUM`     | "Đơn hàng chưa đạt giá trị tối thiểu để áp dụng voucher" | totalAmount < min_order_amount |
| 422  | `NO_VOUCHER_APPLIED`     | "Giỏ hàng chưa có voucher nào được áp dụng"              | DELETE khi không có voucher    |
