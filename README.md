<div align="center">

# 🛒 Bin E-Commerce

**A production-grade e-commerce platform built with microservices architecture**

[![Build Status](https://img.shields.io/github/actions/workflow/status/Bin-E-Commerce/Bin-Ecommerce/ci.yml?branch=main&label=CI&logo=github-actions&logoColor=white)](https://github.com/Bin-E-Commerce/Bin-Ecommerce/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node.js-20+-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![NestJS](https://img.shields.io/badge/NestJS-10-E0234E?logo=nestjs&logoColor=white)](https://nestjs.com)
[![Next.js](https://img.shields.io/badge/Next.js-16-000000?logo=next.js&logoColor=white)](https://nextjs.org)

> Designed around **domain-driven design**, **event-driven communication**, and **cost-efficient cloud deployment** — running 10 independent microservices on a $10/month AWS infrastructure.

[Architecture](#architecture) · [Services](#services) · [Getting Started](#getting-started) · [Design Decisions](#design-decisions)

</div>

---

## Overview

Bin E-Commerce is a full-stack e-commerce system that covers the complete shopping lifecycle — from product discovery and cart management to checkout, payment, shipping, returns, and admin analytics.

**Key highlights:**

- **10 independently deployable NestJS microservices** communicating over Apache Kafka
- **BPMN-driven workflows** for order fulfillment and return processing via Camunda 8 SaaS
- **Dual-database strategy** — PostgreSQL (relational) for transactional data, MongoDB (document) for flexible schemas
- **Zero-trust auth** with Keycloak OIDC — services validate JWT without trusting the gateway
- **Turborepo monorepo** — shared packages, unified CI pipeline, incremental builds
- **Optimized for free-tier constraints** — entire backend runs on 2× AWS EC2 t3.micro with per-service memory caps

---

## Tech Stack

| Layer               | Technology                                        | Rationale                                                     |
| ------------------- | ------------------------------------------------- | ------------------------------------------------------------- |
| **Frontend**        | Next.js 16 · TypeScript · Tailwind CSS            | SSR + ISR for SEO-critical product pages                      |
| **Backend**         | NestJS 10 (×10 services)                          | Decorator-driven, built-in DI, TypeScript-first               |
| **API Gateway**     | NestJS + `@nestjs/axios` proxy                    | Single entry point, JWT validation, rate limiting             |
| **Identity**        | Keycloak 24 (OIDC / OAuth2)                       | Industry-standard IdP, social login, RBAC out of the box      |
| **Event Broker**    | Apache Kafka (KRaft mode)                         | Durable event log, replay capability, service decoupling      |
| **Workflow Engine** | Camunda 8 SaaS (Zeebe gRPC)                       | BPMN-modeled business processes, audit trail                  |
| **DB — SQL**        | AWS RDS PostgreSQL 16                             | ACID transactions for orders, inventory, payments             |
| **DB — NoSQL**      | MongoDB Atlas M0                                  | Flexible schema for carts, notifications, templates           |
| **ORM**             | TypeORM · Mongoose                                | Code-first migrations (TypeORM), schema validation (Mongoose) |
| **Monorepo**        | Turborepo + npm workspaces                        | Shared packages, remote caching, parallel task execution      |
| **Hosting**         | Vercel (frontend) · AWS EC2 t3.micro ×2 (backend) | Cost-optimized: under $15/month total                         |
| **CI/CD**           | GitHub Actions → Docker → GHCR → Dokploy          | Full pipeline from push to production in ~4 min               |
| **Monitoring**      | Prometheus + Grafana                              | Service health, Kafka lag, custom business metrics            |

---

## Monorepo Structure

```
bin-ecommerce/
├── web/                        # Next.js 16 frontend (git submodule)
│   ├── src/app/                # App Router — route groups: (public), (user), (admin), (auth)
│   ├── src/components/         # Reusable UI components
│   ├── src/services/           # Typed API client layer (per domain)
│   ├── src/store/              # Zustand global state
│   ├── src/hooks/              # Custom React hooks
│   └── src/middleware/         # Next.js middleware (auth redirect, locale)
│
├── services/                   # 10 NestJS microservices
│   ├── api-gateway/            # :3000  — Reverse proxy, JWT validation, rate limiting
│   ├── auth-service/           # :3001  — Keycloak sync, user profile, address book
│   ├── product-service/        # :3002  — Catalog, variants, categories, reviews, wishlist
│   ├── cart-service/           # :3003  — Shopping cart (MongoDB, TTL-based guest cart)
│   ├── order-service/          # :3004  — Order lifecycle + Zeebe BPMN workflow
│   ├── inventory-service/      # :3005  — Stock management, reservations, low-stock alerts
│   ├── notification-service/   # :3006  — Email/push dispatch, template engine (MongoDB)
│   ├── shipping-service/       # :3007  — Shipment tracking, GHN/GHTK webhook handler
│   ├── promotion-service/      # :3008  — Discount rules, voucher validation, usage tracking
│   └── return-service/         # :3009  — Return request + Zeebe BPMN refund workflow
│
├── packages/                   # Shared internal libraries (Turborepo)
│   ├── common/src/             # DTOs, enums, Kafka event contracts, shared types
│   ├── eslint-config/          # Unified ESLint ruleset for all services
│   ├── typescript-config/      # Base tsconfig (strict mode enabled)
│   └── testing/src/            # Jest factories, mocks, test fixtures
│
├── infra/
│   ├── docker/                 # Multi-stage Dockerfiles (build → prod image)
│   ├── nginx/conf.d/           # Per-service upstream config, SSL termination
│   ├── keycloak/
│   │   ├── realm-export/       # Realm JSON for reproducible environment setup
│   │   └── themes/             # Branded login/registration pages
│   ├── grafana/
│   │   ├── dashboards/         # Pre-built dashboards (service health, Kafka lag)
│   │   └── provisioning/       # Auto-provision data sources & dashboards on start
│   ├── prometheus/rules/       # Alerting rules (latency, error rate, memory)
│   └── scripts/                # EC2 bootstrap, Kafka topic setup scripts
│
├── scripts/                    # Developer convenience scripts
│   ├── start-all.sh            # Start all services in dev mode
│   ├── run-migrations.sh       # Run TypeORM migrations across all services
│   └── seed-db.sh              # Seed development data
│
├── test/postman/               # Postman collections — run via Newman in CI
├── doc/
│   ├── domain/                 # 12 domain design documents (DDD, event storming)
│   ├── overview/               # C4 architecture diagrams
│   └── plan/                   # Sprint plans, ADRs (Architecture Decision Records)
└── .github/workflows/          # CI: lint → test → build → push GHCR → deploy
```

---

## Architecture

### System Overview

```
                         ┌─────────────────────────────────────────┐
  Browser / Mobile       │              Vercel (CDN + Edge)         │
  ─────────────────────► │         Next.js 16  (web/)               │
                         └────────────────┬────────────────────────┘
                                          │ HTTPS
                         ┌────────────────▼────────────────────────┐
                         │           EC2-A  (t3.micro)              │
                         │  Nginx  ──►  api-gateway :3000           │
                         │              │  JWT verify (Keycloak)    │
                         │    ┌─────────┴─────────────────────┐    │
                         │    │   NestJS Services :3001–3009   │    │
                         └────┼───────────────────────────────┼────┘
                              │  Kafka events (async)          │
                         ┌────▼───────────────────────────────▼────┐
                         │           EC2-B  (t3.micro)              │
                         │  Kafka (KRaft)   Keycloak 24             │
                         │  Prometheus      Grafana                 │
                         └────────────────┬────────────────────────┘
                                          │
               ┌──────────────────────────┼───────────────────────┐
               │                          │                        │
         ┌─────▼──────┐          ┌────────▼────────┐    ┌────────▼───────┐
         │ RDS Postgres│          │  MongoDB Atlas  │    │  Camunda 8 SaaS│
         │  (Free Tier)│          │      (M0)       │    │  Zeebe :26500  │
         └────────────┘          └─────────────────┘    └────────────────┘
```

### Event-Driven Flow (Order Example)

```
User checkout
    │
    ▼
order-service ──[order.created]──► inventory-service  (reserve stock)
              ──[order.created]──► notification-service (confirm email)
              ──[order.created]──► promotion-service   (mark voucher used)
              │
              ▼ Zeebe BPMN workflow
         [payment pending] → [payment confirmed] → [fulfillment]
              │                                         │
              ▼                                         ▼
         [payment failed]                    shipping-service
         → auto cancel                    ──[shipment.created]──► notification-service
         → release stock
```

### CI/CD Pipeline

```
git push → GitHub Actions
    ├─ lint (ESLint + tsc --noEmit)          ~30s
    ├─ test (Jest unit + integration)         ~60s
    ├─ api-test (Newman / Postman)            ~45s
    ├─ docker build + push → GHCR            ~90s
    └─ Dokploy webhook → rolling deploy      ~30s
                                        ─────────
                                        Total ~4 min
```

---

## Services

| Service              | Port | Database   | Kafka Role | Zeebe | Key Responsibilities                            |
| -------------------- | ---- | ---------- | ---------- | ----- | ----------------------------------------------- |
| api-gateway          | 3000 | —          | Consumer   | —     | Auth guard, rate limiting, request routing      |
| auth-service         | 3001 | PostgreSQL | Prod/Cons  | —     | User sync, address book, token management       |
| product-service      | 3002 | PostgreSQL | Prod/Cons  | —     | Catalog CRUD, variant matrix, review system     |
| cart-service         | 3003 | MongoDB    | Prod/Cons  | —     | Cart ops, guest cart (TTL), voucher pre-check   |
| order-service        | 3004 | PostgreSQL | Prod/Cons  | ✓     | Order FSM, payment intent, BPMN fulfillment     |
| inventory-service    | 3005 | PostgreSQL | Consumer   | —     | Stock levels, soft reservations, alert triggers |
| notification-service | 3006 | MongoDB    | Consumer   | —     | Email/push dispatch, Handlebars templates       |
| shipping-service     | 3007 | PostgreSQL | Prod/Cons  | —     | Shipment creation, real-time tracking webhook   |
| promotion-service    | 3008 | PostgreSQL | Consumer   | —     | Discount engine, voucher lifecycle, usage caps  |
| return-service       | 3009 | PostgreSQL | Prod/Cons  | ✓     | Return requests, evidence upload, BPMN refund   |

---

## Design Decisions

### Why Kafka instead of direct HTTP between services?

Services are independently deployable and must tolerate failures. If `notification-service` is down during an order, the event is durably stored in Kafka and processed when it recovers — no lost emails. HTTP calls create tight coupling and cascading failures.

### Why Keycloak instead of custom auth?

OAuth2/OIDC is a solved problem. Keycloak provides social login (Google, Facebook), MFA, token refresh, RBAC, and GDPR-compliant user management out of the box. Building this from scratch adds risk with no competitive advantage.

### Why Camunda 8 for order/return workflows?

Order fulfillment involves multiple compensating transactions (cancel order → release inventory → refund payment). Modeling this as a BPMN process gives visual auditability, automatic retry on step failure, and a history of every state transition — critical for customer support.

### Why split PostgreSQL and MongoDB?

- **PostgreSQL** for anything requiring ACID transactions: orders, inventory, payments — correctness is non-negotiable.
- **MongoDB** for carts (frequent writes, schema flexibility, TTL for guest cleanup) and notification templates (rich nested document structure).

### How do 10 services run on a $10 t3.micro?

Each NestJS service is capped at `--max-old-space-size=100` (~100 MB heap). Kafka runs with `-Xmx128m`, Keycloak with `-Xmx256m`. Total RSS across all processes stays under 1.8 GB. Lightweight services with no heavy computation — this is achievable for a traffic level typical of early-stage products.

---

## Getting Started

### Prerequisites

```bash
node >= 20
npm >= 10
docker >= 24
```

### Clone with submodule

```bash
git clone --recurse-submodules https://github.com/Bin-E-Commerce/Bin-Ecommerce.git
cd Bin-Ecommerce

# If you already cloned without --recurse-submodules
git submodule update --init --recursive
```

### Install & configure

```bash
npm install

# Copy and fill environment variables
cp .env.example .env
```

### Start development

```bash
# 1. Start infrastructure (Kafka + Keycloak + Prometheus + Grafana)
docker compose -f infra/docker/docker-compose.infra.yml up -d

# 2. Run DB migrations
npm run migrate

# 3. Seed development data
npm run seed

# 4. Start all services + frontend (Turborepo parallel)
npm run dev
```

Service URLs in development:

| URL                           | Description            |
| ----------------------------- | ---------------------- |
| `http://localhost:3000`       | API Gateway            |
| `http://localhost:3001–3009`  | Individual services    |
| `http://localhost:8080`       | Keycloak Admin Console |
| `http://localhost:9090`       | Prometheus             |
| `http://localhost:3100`       | Grafana                |
| `http://localhost:3000` (web) | Next.js dev server     |

### Run tests

```bash
npm test              # Unit tests (all services)
npm run test:e2e          # E2E tests
npm run test:api          # API tests via Newman
```

---

## Domain Documentation

Detailed domain design documents are in [`doc/domain/`](doc/domain/):

| #   | Domain                                                  | Topics Covered                                |
| --- | ------------------------------------------------------- | --------------------------------------------- |
| 00  | [Business Overview](doc/domain/00-business-overview.md) | Goals, personas, domain map                   |
| 01  | [Auth & User](doc/domain/01-auth-user.md)               | Registration, login, social auth, GDPR        |
| 02  | [Product Catalog](doc/domain/02-product-catalog.md)     | Variants, pricing, SEO, tags                  |
| 03  | [Cart](doc/domain/03-cart.md)                           | Guest cart, voucher apply, TTL                |
| 04  | [Order](doc/domain/04-order.md)                         | Order states, COD flow, code generation       |
| 05  | [Inventory](doc/domain/05-inventory.md)                 | Stock management, reservations, bulk import   |
| 07  | [Shipping](doc/domain/07-shipping-delivery.md)          | GHN/GHTK integration, tracking webhooks       |
| 08  | [Promotions](doc/domain/08-promotion-voucher.md)        | Discount types, stacking rules, usage caps    |
| 09  | [Reviews](doc/domain/09-review-rating.md)               | Rating system, moderation, verified purchases |
| 10  | [Returns](doc/domain/10-return-refund.md)               | Return policy, refund workflow, Zeebe BPMN    |
| 11  | [Wishlist](doc/domain/11-wishlist.md)                   | Wishlist management, price drop alerts        |
| 12  | [Analytics](doc/domain/12-admin-analytics.md)           | Admin dashboard, revenue reports, KPIs        |

---

## Related Repositories

| Repository                                                                       | Description                                               |
| -------------------------------------------------------------------------------- | --------------------------------------------------------- |
| [Bin-Ecommerce](https://github.com/Bin-E-Commerce/Bin-Ecommerce)                 | This repo — monorepo (services, packages, infra)          |
| [Bin-E-Commerce-UI-Web](https://github.com/Bin-E-Commerce/Bin-E-Commerce-UI-Web) | Next.js 16 frontend (included as git submodule in `web/`) |

---

## License

MIT © [Bin-E-Commerce](https://github.com/Bin-E-Commerce)
