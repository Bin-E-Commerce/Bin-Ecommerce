# 📦 Domain: Product & Category Catalog

> **Service:** `product-service` — Port `3002`
> **Database:** AWS RDS PostgreSQL — schema `catalog`
> **Image Storage:** Cloudinary (Free Tier)
> **Cập nhật:** 22/04/2026

---

## Mục Lục

1. [Tổng Quan Domain](#1-tổng-quan-domain)
2. [Entities & Data Model](#2-entities--data-model)
3. [Business Rules](#3-business-rules)
4. [API Contract](#4-api-contract)
5. [State Machine — Product](#5-state-machine--product)
6. [Luồng Nghiệp Vụ](#6-luồng-nghiệp-vụ)
7. [Validation Rules](#7-validation-rules)
8. [Error Catalog](#8-error-catalog)

---

## 1. Tổng Quan Domain

| Trách nhiệm        | Mô tả                                                                 |
| ------------------ | --------------------------------------------------------------------- |
| Quản lý danh mục   | CRUD category (phân cấp 1 cấp)                                        |
| Quản lý sản phẩm   | CRUD product với gắn danh mục                                         |
| Tìm kiếm & lọc     | Full-text search, filter theo category/price/status, sort, pagination |
| Quản lý hình ảnh   | Upload ảnh lên Cloudinary, lưu URL tham chiếu                         |
| Hiển thị công khai | Khách không cần đăng nhập vẫn xem được product listing                |

**Ngoài phạm vi:**

- Tồn kho (Inventory Service quản lý `stock`)
- Giá sale / voucher / discount (tính năng future)
- Product review / rating (tính năng future)

---

## 2. Entities & Data Model

### 2.1 Entity: `categories`

| Column        | Type           | Constraint             | Mô tả                 |
| ------------- | -------------- | ---------------------- | --------------------- |
| `id`          | `UUID`         | PK                     |                       |
| `name`        | `VARCHAR(100)` | UNIQUE NOT NULL        | Tên danh mục          |
| `slug`        | `VARCHAR(120)` | UNIQUE NOT NULL        | URL-friendly name     |
| `description` | `TEXT`         | NULLABLE               | Mô tả danh mục        |
| `image_url`   | `TEXT`         | NULLABLE               | Ảnh đại diện danh mục |
| `sort_order`  | `SMALLINT`     | NOT NULL DEFAULT 0     | Thứ tự hiển thị       |
| `is_active`   | `BOOLEAN`      | NOT NULL DEFAULT true  | Đang hiển thị hay ẩn  |
| `created_at`  | `TIMESTAMPTZ`  | NOT NULL DEFAULT NOW() |                       |
| `updated_at`  | `TIMESTAMPTZ`  | NOT NULL DEFAULT NOW() |                       |

```sql
CREATE UNIQUE INDEX idx_categories_slug ON categories(slug);
CREATE        INDEX idx_categories_sort ON categories(sort_order) WHERE is_active = true;
```

---

### 2.2 Entity: `products`

| Column              | Type                                          | Constraint                  | Mô tả                      |
| ------------------- | --------------------------------------------- | --------------------------- | -------------------------- |
| `id`                | `UUID`                                        | PK                          |                            |
| `category_id`       | `UUID`                                        | FK → categories.id NULLABLE | Danh mục                   |
| `name`              | `VARCHAR(255)`                                | NOT NULL                    | Tên sản phẩm               |
| `slug`              | `VARCHAR(300)`                                | UNIQUE NOT NULL             | URL-friendly               |
| `description`       | `TEXT`                                        | NULLABLE                    | Mô tả chi tiết             |
| `short_description` | `VARCHAR(500)`                                | NULLABLE                    | Mô tả ngắn (hiển thị card) |
| `price`             | `NUMERIC(12,2)`                               | NOT NULL CHECK (price > 0)  | Giá bán (VNĐ)              |
| `sku`               | `VARCHAR(100)`                                | UNIQUE NULLABLE             | Stock Keeping Unit         |
| `status`            | `ENUM('DRAFT','ACTIVE','INACTIVE','DELETED')` | NOT NULL DEFAULT 'DRAFT'    | Trạng thái                 |
| `thumbnail_url`     | `TEXT`                                        | NULLABLE                    | Ảnh thumbnail chính        |
| `created_by`        | `UUID`                                        | FK → users.id               | Admin tạo                  |
| `created_at`        | `TIMESTAMPTZ`                                 | NOT NULL DEFAULT NOW()      |                            |
| `updated_at`        | `TIMESTAMPTZ`                                 | NOT NULL DEFAULT NOW()      |                            |
| `deleted_at`        | `TIMESTAMPTZ`                                 | NULLABLE                    | Soft delete timestamp      |

```sql
CREATE UNIQUE INDEX idx_products_slug         ON products(slug);
CREATE UNIQUE INDEX idx_products_sku          ON products(sku) WHERE sku IS NOT NULL;
CREATE        INDEX idx_products_category     ON products(category_id) WHERE deleted_at IS NULL;
CREATE        INDEX idx_products_status       ON products(status) WHERE deleted_at IS NULL;
CREATE        INDEX idx_products_price        ON products(price) WHERE deleted_at IS NULL;

-- Full-text search index (PostgreSQL tsvector)
ALTER TABLE products ADD COLUMN search_vector TSVECTOR;
CREATE INDEX idx_products_fts ON products USING GIN(search_vector);
-- Trigger tự cập nhật search_vector khi name/description thay đổi
```

---

### 2.3 Entity: `product_images`

| Column                 | Type           | Constraint                         | Mô tả                           |
| ---------------------- | -------------- | ---------------------------------- | ------------------------------- |
| `id`                   | `UUID`         | PK                                 |                                 |
| `product_id`           | `UUID`         | FK → products.id ON DELETE CASCADE |                                 |
| `url`                  | `TEXT`         | NOT NULL                           | Cloudinary URL                  |
| `cloudinary_public_id` | `VARCHAR(255)` | NOT NULL                           | Dùng để xóa ảnh trên Cloudinary |
| `alt_text`             | `VARCHAR(255)` | NULLABLE                           | Alt text cho SEO/accessibility  |
| `sort_order`           | `SMALLINT`     | NOT NULL DEFAULT 0                 | Thứ tự ảnh                      |
| `is_primary`           | `BOOLEAN`      | NOT NULL DEFAULT false             | Ảnh chính                       |
| `created_at`           | `TIMESTAMPTZ`  | NOT NULL DEFAULT NOW()             |                                 |

```sql
-- Chỉ 1 ảnh chính per product
CREATE UNIQUE INDEX idx_product_primary_image
  ON product_images(product_id)
  WHERE is_primary = true;
```

**Giới hạn:** Tối đa **10 ảnh** / sản phẩm.

---

## 3. Business Rules

### BR-PROD-001: Tạo sản phẩm

- Chỉ user có role `ADMIN` mới được tạo/sửa/xóa sản phẩm
- Sản phẩm mới tạo có status `DRAFT` — chưa hiển thị cho người dùng
- Slug tự động generate từ `name` (lowercase, replace spaces với `-`, remove ký tự đặc biệt)
- Nếu slug đã tồn tại: thêm suffix `-2`, `-3`, ... tự động
- `price` phải là số dương, không được = 0

### BR-PROD-002: Publish sản phẩm

- Chỉ chuyển từ `DRAFT` → `ACTIVE` khi đã có ít nhất **1 ảnh** và `category_id` đã set
- Sản phẩm `ACTIVE` mới hiển thị cho người dùng xem
- Admin có thể switch `ACTIVE` ↔ `INACTIVE` bất kỳ lúc nào

### BR-PROD-003: Xóa sản phẩm

- Xóa là **soft delete**: set `deleted_at = NOW()`, `status = 'DELETED'`
- Không xóa cứng record để giữ tham chiếu từ `order_items` (lịch sử đơn hàng)
- Sản phẩm `DELETED` không hiển thị trong bất kỳ listing nào, kể cả admin (chỉ hiển thị khi filter explicit)
- Không cho phép xóa sản phẩm đang có trong đơn hàng `PENDING`/`CONFIRMED`

### BR-PROD-004: Quản lý danh mục

- Category **không phân cấp** (flat list — 1 cấp) — scope MVP
- Không xóa category đang có product (kể cả product `DELETED`) — 409 Conflict
- Slug category cũng auto-generate + unique

### BR-PROD-005: Ảnh sản phẩm

- Chỉ chấp nhận: `image/jpeg`, `image/png`, `image/webp`
- Kích thước tối đa: **5 MB**
- Ảnh upload lên **Cloudinary** (không lưu trên EC2 filesystem)
- Mỗi product tối đa **10 ảnh**
- Ảnh đầu tiên upload tự động set `is_primary = true`
- Khi xóa ảnh primary: ảnh tiếp theo (sort_order thấp nhất) tự động thành primary
- Khi xóa ảnh: đồng thời gọi Cloudinary API xóa file (dùng `cloudinary_public_id`)

### BR-PROD-006: Tìm kiếm & hiển thị

- `GET /api/products` (public): chỉ trả sản phẩm có `status = 'ACTIVE'` và `deleted_at IS NULL`
- `GET /api/admin/products` (ADMIN): trả tất cả trạng thái trừ `DELETED` (mặc định), có thể filter `status=DELETED`
- Search full-text dùng PostgreSQL `tsvector` tìm trong `name` + `description`
- Kết quả sort mặc định: `createdAt DESC`
- Default pagination: `page=1`, `limit=20`, max `limit=100`

---

## 4. API Contract

### `GET /api/products` _(Public)_

**Query Params:**

```
?page=1
&limit=20
&search=iphone
&categoryId=uuid-cat
&minPrice=100000
&maxPrice=5000000
&sort=price
&order=asc
```

**Response 200:**

```json
{
  "success": true,
  "data": [
    {
      "id": "prod-uuid",
      "name": "iPhone 15 Pro Max 256GB",
      "slug": "iphone-15-pro-max-256gb",
      "shortDescription": "Chip A17 Pro, màn hình 6.7 inch",
      "price": 33990000,
      "thumbnailUrl": "https://res.cloudinary.com/ecommerce/image/upload/iphone15.jpg",
      "category": {
        "id": "cat-uuid",
        "name": "Điện thoại",
        "slug": "dien-thoai"
      },
      "status": "ACTIVE",
      "createdAt": "2026-04-01T00:00:00.000Z"
    }
  ],
  "meta": {
    "total": 45,
    "page": 1,
    "limit": 20,
    "totalPages": 3
  }
}
```

---

### `GET /api/products/:id` _(Public)_

**Response 200:**

```json
{
  "success": true,
  "data": {
    "id": "prod-uuid",
    "name": "iPhone 15 Pro Max 256GB",
    "slug": "iphone-15-pro-max-256gb",
    "description": "Mô tả chi tiết dài...",
    "shortDescription": "Chip A17 Pro, màn hình 6.7 inch",
    "price": 33990000,
    "sku": "IP15PM256",
    "status": "ACTIVE",
    "thumbnailUrl": "https://res.cloudinary.com/...",
    "category": {
      "id": "cat-uuid",
      "name": "Điện thoại",
      "slug": "dien-thoai"
    },
    "images": [
      {
        "id": "img-uuid",
        "url": "https://res.cloudinary.com/...",
        "altText": "iPhone 15 Pro Max màu Natural Titanium",
        "sortOrder": 0,
        "isPrimary": true
      }
    ],
    "createdAt": "2026-04-01T00:00:00.000Z",
    "updatedAt": "2026-04-10T00:00:00.000Z"
  }
}
```

**Errors:** `404` sản phẩm không tồn tại hoặc đã bị xóa

---

### `GET /api/products/slug/:slug` _(Public)_

**Mô tả:** Lấy product theo slug (dùng cho Next.js SSG/ISR)

**Response 200:** cùng structure với `GET /api/products/:id`

---

### `POST /api/admin/products` _(ADMIN only)_

**Headers:** `Authorization: Bearer <accessToken>`

**Request:**

```json
{
  "name": "iPhone 15 Pro Max 256GB",
  "categoryId": "cat-uuid",
  "description": "Mô tả chi tiết...",
  "shortDescription": "Chip A17 Pro",
  "price": 33990000,
  "sku": "IP15PM256"
}
```

**Response 201:**

```json
{
  "success": true,
  "data": {
    "id": "prod-uuid",
    "name": "iPhone 15 Pro Max 256GB",
    "slug": "iphone-15-pro-max-256gb",
    "status": "DRAFT",
    "price": 33990000,
    "createdAt": "2026-04-22T09:00:00.000Z"
  }
}
```

**Errors:** `400` validation | `403` không phải ADMIN | `409` SKU đã tồn tại

---

### `PATCH /api/admin/products/:id` _(ADMIN only)_

**Headers:** `Authorization: Bearer <accessToken>`

**Request (all optional):**

```json
{
  "name": "iPhone 15 Pro Max 512GB",
  "categoryId": "cat-uuid",
  "description": "...",
  "price": 37990000,
  "status": "ACTIVE"
}
```

**Errors:** `400` validation | `403` | `404` | `422` publish nhưng thiếu ảnh/category

---

### `DELETE /api/admin/products/:id` _(ADMIN only)_

**Response 200:**

```json
{ "success": true, "message": "Product deleted" }
```

**Errors:** `404` | `409` đang có đơn hàng PENDING/CONFIRMED

---

### `POST /api/admin/products/:id/images` _(ADMIN only)_

**Headers:** `Authorization: Bearer <accessToken>`, `Content-Type: multipart/form-data`

**Form Fields:**

- `file`: image file (required)
- `altText`: string (optional)

**Response 201:**

```json
{
  "success": true,
  "data": {
    "id": "img-uuid",
    "url": "https://res.cloudinary.com/ecommerce/image/upload/v1234/products/iphone15.jpg",
    "cloudinaryPublicId": "products/iphone15",
    "altText": "iPhone 15 Pro Max",
    "sortOrder": 0,
    "isPrimary": true
  }
}
```

**Errors:** `400` sai file type hoặc > 5MB | `422` đã có 10 ảnh | `404` product không tồn tại

---

### `DELETE /api/admin/products/:id/images/:imageId` _(ADMIN only)_

**Response 200:**

```json
{ "success": true }
```

**Side effect:** Gọi Cloudinary API xóa file tương ứng.

---

### `PATCH /api/admin/products/:id/images/:imageId/primary` _(ADMIN only)_

**Mô tả:** Đặt ảnh này làm primary

**Response 200:**

```json
{ "success": true, "message": "Primary image updated" }
```

---

### `GET /api/categories` _(Public)_

**Response 200:**

```json
{
  "success": true,
  "data": [
    {
      "id": "cat-uuid",
      "name": "Điện thoại",
      "slug": "dien-thoai",
      "imageUrl": "https://res.cloudinary.com/...",
      "sortOrder": 1,
      "productCount": 45
    }
  ]
}
```

---

### `POST /api/admin/categories` _(ADMIN only)_

**Request:**

```json
{
  "name": "Điện thoại",
  "description": "Tất cả các loại điện thoại",
  "sortOrder": 1
}
```

**Response 201:** category object

**Errors:** `409` tên danh mục đã tồn tại

---

### `PATCH /api/admin/categories/:id` _(ADMIN only)_

**Errors:** `404` | `409` tên trùng

---

### `DELETE /api/admin/categories/:id` _(ADMIN only)_

**Errors:** `404` | `409` đang có product thuộc danh mục này

---

## 5. State Machine — Product

```
           [Admin tạo]
                │
                ▼
           ┌─────────┐
           │  DRAFT  │
           └─────────┘
                │
   [Admin publish — có ảnh + category]
                │
                ▼
           ┌─────────┐◀────────────────────────────┐
           │ ACTIVE  │                             │
           └─────────┘                             │
                │                                  │
   [Admin deactivate]              [Admin reactivate]
                │                                  │
                ▼                                  │
          ┌──────────┐                             │
          │ INACTIVE │─────────────────────────────┘
          └──────────┘
                │
          [Admin delete (soft)]
                │
                ▼
           ┌─────────┐
           │ DELETED │  (terminal state — không khôi phục)
           └─────────┘
```

**Visibility matrix:**

| Status   | Public listing | Admin listing    | Checkout |
| -------- | -------------- | ---------------- | -------- |
| DRAFT    | ❌             | ✅               | ❌       |
| ACTIVE   | ✅             | ✅               | ✅       |
| INACTIVE | ❌             | ✅               | ❌       |
| DELETED  | ❌             | ❌ (filter only) | ❌       |

---

## 6. Luồng Nghiệp Vụ

### 6.1 Upload Ảnh lên Cloudinary

```
Admin Client      Product Service         Cloudinary
     │                  │                      │
     ├─ POST /images ──▶│                      │
     │  (multipart)     │                      │
     │                  ├─ validate file ──────│
     │                  ├─ upload to CDN ─────▶│
     │                  │◀── { url, public_id }│
     │                  │                      │
     │                  ├─ INSERT product_images│
     │◀── 201 { image } ─│
```

### 6.2 Next.js SSG Build — Fetch Products

```
Next.js Build         Product Service          RDS
     │                      │                   │
     ├─ GET /products ──────▶│                   │
     │  (no auth — public)  ├─ SELECT ACTIVE ──▶│
     │                      │◀── records ────────│
     │◀── product list ──────│
     │                      │
     │─ statically generate HTML pages ─────────│
```

---

## 7. Validation Rules

### Product Fields

| Field              | Rule                                                                  |
| ------------------ | --------------------------------------------------------------------- |
| `name`             | 3–255 chars, không rỗng, trim whitespace                              |
| `price`            | Số dương, tối đa 12 chữ số, tối đa 2 chữ số thập phân, min 1000 (VNĐ) |
| `sku`              | 2–100 chars, alphanumeric + `-` + `_`, unique                         |
| `shortDescription` | max 500 chars                                                         |
| `description`      | max 50,000 chars                                                      |
| `categoryId`       | UUID format, phải tồn tại trong DB                                    |

### Image Upload

| Rule                | Giá trị                                 |
| ------------------- | --------------------------------------- |
| Định dạng chấp nhận | `image/jpeg`, `image/png`, `image/webp` |
| Kích thước tối đa   | 5 MB                                    |
| Số lượng tối đa     | 10 ảnh / sản phẩm                       |

### Category Fields

| Field         | Rule                                         |
| ------------- | -------------------------------------------- |
| `name`        | 2–100 chars, unique (case-insensitive), trim |
| `sortOrder`   | Integer ≥ 0                                  |
| `description` | max 1000 chars                               |

---

## 8. Error Catalog

| HTTP | Error Code                   | Message (vi)                                  | Điều kiện                 |
| ---- | ---------------------------- | --------------------------------------------- | ------------------------- |
| 400  | `VALIDATION_ERROR`           | "Dữ liệu không hợp lệ"                        | Field validation fail     |
| 400  | `INVALID_PRICE`              | "Giá sản phẩm phải lớn hơn 0"                 | price ≤ 0                 |
| 400  | `INVALID_FILE_TYPE`          | "Chỉ chấp nhận ảnh JPEG, PNG, WebP"           | Sai định dạng             |
| 400  | `FILE_TOO_LARGE`             | "Ảnh không được vượt quá 5MB"                 | File > 5MB                |
| 403  | `FORBIDDEN`                  | "Chỉ Admin mới có thể thực hiện thao tác này" | Role USER                 |
| 404  | `PRODUCT_NOT_FOUND`          | "Không tìm thấy sản phẩm"                     | ID/slug không tồn tại     |
| 404  | `CATEGORY_NOT_FOUND`         | "Không tìm thấy danh mục"                     | Category ID không tồn tại |
| 404  | `IMAGE_NOT_FOUND`            | "Không tìm thấy ảnh"                          | Image ID không tồn tại    |
| 409  | `SKU_ALREADY_EXISTS`         | "SKU đã được sử dụng bởi sản phẩm khác"       | Trùng SKU                 |
| 409  | `CATEGORY_NAME_EXISTS`       | "Tên danh mục đã tồn tại"                     | Trùng tên category        |
| 409  | `CATEGORY_HAS_PRODUCTS`      | "Danh mục đang có sản phẩm, không thể xóa"    | Xóa category có product   |
| 409  | `PRODUCT_HAS_ACTIVE_ORDERS`  | "Sản phẩm đang có trong đơn hàng chờ xử lý"   | Xóa prod có đơn PENDING   |
| 422  | `CANNOT_PUBLISH_NO_IMAGE`    | "Cần ít nhất 1 ảnh để đăng bán sản phẩm"      | Publish không có ảnh      |
| 422  | `CANNOT_PUBLISH_NO_CATEGORY` | "Cần chọn danh mục trước khi đăng bán"        | Publish không có category |
| 422  | `IMAGE_LIMIT_EXCEEDED`       | "Mỗi sản phẩm tối đa 10 ảnh"                  | Vượt quá 10 ảnh           |
| 500  | `CLOUDINARY_UPLOAD_FAILED`   | "Lỗi tải ảnh lên server, vui lòng thử lại"    | Cloudinary API fail       |

---

## 9. Product Variants

### 9.1 Tổng Quan

Khi sản phẩm có nhiều biến thể (size, color, material), mỗi biến thể là 1 bản ghi `product_variants`. Tồn kho được theo dõi ở cấp variant (không phải product). Giá variant có thể điều chỉnh so với giá gốc của product.

**Ví dụ:**

- Product: "Áo phông Unisex" — price = 250,000đ
- Variant 1: Size S, Màu Đỏ — `price_adjustment = 0` → giá bán = 250,000đ
- Variant 2: Size XL, Màu Đỏ — `price_adjustment = +20,000` → giá bán = 270,000đ

### 9.2 Entity: `product_variants`

| Column             | Type            | Constraint                         | Mô tả                            |
| ------------------ | --------------- | ---------------------------------- | -------------------------------- |
| `id`               | `UUID`          | PK                                 |                                  |
| `product_id`       | `UUID`          | FK → products.id ON DELETE CASCADE |                                  |
| `sku`              | `VARCHAR(100)`  | UNIQUE NOT NULL                    | SKU duy nhất cho variant         |
| `attributes`       | `JSONB`         | NOT NULL                           | `{"size": "M", "color": "Đỏ"}`   |
| `price_adjustment` | `NUMERIC(12,2)` | NOT NULL DEFAULT 0                 | ±VNĐ so với products.price       |
| `is_active`        | `BOOLEAN`       | NOT NULL DEFAULT true              |                                  |
| `sort_order`       | `SMALLINT`      | NOT NULL DEFAULT 0                 | Thứ tự hiển thị                  |
| `image_url`        | `TEXT`          | NULLABLE                           | Ảnh riêng của variant (optional) |
| `created_at`       | `TIMESTAMPTZ`   | NOT NULL DEFAULT NOW()             |                                  |
| `updated_at`       | `TIMESTAMPTZ`   | NOT NULL DEFAULT NOW()             |                                  |

```sql
CREATE UNIQUE INDEX idx_variants_sku         ON product_variants(sku);
CREATE        INDEX idx_variants_product     ON product_variants(product_id);
CREATE        INDEX idx_variants_active      ON product_variants(product_id, is_active)
                                             WHERE is_active = true;
-- Không cho phép 2 variants cùng attributes trong 1 product:
CREATE UNIQUE INDEX idx_variants_attributes  ON product_variants(product_id, attributes);
```

### 9.3 Entity: `variant_attribute_definitions`

> Định nghĩa các attribute có thể có của product (dùng để build UI picker)

| Column           | Type          | Constraint                         | Mô tả                             |
| ---------------- | ------------- | ---------------------------------- | --------------------------------- |
| `id`             | `UUID`        | PK                                 |                                   |
| `product_id`     | `UUID`        | FK → products.id ON DELETE CASCADE |                                   |
| `attribute_name` | `VARCHAR(50)` | NOT NULL                           | `"size"`, `"color"`, `"material"` |
| `options`        | `TEXT[]`      | NOT NULL                           | `["S", "M", "L", "XL"]`           |
| `sort_order`     | `SMALLINT`    | NOT NULL DEFAULT 0                 |                                   |

```sql
CREATE UNIQUE INDEX idx_attr_defs_product_name
  ON variant_attribute_definitions(product_id, attribute_name);
```

### 9.4 Business Rules cho Variants

**BR-PROD-VAR-001:** Khi product có variants, `product.price` là giá base. Giá bán thực tế = `product.price + variant.price_adjustment`.

**BR-PROD-VAR-002:** `variant.sku` là UNIQUE globally (không chỉ trong product).

**BR-PROD-VAR-003:** Khi product có ≥ 1 variant, tồn kho được tạo ở cấp variant. `inventory_items.variant_id` = `product_variants.id`. Không còn inventory trực tiếp của `product_id`.

**BR-PROD-VAR-004:** Xóa variant khi còn tồn kho > 0 → 409. Admin phải đặt tồn kho về 0 trước.

**BR-PROD-VAR-005:** Nếu product không có variants (is_simple = true), cart/order dùng `product_id` trực tiếp.

**BR-PROD-VAR-006:** Khi publish sản phẩm có variant: phải có ≥ 1 variant active.

### 9.5 API Contract — Variants

#### `GET /api/products/:id/variants` _(Public)_

**Response 200:**

```json
{
  "success": true,
  "data": {
    "productId": "prod-uuid",
    "attributeDefinitions": [
      { "name": "size", "options": ["S", "M", "L", "XL"] },
      { "name": "color", "options": ["Đỏ", "Đen", "Trắng"] }
    ],
    "variants": [
      {
        "id": "variant-uuid-1",
        "sku": "SHIRT-M-RED",
        "attributes": { "size": "M", "color": "Đỏ" },
        "basePrice": 250000,
        "priceAdjustment": 0,
        "finalPrice": 250000,
        "imageUrl": null,
        "isActive": true,
        "stockStatus": "IN_STOCK"
      },
      {
        "id": "variant-uuid-2",
        "sku": "SHIRT-XL-RED",
        "attributes": { "size": "XL", "color": "Đỏ" },
        "basePrice": 250000,
        "priceAdjustment": 20000,
        "finalPrice": 270000,
        "imageUrl": null,
        "isActive": true,
        "stockStatus": "LOW_STOCK"
      }
    ]
  }
}
```

---

#### `POST /api/admin/products/:id/variants` _(ADMIN)_

**Request:**

```json
{
  "sku": "SHIRT-S-BLACK",
  "attributes": { "size": "S", "color": "Đen" },
  "priceAdjustment": -10000,
  "isActive": true,
  "sortOrder": 1
}
```

**Response 201:** variant mới tạo

**Errors:** `400` attributes không hợp lệ | `409` SKU đã tồn tại | `409` attributes trùng

---

#### `PATCH /api/admin/products/:id/variants/:variantId` _(ADMIN)_

**Request:** _(các field muốn sửa)_

```json
{
  "priceAdjustment": 0,
  "isActive": false
}
```

**Response 200:** variant đã cập nhật

---

#### `DELETE /api/admin/products/:id/variants/:variantId` _(ADMIN)_

**Response 200:** `{ "success": true }`

**Errors:** `409` variant còn tồn kho > 0 | `409` variant đang trong đơn hàng PENDING

---

#### `POST /api/admin/products/:id/variants/attribute-definitions` _(ADMIN)_

**Mô tả:** Thiết lập attribute options cho product (trước khi tạo variants)

**Request:**

```json
{
  "definitions": [
    {
      "attributeName": "size",
      "options": ["S", "M", "L", "XL"],
      "sortOrder": 1
    },
    {
      "attributeName": "color",
      "options": ["Đỏ", "Đen", "Trắng"],
      "sortOrder": 2
    }
  ]
}
```

**Response 200:** danh sách attribute definitions đã lưu

---

### 9.6 Error Catalog bổ sung cho Variants

| HTTP | Error Code                   | Message (vi)                                     | Điều kiện                               |
| ---- | ---------------------------- | ------------------------------------------------ | --------------------------------------- |
| 400  | `INVALID_VARIANT_ATTRIBUTES` | "Attributes không đúng định nghĩa sản phẩm"      | Attributes không nằm trong definitions  |
| 409  | `VARIANT_SKU_EXISTS`         | "SKU variant đã được sử dụng"                    | Trùng SKU                               |
| 409  | `VARIANT_ATTRIBUTES_EXISTS`  | "Đã có variant với bộ thuộc tính này"            | Trùng attributes combination            |
| 409  | `VARIANT_HAS_STOCK`          | "Không thể xóa variant còn tồn kho"              | available_qty > 0                       |
| 422  | `NO_ACTIVE_VARIANTS`         | "Sản phẩm phải có ít nhất 1 variant để đăng bán" | Publish product không có variant active |

---

## 10. SEO Metadata & Tags

### 10.1 Cập nhật bảng `products` — Thêm cột SEO

| Column thêm        | Type           | Constraint         | Mô tả                                                    |
| ------------------ | -------------- | ------------------ | -------------------------------------------------------- |
| `meta_title`       | `VARCHAR(70)`  | NULLABLE           | SEO title (Google hiển thị ~60 chars)                    |
| `meta_description` | `VARCHAR(160)` | NULLABLE           | SEO description (hiển thị ~155 chars)                    |
| `meta_keywords`    | `TEXT[]`       | NULLABLE           | Keywords array                                           |
| `canonical_url`    | `TEXT`         | NULLABLE           | Canonical URL (tránh duplicate content)                  |
| `avg_rating`       | `NUMERIC(3,2)` | NULLABLE           | Aggregate từ reviews (xem domain Review)                 |
| `review_count`     | `INTEGER`      | NOT NULL DEFAULT 0 | Số review APPROVED                                       |
| `discount_percent` | `SMALLINT`     | NULLABLE           | % giảm giá hiển thị (cosmetic, không dùng cho tính tiền) |

```sql
ALTER TABLE products ADD COLUMN meta_title VARCHAR(70);
ALTER TABLE products ADD COLUMN meta_description VARCHAR(160);
ALTER TABLE products ADD COLUMN meta_keywords TEXT[];
ALTER TABLE products ADD COLUMN canonical_url TEXT;
ALTER TABLE products ADD COLUMN avg_rating NUMERIC(3,2);
ALTER TABLE products ADD COLUMN review_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN discount_percent SMALLINT;
```

### 10.2 Entity: `tags`

| Column       | Type           | Constraint             | Mô tả                         |
| ------------ | -------------- | ---------------------- | ----------------------------- |
| `id`         | `UUID`         | PK                     |                               |
| `name`       | `VARCHAR(100)` | UNIQUE NOT NULL        | Tên tag (lowercase, no-space) |
| `slug`       | `VARCHAR(120)` | UNIQUE NOT NULL        | URL-friendly                  |
| `created_at` | `TIMESTAMPTZ`  | NOT NULL DEFAULT NOW() |                               |

### 10.3 Entity: `product_tags`

| Column       | Type   | Constraint                         | Mô tả |
| ------------ | ------ | ---------------------------------- | ----- |
| `product_id` | `UUID` | FK → products.id ON DELETE CASCADE |       |
| `tag_id`     | `UUID` | FK → tags.id ON DELETE CASCADE     |       |

```sql
CREATE PRIMARY KEY ON product_tags(product_id, tag_id);
CREATE INDEX idx_product_tags_tag ON product_tags(tag_id);
```

### 10.4 Business Rules cho Tags

- Tags được tạo auto khi chưa tồn tại (upsert by name)
- Tag name normalize: lowercase, trim, replace spaces với `-`
- Tối đa **10 tags** / sản phẩm
- Tags hiển thị trong product listing (filter, search)

### 10.5 API — Tags

**`PATCH /api/admin/products/:id`** — Thêm `tags` vào request body:

```json
{
  "tags": ["smartphone", "apple", "5g", "flagship"]
}
```

Tags sẽ được upsert và link với product.

**`GET /api/products?tag=smartphone`** — Filter sản phẩm theo tag.

**`GET /api/tags`** _(Public)_ — Danh sách tất cả tags (cho filter UI).

**Response:**

```json
{
  "success": true,
  "data": [
    {
      "id": "tag-uuid",
      "name": "smartphone",
      "slug": "smartphone",
      "productCount": 15
    }
  ]
}
```
