# ❤️ Domain: Wishlist

> **Service:** `product-service` — Port `3002` (module `wishlist` trong product-service)
> **Database:** MongoDB Atlas M0 — collection `wishlists`
> **Cập nhật:** 22/04/2026

---

## Mục Lục

1. [Tổng Quan Domain](#1-tổng-quan-domain)
2. [Data Model (MongoDB)](#2-data-model-mongodb)
3. [Business Rules](#3-business-rules)
4. [API Contract](#4-api-contract)
5. [Luồng Nghiệp Vụ](#5-luồng-nghiệp-vụ)
6. [Validation Rules](#6-validation-rules)
7. [Error Catalog](#7-error-catalog)

---

## 1. Tổng Quan Domain

| Trách nhiệm                  | Mô tả                                                             |
| ---------------------------- | ----------------------------------------------------------------- |
| Lưu sản phẩm yêu thích       | User bookmark sản phẩm để mua sau                                 |
| Kiểm tra trạng thái sản phẩm | Hiển thị cảnh báo nếu sản phẩm hết hàng / không còn bán           |
| Chuyển sang giỏ              | "Move to cart" — thêm item vào cart-service rồi xóa khỏi wishlist |
| Không cần đồng bộ giá        | Price snapshot KHÔNG bắt buộc (wishlist chỉ là bookmark)          |

**Ngoài phạm vi MVP:**

- Chia sẻ wishlist công khai
- Wishlist nhiều list (chỉ 1 list per user)
- Notify khi giá giảm
- Guest wishlist (chỉ dành cho user đã đăng nhập)

---

## 2. Data Model (MongoDB)

### Collection: `wishlists`

```json
{
  "_id": "ObjectId",
  "userId": "user-uuid",
  "items": [
    {
      "productId": "product-uuid",
      "productName": "iPhone 15 Pro 128GB",
      "slug": "iphone-15-pro-128gb",
      "thumbnailUrl": "https://res.cloudinary.com/.../thumb.jpg",
      "price": 25000000,
      "discountPercent": 0,
      "categoryId": "cat-uuid",
      "categoryName": "Điện thoại",
      "addedAt": "2026-04-22T10:00:00.000Z",
      "status": "ACTIVE"
    }
  ],
  "itemCount": 1,
  "updatedAt": "2026-04-22T10:00:00.000Z",
  "createdAt": "2026-04-22T10:00:00.000Z"
}
```

**Indexes:**

```javascript
// Unique per user
db.wishlists.createIndex({ userId: 1 }, { unique: true });
// Fast lookup by userId + productId (check if already in wishlist)
db.wishlists.createIndex({ userId: 1, "items.productId": 1 });
```

**Lưu ý về `price` và `status`:**

- `price`: Snapshot tại thời điểm add, mang tính tham khảo — KHÔNG dùng để tính tiền
- `status`: Được refresh từ product-service mỗi khi GET /api/wishlist
  - `ACTIVE`: Sản phẩm vẫn đang bán
  - `OUT_OF_STOCK`: Hết hàng (tất cả variants)
  - `INACTIVE`: Sản phẩm bị ẩn / ngừng bán
  - `DELETED`: Sản phẩm bị xóa

---

## 3. Business Rules

### BR-WISH-001: Authentication Required

- Wishlist chỉ dành cho user đã đăng nhập (JWT required)
- Không hỗ trợ guest wishlist

### BR-WISH-002: Giới hạn số lượng

- Tối đa **100 items** trong 1 wishlist
- Thêm quá giới hạn → 400 "Danh sách yêu thích đã đầy (tối đa 100 sản phẩm)"

### BR-WISH-003: Không thêm trùng

- Nếu `productId` đã tồn tại trong wishlist → trả 200 (idempotent, không báo lỗi)
- Không thêm trùng variant khác của cùng 1 sản phẩm (wishlist track productId, không phải variantId)

### BR-WISH-004: Kiểm tra sản phẩm khi thêm

- Khi thêm vào wishlist: product phải `status = ACTIVE`
- Snapshot `productName`, `thumbnailUrl`, `price` từ product-service tại thời điểm add
- Sản phẩm INACTIVE/DELETED: không cho phép thêm mới, nhưng item đã có vẫn hiển thị với warning

### BR-WISH-005: Refresh status khi GET

- Khi user GET /api/wishlist: hệ thống refresh `items[].status` bằng cách query product-service
- Nếu product bị DELETED: `items[].status = 'DELETED'`, icon "Không còn bán"
- Price và tên KHÔNG tự động update (chỉ snapshot tại thời điểm add)

### BR-WISH-006: Move to Cart

- `POST /api/wishlist/items/:productId/move-to-cart`
- Kiểm tra product hiện tại ACTIVE
- Gọi cart-service: thêm product vào cart với quantity=1
- Nếu cart thêm thành công: xóa item khỏi wishlist
- Nếu cart thêm thất bại: KHÔNG xóa khỏi wishlist

---

## 4. API Contract

### `GET /api/wishlist` _(User)_

**Headers:** `Authorization: Bearer <token>`

**Mô tả:** Lấy toàn bộ wishlist, refresh status sản phẩm

**Response 200:**

```json
{
  "success": true,
  "data": {
    "userId": "user-uuid",
    "itemCount": 3,
    "items": [
      {
        "productId": "prod-uuid-1",
        "productName": "iPhone 15 Pro 128GB",
        "slug": "iphone-15-pro-128gb",
        "thumbnailUrl": "https://res.cloudinary.com/.../thumb.jpg",
        "price": 25000000,
        "discountPercent": 10,
        "currentPrice": 22500000,
        "categoryName": "Điện thoại",
        "status": "ACTIVE",
        "inStock": true,
        "addedAt": "2026-04-22T10:00:00.000Z"
      },
      {
        "productId": "prod-uuid-2",
        "productName": "Samsung Galaxy S24",
        "slug": "samsung-galaxy-s24",
        "thumbnailUrl": "https://res.cloudinary.com/.../thumb.jpg",
        "price": 20000000,
        "discountPercent": 0,
        "currentPrice": 20000000,
        "categoryName": "Điện thoại",
        "status": "OUT_OF_STOCK",
        "inStock": false,
        "stockWarning": "Sản phẩm hiện đang hết hàng",
        "addedAt": "2026-04-20T08:00:00.000Z"
      },
      {
        "productId": "prod-uuid-3",
        "productName": "Xiaomi 14",
        "status": "DELETED",
        "inStock": false,
        "stockWarning": "Sản phẩm này không còn được bán",
        "addedAt": "2026-04-18T12:00:00.000Z"
      }
    ],
    "updatedAt": "2026-04-22T10:00:00.000Z"
  }
}
```

---

### `POST /api/wishlist/items` _(User)_

**Headers:** `Authorization: Bearer <token>`

**Request:**

```json
{
  "productId": "prod-uuid"
}
```

**Response 200** (đã tồn tại — idempotent):

```json
{
  "success": true,
  "message": "Sản phẩm đã có trong danh sách yêu thích",
  "alreadyExists": true
}
```

**Response 201** (thêm mới thành công):

```json
{
  "success": true,
  "data": {
    "productId": "prod-uuid",
    "productName": "iPhone 15 Pro 128GB",
    "addedAt": "2026-04-22T10:00:00.000Z"
  },
  "message": "Đã thêm vào danh sách yêu thích",
  "itemCount": 4
}
```

**Errors:**

| HTTP | Error Code           | Message                                            |
| ---- | -------------------- | -------------------------------------------------- |
| 400  | `PRODUCT_NOT_ACTIVE` | "Sản phẩm không còn được bán"                      |
| 400  | `WISHLIST_FULL`      | "Danh sách yêu thích đã đầy (tối đa 100 sản phẩm)" |
| 404  | `PRODUCT_NOT_FOUND`  | "Không tìm thấy sản phẩm"                          |

---

### `DELETE /api/wishlist/items/:productId` _(User)_

**Response 200:**

```json
{
  "success": true,
  "message": "Đã xóa khỏi danh sách yêu thích",
  "itemCount": 2
}
```

**Response 200** (không tìm thấy — idempotent):

```json
{
  "success": true,
  "message": "Sản phẩm không có trong danh sách yêu thích"
}
```

---

### `POST /api/wishlist/items/:productId/move-to-cart` _(User)_

**Request:** _(optional)_

```json
{
  "variantId": "variant-uuid",
  "quantity": 1
}
```

**Response 200:**

```json
{
  "success": true,
  "message": "Đã thêm vào giỏ hàng và xóa khỏi danh sách yêu thích",
  "cartItemAdded": true,
  "removedFromWishlist": true
}
```

**Errors:**

| HTTP | Error Code           | Message                                               |
| ---- | -------------------- | ----------------------------------------------------- |
| 400  | `PRODUCT_NOT_ACTIVE` | "Sản phẩm không còn được bán, không thể thêm vào giỏ" |
| 400  | `OUT_OF_STOCK`       | "Sản phẩm hiện đang hết hàng"                         |
| 404  | `NOT_IN_WISHLIST`    | "Sản phẩm không có trong danh sách yêu thích"         |

---

### `DELETE /api/wishlist` _(User)_

**Mô tả:** Xóa toàn bộ wishlist

**Response 200:**

```json
{
  "success": true,
  "message": "Đã xóa toàn bộ danh sách yêu thích"
}
```

---

## 5. Luồng Nghiệp Vụ

### 5.1 Thêm vào Wishlist

```
User        Product Service (wishlist module)     Product Service (catalog)
  │                    │                                  │
  ├─ POST /wishlist/items ──────────────────────────────▶─│
  │  { productId }     │                                  │
  │                    ├─ GET product detail ─────────────▶│
  │                    │◀─ { status, name, price, thumb } ─│
  │                    │                                  │
  │                    ├─ check: status ACTIVE?           │
  │                    ├─ check: already in wishlist?     │
  │                    ├─ check: itemCount < 100?         │
  │                    │                                  │
  │                    ├─ $push to wishlists.items        │
  │◀─ 201 ─────────────│                                  │
```

### 5.2 Move to Cart

```
User       Product Service (wishlist)    Cart Service
  │                  │                       │
  ├─ POST /wishlist/items/:id/move-to-cart ──▶│
  │                  │                       │
  │                  ├─ verify product ACTIVE │
  │                  ├─ POST /internal/cart/items ────────▶│
  │                  │   { productId, variantId, qty: 1 } │
  │                  │◀─ { success: true } ──────────────── │
  │                  │                       │
  │                  ├─ $pull wishlists.items where productId
  │◀─ 200 ──────────│                       │
```

---

## 6. Validation Rules

| Field                      | Rule                     |
| -------------------------- | ------------------------ |
| `productId`                | UUID, required           |
| `variantId` (move-to-cart) | UUID, optional           |
| `quantity` (move-to-cart)  | Integer ≥ 1, default = 1 |
| Max items                  | ≤ 100 items per wishlist |

---

## 7. Error Catalog

| HTTP | Error Code                 | Message (vi)                                          | Điều kiện                   |
| ---- | -------------------------- | ----------------------------------------------------- | --------------------------- |
| 400  | `PRODUCT_NOT_ACTIVE`       | "Sản phẩm không còn được bán"                         | status != ACTIVE            |
| 400  | `WISHLIST_FULL`            | "Danh sách yêu thích đã đầy (tối đa 100 sản phẩm)"    | itemCount >= 100            |
| 400  | `OUT_OF_STOCK`             | "Sản phẩm đang hết hàng, không thể thêm vào giỏ"      | move-to-cart, hết hàng      |
| 404  | `PRODUCT_NOT_FOUND`        | "Không tìm thấy sản phẩm"                             | productId không tồn tại     |
| 404  | `NOT_IN_WISHLIST`          | "Sản phẩm không có trong danh sách yêu thích của bạn" | move-to-cart / delete       |
| 502  | `CART_SERVICE_UNAVAILABLE` | "Không thể thêm vào giỏ lúc này, vui lòng thử lại"    | cart-service không phản hồi |
