# 🗂️ JIRA Sprint Planning — E-Commerce MVP

> **Project Key:** `ECM`
> **Board type:** Scrum
> **Sprint length:** 2 tuần
> **Team:** `@fullstack` (1 Fullstack Developer) · `@qa` (1 QA/Tester)
> **Timeline:** 21/04/2026 → 14/08/2026 — **8 Sprints**
> **Story Point Scale:** Fibonacci (1 · 2 · 3 · 5 · 8 · 13)
> **Priority:** 🔴 Highest · 🟠 High · 🟡 Medium · 🔵 Low · ⚪ Trivial

---

## 📌 Epics Overview

| Epic Key | Epic Name                            | Mô tả                                | Sprint   |
| -------- | ------------------------------------ | ------------------------------------ | -------- |
| `ECM-E1` | 🏗️ Infrastructure Setup              | Môi trường, server, CI/CD skeleton   | Sprint 1 |
| `ECM-E2` | 🔐 Authentication & Authorization    | Keycloak, JWT, API Gateway           | Sprint 2 |
| `ECM-E3` | 📦 Product Catalog                   | CRUD sản phẩm, danh mục, ảnh         | Sprint 3 |
| `ECM-E4` | 🛒 Cart & Inventory                  | Giỏ hàng, tồn kho, reserve/release   | Sprint 4 |
| `ECM-E5` | 📋 Order Management & Saga           | Tạo đơn, Camunda orchestration, Saga | Sprint 5 |
| `ECM-E6` | 💳 Payment & Notification            | Stripe, email, Kafka EDA hoàn chỉnh  | Sprint 6 |
| `ECM-E7` | 🖥️ Frontend (Next.js)                | Giao diện người dùng, Vercel deploy  | Sprint 7 |
| `ECM-E8` | 📊 Monitoring & Production Hardening | Grafana, k6, security, polish        | Sprint 8 |

---

## 🔖 Label Convention

| Label          | Ý nghĩa                          |
| -------------- | -------------------------------- |
| `backend`      | NestJS / API logic               |
| `frontend`     | Next.js / UI                     |
| `infra`        | Docker, EC2, server config       |
| `testing`      | Unit test / API test / E2E       |
| `devops`       | CI/CD, Dokploy, GitHub Actions   |
| `security`     | Auth, JWT, permissions           |
| `kafka`        | Event-driven logic               |
| `camunda`      | Zeebe / BPMN / Saga              |
| `swagger`      | API docs                         |
| `ram-critical` | Liên quan đến OOM / memory limit |

---

## 🏁 Backlog — User Stories

### Epic ECM-E1: Infrastructure Setup

```
ECM-1  [Story] Tạo và cấu hình EC2-A (App Server)
ECM-2  [Story] Tạo và cấu hình EC2-B (Infra Server)
ECM-3  [Story] Setup Swap File 4GB trên cả 2 EC2
ECM-4  [Story] Cài đặt Docker + Docker Compose
ECM-5  [Story] Cài đặt và cấu hình Dokploy
ECM-6  [Story] Cấu hình Nginx + SSL (Let's Encrypt via Dokploy)
ECM-7  [Story] Tạo AWS RDS PostgreSQL Free Tier
ECM-8  [Story] Tạo MongoDB Atlas M0
ECM-9  [Story] Khởi tạo monorepo với Turborepo
ECM-10 [Story] Setup Kafka KRaft trên EC2-B
ECM-11 [Story] Setup Keycloak trên EC2-B với RAM limit
ECM-12 [Story] Setup Camunda 8 SaaS Free account
ECM-13 [Story] Tạo GitHub repository + branch strategy
ECM-14 [Story] Setup GitHub Actions skeleton (lint only)
ECM-15 [Task]  QA: Viết Infrastructure Smoke Test Checklist
```

### Epic ECM-E2: Authentication & Authorization

```
ECM-16 [Story] Scaffold API Gateway Service (NestJS)
ECM-17 [Story] Scaffold Auth Service (NestJS)
ECM-18 [Story] Implement user registration với Keycloak
ECM-19 [Story] Implement user login / token refresh
ECM-20 [Story] Implement JWT Guard tại API Gateway
ECM-21 [Story] Implement Role-based Access Control (RBAC)
ECM-22 [Story] Setup Swagger CDN strategy + aggregation tại Gateway
ECM-23 [Task]  Unit Test: AuthService (login, register logic)
ECM-24 [Task]  QA: Postman Collection — Auth API
ECM-25 [Task]  Dokploy: Deploy Gateway + Auth Service
```

### Epic ECM-E3: Product Catalog

```
ECM-26 [Story] Scaffold Product Service (NestJS + TypeORM)
ECM-27 [Story] Implement Product CRUD (Admin only)
ECM-28 [Story] Implement Category CRUD
ECM-29 [Story] Implement Product Search + Pagination + Filter
ECM-30 [Story] Implement Image Upload via Cloudinary
ECM-31 [Task]  Unit Test: ProductService (create, search, update)
ECM-32 [Task]  QA: Postman Collection — Product API
ECM-33 [Task]  QA: Data-driven test (CSV) cho Product creation
```

### Epic ECM-E4: Cart & Inventory

```
ECM-34 [Story] Scaffold Cart Service (NestJS + MongoDB)
ECM-35 [Story] Implement Cart CRUD (add/update/remove/get/clear)
ECM-36 [Story] Implement Cart TTL (7 ngày inactivity)
ECM-37 [Story] Scaffold Inventory Service (NestJS + TypeORM)
ECM-38 [Story] Implement Reserve Inventory (pessimistic lock)
ECM-39 [Story] Implement Release Inventory
ECM-40 [Story] Kafka Producer: publish inventory.reserved / released
ECM-41 [Task]  Unit Test: InventoryService (reserve, release, check stock)
ECM-42 [Task]  QA: Postman Collection — Cart API
ECM-43 [Task]  QA: Postman Collection — Inventory API
ECM-44 [Bug]   Race Condition Test: oversell prevention
```

### Epic ECM-E5: Order Management & Saga

```
ECM-45 [Story] Scaffold Order Service (NestJS + TypeORM)
ECM-46 [Story] Thiết kế BPMN Order Fulfillment trên Camunda Modeler
ECM-47 [Story] Deploy BPMN lên Camunda 8 SaaS
ECM-48 [Story] Implement Zeebe Client + Job Worker: validate-order
ECM-49 [Story] Implement Zeebe Job Worker: reserve-inventory
ECM-50 [Story] Implement Zeebe Job Worker: process-payment
ECM-51 [Story] Implement Zeebe Job Worker: confirm-order
ECM-52 [Story] Implement Zeebe Job Worker: trigger-shipment
ECM-53 [Story] Implement Compensation: release-inventory
ECM-54 [Story] Implement Compensation: refund-payment
ECM-55 [Story] Kafka Producer: order.created / paid / failed / shipped
ECM-56 [Task]  Unit Test: OrderService (calculateTotal, cancel, publish)
ECM-57 [Task]  QA: Postman Collection — Order API (E2E flow)
ECM-58 [Task]  QA: Verify Camunda Operate — process trace
```

### Epic ECM-E6: Payment & Notification

