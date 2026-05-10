# Tổng quan các file đã tạo — Bin E-Commerce

> **Phiên bản tài liệu:** April 2026  
> **Trạng thái:** Phase A (infra), Phase B (tsconfig/monorepo), Phase C (scaffold services), Phase D (api-gateway) — **DONE**

---

## Mục lục

1. [Cấu trúc thư mục](#1-cấu-trúc-thư-mục)
2. [Monorepo root](#2-monorepo-root)
3. [Infrastructure — `infra/`](#3-infrastructure--infra)
4. [API Gateway — `services/api-gateway/`](#4-api-gateway--servicesapi-gateway)
5. [10 NestJS Services scaffold](#5-10-nestjs-services-scaffold)
6. [docker-compose.yml (root)](#6-docker-composeyml-root)
7. [Luồng request end-to-end](#7-luồng-request-end-to-end)

---

## 1. Cấu trúc thư mục

```
e:\Study\Project\E-commerce\
├── package.json                    ← npm workspaces root
├── tsconfig.base.json              ← TypeScript base config (inherited by all services)
├── turbo.json                      ← Turbo build pipeline
├── .env.example                    ← Template biến môi trường
├── docker-compose.yml              ← Chạy 10 NestJS services + Nginx
│
├── infra/
│   ├── docker/
│   │   └── docker-compose.infra.yml   ← Postgres, MongoDB, Redis, Kafka, Keycloak, Prometheus, Grafana
│   ├── keycloak/
│   │   └── realm-export/
│   │       └── bin-ecommerce-realm.json   ← Keycloak realm auto-import
│   ├── nginx/
│   │   └── conf.d/
│   │       └── default.conf        ← Reverse proxy + rate limiting
│   └── prometheus/
│       └── prometheus.yml          ← Scrape config
│
├── services/
│   ├── api-gateway/                ← Port 3000
│   ├── auth-service/               ← Port 3001
│   ├── product-service/            ← Port 3002
│   ├── cart-service/               ← Port 3003
│   ├── order-service/              ← Port 3004
│   ├── inventory-service/          ← Port 3005
│   ├── notification-service/       ← Port 3006
│   ├── shipping-service/           ← Port 3007
│   ├── promotion-service/          ← Port 3008
│   └── return-service/             ← Port 3009
│
├── packages/
│   └── common/                     ← Shared DTOs, enums, Kafka event contracts
│
└── web/                            ← Next.js 14 frontend
```

---

## 2. Monorepo root

### `package.json`
```json
{
  "workspaces": ["packages/*", "services/*"]
}
```
- **npm workspaces**: mỗi thư mục trong `packages/` và `services/` là một package độc lập.
- `npm install` ở root sẽ cài tất cả dependencies và link symlinks giữa packages.
- Scripts: `infra:up`, `infra:down`, `services:up` (chạy docker compose).

### `tsconfig.base.json`
- Tất cả services đều `extends: "../../tsconfig.base.json"`.
- Các flag quan trọng:
  - `strict: true` — no `any`, strict null checks, v.v.
  - `experimentalDecorators: true` + `emitDecoratorMetadata: true` — **bắt buộc** cho NestJS (`@Injectable`, `@Controller`, v.v.).
  - `target: ES2022` — hỗ trợ async/await, optional chaining native.
  - `ignoreDeprecations: "6.0"` — suppress `baseUrl` deprecation warning (TypeScript 5.7).

### `turbo.json`
Turbo là build orchestrator cho monorepo:
```
npm run build  →  turbo build  →  build các packages trước, rồi services (theo dependency graph)
```
Tasks có `dependsOn: ["^build"]` nghĩa là chạy sau khi tất cả dependencies đã build xong.

---

## 3. Infrastructure — `infra/`

### `infra/docker/docker-compose.infra.yml`

Chạy riêng môi trường infra (tương đương EC2-B):

| Service | Image | Port | Mục đích |
|---------|-------|------|----------|
| `postgres` | `postgres:16-alpine` | 5432 | Database cho 7 services |
| `mongo` | `mongo:7-jammy` | 27017 | Database cho cart, notification, product |
| `redis` | `redis:7-alpine` | 6379 | Cache, session |
| `kafka` | `bitnami/kafka:3.7` | 9092 | Message broker (KRaft, không cần ZooKeeper) |
| `keycloak` | `keycloak:24.0` | 8080 | Identity Provider |
| `prometheus` | `prom/prometheus:2.51.2` | 9090 | Metrics scraping |
| `grafana` | `grafana:10.4.2` | 3030 | Metrics dashboard |

**Cách chạy:**
```bash
docker compose -f infra/docker/docker-compose.infra.yml up -d
```

**Lưu ý RAM (EC2 t3.micro 1GB):**
- Kafka KRaft mode: tiết kiệm ~150MB RAM so với ZooKeeper mode.
- Kafka JVM: `-Xmx128m -Xms64m`.
- Keycloak: `-Xmx256m`.
- Redis: `maxmemory 64mb allkeys-lru`.

### `infra/keycloak/realm-export/bin-ecommerce-realm.json`
File này được **Keycloak tự động import** khi start với `--import-realm`.

Cấu hình quan trọng:
- **Realm**: `bin-ecommerce`
- **Roles**: `USER` (default), `ADMIN`
- **Client `api-gateway`**: `directAccessGrantsEnabled: true` → ROPC grant (username/password → token)
- **Client `web-client`**: public client, standard flow (Authorization Code)
- **Password policy**: length(8) + upperCase + lowerCase + digits + specialChars + notUsername + notEmail
- **Brute force protection**: khóa tài khoản sau 5 lần đăng nhập sai
- **Protocol mapper**: inject `roles` vào JWT payload

### `infra/nginx/conf.d/default.conf`
Nginx đứng trước API Gateway, xử lý:

```
Client → Nginx (port 80/443) → api-gateway:3000 → [các microservices]
```

**Rate limiting zones:**
```nginx
limit_req_zone $binary_remote_addr zone=api_global:10m rate=100r/m;   # 100 req/min
limit_req_zone $binary_remote_addr zone=auth_strict:10m rate=10r/m;   # 10 req/min (login/register)
```

Auth endpoints (`/api/auth/login`, `/register`, `/refresh`, v.v.) áp dụng zone `auth_strict` để chống brute force.

**Security headers** được thêm vào mọi response:
- `X-Frame-Options: DENY`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`

### `infra/prometheus/prometheus.yml`
Prometheus scrape tất cả 10 services qua endpoint `GET /api/metrics` (ports 3000–3009) mỗi 15 giây.

---

## 4. API Gateway — `services/api-gateway/`

API Gateway là **entry point duy nhất** cho tất cả request từ client. Không service nào được expose trực tiếp ra ngoài.

### Cấu trúc thư mục

```
services/api-gateway/src/
├── main.ts                         ← Bootstrap NestJS app
├── app.module.ts                   ← Root module
├── common/
│   ├── decorators/
│   │   └── public.decorator.ts     ← @Public() — bypass JWT
│   ├── guards/
│   │   └── jwt-auth.guard.ts       ← Global JWT guard
│   └── services/
│       ├── jwks.service.ts         ← Fetch + cache Keycloak public keys
│       └── proxy.service.ts        ← Forward request đến microservice
└── modules/
    ├── health/                     ← GET /api/health
    ├── auth/                       ← Proxy đến auth-service:3001
    ├── product/                    ← Proxy đến product-service:3002
    ├── cart/                       ← Proxy đến cart-service:3003
    ├── order/                      ← Proxy đến order-service:3004
    ├── inventory/                  ← Proxy đến inventory-service:3005
    ├── notification/               ← Proxy đến notification-service:3006
    ├── shipping/                   ← Proxy đến shipping-service:3007
    ├── promotion/                  ← Proxy đến promotion-service:3008
    └── return/                     ← Proxy đến return-service:3009
```

### Luồng xác thực JWT

```
Request → JwtAuthGuard.canActivate()
            ↓
         Route có @Public()?  → YES → tiếp tục (không check JWT)
            ↓ NO
         Lấy Bearer token từ Authorization header
            ↓
         JwksService.verifyToken(token)
            ├── jwt.decode(token) → lấy kid (Key ID)
            ├── jwksClient.getSigningKey(kid) → fetch public key từ Keycloak JWKS endpoint
            │   (cached 1 giờ)
            └── jwt.verify(token, publicKey, { algorithms: ['RS256'], issuer: ... })
            ↓
         Inject vào request headers:
            X-User-Id: <sub>
            X-User-Email: <email>
            X-User-Roles: USER,ADMIN
            ↓
         ProxyService.forward(targetUrl, req)
```

### `JwksService`
- Kết nối tới: `http://keycloak:8080/realms/bin-ecommerce/protocol/openid-connect/certs`
- Cache public keys **1 giờ** — giảm network call đến Keycloak
- Rate limit: tối đa 10 JWKS request/phút (tránh flood Keycloak nếu có nhiều tokens invalid)

### `ProxyService`
- Forward **method + body + query params** nguyên vẹn đến upstream service.
- Chỉ forward headers an toàn: `X-User-*`, `Content-Type`, `X-Forwarded-For`.
- **KHÔNG forward** `Authorization` header — các services tin tưởng `X-User-*` từ gateway.
- Nếu upstream không phản hồi → throw `InternalServerErrorException`.

### `@Public()` decorator
Dùng cho các route không cần đăng nhập:
```typescript
@Public()
@Post('login')
login(@Body() dto: LoginDto) { ... }
```

### Proxy modules (ví dụ: `auth-proxy.module.ts`)
Mỗi module có:
- `*-proxy.controller.ts`: bắt tất cả routes `@All('*splat')` trong domain đó
- Forward đến service URL đọc từ env (`AUTH_SERVICE_URL`, `PRODUCT_SERVICE_URL`, v.v.)

---

## 5. 10 NestJS Services scaffold

Mỗi service có cấu trúc giống nhau:

```
services/<name>/
├── package.json       ← dependencies riêng (TypeORM/Mongoose tuỳ loại DB)
├── tsconfig.json      ← extends ../../tsconfig.base.json
├── Dockerfile         ← multi-stage build, non-root user
└── src/
    ├── main.ts        ← Bootstrap
    └── app.module.ts  ← Root module (ConfigModule + DB + Throttler + Terminus)
```

### Database theo service

| Service | PostgreSQL | MongoDB | Redis | Kafka |
|---------|-----------|---------|-------|-------|
| auth-service | ✅ `bin_auth` | | | ✅ |
| product-service | ✅ `bin_product` | ✅ `bin_product` | | |
| cart-service | | ✅ `bin_cart` | ✅ | |
| order-service | ✅ `bin_order` | | | ✅ |
| inventory-service | ✅ `bin_inventory` | | | ✅ |
| notification-service | | ✅ `bin_notification` | | ✅ |
| shipping-service | ✅ `bin_shipping` | | | ✅ |
| promotion-service | ✅ `bin_promotion` | | | ✅ |
| return-service | ✅ `bin_return` | | | ✅ |

### `src/main.ts` — pattern chuẩn

```typescript
app.setGlobalPrefix('api');
app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
// → endpoint: POST /api/v1/auth/login
```

**ValidationPipe config:**
- `whitelist: true` — loại bỏ các fields không khai báo trong DTO
- `forbidNonWhitelisted: true` — throw error nếu có fields lạ (security)
- `transform: true` — tự động convert string sang number, v.v.

**`enableCors({ origin: false })`** — các services không accept request từ browser trực tiếp, chỉ accept từ gateway (internal Docker network).

### `Dockerfile` — multi-stage build

```dockerfile
# Stage 1: builder — có devDeps, biên dịch TypeScript → JavaScript
FROM node:20-alpine AS builder
...
RUN npx nest build   # → dist/

# Stage 2: production — chỉ có runtime, không có source code
FROM node:20-alpine AS production
RUN adduser -S nestjs -u 1001   # non-root user (security)
COPY --from=builder dist/ ./dist/
RUN npm install --omit=dev      # production deps only
USER nestjs
CMD ["node", "--max-old-space-size=100", "dist/main"]
#                    ↑ giới hạn 100MB heap — quan trọng cho EC2 t3.micro
```

**HEALTHCHECK:**
```dockerfile
HEALTHCHECK CMD wget -qO- http://localhost:<PORT>/api/health || exit 1
```
Docker (và docker-compose `depends_on: condition: service_healthy`) dùng healthcheck để biết service đã sẵn sàng chưa.

---

## 6. `docker-compose.yml` (root)

Chạy toàn bộ 10 NestJS services + Nginx:

```bash
# Bước 1: Start infra
docker compose -f infra/docker/docker-compose.infra.yml up -d

# Bước 2: Start services
docker compose up -d
```

**Hai networks:**
- `bin_infra_net` — `external: true`, shared với infra compose (để services kết nối Postgres, Kafka, v.v.)
- `bin_app_net` — internal, chỉ services và Nginx

**Memory limits:**
```yaml
deploy:
  resources:
    limits:
      memory: 150m      # 100m heap + 50m headroom
    reservations:
      memory: 64m
```

**`depends_on` với health checks:**
```yaml
api-gateway:
  depends_on:
    auth-service:
      condition: service_healthy   # chờ auth-service healthy mới start gateway
```

---

## 7. Luồng request end-to-end

### Ví dụ: `POST /api/auth/login`

```
Browser
  → Nginx (rate limit: 10 req/min cho auth endpoints)
    → api-gateway:3000
      → JwtAuthGuard: route login có @Public() → skip JWT
      → AuthProxyController: forward POST /api/auth/login
        → auth-service:3001/api/v1/auth/login
          → Keycloak ROPC: POST /realms/bin-ecommerce/protocol/openid-connect/token
          ← { access_token, refresh_token, expires_in }
        ← 200 OK { data: { accessToken, user }, statusCode: 200 }
      ← (proxy trả về response nguyên vẹn)
    ←
  ← Set-Cookie: refreshToken=...; HttpOnly; Secure
```

### Ví dụ: `GET /api/orders` (protected)

```
Browser  [Authorization: Bearer <access_token>]
  → Nginx
    → api-gateway:3000
      → JwtAuthGuard:
          1. jwt.decode(token) → kid
          2. jwksClient.getSigningKey(kid) → publicKey (from cache/Keycloak)
          3. jwt.verify(token, publicKey, RS256) → { sub, email, roles }
          4. inject headers: X-User-Id, X-User-Email, X-User-Roles
      → OrderProxyController: forward GET /api/orders
        → order-service:3004/api/v1/orders
          → đọc X-User-Id từ header (không cần verify JWT lại)
          ← 200 OK { data: [...orders], statusCode: 200 }
      ←
    ←
  ←
```
