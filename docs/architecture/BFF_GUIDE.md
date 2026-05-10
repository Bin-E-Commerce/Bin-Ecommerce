# BFF — Backend for Frontend Pattern

> Áp dụng cho: Next.js 14 frontend + 10 NestJS microservices

---

## BFF là gì?

**Backend for Frontend (BFF)** là một lớp backend **riêng cho từng loại client** — thay vì tất cả clients gọi chung 1 API.

```
❌ Không có BFF:
  Mobile App  ──────────────────────────────▶ API Gateway
  Web Browser ──────────────────────────────▶ API Gateway
  Admin Panel ──────────────────────────────▶ API Gateway
              (cùng API, nhưng nhu cầu khác nhau)

✅ Có BFF:
  Mobile App  ──▶ BFF Mobile  ──▶ API Gateway ──▶ Services
  Web Browser ──▶ BFF Web     ──▶ API Gateway ──▶ Services
  Admin Panel ──▶ BFF Admin   ──▶ API Gateway ──▶ Services
              (mỗi BFF tailored cho client của nó)
```

---

## Vấn đề BFF giải quyết

### Vấn đề 1 — Over-fetching

Trang product detail của web cần:

```json
{
  "product": { "id", "name", "price", "images", "description", "specs" },
  "reviews": [{ "rating", "comment", "user" }],
  "relatedProducts": [{ "id", "name", "price", "thumbnail" }],
  "stock": { "available", "quantity" }
}
```

Nhưng API trả về toàn bộ mỗi resource → client nhận data thừa, chậm.

**BFF giải quyết**: Aggregate đúng data cần thiết cho trang đó, trim fields thừa.

---

### Vấn đề 2 — Waterfall requests

```
❌ Không có BFF (client tự gọi):
  1. GET /products/123          → 50ms
  2. GET /reviews?productId=123 → 50ms  (chờ bước 1 xong)
  3. GET /stock/123             → 50ms  (chờ bước 2 xong)
  Tổng: 150ms + network roundtrip × 3

✅ Có BFF (parallel trên server):
  Client → BFF (1 request)
  BFF gọi parallel:
    Promise.all([
      productService.get(123),    → 50ms ┐
      reviewService.getFor(123),  → 50ms ├─ parallel
      stockService.get(123),      → 50ms ┘
    ])
  Tổng: 50ms + 1 network roundtrip
```

---

### Vấn đề 3 — Mobile vs Web khác nhau

|             | Web                       | Mobile            |
| ----------- | ------------------------- | ----------------- |
| Bandwidth   | Tốt                       | Hạn chế (4G/5G)   |
| Screen size | Lớn                       | Nhỏ               |
| Data cần    | Nhiều (SEO, full content) | Ít (chỉ hiển thị) |
| Auth        | Cookie + token            | Token only        |
| Cache       | Browser cache             | App cache         |

BFF Mobile trả về payload nhỏ hơn, BFF Web trả về đầy đủ.

---

## BFF trong hệ thống hiện tại

Hệ thống hiện có **Next.js 14 App Router** — đây là nơi implement BFF **tự nhiên nhất**.

### Next.js Route Handlers = BFF layer

```
web/src/app/api/           ← đây là BFF của Next.js
├── products/
│   ├── [id]/
│   │   └── route.ts      ← GET /api/products/:id (aggregate data)
├── cart/
│   └── route.ts
└── checkout/
    └── route.ts
```

### Ví dụ: Product Detail Page

```typescript
// web/src/app/api/products/[id]/route.ts — BFF endpoint

import { NextRequest, NextResponse } from "next/server";

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  const { id } = params;
  const accessToken = request.cookies.get("accessToken")?.value;

  // Gọi parallel đến các microservices
  const [product, reviews, stock, relatedProducts] = await Promise.all([
    fetch(`${process.env.PRODUCT_SERVICE_URL}/api/v1/products/${id}`),
    fetch(
      `${process.env.PRODUCT_SERVICE_URL}/api/v1/reviews?productId=${id}&limit=10`,
    ),
    fetch(`${process.env.INVENTORY_SERVICE_URL}/api/v1/stock/${id}`),
    fetch(
      `${process.env.PRODUCT_SERVICE_URL}/api/v1/products/${id}/related?limit=6`,
    ),
  ]);

  // Aggregate + shape response cho web client
  return NextResponse.json({
    product: await product.json(),
    reviews: await reviews.json(),
    stock: await stock.json(),
    relatedProducts: await relatedProducts.json(),
  });
}
```