```
ECM-59 [Story] Tích hợp Stripe Test Mode (Payment Intent)
ECM-60 [Story] Implement Stripe Webhook handler
ECM-61 [Story] Scaffold Notification Service (Kafka Consumer)
ECM-62 [Story] Kafka Consumer: order.paid → send email via SendGrid
ECM-63 [Story] Kafka Consumer: inventory.low → alert admin
ECM-64 [Story] Implement Dead Letter Topic (DLT) cho failed messages
ECM-65 [Task]  QA: Test E2E với Stripe test cards
ECM-66 [Task]  QA: Verify email received (Mailtrap test env)
ECM-67 [Task]  QA: Test Kafka consumer retry + DLT fallback
```

### Epic ECM-E7: Frontend (Next.js)

```
ECM-68 [Story] Setup Next.js + Tailwind CSS + TypeScript
ECM-69 [Story] Integrate Keycloak OIDC (next-auth)
ECM-70 [Story] Page: Home (SSG)
ECM-71 [Story] Page: Product Listing (SSG + ISR)
ECM-72 [Story] Page: Product Detail (ISR)
ECM-73 [Story] Page: Cart
ECM-74 [Story] Page: Checkout Flow + Stripe Elements
ECM-75 [Story] Page: Order History + Order Detail
ECM-76 [Story] Admin Panel: Product Management
ECM-77 [Story] Deploy lên Vercel
ECM-78 [Task]  QA: Playwright E2E — Signup → Browse → Add to Cart → Checkout
ECM-79 [Task]  QA: Cross-browser testing (Chrome, Firefox, Safari)
ECM-80 [Task]  QA: Mobile responsiveness (Tailwind breakpoints)
```

### Epic ECM-E8: Monitoring & Production Hardening

```
ECM-81 [Story] Cấu hình Grafana Dashboards (Node Exporter, Kafka, NestJS)
ECM-82 [Story] Prometheus Alerting Rules (RAM > 80%, Swap > 50%)
ECM-83 [Story] Load Test với k6 (50 concurrent users, 5 phút)
ECM-84 [Story] RAM Tuning dựa trên load test results
ECM-85 [Story] Security Scan cơ bản (OWASP ZAP)
ECM-86 [Task]  Review + hoàn thiện tất cả Swagger @ApiOperation
ECM-87 [Task]  QA: Viết k6 performance test report
ECM-88 [Task]  QA: Regression test suite (toàn bộ Postman collections)
ECM-89 [Task]  Buffer: Bug fixes tổng hợp
```

---

---

# 🏃 Sprint 1 — Infrastructure Foundation

> **Thời gian:** 21/04/2026 — 04/05/2026
> **Sprint Goal:** _"Toàn bộ môi trường server sẵn sàng: 2 EC2 lên sống, Docker chạy, Dokploy deploy được, GitHub repo có nhánh chuẩn, QA có checklist smoke test."_
> **Total Story Points:** 42

---

### ECM-1 — Tạo và cấu hình EC2-A (App Server)

| Field        | Value                       |
| ------------ | --------------------------- |
| **Type**     | Story                       |
| **Epic**     | ECM-E1 Infrastructure Setup |
| **Assignee** | @fullstack                  |
| **Priority** | 🔴 Highest                  |
| **Points**   | 3                           |
| **Labels**   | `infra` `ram-critical`      |

**User Story:**

> As a DevOps Engineer, I want EC2-A (App Server) provisioned and hardened so that all NestJS services can be deployed safely within the 1GB RAM budget.

**Acceptance Criteria:**

- [ ] EC2 t3.micro launched trong AWS Free Tier (region: ap-southeast-1)
- [ ] Security Groups mở đúng ports: `22` (SSH), `80` (HTTP), `443` (HTTPS), `3000-3006` (NestJS), `3100` (Grafana), `9090` (Prometheus)
- [ ] Key pair `.pem` được lưu an toàn (không commit vào Git)
- [ ] User `ubuntu` có thể SSH thành công
- [ ] Hostname set: `ec2-app.ecommerce.internal`
- [ ] `ufw` firewall enabled với chỉ các ports đã khai báo

**Sub-tasks:**

- `ECM-1-1` Launch EC2 t3.micro từ AWS Console
- `ECM-1-2` Cấu hình Security Groups
- `ECM-1-3` SSH vào instance, update packages: `sudo apt update && sudo apt upgrade -y`
- `ECM-1-4` Set hostname + `/etc/hosts` entry

---

### ECM-2 — Tạo và cấu hình EC2-B (Infra Server)

| Field        | Value                  |
| ------------ | ---------------------- |
| **Type**     | Story                  |
| **Epic**     | ECM-E1                 |
| **Assignee** | @fullstack             |
| **Priority** | 🔴 Highest             |
| **Points**   | 3                      |
| **Labels**   | `infra` `ram-critical` |

**User Story:**

> As a DevOps Engineer, I want EC2-B (Infra Server) to host Kafka, Keycloak, Prometheus and Grafana — isolated from app traffic to protect the 1GB RAM of EC2-A.

**Acceptance Criteria:**

- [ ] EC2-B t3.micro trong cùng VPC / Subnet với EC2-A
- [ ] Security Groups: `9092` (Kafka), `8080` (Keycloak), `9090` (Prometheus), `3100` (Grafana), `9100` (Node Exporter)
- [ ] EC2-A và EC2-B ping được nhau qua **Private IP** (VPC internal)
- [ ] Hostname set: `ec2-infra.ecommerce.internal`

**Sub-tasks:**

- `ECM-2-1` Launch EC2-B trong cùng VPC
- `ECM-2-2` Cấu hình Security Groups (restrict: chỉ EC2-A và admin IP mới access)
- `ECM-2-3` Verify VPC connectivity: `ping <EC2-A private IP>` từ EC2-B

---

### ECM-3 — Setup Swap File 4GB trên cả 2 EC2

| Field        | Value                  |
| ------------ | ---------------------- |
| **Type**     | Story                  |
| **Epic**     | ECM-E1                 |
| **Assignee** | @fullstack             |
| **Priority** | 🔴 Highest             |
| **Points**   | 2                      |
| **Labels**   | `infra` `ram-critical` |

**User Story:**

> As a DevOps Engineer, I want 4GB swap configured on both EC2 instances so that memory overflows don't cause immediate OOM kills during low-traffic periods.

**Acceptance Criteria:**

- [ ] File `/swapfile` size 4GB tồn tại trên cả 2 EC2
- [ ] `free -h` hiển thị `Swap: 4.0G`
- [ ] Entry trong `/etc/fstab` để persist sau reboot
- [ ] `vm.swappiness=60` được set trong `/etc/sysctl.conf`
- [ ] `vm.vfs_cache_pressure=50` được set

**Implementation:**

```bash
sudo fallocate -l 4G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
echo 'vm.swappiness=60' | sudo tee -a /etc/sysctl.conf
echo 'vm.vfs_cache_pressure=50' | sudo tee -a /etc/sysctl.conf
sudo sysctl -p
free -h
```

---

### ECM-4 — Cài đặt Docker + Docker Compose

| Field        | Value            |
| ------------ | ---------------- |
| **Type**     | Story            |
| **Epic**     | ECM-E1           |
| **Assignee** | @fullstack       |
| **Priority** | 🔴 Highest       |
| **Points**   | 2                |
| **Labels**   | `infra` `devops` |

**Acceptance Criteria:**

