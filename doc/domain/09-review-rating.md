# ⭐ Domain: Review & Rating

> **Service:** `product-service` — Port `3002` (reviews là module trong product-service)
> **Database:** AWS RDS PostgreSQL — schema `product`
> **Kafka Topics produced:** `review.submitted` · `review.approved`
> **Kafka Topics consumed:** — (check order status qua internal API call to order-service)
> **Cập nhật:** 22/04/2026

---

## Mục Lục

1. [Tổng Quan Domain](#1-tổng-quan-domain)
2. [Entities & Data Model](#2-entities--data-model)
3. [Business Rules](#3-business-rules)
4. [API Contract](#4-api-contract)
5. [State Machine — Review](#5-state-machine--review)
6. [Aggregate Rating Logic](#6-aggregate-rating-logic)
7. [Luồng Nghiệp Vụ](#7-luồng-nghiệp-vụ)
8. [Validation Rules](#8-validation-rules)
9. [Error Catalog](#9-error-catalog)

---

## 1. Tổng Quan Domain

| Trách nhiệm     | Mô tả                                                         |
| --------------- | ------------------------------------------------------------- |
| Cho phép review | Chỉ người mua hàng xác nhận (order DELIVERED) mới được review |
| Kiểm duyệt      | Admin approve/reject trước khi hiển thị công khai             |
| Rating tổng hợp | Tính `avg_rating` + `review_count` lưu trên bảng `products`   |
| Ảnh review      | Upload ảnh đính kèm review (Cloudinary, tối đa 5 ảnh)         |

**Ngoài phạm vi MVP:**

- Review phản hồi (replies to review)
- Helpful/Unhelpful voting
- Verified purchase badge API riêng
- Review report/spam detection
- Review import/export

---

## 2. Entities & Data Model

### 2.1 Entity: `reviews`

| Column            | Type           | Constraint                        | Mô tả                             |
| ----------------- | -------------- | --------------------------------- | --------------------------------- |
| `id`              | `UUID`         | PK                                |                                   |
| `product_id`      | `UUID`         | FK → products.id NOT NULL         |                                   |
| `variant_id`      | `UUID`         | FK → product_variants.id NULLABLE | Variant đã mua                    |
| `user_id`         | `UUID`         | NOT NULL                          |                                   |
| `order_id`        | `UUID`         | NOT NULL                          | Order chứa sản phẩm này           |
| `order_item_id`   | `UUID`         | NOT NULL                          | Cụ thể order item                 |
| `rating`          | `SMALLINT`     | NOT NULL CHECK(1-5)               | Điểm đánh giá                     |
| `title`           | `VARCHAR(200)` | NULLABLE                          | Tiêu đề                           |
| `body`            | `TEXT`         | NULLABLE                          | Nội dung (tối đa 2000 ký tự)      |
| `status`          | `ENUM`         | NOT NULL DEFAULT 'PENDING'        | `PENDING`, `APPROVED`, `REJECTED` |
| `rejected_reason` | `TEXT`         | NULLABLE                          | Lý do từ chối (admin điền)        |
| `approved_at`     | `TIMESTAMPTZ`  | NULLABLE                          |                                   |
| `rejected_at`     | `TIMESTAMPTZ`  | NULLABLE                          |                                   |
| `approved_by`     | `UUID`         | NULLABLE                          | Admin userId                      |
| `created_at`      | `TIMESTAMPTZ`  | NOT NULL DEFAULT NOW()            |                                   |
| `updated_at`      | `TIMESTAMPTZ`  | NOT NULL DEFAULT NOW()            |                                   |

**ENUM `review_status`:**

```sql
CREATE TYPE review_status AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
```

**Constraints:**

```sql
-- Mỗi user chỉ review 1 lần trên mỗi sản phẩm:
CREATE UNIQUE INDEX idx_reviews_user_product
  ON reviews(user_id, product_id)
  WHERE status != 'REJECTED';  -- Nếu bị reject có thể review lại (optional)

-- Đảm bảo 1 order_item chỉ được review 1 lần:
CREATE UNIQUE INDEX idx_reviews_order_item
  ON reviews(order_item_id);

CREATE INDEX idx_reviews_product_id   ON reviews(product_id);
CREATE INDEX idx_reviews_user_id      ON reviews(user_id);
CREATE INDEX idx_reviews_status       ON reviews(status);
CREATE INDEX idx_reviews_product_approved ON reviews(product_id, status) WHERE status = 'APPROVED';
```

---

### 2.2 Entity: `review_images`

| Column                 | Type           | Constraint                        | Mô tả                    |
| ---------------------- | -------------- | --------------------------------- | ------------------------ |
| `id`                   | `UUID`         | PK                                |                          |
| `review_id`            | `UUID`         | FK → reviews.id ON DELETE CASCADE |                          |
| `url`                  | `VARCHAR(500)` | NOT NULL                          | Cloudinary URL           |
| `cloudinary_public_id` | `VARCHAR(200)` | NOT NULL                          | Để xóa khi review bị xóa |
| `sort_order`           | `SMALLINT`     | NOT NULL DEFAULT 0                |                          |
| `created_at`           | `TIMESTAMPTZ`  | NOT NULL DEFAULT NOW()            |                          |

```sql
CREATE INDEX idx_review_images_review ON review_images(review_id);
```

---

### 2.3 Denormalized Fields trên `products`

> Để truy vấn nhanh mà không cần JOIN với reviews mỗi lần

| Column         | Type           | Mô tả                                     |
| -------------- | -------------- | ----------------------------------------- |
| `avg_rating`   | `NUMERIC(3,2)` | Trung bình rating tất cả APPROVED reviews |
| `review_count` | `INTEGER`      | Số review đã APPROVED                     |

Cập nhật sau mỗi review được APPROVE hoặc REJECT (dùng DB trigger hoặc service logic).

---

## 3. Business Rules

### BR-REV-001: Điều kiện được review

- User phải đăng nhập (JWT required)
- `order_item_id` phải tồn tại trong order của user
- Order phải ở trạng thái **DELIVERED**
- Thời hạn viết review: **30 ngày** kể từ `order.delivered_at`
- Nếu quá 30 ngày → 403 "Thời hạn viết đánh giá đã hết"

### BR-REV-002: Giới hạn 1 review / sản phẩm / user

- Mỗi user chỉ được review **1 lần** trên cùng 1 sản phẩm
- Nếu review bị REJECTED: user có thể submit lại (cũ bị xóa, tạo mới)
- Nếu review đang PENDING hoặc APPROVED: không cho phép submit thêm

### BR-REV-003: Moderation

- Review mới tạo: `status = PENDING`
- Admin phải APPROVE trước khi review hiển thị công khai
- Khi APPROVE: `approved_at = NOW()`, `approved_by = adminId`, cập nhật `products.avg_rating + review_count`
- Khi REJECT: `rejected_at = NOW()`, `rejected_reason = "..."` (bắt buộc)
- Publish Kafka `review.approved` khi approve thành công

### BR-REV-004: Cập nhật aggregate rating

Sau mỗi APPROVE/REJECT, chạy:

```sql
UPDATE products
SET
  avg_rating = (
    SELECT AVG(rating) FROM reviews
    WHERE product_id = :productId AND status = 'APPROVED'
  ),
  review_count = (
    SELECT COUNT(*) FROM reviews
    WHERE product_id = :productId AND status = 'APPROVED'
  )
WHERE id = :productId;
```

### BR-REV-005: Ảnh review

- Tối đa **5 ảnh** mỗi review
- Upload qua `POST /api/uploads/review` → Cloudinary → nhận URL
- Khi xóa review → xóa ảnh trên Cloudinary (Cloudinary webhook hoặc direct API call)

### BR-REV-006: User sửa review

- User có thể sửa review của mình khi `status = PENDING` hoặc `APPROVED`
- Khi sửa review APPROVED → chuyển về `PENDING` để kiểm duyệt lại
- Nếu sửa → cập nhật lại aggregate rating

---

## 4. API Contract

### `POST /api/products/:id/reviews` _(User)_

**Headers:** `Authorization: Bearer <token>`

**Request:**

```json
{
  "orderItemId": "order-item-uuid",
  "rating": 5,
  "title": "Sản phẩm rất tốt!",
  "body": "Chất lượng vượt mong đợi, giao hàng nhanh. Sẽ ủng hộ lần sau.",
  "imageUrls": ["https://res.cloudinary.com/.../review-img-1.jpg"]
}
```

**Response 201:**

```json
{
  "success": true,
  "data": {
    "id": "review-uuid",
    "productId": "prod-uuid",
    "rating": 5,
    "title": "Sản phẩm rất tốt!",
    "status": "PENDING",
    "message": "Cảm ơn bạn đã đánh giá! Review của bạn đang chờ kiểm duyệt."
  }
}
```

**Errors:**

| HTTP | Error Code              | Message                               |
| ---- | ----------------------- | ------------------------------------- |
| 403  | `NOT_PURCHASED`         | "Bạn chưa mua sản phẩm này"           |
| 403  | `ORDER_NOT_DELIVERED`   | "Đơn hàng chưa được giao thành công"  |
| 403  | `REVIEW_WINDOW_EXPIRED` | "Thời hạn 30 ngày để đánh giá đã qua" |
| 409  | `REVIEW_ALREADY_EXISTS` | "Bạn đã đánh giá sản phẩm này rồi"    |

---

### `GET /api/products/:id/reviews` _(Public)_

**Query Params:** `?page=1&limit=10&rating=5&sortBy=newest`

**Response 200:**

```json
{
  "success": true,
  "data": {
    "productId": "prod-uuid",
    "avgRating": 4.6,
    "reviewCount": 128,
    "ratingDistribution": {
      "5": 80,
      "4": 25,
      "3": 15,
      "2": 5,
      "1": 3
    },
    "reviews": [
      {
        "id": "review-uuid",
        "user": {
          "id": "user-uuid",
          "name": "Nguyễn V***",
          "avatarUrl": null
        },
        "rating": 5,
        "title": "Sản phẩm rất tốt!",
        "body": "Chất lượng vượt mong đợi...",
        "images": ["https://res.cloudinary.com/..."],
        "variantInfo": "Màu đỏ - Size M",
        "createdAt": "2026-04-20T10:00:00.000Z",
        "approvedAt": "2026-04-21T09:00:00.000Z"
      }
    ],
    "pagination": { "page": 1, "limit": 10, "total": 128, "totalPages": 13 }
  }
}
```

> Chỉ trả về review có `status = 'APPROVED'`
> Tên user hiển thị che bớt: `Nguyễn V***`

---

### `PATCH /api/reviews/:id` _(User)_

**Headers:** `Authorization: Bearer <token>`

**Request:**

```json
{
  "rating": 4,
  "title": "Vẫn tốt nhưng giao hơi chậm",
  "body": "Sản phẩm đúng mô tả nhưng giao hàng mất 4 ngày...",
  "imageUrls": ["https://res.cloudinary.com/..."]
}
```

**Response 200:** review đã cập nhật với `status: "PENDING"` (nếu đang APPROVED)

**Errors:** `403` không phải review của mình | `404` không tìm thấy

---

### `DELETE /api/reviews/:id` _(User)_

**Response 200:** `{ "success": true, "message": "Đã xóa đánh giá" }`

**Lưu ý:** Xóa review → cập nhật lại `products.avg_rating` + `review_count`

---

### `GET /api/admin/reviews` _(ADMIN)_

**Query:** `?status=PENDING&productId=uuid&page=1&limit=20&sortBy=createdAt`

**Response 200:**

```json
{
  "success": true,
  "data": {
    "reviews": [
      {
        "id": "review-uuid",
        "product": { "id": "prod-uuid", "name": "iPhone 15 Pro" },
        "user": {
          "id": "user-uuid",
          "name": "Nguyễn Văn A",
          "email": "a@gmail.com"
        },
        "rating": 2,
        "body": "Sản phẩm bị lỗi...",
        "images": [],
        "status": "PENDING",
        "createdAt": "2026-04-22T08:00:00.000Z"
      }
    ],
    "pagination": { "total": 45, "page": 1, "limit": 20 }
  }
}
```

---

### `PATCH /api/admin/reviews/:id/approve` _(ADMIN)_

**Response 200:**

```json
{
  "success": true,
  "message": "Review đã được phê duyệt",
  "data": { "reviewId": "uuid", "status": "APPROVED" }
}
```

---

### `PATCH /api/admin/reviews/:id/reject` _(ADMIN)_

**Request:** `{ "reason": "Nội dung không phù hợp" }`

**Response 200:**

```json
{
  "success": true,
  "message": "Review đã bị từ chối",
  "data": {
    "reviewId": "uuid",
    "status": "REJECTED",
    "reason": "Nội dung không phù hợp"
  }
}
```

---

## 5. State Machine — Review

```
[User: POST /products/:id/reviews]
              │
              ▼
         ┌─────────┐
         │ PENDING │  ← Ẩn với public, chờ kiểm duyệt
         └─────────┘
           /      \
   [Admin APPROVE] [Admin REJECT]
         │               │
         ▼               ▼
    ┌──────────┐    ┌──────────┐
    │ APPROVED │    │ REJECTED │
    └──────────┘    └──────────┘
    (hiển thị)     (ẩn, user có thể submit lại)

APPROVED → PENDING:
  [User sửa review (PATCH /reviews/:id)]

PENDING / APPROVED → (deleted):
  [User xóa (DELETE /reviews/:id)]
  → cập nhật aggregate rating
```

---

## 6. Aggregate Rating Logic

```
Khi nào cập nhật products.avg_rating và review_count?

Event                         Action
────────────────────────────────────────────────────────
Admin APPROVE review          avg_rating tăng, review_count++
Admin REJECT review (từ APPROVED) avg_rating giảm, review_count--
User DELETE review (APPROVED) avg_rating giảm, review_count--
User EDIT review (APPROVED → PENDING) avg_rating giảm, review_count--

Công thức:
  new_avg = SUM(rating từ tất cả APPROVED reviews của product) / COUNT(APPROVED reviews)
  Hoặc đơn giản hơn:
  new_avg = ((old_avg * old_count) + new_rating) / (old_count + 1)

Xử lý edge case:
  Nếu review_count = 0: avg_rating = NULL (hiển thị "Chưa có đánh giá")
  Lưu với NUMERIC(3,2): vd 4.75

Tránh race condition:
  Dùng DB-level UPDATE thay vì tính toán ở application layer:
  UPDATE products SET
    avg_rating = (SELECT AVG(rating) FROM reviews WHERE product_id = :id AND status = 'APPROVED'),
    review_count = (SELECT COUNT(*) FROM reviews WHERE product_id = :id AND status = 'APPROVED')
  WHERE id = :id;
```

---

## 7. Luồng Nghiệp Vụ

### 7.1 Submit Review

```
User              Product Service         Order Service         DB
  │                    │                       │                │
  ├─ POST /products/:id/reviews ──▶│            │                │
  │  { orderItemId, rating, ... }  │            │                │
  │                    │           │            │                │
  │                    ├─ GET /internal/orders/items/:orderItemId
  │                    │──────────────────────▶│                │
  │                    │◀─ { orderId, userId, status: "DELIVERED", deliveredAt }
  │                    │           │            │                │
  │                    ├─ validate: user match, status DELIVERED, within 30 days
  │                    ├─ INSERT review (PENDING)               │
  │                    ├─ Kafka: review.submitted               │
  │◀─ 201 { reviewId } ─│                       │                │
```

### 7.2 Admin Moderation

```
Admin           Product Service        DB               Kafka
  │                  │                  │                 │
  ├─ PATCH /admin/reviews/:id/approve ──▶│                 │
  │                  ├─ UPDATE status=APPROVED            │
  │                  ├─ UPDATE products avg_rating        │
  │                  ├─ Kafka: review.approved ───────────▶│
  │◀─ 200 ───────────│                  │                 │
```

---

## 8. Validation Rules

| Field                    | Rule                                                  |
| ------------------------ | ----------------------------------------------------- |
| `rating`                 | Integer, 1 đến 5, required                            |
| `title`                  | Optional, max 200 ký tự                               |
| `body`                   | Optional, max 2000 ký tự                              |
| `imageUrls`              | Optional, tối đa 5 URLs, phải là valid Cloudinary URL |
| `orderItemId`            | UUID, required, phải thuộc order của user đang gọi    |
| `rejectedReason` (admin) | Required khi REJECT, max 500 ký tự                    |

---

## 9. Error Catalog

| HTTP | Error Code               | Message (vi)                                | Điều kiện                       |
| ---- | ------------------------ | ------------------------------------------- | ------------------------------- |
| 400  | `INVALID_RATING`         | "Điểm đánh giá phải từ 1 đến 5"             | rating ngoài khoảng             |
| 400  | `INVALID_IMAGE_URL`      | "URL ảnh không hợp lệ"                      | Không phải Cloudinary URL       |
| 400  | `TOO_MANY_IMAGES`        | "Tối đa 5 ảnh cho mỗi đánh giá"             | imageUrls.length > 5            |
| 403  | `NOT_PURCHASED`          | "Bạn phải mua sản phẩm trước khi đánh giá"  | orderItemId không thuộc về user |
| 403  | `ORDER_NOT_DELIVERED`    | "Chỉ đánh giá được sau khi nhận hàng"       | order.status != DELIVERED       |
| 403  | `REVIEW_WINDOW_EXPIRED`  | "Thời hạn đánh giá 30 ngày đã qua"          | > 30 ngày từ deliveredAt        |
| 403  | `NOT_YOUR_REVIEW`        | "Bạn không có quyền chỉnh sửa đánh giá này" | userId không khớp               |
| 404  | `REVIEW_NOT_FOUND`       | "Không tìm thấy đánh giá"                   | reviewId sai                    |
| 409  | `REVIEW_ALREADY_EXISTS`  | "Bạn đã đánh giá sản phẩm này rồi"          | Unique constraint vi phạm       |
| 422  | `REJECT_REASON_REQUIRED` | "Vui lòng nhập lý do từ chối"               | Admin reject không có reason    |