### Ví dụ: Checkout Page (cần auth)

```typescript
// web/src/app/api/checkout/summary/route.ts

export async function GET(request: NextRequest) {
  // BFF có thể đọc httpOnly cookie → forward token đến services
  const refreshToken = request.cookies.get("refreshToken")?.value;
  const accessToken = await getAccessToken(refreshToken);

  const userId = getUserIdFromToken(accessToken);

  const [cart, addresses, promotions] = await Promise.all([
    fetch(`${CART_URL}/api/v1/cart/${userId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    }),
    fetch(`${AUTH_URL}/api/v1/users/${userId}/addresses`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    }),
    fetch(`${PROMOTION_URL}/api/v1/promotions/active`),
  ]);

  return NextResponse.json({
    cart: await cart.json(),
    addresses: await addresses.json(),
    promotions: await promotions.json(),
  });
}
```

---

## Next.js Server Components = BFF inline

App Router cho phép fetch data **trực tiếp trong component** chạy trên server — không cần Route Handler:

```typescript
// web/src/app/products/[id]/page.tsx — Server Component

async function ProductPage({ params }: { params: { id: string } }) {
  // Code này chạy trên server — KHÔNG expose ra client
  // Đây chính là BFF pattern inline
  const [product, reviews] = await Promise.all([
    fetch(`${process.env.PRODUCT_SERVICE_URL}/api/v1/products/${params.id}`, {
      next: { revalidate: 60 },  // ISR cache 60 giây
    }).then(r => r.json()),

    fetch(`${process.env.PRODUCT_SERVICE_URL}/api/v1/reviews?productId=${params.id}`).then(r => r.json()),
  ]);

  return (
    <div>
      <ProductDetail product={product} />
      <ReviewList reviews={reviews} />
    </div>
  );
}
```

**Lợi ích**: URL của microservices **không bao giờ expose** ra browser. Client chỉ thấy domain của Next.js app.

---

## Khi nào dùng Route Handler vs Server Component

|                | Server Component                     | Route Handler (`/api/*`)       |
| -------------- | ------------------------------------ | ------------------------------ |
| **Dùng khi**   | Render HTML (SSR/SSG)                | Client-side fetch (SPA-style)  |
| **Trả về**     | HTML/JSX                             | JSON                           |
| **Client gọi** | Không (chạy build time/request time) | `fetch('/api/...')` từ browser |
| **Ví dụ**      | Product page, Home page              | Cart update, Form submit       |

---

## Khi nào cần BFF riêng (separate service)

Hệ thống hiện tại **chưa cần** BFF riêng. Nhưng cần khi:

```
✅ Cần BFF riêng khi:
  - Có thêm mobile app cần API khác web
  - Team mobile và team web work độc lập
  - Logic BFF quá phức tạp để để trong Next.js
  - Cần BFF cho third-party integrations

❌ Chưa cần BFF riêng khi:
  - Chỉ có 1 loại client (web)
  - Next.js Server Components đủ handle
  - Team nhỏ
```

Nếu cần BFF riêng, thêm NestJS service:

```
services/
├── api-gateway/         ← hiện tại (auth + proxy)
├── bff-web/             ← BFF cho Next.js web (port 3010)
├── bff-mobile/          ← BFF cho React Native app (port 3011)
└── ...
```

---

## Luồng hoàn chỉnh trong hệ thống hiện tại

```
Browser
  │
  ├─ Server Component (SSR) ──────────────────────────────────▶ Microservices
  │  (Next.js server, không qua gateway)                        (trực tiếp)
  │
  ├─ Route Handler /api/* ──▶ Nginx ──▶ api-gateway ──▶ Microservices
  │  (client-side fetch)
  │
  └─ Client Component fetch ──▶ Nginx ──▶ api-gateway ──▶ Microservices
     (useEffect, mutations)
```

**Note**: Server Components nên gọi thẳng đến service URL (qua internal network) thay vì qua Nginx/gateway → nhanh hơn, không tốn rate limit.

---

## Tóm tắt

| Pattern                           | Dùng khi                               | Ví dụ                       |
| --------------------------------- | -------------------------------------- | --------------------------- |
| **Server Component (inline BFF)** | SSR pages, initial data load           | Product page, Category page |
| **Route Handler BFF**             | Client mutations, client-side fetching | Add to cart, Update profile |
| **Dedicated BFF service**         | Nhiều client types, team lớn           | Khi có mobile app           |
| **Gọi thẳng API Gateway**         | Simple CRUD, không cần aggregate       | Admin panel                 |