- [ ] Docker Engine (không phải Docker Desktop) installed trên cả 2 EC2
- [ ] `docker --version` trả Docker Engine ≥ 26.x
- [ ] `docker compose version` trả Compose V2 ≥ 2.25
- [ ] User `ubuntu` được add vào group `docker` (không cần sudo)
- [ ] `docker run hello-world` thành công

---

### ECM-5 — Cài đặt và cấu hình Dokploy

| Field        | Value            |
| ------------ | ---------------- |
| **Type**     | Story            |
| **Epic**     | ECM-E1           |
| **Assignee** | @fullstack       |
| **Priority** | 🟠 High          |
| **Points**   | 3                |
| **Labels**   | `infra` `devops` |

**User Story:**

> As a Developer, I want Dokploy installed on EC2-A so that I can deploy Docker Compose apps via web UI and webhooks without managing individual containers manually.

**Acceptance Criteria:**

- [ ] Dokploy cài thành công qua official install script
- [ ] Dokploy Admin UI accessible tại `https://<EC2-A-IP>:3000`
- [ ] Admin account tạo được + password thay đổi từ default
- [ ] GitHub integration được cấu hình (OAuth App hoặc Personal Access Token)
- [ ] SSL certificate provisioned qua Let's Encrypt cho domain (nếu có)
- [ ] Dokploy RAM footprint < 80MB (verify qua `docker stats`)

---

### ECM-6 — Cấu hình Nginx + SSL

| Field        | Value              |
| ------------ | ------------------ |
| **Type**     | Story              |
| **Epic**     | ECM-E1             |
| **Assignee** | @fullstack         |
| **Priority** | 🟠 High            |
| **Points**   | 2                  |
| **Labels**   | `infra` `security` |

**Acceptance Criteria:**

- [ ] Nginx reverse proxy chạy trên EC2-A port 80/443
- [ ] HTTP → HTTPS redirect active
- [ ] SSL cert từ Let's Encrypt (auto-renew via Dokploy hoặc certbot)
- [ ] Proxy rules: `api.ecommerce.local` → API Gateway `:3000`
- [ ] Security headers: `X-Content-Type-Options`, `X-Frame-Options`, `HSTS`
- [ ] Nginx RAM footprint < 30MB

---

### ECM-7 — Tạo AWS RDS PostgreSQL Free Tier

| Field        | Value      |
| ------------ | ---------- |
| **Type**     | Story      |
| **Epic**     | ECM-E1     |
| **Assignee** | @fullstack |
| **Priority** | 🔴 Highest |
| **Points**   | 2          |
| **Labels**   | `infra`    |

**Acceptance Criteria:**

- [ ] RDS instance `db.t3.micro`, engine PostgreSQL 16, storage 20GB (Free Tier)
- [ ] Database: `ecommerce_db`, user: `ecom_user`, password: strong random
- [ ] Security Group: chỉ cho phép EC2-A Private IP kết nối port 5432
- [ ] Credentials lưu trong **AWS Secrets Manager** hoặc `.env` (không commit)
- [ ] EC2-A kết nối được: `psql -h <rds-endpoint> -U ecom_user -d ecommerce_db`
- [ ] Database `keycloak` cũng được tạo (cho Sprint 2)

---

### ECM-8 — Tạo MongoDB Atlas M0

| Field        | Value      |
| ------------ | ---------- |
| **Type**     | Story      |
| **Epic**     | ECM-E1     |
| **Assignee** | @fullstack |
| **Priority** | 🟠 High    |
| **Points**   | 1          |
| **Labels**   | `infra`    |

**Acceptance Criteria:**

- [ ] Atlas M0 cluster tạo thành công (region: Singapore)
- [ ] Network Access: whitelist EC2-A Public IP
- [ ] Database user tạo với quyền `readWrite` trên db `ecommerce`
- [ ] Connection string lưu vào `.env.example`
- [ ] Test kết nối từ EC2-A: `mongosh "<connection-string>"`

---

### ECM-9 — Khởi tạo Monorepo với Turborepo

| Field        | Value                      |
| ------------ | -------------------------- |
| **Type**     | Story                      |
| **Epic**     | ECM-E1                     |
| **Assignee** | @fullstack                 |
| **Priority** | 🟠 High                    |
| **Points**   | 3                          |
| **Labels**   | `infra` `devops` `backend` |

**Acceptance Criteria:**

- [ ] Cấu trúc thư mục:
  ```
  /
  ├── apps/
  │   ├── api-gateway/
  │   ├── auth-service/
  │   ├── product-service/
  │   ├── cart-service/
  │   ├── order-service/
  │   ├── inventory-service/
  │   └── notification-service/
  ├── packages/
  │   └── common/          # Shared types, Kafka topics, enums
  ├── turbo.json
  ├── pnpm-workspace.yaml
  ├── tsconfig.base.json
  ├── .prettierrc
  └── package.json
  ```
- [ ] `pnpm install` chạy thành công từ root
- [ ] `pnpm run build` (turbo) thành công cho `@ecommerce/common`
- [ ] `@ecommerce/common` export: `KAFKA_TOPICS`, `OrderStatus`, `ZEEBE_JOBS`, shared DTOs
- [ ] `.gitignore` chuẩn (node_modules, dist, .env, coverage)

---

### ECM-10 — Setup Kafka KRaft trên EC2-B

| Field        | Value                          |
| ------------ | ------------------------------ |
| **Type**     | Story                          |
| **Epic**     | ECM-E1                         |
| **Assignee** | @fullstack                     |
| **Priority** | 🟠 High                        |
| **Points**   | 3                              |
| **Labels**   | `infra` `kafka` `ram-critical` |

**User Story:**

> As a Developer, I want Kafka running in KRaft mode (no ZooKeeper) on EC2-B so that I save ~200MB RAM while having a fully functional event broker.

**Acceptance Criteria:**

- [ ] Kafka 7.6+ running in KRaft mode (no ZooKeeper container)
- [ ] `KAFKA_HEAP_OPTS: "-Xmx128m -Xms64m"` được set
- [ ] `deploy.resources.limits.memory: 200m` trong Docker Compose
- [ ] Kafka reachable từ EC2-A: `kafka-topics.sh --bootstrap-server <EC2-B-private-IP>:9092 --list`
- [ ] Test publish/consume message thành công
- [ ] JMX Exporter sidecar chạy ở `:9308` (cho Prometheus scrape)

---

### ECM-11 — Setup Keycloak với RAM limit

| Field        | Value                             |
| ------------ | --------------------------------- |
| **Type**     | Story                             |
| **Epic**     | ECM-E1                            |
| **Assignee** | @fullstack                        |
| **Priority** | 🟠 High                           |
| **Points**   | 3                                 |
| **Labels**   | `infra` `security` `ram-critical` |

**Acceptance Criteria:**

- [ ] Keycloak 24 chạy với `JAVA_OPTS: "-Xmx256m -Xms128m"`
- [ ] `deploy.resources.limits.memory: 320m`
- [ ] Realm `ecommerce` được tạo
- [ ] Client `ecommerce-backend` (confidential) và `ecommerce-frontend` (public) được tạo
- [ ] Roles: `ADMIN`, `USER` được tạo trong realm
- [ ] Test user admin: `admin@ecommerce.com` / `Admin@12345`
- [ ] Keycloak Admin Console accessible: `http://<EC2-B-private-IP>:8080`
- [ ] KC_DB trỏ đến RDS PostgreSQL (không dùng H2/SQLite)

