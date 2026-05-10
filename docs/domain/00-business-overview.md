# 🗺️ Business Overview — E-Commerce MVP

> **Tài liệu chủ đạo** — đọc file này trước khi đọc bất kỳ domain file nào khác
> **Phiên bản:** 1.0 · **Cập nhật:** 22/04/2026
> **Scope:** Single-vendor B2C E-commerce · Thị trường Việt Nam · VNĐ

---

## Mục Lục

1. [Tầm Nhìn & Phạm Vi](#1-tầm-nhìn--phạm-vi)
2. [Actor Diagram](#2-actor-diagram)
3. [Customer Journey Map](#3-customer-journey-map)
4. [Bounded Context Map](#4-bounded-context-map)
5. [Kiến Trúc Microservices](#5-kiến-trúc-microservices)
6. [Cross-Domain Event Catalog](#6-cross-domain-event-catalog)
7. [API Surface Tổng Hợp](#7-api-surface-tổng-hợp)
8. [Luồng Nghiệp Vụ Tổng Thể](#8-luồng-nghiệp-vụ-tổng-thể)
9. [Business Rules Tổng Hợp](#9-business-rules-tổng-hợp)
10. [KPI & Metrics](#10-kpi--metrics)
11. [Security Perimeter](#11-security-perimeter)
12. [Danh Sách Domain Files](#12-danh-sách-domain-files)

---

## 1. Tầm Nhìn & Phạm Vi

### Mục tiêu kinh doanh

| #   | Mục tiêu                                        | Metrics                         |
| --- | ----------------------------------------------- | ------------------------------- |
| 1   | Cho phép khách hàng mua hàng online dễ dàng     | Checkout rate ≥ 60% add-to-cart |
| 2   | Admin quản lý đơn hàng và sản phẩm hiệu quả     | Order processing time < 5 phút  |
| 3   | Hệ thống ổn định trong điều kiện ngân sách thấp | Uptime ≥ 99%, RAM EC2 < 80%     |
| 4   | Bảo mật thanh toán và dữ liệu người dùng        | 0 data breach incidents         |

### In Scope — MVP

| Domain          | Tính năng                                                     |
| --------------- | ------------------------------------------------------------- |
| Auth & User     | Đăng ký, đăng nhập, quản lý hồ sơ, địa chỉ giao hàng          |
| Product Catalog | CRUD sản phẩm, danh mục, ảnh, variants (size/color), tìm kiếm |
| Cart            | Thêm/sửa/xóa sản phẩm, áp mã giảm giá, guest cart             |
| Order           | Đặt hàng, theo dõi, hủy đơn, COD + Stripe                     |
| Inventory       | Tồn kho theo variant, reserve/release/commit                  |
| Payment         | Stripe PaymentIntent, Stripe Webhook, hoàn tiền               |
| Shipping        | Tạo vận đơn, tracking trạng thái, xác nhận giao hàng          |
| Promotion       | Voucher code, discount %, giảm tiền, miễn phí ship            |
| Review          | Đánh giá sau mua hàng, rating 1–5 sao                         |
| Return/Refund   | Yêu cầu đổi trả, hoàn tiền sau 7 ngày nhận hàng               |
| Wishlist        | Danh sách yêu thích                                           |
| Notification    | Email (SendGrid), Kafka EDA                                   |
| Admin Analytics | Doanh thu, đơn hàng, sản phẩm bán chạy                        |

### Out of Scope — MVP

- Multi-vendor / marketplace
- Multi-currency (chỉ VNĐ)
- Multi-warehouse (1 kho)
- Subscription / recurring orders
- Social sharing / referral program
- Live chat / customer support
- Product recommendations (ML)
- Mobile native app (chỉ responsive web)

---

## 2. Actor Diagram

```
                        ┌─────────────────────────────────────────┐
                        │            E-Commerce System             │
                        │                                         │
  ┌──────────┐          │  ┌──────────┐    ┌──────────────────┐  │
  │  Guest   │─────────▶│  │  Public  │    │  Auth Protected  │  │
  │  User    │          │  │   APIs   │    │      APIs        │  │
  └──────────┘          │  │ /products│    │ /cart /orders    │  │
                        │  │/categories   │ /profile /wishlist│  │
  ┌──────────┐          │  └──────────┘    └──────────────────┘  │
  │ Logged-in│─────────▶│                                         │
  │  User    │          │  ┌──────────────────────────────────┐  │
  └──────────┘          │  │       Admin-only APIs             │  │
                        │  │ /admin/products /admin/orders     │  │
  ┌──────────┐          │  │ /admin/inventory /admin/users     │  │
  │  Admin   │─────────▶│  │ /admin/analytics /admin/vouchers  │  │
  └──────────┘          │  └──────────────────────────────────┘  │
                        │                                         │
  ┌──────────┐          │  ┌──────────────────────────────────┐  │
  │  Stripe  │─────────▶│  │       Webhook Endpoints           │  │
  │ Webhook  │          │  │ /webhooks/stripe                  │  │
  └──────────┘          │  └──────────────────────────────────┘  │
                        │                                         │
  ┌──────────┐          │  ┌──────────────────────────────────┐  │
  │  GHN/    │─────────▶│  │       Shipping Webhook            │  │
  │  GHTK    │          │  │ /webhooks/shipping                │  │
  └──────────┘          │  └──────────────────────────────────┘  │
                        └─────────────────────────────────────────┘
```

---

## 3. Customer Journey Map

### 3.1 Happy Path — Mua hàng thành công

```
Stage 1: DISCOVERY
  Guest User
    │
    ├─ Truy cập trang chủ (SSG — Next.js)
    ├─ Browse category / search sản phẩm
    ├─ Xem product detail (ISR — Next.js)
    └─ Add to Cart (guest cart — sessionId cookie)
        │
        ▼
Stage 2: REGISTRATION / LOGIN
    │
    ├─ Lần đầu: Register → Email verification
    ├─ Lần sau: Login (Keycloak) → JWT
    └─ Guest cart tự động merge với auth cart
        │
        ▼
Stage 3: CART & PROMOTION
    │
    ├─ Xem giỏ hàng
    ├─ Điều chỉnh số lượng / xóa item
    ├─ Áp mã voucher (nếu có)
    └─ Kiểm tra tổng tiền → "Đặt hàng"
        │
        ▼
Stage 4: CHECKOUT
    │
    ├─ Chọn/thêm địa chỉ giao hàng
    ├─ Chọn phương thức vận chuyển
    ├─ Chọn phương thức thanh toán (Stripe / COD)
    └─ Xác nhận đơn hàng → POST /orders
        │
        ▼
Stage 5: ORDER PROCESSING (Camunda Saga)
    │
    ├─ validate-order (kiểm tra user, items, địa chỉ)
    ├─ reserve-inventory (giữ chỗ hàng)
    ├─ process-payment (Stripe hoặc COD)
    └─ confirm-order → trigger-shipment
        │
        ▼
Stage 6: DELIVERY
    │
    ├─ Order SHIPPING — nhận tracking number từ GHN/GHTK
    ├─ Theo dõi tracking (GET /orders/:id)
    └─ Order DELIVERED — xác nhận giao hàng
        │
        ▼
Stage 7: POST-PURCHASE
    │
    ├─ Email xác nhận giao hàng
    ├─ Viết review sản phẩm (trong 30 ngày)
    ├─ Đổi trả nếu cần (trong 7 ngày nhận hàng)
    └─ Add sản phẩm vào Wishlist để mua lại
```

### 3.2 Negative Paths

| Scenario               | Xử lý                                                           |
| ---------------------- | --------------------------------------------------------------- |
| Hết hàng khi checkout  | Saga fail → FAILED, release inventory (nếu có), thông báo user  |
| Thanh toán Stripe fail | Saga compensation → release inventory → FAILED, email thông báo |
| Hủy đơn trước giao     | User/Admin cancel → release inventory → refund → CANCELLED      |
| Giao hàng thất bại     | Carrier retry 2 lần → FAILED_DELIVERY, liên hệ khách hàng       |
| Đổi trả sản phẩm       | Return request → Admin approve → restock → refund               |

---

## 4. Bounded Context Map

```
┌────────────────────────────────────────────────────────────────────────┐
│                         E-Commerce Platform                            │
│                                                                        │
│  ┌─────────────┐      ┌─────────────┐      ┌──────────────────────┐  │
│  │   Identity  │      │   Catalog   │      │   Commerce Core      │  │
│  │  Context    │      │  Context    │      │      Context         │  │
│  │             │      │             │      │                      │  │
│  │ auth-service│      │product-svc  │      │ order-service        │  │
│  │ Keycloak    │      │             │      │ cart-service         │  │
│  │             │      │ Product     │      │ inventory-service    │  │
│  │ User        │      │ Category    │      │                      │  │
│  │ Address     │      │ Variant     │      │ Order                │  │
│  │ Role        │      │ Review      │      │ OrderItem            │  │
│  └──────┬──────┘      │ Wishlist    │      │ Inventory            │  │
│         │             │             │      │ Reservation          │  │
│         │ JWT         └──────┬──────┘      └──────────┬───────────┘  │
│         │ userId             │ productId              │              │
│         └────────────────────┼────────────────────────┘              │
│                              │                                        │
│  ┌───────────────────────────┼────────────────────────────────────┐  │
│  │              Financial Context                                 │  │
│  │                                                                │  │
│  │  payment (in order-svc)   promotion-svc   return-svc          │  │
│  │                                                                │  │
│  │  PaymentTransaction       Voucher          ReturnRequest       │  │
│  │  Stripe PaymentIntent     Promotion        ReturnItem          │  │
│  │  Refund                   VoucherUsage     Refund              │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                        │
│  ┌──────────────────────────────────────────────────────────────────┐ │
│  │                    Operations Context                            │ │
│  │                                                                  │ │
│  │  shipping-svc         notification-svc    admin-analytics       │ │
│  │                                                                  │ │
│  │  Shipment             NotificationLog     (query-based)         │ │
│  │  ShippingMethod       EmailTemplate       DailyRevenue          │ │
│  │  TrackingEvent        KafkaDLQ            TopProducts           │ │
│  └──────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Kiến Trúc Microservices

| Service                | Port | DB             | Ghi chú                                            |
| ---------------------- | ---- | -------------- | -------------------------------------------------- |
| `api-gateway`          | 3000 | —              | JWT verify, rate limit, proxy, Swagger aggregation |
| `auth-service`         | 3001 | RDS PostgreSQL | User, Address, Keycloak bridge                     |
| `product-service`      | 3002 | RDS PostgreSQL | Product, Variant, Category, Review, Wishlist       |
| `cart-service`         | 3003 | MongoDB Atlas  | Cart (guest + auth), TTL                           |
| `order-service`        | 3004 | RDS PostgreSQL | Order, Saga, Payment, Promotion apply              |
| `inventory-service`    | 3005 | RDS PostgreSQL | Inventory per variant, Reservation                 |
| `notification-service` | 3006 | MongoDB Atlas  | Kafka consumer, Email, DLQ                         |
| `shipping-service`     | 3007 | RDS PostgreSQL | Shipment, GHN/GHTK webhook                         |
| `promotion-service`    | 3008 | RDS PostgreSQL | Voucher, Promotion rules                           |
| `return-service`       | 3009 | RDS PostgreSQL | Return request, Refund orchestration               |

**Keycloak** — EC2-B :8080  
**Kafka KRaft** — EC2-B :9092  
**Camunda Zeebe** — SaaS :26500

---

## 6. Cross-Domain Event Catalog

### Kafka Topics — Tất cả

| Topic                           | Producer             | Consumers                               | Payload key                                 |
| ------------------------------- | -------------------- | --------------------------------------- | ------------------------------------------- |
| `user.registered`               | auth-service         | notification-service                    | `{ userId, email, name }`                   |
| `user.email.verify.requested`   | auth-service         | notification-service                    | `{ userId, email, token }`                  |
| `user.password.reset.requested` | auth-service         | notification-service                    | `{ userId, email, token }`                  |
| `user.banned`                   | auth-service         | order-service, cart-service             | `{ userId, reason }`                        |
| `product.created`               | product-service      | inventory-service                       | `{ productId, variants[] }`                 |
| `product.deleted`               | product-service      | inventory-service, cart-service         | `{ productId }`                             |
| `product.price.changed`         | product-service      | — (no auto-update cart)                 | `{ productId, oldPrice, newPrice }`         |
| `order.created`                 | order-service        | notification-service                    | Order payload full                          |
| `order.paid`                    | order-service        | notification-service, shipping-service  | `{ orderId, userId, email, ... }`           |
| `order.failed`                  | order-service        | notification-service                    | `{ orderId, reason }`                       |
| `order.shipped`                 | order-service        | notification-service                    | `{ orderId, trackingNumber }`               |
| `order.delivered`               | shipping-service     | order-service, notification-service     | `{ orderId, deliveredAt }`                  |
| `order.cancelled`               | order-service        | notification-service, inventory-service | `{ orderId, reason, refundStatus }`         |
| `inventory.reserved`            | inventory-service    | —                                       | `{ orderId, items[] }`                      |
| `inventory.released`            | inventory-service    | —                                       | `{ orderId, reason }`                       |
| `inventory.committed`           | inventory-service    | —                                       | `{ orderId }`                               |
| `inventory.low`                 | inventory-service    | notification-service                    | `{ productId, variantId, availableQty }`    |
| `inventory.restocked`           | inventory-service    | —                                       | `{ productId, variantId, addedQty }`        |
| `payment.succeeded`             | order-service        | —                                       | `{ orderId, paymentIntentId }`              |
| `payment.failed`                | order-service        | notification-service                    | `{ orderId, failureCode }`                  |
| `payment.refunded`              | order-service        | notification-service                    | `{ orderId, amount }`                       |
| `shipment.created`              | shipping-service     | —                                       | `{ orderId, shipmentId, carrier }`          |
| `shipment.picked_up`            | shipping-service     | notification-service                    | `{ orderId, trackingNumber }`               |
| `shipment.in_transit`           | shipping-service     | —                                       | `{ shipmentId, location }`                  |
| `shipment.delivered`            | shipping-service     | order-service, notification-service     | `{ orderId, deliveredAt }`                  |
| `shipment.failed`               | shipping-service     | order-service, notification-service     | `{ orderId, reason }`                       |
| `voucher.applied`               | order-service        | promotion-service                       | `{ voucherId, orderId, discountAmount }`    |
| `voucher.released`              | order-service        | promotion-service                       | `{ voucherId, orderId }` (khi order cancel) |
| `return.requested`              | return-service       | notification-service                    | `{ returnId, orderId, userId }`             |
| `return.approved`               | return-service       | inventory-service, notification-service | `{ returnId, items[] }`                     |
| `return.rejected`               | return-service       | notification-service                    | `{ returnId, reason }`                      |
| `return.refund.processed`       | return-service       | notification-service                    | `{ returnId, amount }`                      |
| `review.submitted`              | product-service      | notification-service (admin alert)      | `{ reviewId, productId, rating }`           |
| `review.approved`               | product-service      | —                                       | `{ reviewId, productId }`                   |
| `notification.dlq`              | notification-service | — (manual monitoring)                   | `{ originalTopic, payload, error }`         |

---

## 7. API Surface Tổng Hợp

### Public APIs (không cần JWT)

| Method | Path                        | Service          | Mô tả                              |
| ------ | --------------------------- | ---------------- | ---------------------------------- |
| `GET`  | `/api/products`             | product-service  | Danh sách sản phẩm + filter/search |
| `GET`  | `/api/products/:id`         | product-service  | Chi tiết sản phẩm                  |
| `GET`  | `/api/products/slug/:slug`  | product-service  | Theo slug (SSG)                    |
| `GET`  | `/api/categories`           | product-service  | Danh sách danh mục                 |
| `GET`  | `/api/products/:id/reviews` | product-service  | Đánh giá sản phẩm                  |
| `GET`  | `/api/cart`                 | cart-service     | Xem giỏ (guest + auth)             |
| `POST` | `/api/cart/items`           | cart-service     | Thêm vào giỏ                       |
| `POST` | `/api/auth/register`        | auth-service     | Đăng ký                            |
| `POST` | `/api/auth/login`           | auth-service     | Đăng nhập                          |
| `POST` | `/api/auth/refresh`         | auth-service     | Làm mới token                      |
| `POST` | `/api/auth/forgot-password` | auth-service     | Yêu cầu reset password             |
| `POST` | `/api/auth/reset-password`  | auth-service     | Đặt lại mật khẩu                   |
| `GET`  | `/api/auth/verify-email`    | auth-service     | Xác thực email                     |
| `POST` | `/api/webhooks/stripe`      | order-service    | Stripe webhook                     |
| `POST` | `/api/webhooks/shipping`    | shipping-service | GHN/GHTK webhook                   |

### Auth User APIs (JWT required — role: USER)

| Method         | Path                                          | Service         | Mô tả                     |
| -------------- | --------------------------------------------- | --------------- | ------------------------- |
| `GET`          | `/api/auth/me`                                | auth-service    | Thông tin user hiện tại   |
| `PATCH`        | `/api/auth/me`                                | auth-service    | Cập nhật hồ sơ            |
| `DELETE`       | `/api/auth/account`                           | auth-service    | Xóa tài khoản (GDPR)      |
| `GET/POST`     | `/api/auth/addresses`                         | auth-service    | Quản lý địa chỉ           |
| `PATCH/DELETE` | `/api/auth/addresses/:id`                     | auth-service    | Sửa/xóa địa chỉ           |
| `PATCH`        | `/api/auth/addresses/:id/default`             | auth-service    | Đặt địa chỉ mặc định      |
| `POST`         | `/api/auth/logout`                            | auth-service    | Đăng xuất                 |
| `PATCH`        | `/api/cart/items/:itemId`                     | cart-service    | Sửa số lượng              |
| `DELETE`       | `/api/cart/items/:itemId`                     | cart-service    | Xóa item                  |
| `DELETE`       | `/api/cart`                                   | cart-service    | Xóa toàn bộ giỏ           |
| `POST`         | `/api/cart/voucher`                           | cart-service    | Áp mã voucher             |
| `DELETE`       | `/api/cart/voucher`                           | cart-service    | Gỡ voucher                |
| `POST`         | `/api/orders`                                 | order-service   | Tạo đơn hàng              |
| `GET`          | `/api/orders`                                 | order-service   | Danh sách đơn của user    |
| `GET`          | `/api/orders/:id`                             | order-service   | Chi tiết đơn              |
| `POST`         | `/api/orders/:id/cancel`                      | order-service   | Hủy đơn                   |
| `GET`          | `/api/orders/:id/payment`                     | order-service   | Thông tin thanh toán      |
| `GET`          | `/api/wishlist`                               | product-service | Danh sách yêu thích       |
| `POST`         | `/api/wishlist/items`                         | product-service | Thêm vào wishlist         |
| `DELETE`       | `/api/wishlist/items/:productId`              | product-service | Xóa khỏi wishlist         |
| `POST`         | `/api/wishlist/items/:productId/move-to-cart` | product-service | Chuyển sang cart          |
| `POST`         | `/api/products/:id/reviews`                   | product-service | Gửi review                |
| `PATCH`        | `/api/reviews/:id`                            | product-service | Sửa review                |
| `DELETE`       | `/api/reviews/:id`                            | product-service | Xóa review                |
| `GET`          | `/api/returns`                                | return-service  | Danh sách yêu cầu đổi trả |
| `POST`         | `/api/returns`                                | return-service  | Tạo yêu cầu đổi trả       |
| `GET`          | `/api/returns/:id`                            | return-service  | Chi tiết yêu cầu          |

### Admin APIs (JWT required — role: ADMIN)

| Method                  | Path                                      | Service              | Mô tả               |
| ----------------------- | ----------------------------------------- | -------------------- | ------------------- |
| `GET/POST/PATCH/DELETE` | `/api/admin/products`                     | product-service      | Quản lý sản phẩm    |
| `POST/DELETE/PATCH`     | `/api/admin/products/:id/images`          | product-service      | Quản lý ảnh         |
| `POST/PATCH/DELETE`     | `/api/admin/products/:id/variants`        | product-service      | Quản lý variants    |
| `GET/POST/PATCH/DELETE` | `/api/admin/categories`                   | product-service      | Quản lý danh mục    |
| `GET/POST/PATCH/DELETE` | `/api/admin/vouchers`                     | promotion-service    | Quản lý voucher     |
| `GET/POST/PATCH/DELETE` | `/api/admin/promotions`                   | promotion-service    | Quản lý khuyến mãi  |
| `GET`                   | `/api/admin/orders`                       | order-service        | Tất cả đơn hàng     |
| `PATCH`                 | `/api/admin/orders/:id/status`            | order-service        | Cập nhật trạng thái |
| `POST`                  | `/api/admin/orders/:id/cancel`            | order-service        | Hủy đơn (admin)     |
| `GET`                   | `/api/admin/inventory`                    | inventory-service    | Quản lý tồn kho     |
| `POST`                  | `/api/admin/inventory/:variantId/restock` | inventory-service    | Nhập kho            |
| `POST`                  | `/api/admin/inventory/:variantId/adjust`  | inventory-service    | Điều chỉnh tồn kho  |
| `GET`                   | `/api/admin/users`                        | auth-service         | Quản lý người dùng  |
| `PATCH`                 | `/api/admin/users/:id/status`             | auth-service         | Khóa/mở tài khoản   |
| `PATCH`                 | `/api/admin/users/:id/role`               | auth-service         | Phân quyền          |
| `GET/PATCH/POST`        | `/api/admin/returns`                      | return-service       | Quản lý đổi trả     |
| `GET`                   | `/api/admin/reviews`                      | product-service      | Quản lý review      |
| `PATCH`                 | `/api/admin/reviews/:id/approve`          | product-service      | Duyệt review        |
| `GET`                   | `/api/admin/shipments`                    | shipping-service     | Theo dõi vận chuyển |
| `GET`                   | `/api/admin/analytics/revenue`            | order-service        | Doanh thu           |
| `GET`                   | `/api/admin/analytics/top-products`       | product-service      | Sản phẩm bán chạy   |
| `GET`                   | `/api/admin/analytics/orders`             | order-service        | Thống kê đơn hàng   |
| `GET`                   | `/api/admin/analytics/inventory`          | inventory-service    | Báo cáo tồn kho     |
| `GET`                   | `/api/admin/notifications`                | notification-service | Log thông báo       |

---

## 8. Luồng Nghiệp Vụ Tổng Thể

### 8.1 Order Fulfillment End-to-End

```
User                Frontend         API Gateway          Services               External
 │                     │                  │                  │                       │
 ├─ Add to Cart ───────▶│                  │                  │                       │
 │                     ├─ POST /cart ──────▶ cart-service      │                       │
 │                     │                  │                  │                       │
 ├─ Apply Voucher ─────▶│                  │                  │                       │
 │                     ├─ POST /cart/voucher▶ promotion-service │                      │
 │                     │◀─ discountAmount ─│                  │                       │
 │                     │                  │                  │                       │
 ├─ Checkout ──────────▶│                  │                  │                       │
 │                     ├─ POST /orders ────▶ order-service      │                       │
 │                     │                  ├─ Camunda Saga ───▶ Zeebe                   │
 │                     │                  │   │                │                       │
 │                     │                  │   ├─ validate ────▶ auth/product-svc       │
 │                     │                  │   ├─ reserve ─────▶ inventory-service      │
 │                     │                  │   ├─ payment ─────────────────────────────▶ Stripe
 │                     │◀─ 201 { order } ──│   │                │                       │
 │                     │                  │   ├─ confirm ──────▶ (Kafka: order.paid)   │
 │                     │                  │   └─ shipment ─────▶ shipping-service      │
 │                     │                  │                  │                         │
 │                     │                  │ (Kafka consumers) │                        │
 │                     │                  │   notification-svc: email order confirmed  │
 │                     │                  │   shipping-svc: tạo vận đơn GHN           │
 │                     │                  │                                            │
 │ (Email nhận)         │                  │                   GHN Webhook ────────────▶
 │                     │                  │                  shipping-svc cập nhật    │
 │                     │                  │                  Kafka: order.delivered    │
 │                     │                  │                                            │
 ├─ Viết Review ───────▶│                  │                  │                       │
 │                     ├─ POST /reviews ───▶ product-service    │                      │
```

### 8.2 Return & Refund Flow

```
User                  Return Service         Inventory Svc     Order Svc / Stripe
 │                         │                     │                    │
 ├─ POST /returns ─────────▶│                     │                    │
 │  (7 ngày sau DELIVERED)  ├─ validate eligible  │                    │
 │                         ├─ INSERT return req   │                    │
 │                         ├─ status = PENDING    │                    │
 │                         │                     │                    │
 │  (Admin review)         │                     │                    │
 │                         ├─ PATCH /admin/returns/:id (APPROVED)      │
 │                         ├─ Kafka: return.approved                   │
 │                         │◀────────────────────│                    │
 │                         │            inventory-svc restock         │
 │                         │                                          │
 │                         ├─ trigger refund ─────────────────────────▶│
 │                         │                              Stripe.refund│
 │                         ├─ status = REFUND_PROCESSED               │
 │ (Email nhận)             ├─ Kafka: return.refund.processed          │
```

---

## 9. Business Rules Tổng Hợp

### Matrix: Quyền truy cập theo Role

| Tài nguyên       | Guest          | USER         | ADMIN  |
| ---------------- | -------------- | ------------ | ------ |
| Xem sản phẩm     | ✅             | ✅           | ✅     |
| Thêm giỏ hàng    | ✅ (sessionId) | ✅ (userId)  | ✅     |
| Đặt hàng         | ❌             | ✅           | ✅     |
| Xem đơn hàng     | ❌             | Đơn của mình | Tất cả |
| Viết review      | ❌             | ✅ (đã mua)  | ✅     |
| Wishlist         | ❌             | ✅           | ✅     |
| Quản lý sản phẩm | ❌             | ❌           | ✅     |
| Quản lý tồn kho  | ❌             | ❌           | ✅     |
| Quản lý voucher  | ❌             | ❌           | ✅     |
| Xem analytics    | ❌             | ❌           | ✅     |
| Approve review   | ❌             | ❌           | ✅     |
| Approve return   | ❌             | ❌           | ✅     |
| Ban user         | ❌             | ❌           | ✅     |

### Snapshot Rule (bất biến sau khi tạo đơn)

| Dữ liệu              | Tại thời điểm | Lưu ở đâu                         |
| -------------------- | ------------- | --------------------------------- |
| Giá sản phẩm         | Tạo đơn       | `order_items.unit_price`          |
| Tên sản phẩm         | Tạo đơn       | `order_items.product_name`        |
| Variant (size/color) | Tạo đơn       | `order_items.variant_snapshot`    |
| Địa chỉ giao hàng    | Tạo đơn       | `orders.shipping_address` (JSONB) |
| Giá cart item        | Add to cart   | `carts.items[].priceAtAdded`      |
| Discount từ voucher  | Tạo đơn       | `orders.discount_amount`          |

### SLA Response Time

| Loại                             | Target    | Fallback           |
| -------------------------------- | --------- | ------------------ |
| API public (GET product/listing) | < 200ms   | Từ CDN / SSG       |
| API authenticated (cart/order)   | < 500ms   | —                  |
| Saga completion                  | < 30 giây | FAILED sau 10 phút |
| Email delivery                   | < 2 phút  | DLQ sau 3 retries  |
| Webhook xử lý                    | < 5 giây  | Stripe retry 3 lần |

---

## 10. KPI & Metrics

### Business KPIs

| KPI                   | Formula                      | Target MVP |
| --------------------- | ---------------------------- | ---------- |
| Conversion Rate       | Orders / Sessions            | ≥ 3%       |
| Cart Abandonment Rate | 1 - (Checkout / Add-to-cart) | ≤ 40%      |
| Average Order Value   | Tổng revenue / Số orders     | —          |
| Return Rate           | Returns / Delivered          | ≤ 5%       |
| Payment Success Rate  | Succeeded / Attempted        | ≥ 95%      |
| Email Delivery Rate   | Sent / Triggered             | ≥ 98%      |

### Technical KPIs

| KPI                   | Target                |
| --------------------- | --------------------- |
| API Response Time p95 | < 2000ms (under load) |
| API Error Rate        | < 1%                  |
| EC2-A RAM Usage       | < 80% (800MB of 1GB)  |
| EC2-B RAM Usage       | < 80% (800MB of 1GB)  |
| Uptime                | ≥ 99%                 |
| Saga Success Rate     | ≥ 98%                 |
| OOM Kill Count        | 0                     |

### Prometheus Metrics per Service

Mỗi NestJS service expose `/metrics` với:

- `http_requests_total{method, route, status}`
- `http_request_duration_seconds{method, route}`
- `nodejs_heap_used_bytes`
- `nodejs_active_handles_total`

---

## 11. Security Perimeter

### Authentication & Authorization Flow

```
Request → API Gateway
              │
              ├─ Public route? → forward thẳng
              │
              ├─ JWT Bearer token present?
              │     │ YES: verify với Keycloak JWKS (cache 1h)
              │     │      extract userId, role → inject header
              │     │ NO:  401 Unauthorized
              │
              ├─ @Roles('ADMIN') guard?
              │     │ YES: check role claim
              │     │      fail → 403 Forbidden
              │
              └─ Forward to upstream service với X-User-Id, X-User-Role headers
```

### Security Checklist

| Layer            | Biện pháp                                             |
| ---------------- | ----------------------------------------------------- |
| Transport        | HTTPS / TLS 1.2+ everywhere                           |
| Auth             | JWT RS256, JWKS rotation, short-lived tokens (15 min) |
| Password         | Stored only in Keycloak (bcrypt), never in app DB     |
| API Rate Limit   | 100 req/min per IP tại Gateway                        |
| Input Validation | Global ValidationPipe whitelist:true                  |
| SQL Injection    | TypeORM parameterized queries                         |
| XSS              | Content-Security-Policy headers                       |
| CORS             | Whitelist production domain only                      |
| Webhook          | Stripe signature verify bắt buộc                      |
| Secrets          | AWS Secrets Manager / .env (không commit)             |
| Internal APIs    | X-Internal-Service-Key header                         |
| File Upload      | Validate MIME + size trước khi gọi Cloudinary         |

---

## 12. Danh Sách Domain Files

| File                                                     | Domain                                       | Service                                         |
| -------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------- |
| [00-business-overview.md](00-business-overview.md)       | ← File này                                   | Tổng quan                                       |
| [01-auth-user.md](01-auth-user.md)                       | Auth & User                                  | auth-service :3001                              |
| [02-product-catalog.md](02-product-catalog.md)           | Product, Category, Variant, Review, Wishlist | product-service :3002                           |
| [03-cart.md](03-cart.md)                                 | Shopping Cart (guest + auth)                 | cart-service :3003                              |
| [04-order.md](04-order.md)                               | Order Management & Camunda Saga              | order-service :3004                             |
| [05-inventory.md](05-inventory.md)                       | Inventory per Variant                        | inventory-service :3005                         |
| [06-payment-notification.md](06-payment-notification.md) | Payment & Notification                       | order-service :3004, notification-service :3006 |
| [07-shipping-delivery.md](07-shipping-delivery.md)       | Shipping & Delivery                          | shipping-service :3007                          |
| [08-promotion-voucher.md](08-promotion-voucher.md)       | Promotion & Voucher                          | promotion-service :3008                         |
| [09-review-rating.md](09-review-rating.md)               | Review & Rating                              | product-service :3002                           |
| [10-return-refund.md](10-return-refund.md)               | Return & Refund                              | return-service :3009                            |
| [11-wishlist.md](11-wishlist.md)                         | Wishlist                                     | product-service :3002                           |
| [12-admin-analytics.md](12-admin-analytics.md)           | Admin Analytics & Reports                    | Multiple (query-based)                          |