---

### ECM-12 — Setup Camunda 8 SaaS Free Account

| Field        | Value             |
| ------------ | ----------------- |
| **Type**     | Story             |
| **Epic**     | ECM-E1            |
| **Assignee** | @fullstack        |
| **Priority** | 🟠 High           |
| **Points**   | 2                 |
| **Labels**   | `infra` `camunda` |

**Acceptance Criteria:**

- [ ] Tài khoản Camunda 8 SaaS tạo tại `https://camunda.io`
- [ ] Cluster "ecommerce-dev" được tạo (Free Plan: 1 cluster, 3 process instances/day)
- [ ] API Credentials (Client ID + Client Secret) tạo và lưu vào `.env.example`
- [ ] Zeebe endpoint URL lưu vào `.env.example`
- [ ] Test kết nối từ local: `zbctl status --address <zeebe-endpoint>`

---

### ECM-13 — GitHub Repository + Branch Strategy

| Field        | Value      |
| ------------ | ---------- |
| **Type**     | Story      |
| **Epic**     | ECM-E1     |
| **Assignee** | @fullstack |
| **Priority** | 🟠 High    |
| **Points**   | 2          |
| **Labels**   | `devops`   |

**Acceptance Criteria:**

- [ ] Repo `ecommerce-mvp` được tạo trên GitHub (private)
- [ ] Branch `main` = production, protected (require PR + CI pass to merge)
- [ ] Branch `develop` = integration branch
- [ ] Feature branch convention: `feature/ECM-XX-short-description`
- [ ] Bugfix branch: `bugfix/ECM-XX-short-description`
- [ ] `CODEOWNERS` file: `@fullstack` review backend, `@qa` review test files
- [ ] `.env.example` committed với tất cả required keys (values là placeholder)

---

### ECM-14 — Setup GitHub Actions Skeleton

| Field        | Value            |
| ------------ | ---------------- |
| **Type**     | Story            |
| **Epic**     | ECM-E1           |
| **Assignee** | @fullstack       |
| **Priority** | 🟡 Medium        |
| **Points**   | 3                |
| **Labels**   | `devops` `ci/cd` |

**Acceptance Criteria:**

- [ ] File `.github/workflows/main.yml` tạo với 3 jobs: `test-unit`, `test-api`, `build-and-deploy`
- [ ] `test-unit` job: `pnpm lint` + `pnpm test:cov`
- [ ] `test-api` job: start service → run Newman (placeholder, pass ngay cả khi collection rỗng)
- [ ] `build-and-deploy` job: chỉ chạy khi `needs: [test-unit, test-api]` pass + `ref == main`
- [ ] GitHub Secrets cần có: `DOKPLOY_TOKEN`, `DOKPLOY_HOST` (được document trong README)
- [ ] CI badge thêm vào README

---

### ECM-15 — QA: Infrastructure Smoke Test Checklist

| Field        | Value             |
| ------------ | ----------------- |
| **Type**     | Task              |
| **Epic**     | ECM-E1            |
| **Assignee** | @qa               |
| **Priority** | 🟠 High           |
| **Points**   | 2                 |
| **Labels**   | `testing` `infra` |

**Acceptance Criteria:**

- [ ] Checklist document tại `docs/qa/smoke-test-checklist.md`
- [ ] Bao gồm kiểm tra: EC2-A SSH, EC2-B SSH, Docker ps, Kafka ping, Keycloak HTTP, RDS connect, MongoDB connect, Dokploy UI accessible
- [ ] Mỗi item có: command để check + expected output + status (✅/❌)
- [ ] Checklist chạy qua và tất cả ✅ trước khi Sprint 1 close

**Mẫu Checklist:**

```
[ ] EC2-A: ssh ubuntu@<ec2-a-ip>                          → Connected
[ ] EC2-B: ssh ubuntu@<ec2-b-ip>                          → Connected
[ ] Swap EC2-A: free -h                                    → Swap: 4.0G
[ ] Swap EC2-B: free -h                                    → Swap: 4.0G
[ ] Docker EC2-A: docker ps                                → No crash
[ ] Kafka: kafka-topics.sh --list                          → (empty) OK
[ ] Keycloak: curl http://<ec2-b-private>:8080/health     → {"status":"UP"}
[ ] RDS: psql -h <rds> -U ecom_user -c "SELECT 1"        → 1 row
[ ] MongoDB: mongosh "<atlas-uri>" --eval "db.runCommand({ping:1})" → ok: 1
[ ] Dokploy UI: curl https://<ec2-a-ip>:3000              → 200 OK
```

---

**Sprint 1 — Velocity Summary:**

| Assignee   | Stories/Tasks  | Story Points |
| ---------- | -------------- | ------------ |
| @fullstack | ECM-1 ~ ECM-14 | 33 pts       |
| @qa        | ECM-15         | 2 pts        |
| **Total**  | **15 items**   | **35 pts**   |

**Sprint 1 — Definition of Done:**

- [ ] 2 EC2 instances up, SSH-able
- [ ] 4GB Swap active trên cả 2
- [ ] Docker + Dokploy running trên EC2-A
- [ ] Kafka, Keycloak, RDS, MongoDB Atlas accessible
- [ ] Monorepo trên GitHub, CI pipeline skeleton green
- [ ] QA smoke test checklist: tất cả ✅

---

---

# 🏃 Sprint 2 — Auth Service + API Gateway

> **Thời gian:** 05/05/2026 — 18/05/2026
> **Sprint Goal:** _"User đăng ký và đăng nhập được. JWT hợp lệ chạy qua API Gateway. Swagger live tại /api/docs. QA có Postman collection chạy được."_
> **Total Story Points:** 38

---

### ECM-16 — Scaffold API Gateway Service

| Field        | Value               |
| ------------ | ------------------- |
| **Type**     | Story               |
| **Epic**     | ECM-E2              |
| **Assignee** | @fullstack          |
| **Priority** | 🔴 Highest          |
| **Points**   | 3                   |
| **Labels**   | `backend` `swagger` |

**Acceptance Criteria:**

- [ ] NestJS app tạo tại `apps/api-gateway`
- [ ] Port: `3000`, prefix: `/api`
- [ ] Proxy module forward requests đến đúng upstream service
- [ ] Rate limiting: 100 req/min per IP (dùng `@nestjs/throttler`)
- [ ] Global `ValidationPipe` với `whitelist: true`
- [ ] Health check endpoint: `GET /api/health` → `{ status: "ok" }`
- [ ] `GET /api/docs` → Swagger UI với CDN assets (syntaxHighlight: false)
- [ ] Swagger aggregation: load specs từ tất cả services

---

### ECM-17 — Scaffold Auth Service

| Field        | Value                |
| ------------ | -------------------- |
| **Type**     | Story                |
| **Epic**     | ECM-E2               |
| **Assignee** | @fullstack           |
| **Priority** | 🔴 Highest           |
| **Points**   | 3                    |
| **Labels**   | `backend` `security` |

**Acceptance Criteria:**

- [ ] NestJS app tạo tại `apps/auth-service`
- [ ] Port: `3001`, prefix: `/api`
- [ ] TypeORM kết nối RDS, entity `User` (`id`, `email`, `name`, `keycloakId`, `role`)
- [ ] `GET /api/docs` → Swagger UI (CDN assets)
- [ ] `GET /api/docs-json` → OpenAPI JSON spec
- [ ] `/metrics` endpoint expose Prometheus metrics

---

### ECM-18 — Implement User Registration

| Field        | Value                |
| ------------ | -------------------- |
| **Type**     | Story                |
| **Epic**     | ECM-E2               |
| **Assignee** | @fullstack           |
| **Priority** | 🔴 Highest           |
| **Points**   | 5                    |
| **Labels**   | `backend` `security` |

**User Story:**

> As a new user, I want to register with email and password so that I can access the platform.

**Acceptance Criteria:**

- [ ] `POST /api/auth/register` nhận `{ email, password, name }`
- [ ] Tạo user trong Keycloak realm `ecommerce` via Admin REST API
- [ ] Lưu user record vào RDS `users` table với `keycloakId`
- [ ] Validate: email format, password min 8 chars, unique email
- [ ] Trả về `{ id, email, name, role }` (không trả password)
- [ ] HTTP 201 Created khi thành công
- [ ] HTTP 409 Conflict khi email đã tồn tại
- [ ] Swagger `@ApiOperation`, `@ApiResponse` decorators đầy đủ

---

### ECM-19 — Implement Login / Token Refresh

| Field        | Value                |
| ------------ | -------------------- |
| **Type**     | Story                |
| **Epic**     | ECM-E2               |
| **Assignee** | @fullstack           |
| **Priority** | 🔴 Highest           |
| **Points**   | 5                    |
| **Labels**   | `backend` `security` |

**Acceptance Criteria:**

- [ ] `POST /api/auth/login` nhận `{ email, password }` → gọi Keycloak token endpoint
- [ ] Trả về `{ accessToken, refreshToken, expiresIn }`
- [ ] `POST /api/auth/refresh` nhận `{ refreshToken }` → trả `accessToken` mới
- [ ] `POST /api/auth/logout` revoke token trong Keycloak
- [ ] `GET /api/auth/me` (protected) → trả thông tin user hiện tại
- [ ] HTTP 401 khi sai credentials

---

### ECM-20 — Implement JWT Guard tại API Gateway

| Field        | Value                |
| ------------ | -------------------- |
| **Type**     | Story                |
| **Epic**     | ECM-E2               |
| **Assignee** | @fullstack           |
| **Priority** | 🔴 Highest           |
| **Points**   | 3                    |
| **Labels**   | `backend` `security` |

**Acceptance Criteria:**

- [ ] `JwtAuthGuard` verify JWT bằng Keycloak public key (JWKS endpoint)
- [ ] Public key được cache (TTL 1h) để không gọi Keycloak mỗi request
- [ ] Request không có token → 401 Unauthorized
- [ ] Token hết hạn → 401 với message `TOKEN_EXPIRED`
- [ ] Token invalid → 401 với message `INVALID_TOKEN`
- [ ] `userId` và `role` được inject vào request context sau verify

---

### ECM-21 — Implement RBAC (Role-based Access Control)

| Field        | Value                |
| ------------ | -------------------- |
| **Type**     | Story                |
| **Epic**     | ECM-E2               |
| **Assignee** | @fullstack           |
| **Priority** | 🟠 High              |
| **Points**   | 2                    |
| **Labels**   | `backend` `security` |

**Acceptance Criteria:**

- [ ] `@Roles('ADMIN')` decorator hoạt động tại controller method
- [ ] `RolesGuard` kiểm tra role từ JWT claims
- [ ] User với role `USER` gọi Admin endpoint → 403 Forbidden
- [ ] Unit test cho `RolesGuard`

---

### ECM-22 — Setup Swagger CDN + Aggregation

| Field        | Value                              |
| ------------ | ---------------------------------- |
| **Type**     | Story                              |
| **Epic**     | ECM-E2                             |
| **Assignee** | @fullstack                         |
| **Priority** | 🟠 High                            |
| **Points**   | 3                                  |
| **Labels**   | `backend` `swagger` `ram-critical` |

**Acceptance Criteria:**

- [ ] Tất cả NestJS services dùng CDN: `cdn.jsdelivr.net/npm/swagger-ui-dist@5`
- [ ] `syntaxHighlight: false`, `docExpansion: 'none'`, `defaultModelsExpandDepth: 0`
- [ ] API Gateway aggregated Swagger: hiển thị spec từ Auth + (future) tất cả services
- [ ] RAM của mỗi NestJS pod **không tăng** khi load Swagger UI (verify qua `docker stats`)

---

### ECM-23 — Unit Test: AuthService

| Field        | Value               |
| ------------ | ------------------- |
| **Type**     | Task                |
| **Epic**     | ECM-E2              |
| **Assignee** | @fullstack          |
| **Priority** | 🟠 High             |
| **Points**   | 3                   |
| **Labels**   | `testing` `backend` |

**Acceptance Criteria:**

- [ ] File: `apps/auth-service/src/auth/auth.service.spec.ts`
- [ ] Test `register()`: success → return user object, duplicate email → throw 409
- [ ] Test `login()`: valid credentials → return tokens, invalid → throw 401
- [ ] Test `validateToken()`: valid JWT → return payload, expired → throw 401
- [ ] All mocks: Keycloak client, UserRepository
- [ ] Coverage: AuthService functions ≥ 70%

---

### ECM-24 — QA: Postman Collection — Auth API

| Field        | Value                |
| ------------ | -------------------- |
| **Type**     | Task                 |
| **Epic**     | ECM-E2               |
| **Assignee** | @qa                  |
| **Priority** | 🟠 High              |
| **Points**   | 5                    |
| **Labels**   | `testing` `security` |

**Acceptance Criteria:**

- [ ] File: `postman/auth-service.collection.json`
- [ ] **Happy Path:**
  - `POST /auth/register` → 201, body có `id` (UUID), `email`, `role`
  - `POST /auth/login` → 200, body có `accessToken`, `refreshToken`, `expiresIn` (number)
  - `GET /auth/me` (với token) → 200, body đúng user info
  - `POST /auth/refresh` → 200, new `accessToken`
  - `POST /auth/logout` → 200
- [ ] **Negative Cases:**
  - Register với email đã tồn tại → 409
  - Register với email format sai → 400
  - Register với password < 8 chars → 400
  - Login với sai password → 401
  - GET /me không có token → 401
  - GET /me với token hết hạn → 401
- [ ] Postman Tests script: check status, UUID format, response time < 1000ms
- [ ] Collection có thể chạy bằng `newman run` từ CLI

---

### ECM-25 — Dokploy: Deploy Gateway + Auth Service

| Field        | Value            |
| ------------ | ---------------- |
| **Type**     | Task             |
| **Epic**     | ECM-E2           |
| **Assignee** | @fullstack       |
| **Priority** | 🟡 Medium        |
| **Points**   | 2                |
| **Labels**   | `devops` `infra` |

**Acceptance Criteria:**

- [ ] 2 apps tạo trong Dokploy: `api-gateway`, `auth-service`
- [ ] Kết nối đến GitHub repo, set branch `main`
- [ ] Environment variables được set (không hardcode trong image)
- [ ] Health check URL cấu hình: `/api/health`
- [ ] Rolling restart hoạt động: deploy mới không downtime
- [ ] RAM mỗi container không vượt limit đặt trong Docker Compose

---

**Sprint 2 — Definition of Done:**

- [ ] `POST /api/auth/login` trả JWT hợp lệ
- [ ] `GET /api/health` từ Gateway trả 200
- [ ] `GET /api/docs` tại Gateway → Swagger UI load từ CDN
- [ ] Postman Auth Collection chạy Newman: tất cả 15+ tests pass
- [ ] RAM EC2-A < 500MB sau khi deploy 2 services

---

---

# 🏃 Sprint 3 — Product Service

> **Thời gian:** 19/05/2026 — 01/06/2026
> **Sprint Goal:** _"Admin quản lý sản phẩm đầy đủ. Phân quyền đúng. QA có 40+ Postman tests."_
> **Total Story Points:** 36

---

### ECM-26 — Scaffold Product Service

| Field        | Value      |
| ------------ | ---------- |
| **Type**     | Story      |
| **Assignee** | @fullstack |
| **Priority** | 🔴 Highest |
| **Points**   | 2          |
| **Labels**   | `backend`  |

**Acceptance Criteria:**

- [ ] NestJS app tại `apps/product-service`, port `3002`
- [ ] TypeORM entities: `Product`, `Category`, `ProductImage`
- [ ] Relations: `Category` 1-N `Product`, `Product` 1-N `ProductImage`
- [ ] TypeORM migration tạo tables trên RDS
- [ ] `/metrics` và `/api/docs` endpoints hoạt động

---

### ECM-27 — Implement Product CRUD (Admin)

| Field        | Value                |
| ------------ | -------------------- |
| **Type**     | Story                |
| **Assignee** | @fullstack           |
| **Priority** | 🔴 Highest           |
| **Points**   | 5                    |
| **Labels**   | `backend` `security` |

**Acceptance Criteria:**

- [ ] `POST /api/products` — tạo sản phẩm (ADMIN only) → 201
- [ ] `GET /api/products/:id` — lấy chi tiết → 200
- [ ] `PATCH /api/products/:id` — cập nhật (ADMIN only) → 200
- [ ] `DELETE /api/products/:id` — xóa mềm (ADMIN only) → 200
- [ ] Validate: `name` required, `price > 0`, `stock >= 0`
- [ ] `@ApiOperation`, `@ApiResponse` đầy đủ trên tất cả endpoints

---

### ECM-28 — Implement Product Search + Pagination + Filter

| Field        | Value      |
| ------------ | ---------- |
| **Type**     | Story      |
| **Assignee** | @fullstack |
| **Priority** | 🟠 High    |
| **Points**   | 5          |
| **Labels**   | `backend`  |

**Acceptance Criteria:**

- [ ] `GET /api/products?page=1&limit=20&category=electronics&search=iphone&minPrice=100&maxPrice=1000`
- [ ] Response: `{ success, data: Product[], meta: { total, page, limit, totalPages } }`
- [ ] Search tìm trong `name` và `description` (case-insensitive, PostgreSQL `ILIKE`)
- [ ] Default: `limit=20`, max `limit=100`
- [ ] Sắp xếp: `?sort=price&order=asc` (default: `createdAt DESC`)

---

### ECM-29 — Implement Category CRUD

| Field        | Value      |
| ------------ | ---------- |
| **Type**     | Story      |
| **Assignee** | @fullstack |
| **Priority** | 🟠 High    |
| **Points**   | 2          |
| **Labels**   | `backend`  |

**Acceptance Criteria:**

- [ ] `GET /api/categories` → list tất cả (public)
- [ ] `POST /api/categories` → tạo (ADMIN only)
- [ ] `PATCH /api/categories/:id` → sửa (ADMIN only)
- [ ] `DELETE /api/categories/:id` → xóa (ADMIN only, chỉ khi không có product)

---

### ECM-30 — Implement Image Upload via Cloudinary

| Field        | Value      |
| ------------ | ---------- |
| **Type**     | Story      |
| **Assignee** | @fullstack |
| **Priority** | 🟡 Medium  |
| **Points**   | 3          |
| **Labels**   | `backend`  |

**Acceptance Criteria:**

- [ ] `POST /api/products/:id/images` — upload ảnh lên Cloudinary (ADMIN only)
- [ ] Cloudinary trả URL, lưu vào `ProductImage` table
- [ ] File validation: chỉ accept `image/jpeg`, `image/png`, `image/webp`; max size 5MB
- [ ] Không lưu file trên EC2 filesystem
- [ ] `DELETE /api/products/:id/images/:imageId` — xóa ảnh

---

### ECM-31 — Unit Test: ProductService

| Field        | Value               |
| ------------ | ------------------- |
| **Type**     | Task                |
| **Assignee** | @fullstack          |
| **Priority** | 🟠 High             |
| **Points**   | 3                   |
| **Labels**   | `testing` `backend` |

**Acceptance Criteria:**

- [ ] Test `create()`: valid data → return product, price ≤ 0 → throw 400
- [ ] Test `findAll()`: trả đúng paginated response
- [ ] Test `findById()`: not found → throw 404
- [ ] Test `update()`: user role → throw 403, admin → success
- [ ] Test `delete()`: soft-delete flag được set
- [ ] Coverage ProductService ≥ 70%

---

### ECM-32 — QA: Postman Collection — Product API

| Field        | Value     |
| ------------ | --------- |
| **Type**     | Task      |
| **Assignee** | @qa       |
| **Priority** | 🟠 High   |
| **Points**   | 5         |
| **Labels**   | `testing` |

**Acceptance Criteria:**

- [ ] File: `postman/product-service.collection.json`
- [ ] **Happy Path (Admin token):** CRUD product, CRUD category, image upload
- [ ] **Negative Cases:** User token → 403; product not found → 404; invalid price → 400; file > 5MB → 400
- [ ] **Pagination test:** page=1&limit=5 → `meta.totalPages` tính đúng
- [ ] **Search test:** `?search=iphone` → results chỉ chứa "iphone" trong name/description
- [ ] Tổng: ≥ 40 test cases

---

### ECM-33 — QA: Data-Driven Test (CSV) cho Product Creation

| Field        | Value     |
| ------------ | --------- |
| **Type**     | Task      |
| **Assignee** | @qa       |
| **Priority** | 🟡 Medium |
| **Points**   | 3         |
| **Labels**   | `testing` |

**Acceptance Criteria:**

- [ ] File CSV: `postman/data/product-create.csv` với 10+ bộ dữ liệu
- [ ] Mỗi row: `name, price, stock, categoryId, expectedStatus`
- [ ] Bao gồm valid + invalid data rows
- [ ] Newman chạy với `--iteration-data product-create.csv`
- [ ] Tất cả `expectedStatus` match `pm.response.status`

---

**Sprint 3 — Definition of Done:**

- [ ] Admin CRUD sản phẩm, danh mục hoạt động
- [ ] Search + pagination + filter đúng kết quả
- [ ] Image upload lên Cloudinary thành công
- [ ] Newman Product Collection: 40+ tests pass
- [ ] Jest coverage ProductService ≥ 70%

---

---

# 🏃 Sprint 4 — Cart & Inventory

> **Thời gian:** 02/06/2026 — 15/06/2026
> **Sprint Goal:** _"Giỏ hàng lưu được. Kho hàng reserve/release không bị race condition. Kafka events được publish."_
> **Total Story Points:** 37

---

### ECM-34 ~ ECM-44 — Cart + Inventory Service

_(Tương tự cấu trúc trên — xem Backlog section)_

**Sprint 4 — Definition of Done:**

- [ ] Cart: add/remove/update/clear hoạt động; TTL 7 ngày active
- [ ] Inventory: reserve + release với pessimistic locking — không oversell
- [ ] Kafka: `inventory.reserved`, `inventory.released` events được publish và verify
- [ ] Race condition test: 10 concurrent requests reserve 1 item → chỉ 1 thành công
- [ ] Newman Cart + Inventory collections: tất cả pass

---

---

# 🏃 Sprint 5 — Order Service + Camunda Saga

> **Thời gian:** 16/06/2026 — 29/06/2026
> **Sprint Goal:** _"Đặt hàng hoàn chỉnh: Order Service → Camunda orchestrate Saga → reserve inventory → payment mock → CONFIRMED. QA verify process trace trên Camunda Operate."_
> **Total Story Points:** 44

---

### ECM-46 — Thiết Kế BPMN Order Fulfillment

| Field        | Value               |
| ------------ | ------------------- |
| **Type**     | Story               |
| **Assignee** | @fullstack          |
| **Priority** | 🔴 Highest          |
| **Points**   | 3                   |
| **Labels**   | `camunda` `backend` |

**Acceptance Criteria:**

- [ ] File BPMN: `camunda/order-fulfillment.bpmn`
- [ ] Process có đủ các tasks:
  - `validate-order` (Service Task)
  - `reserve-inventory` (Service Task)
  - `process-payment` (Service Task)
  - `payment-gateway` (Exclusive Gateway — success/fail)
  - `confirm-order` (Service Task)
  - `trigger-shipment` (Service Task)
  - Compensation: `release-inventory` (Compensation Task)
- [ ] Error boundary events được định nghĩa
- [ ] BPMN có thể open và validate trong Camunda Modeler

---

### ECM-56 — Unit Test: OrderService

| Field        | Value                                 |
| ------------ | ------------------------------------- |
| **Type**     | Task                                  |
| **Assignee** | @fullstack                            |
| **Priority** | 🔴 Highest                            |
| **Points**   | 5                                     |
| **Labels**   | `testing` `backend` `camunda` `kafka` |

**Acceptance Criteria:**

- [ ] File: `apps/order-service/src/orders/orders.service.spec.ts`
- [ ] `calculateTotalAmount()`: 6 test cases (single item, multiple items, empty → throw, qty=0 → throw, negative price → throw, decimal rounding)
- [ ] `createOrder()`: persist correct totalAmount, publish `order.created` Kafka event
- [ ] `cancelOrder()`: CONFIRMED → throw 409, wrong userId → throw 403, PENDING → success
- [ ] KafkaJS mock: verify `send()` được gọi với đúng topic và payload
- [ ] Coverage OrderService ≥ 75%

---

### ECM-57 — QA: Postman Collection — Order API

| Field        | Value                       |
| ------------ | --------------------------- |
| **Type**     | Task                        |
| **Assignee** | @qa                         |
| **Priority** | 🔴 Highest                  |
| **Points**   | 8                           |
| **Labels**   | `testing` `camunda` `kafka` |

**Acceptance Criteria:**

- [ ] File: `postman/order-service.collection.json`
- [ ] **Happy Path E2E:**
  1. Register user → get token
  2. Add product to cart
  3. POST /orders → 201, status=PENDING, UUID id
  4. GET /orders/:id → status chuyển dần (poll 5 lần, interval 2s)
  5. Final status = CONFIRMED
- [ ] **Negative Cases:**
  - `items: []` → 400
  - `productId` không tồn tại → 404 hoặc 422
  - `quantity: -1` → 400
  - Không có token → 401
  - Cancel CONFIRMED order → 409
- [ ] **Postman Tests script chuẩn** (xem Mẫu 2 trong PROJECT_PLAN.md)
- [ ] `totalAmount` được verify tính đúng

---

### ECM-58 — QA: Verify Camunda Operate

| Field        | Value               |
| ------------ | ------------------- |
| **Type**     | Task                |
| **Assignee** | @qa                 |
| **Priority** | 🟠 High             |
| **Points**   | 2                   |
| **Labels**   | `testing` `camunda` |

**Acceptance Criteria:**

- [ ] Đặt 1 đơn thành công → vào Camunda Operate kiểm tra process instance
- [ ] Verify đúng path: validate → reserve → payment → confirm (không skip bước nào)
- [ ] Đặt 1 đơn với payment fail → verify compensation path: release-inventory được chạy
- [ ] Screenshot evidence attach vào Jira ticket

---

**Sprint 5 — Definition of Done:**

- [ ] Order Saga hoạt động end-to-end
- [ ] Camunda Operate hiển thị đúng process trace
- [ ] Jest coverage OrderService ≥ 75%
- [ ] Newman Order Collection: tất cả pass

---

---

# 🏃 Sprint 6 — Payment + Notification + EDA

> **Thời gian:** 30/06/2026 — 13/07/2026
> **Sprint Goal:** _"Thanh toán Stripe thực. Email xác nhận gửi sau mỗi đơn. Dead Letter Topic xử lý failed messages."_
> **Total Story Points:** 35

---

_(Chi tiết tương tự cấu trúc trên — xem Backlog ECM-59 ~ ECM-67)_

**Sprint 6 — Definition of Done:**

- [ ] Stripe test card `4242 4242 4242 4242` → order CONFIRMED
- [ ] Email xác nhận nhận được trong Mailtrap
- [ ] DLT: failed message sau 3 retries → vào DLT topic
- [ ] Newman E2E với payment: pass

---

---

# 🏃 Sprint 7 — Frontend (Next.js)

> **Thời gian:** 14/07/2026 — 27/07/2026
> **Sprint Goal:** _"Frontend live trên Vercel. User signup → browse → add to cart → checkout → nhận email xác nhận."_
> **Total Story Points:** 42

---

### ECM-78 — QA: Playwright E2E Test Suite

| Field        | Value                |
| ------------ | -------------------- |
| **Type**     | Task                 |
| **Assignee** | @qa                  |
| **Priority** | 🔴 Highest           |
| **Points**   | 8                    |
| **Labels**   | `testing` `frontend` |

**Acceptance Criteria:**

- [ ] File: `e2e/checkout.spec.ts`
- [ ] **Journey 1: Happy Path Purchase**
  1. Register mới (unique email)
  2. Browse Product Listing, click vào product
  3. Click "Add to Cart"
  4. Cart count badge = 1
  5. Navigate /cart, click "Checkout"
  6. Fill Stripe test card `4242...`
  7. Click "Place Order"
  8. Redirect về /orders/:id
  9. Order status = CONFIRMED (hoặc PENDING → polling)
  10. Email received trong Mailtrap (optional)
- [ ] **Journey 2: Authentication Guard**
  - Truy cập /cart khi chưa login → redirect /login
  - Sau login → redirect lại /cart
- [ ] **Journey 3: Admin Panel**
  - Login với admin account
  - Tạo product mới
  - Product hiển thị trong listing
- [ ] Chạy được trên Chrome + Firefox

---

**Sprint 7 — Definition of Done:**

- [ ] Frontend live trên Vercel với domain production
- [ ] User có thể mua hàng end-to-end
- [ ] Playwright E2E: 3 journeys pass
- [ ] Không có layout break trên mobile (375px)

---

---

# 🏃 Sprint 8 — Monitoring + Load Test + Polish

> **Thời gian:** 28/07/2026 — 14/08/2026
> **Sprint Goal:** _"System stable dưới 50 concurrent users. Grafana dashboards live. Security scan clean. Docs hoàn chỉnh."_
> **Total Story Points:** 34

---

### ECM-83 — Load Test với k6

| Field        | Value                            |
| ------------ | -------------------------------- |
| **Type**     | Story                            |
| **Assignee** | @fullstack                       |
| **Priority** | 🔴 Highest                       |
| **Points**   | 5                                |
| **Labels**   | `testing` `infra` `ram-critical` |

**Acceptance Criteria:**

- [ ] File: `k6/order-load.js`
- [ ] Scenario: ramp 0→20 users (1 phút), sustain 50 users (3 phút), ramp down (1 phút)
- [ ] Thresholds: `http_req_duration p(95) < 2000ms`, `error_rate < 1%`
- [ ] Monitor RAM EC2-A và EC2-B trong suốt bài test (Grafana)
- [ ] Không có OOM kill xảy ra
- [ ] Report: response time distribution, throughput, RAM peak, swap usage

---

### ECM-87 — QA: k6 Performance Report

| Field        | Value     |
| ------------ | --------- |
| **Type**     | Task      |
| **Assignee** | @qa       |
| **Priority** | 🟠 High   |
| **Points**   | 3         |
| **Labels**   | `testing` |

**Acceptance Criteria:**

- [ ] Document: `docs/qa/performance-report-sprint8.md`
- [ ] Bao gồm: test configuration, VU profile, kết quả p50/p95/p99, error rate, RAM usage chart (screenshot Grafana)
- [ ] So sánh với thresholds đề ra
- [ ] Recommendation: component nào cần tăng RAM limit / nào có thể giảm

---

### ECM-85 — Security Scan (OWASP ZAP)

| Field        | Value                |
| ------------ | -------------------- |
| **Type**     | Story                |
| **Assignee** | @qa                  |
| **Priority** | 🟠 High              |
| **Points**   | 3                    |
| **Labels**   | `testing` `security` |

**Acceptance Criteria:**

- [ ] Chạy OWASP ZAP Baseline Scan trên staging URL
- [ ] Không có `HIGH` severity alerts
- [ ] `MEDIUM` alerts được document và assign cho @fullstack fix
- [ ] Report lưu tại `docs/qa/security-scan-sprint8.html`

---

### ECM-88 — QA: Regression Test Suite

| Field        | Value      |
| ------------ | ---------- |
| **Type**     | Task       |
| **Assignee** | @qa        |
| **Priority** | 🔴 Highest |
| **Points**   | 5          |
| **Labels**   | `testing`  |

**Acceptance Criteria:**

- [ ] Script: `scripts/run-regression.sh` chạy tất cả Newman collections theo thứ tự:
  1. Auth Collection
  2. Product Collection
  3. Cart Collection
  4. Inventory Collection
  5. Order Collection (E2E)
- [ ] Tất cả collections pass 0 failures
- [ ] Script trả exit code 0 khi pass, exit code 1 khi có failure
- [ ] Script được tích hợp vào GitHub Actions job `test-api` (thay thế placeholder)

---

**Sprint 8 — Definition of Done:**

- [ ] Grafana dashboards: EC2 RAM, Swap, HTTP requests live
- [ ] Prometheus alert rules active (RAM > 80% → alert)
- [ ] k6 load test: thresholds met
- [ ] OWASP ZAP: no HIGH severity
- [ ] Regression suite: 100% pass
- [ ] Tất cả Swagger endpoints có `@ApiOperation` description

---

---

## 📊 Sprint Velocity Overview

| Sprint    | Tên                       | Dev Points | QA Points | Total   |
| --------- | ------------------------- | ---------- | --------- | ------- |
| Sprint 1  | Infrastructure Foundation | 33         | 2         | **35**  |
| Sprint 2  | Auth + API Gateway        | 21         | 7         | **38**  |
| Sprint 3  | Product Service           | 20         | 8         | **36**  |
| Sprint 4  | Cart + Inventory          | 21         | 8         | **37**  |
| Sprint 5  | Order + Camunda Saga      | 24         | 10        | **44**  |
| Sprint 6  | Payment + Notification    | 22         | 8         | **35**  |
| Sprint 7  | Frontend Next.js          | 26         | 13        | **42**  |
| Sprint 8  | Monitoring + Polish       | 18         | 11        | **34**  |
| **Total** |                           | **185**    | **67**    | **301** |

---

## 🐛 Bug Severity Definitions

| Severity          | Mô tả                                               | SLA Fix                    |
| ----------------- | --------------------------------------------------- | -------------------------- |
| **P0 — Blocker**  | System down, không thể deploy, data loss            | Fix trong ngày             |
| **P1 — Critical** | Core feature không hoạt động (login, checkout fail) | Fix trong sprint hiện tại  |
| **P2 — Major**    | Feature chính bị ảnh hưởng nhưng có workaround      | Fix trong sprint tiếp theo |
| **P3 — Minor**    | UI glitch, non-critical logic error                 | Backlog                    |
| **P4 — Trivial**  | Typo, cosmetic                                      | Nice-to-have               |

---

## 🔄 Dev-QA Collaboration Workflow (mỗi Sprint)

```
Day 1-2  │ Dev: Viết DTOs + @ApiProperty → Swagger spec live
         │ QA:  Đọc User Stories + viết Test Cases (manual)
         │
Day 2-3  │ Dev: Share Swagger URL (/api/docs-json)
         │ QA:  Import vào Postman → tạo Collection → viết tests (FAIL = đúng)
         │
Day 3-5  │ Dev: Implement Service logic + Unit Tests (Jest)
         │ QA:  Hoàn thiện Postman tests, setup environments
         │
Day 5-9  │ Dev: Fix bugs từ QA → push lên dev branch
         │ QA:  Chạy Newman liên tục → báo bug qua Jira comment
         │
Day 9    │ Code Freeze: Merge vào develop
         │ QA:  Full regression run
         │
Day 10   │ Sprint Review + Retrospective
         │ Cả hai: Demo, Sign-off, Planning Sprint tiếp theo
```

---

## 📋 Pull Request Template

> File: `.github/pull_request_template.md`

```markdown
## Jira Ticket

Closes ECM-[TICKET_NUMBER]

## Loại thay đổi

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor
- [ ] Test
- [ ] Infra/DevOps

## Checklist

- [ ] Self-review code
- [ ] Unit tests đã viết / cập nhật
- [ ] Swagger annotations đầy đủ
- [ ] Không có hardcoded secrets
- [ ] `pnpm lint` pass
- [ ] `pnpm test` pass locally
- [ ] RAM impact đã xem xét (nếu thêm dependency nặng)

## Mô tả thay đổi

<!-- Mô tả ngắn gọn -->

## QA Notes

<!-- Hướng dẫn QA test thủ công nếu cần -->

## Screenshots / Swagger diff (nếu có)
```
