# SpaceHub — Co-Working Space Web Application

![CI/CD Pipeline](https://github.com/Title-v/co-working-space/actions/workflows/workflow.yml/badge.svg)

A full-featured co-working space management system with desk booking, membership management, payment processing, employee operations, and manager analytics. Built with **HTML, CSS, JavaScript**, **Node.js/Express**, and **Neon PostgreSQL**. Deployed automatically via **GitHub Actions + Docker + Render**.

## Features

### Customer Features
- Account Registration & Login — secure sign-up with encrypted PII storage
- Desk Booking — 3-step flow: date selection, time slot picker with availability grid, payment
- Multiple Payment Methods — Credit Card, Bank Transfer, TrueWallet (simulated)
- My Bookings — view, track status, and cancel reservations
- Booking Expiry — unpaid bookings auto-expire after 30 minutes with live countdown
- Profile Management — view and update personal information
- Membership Plans — Day, Month, and Year subscriptions with custom durations

### Employee Features
- Reservation Management — view all reservations by date
- Customer Check-In — verify and check in confirmed bookings
- Equipment Inventory — track and update stock levels
- Expense Recording — log daily operational expenses
- CCTV Monitoring — simulated camera feed dashboard (stub API)

### Manager Features
- Revenue Dashboard — daily/monthly revenue overview with payment method breakdown
- Income Reports — monthly revenue vs. expenses with net profit calculation
- Employee Management — add, view, update, and remove employee accounts
- Daily Summary — real-time stats: reservations, income, expenses, net income, member count
- Banking API — simulated bank transfer endpoint

### Security & Infrastructure
- bcrypt Password Hashing — salted hashing with 10 rounds
- AES-256-GCM Encryption — customer PII (name, phone, address) encrypted at rest with authenticated encryption
- Role-Based Access Control — server-side role verification (customer, employee, manager)
- Booking Expiry — unpaid reservations auto-expire after 30 minutes (background job)
- Neon PostgreSQL — serverless database with indexed queries
- Docker — containerized with multi-stage Alpine build, non-root user
- CI/CD — GitHub Actions with lint + Jest tests + SonarCloud analysis + Docker build

## Tech Stack

| Layer        | Technology                          |
|--------------|-------------------------------------|
| Frontend     | HTML, CSS (BEM), Vanilla JavaScript |
| Backend      | Node.js 20, Express                 |
| Database     | Neon (Serverless PostgreSQL)        |
| Encryption   | AES-256-GCM (Node.js crypto)       |
| Auth         | bcryptjs (password hashing)         |
| Testing      | Jest, Supertest                     |
| Code Quality | SonarCloud                          |
| Container    | Docker (Alpine)                     |
| Registry     | GitHub Container Registry           |
| CI/CD        | GitHub Actions                      |
| Hosting      | Render                              |

## Project Structure

```
├── .github/workflows/
│   └── workflow.yml                # CI/CD pipeline
├── designs/
│   ├── Emerald_D1_Design.md        # C4 diagrams & design rationale
│   └── diagrams/                   # C4 diagram images
├── implementations/
│   ├── lib/
│   │   ├── crypto.js               # AES-256-GCM encrypt/decrypt helpers
│   │   ├── crypto.test.js          # Unit tests for encryption
│   │   ├── auth.js                 # Role-based access control middleware
│   │   └── expiry.js               # Background job: expire unpaid bookings
│   ├── public/
│   │   ├── index.html              # Welcome / landing page
│   │   ├── login.html              # Sign in (role-based redirect)
│   │   ├── register.html           # Create account page
│   │   ├── dashboard.html          # Customer dashboard
│   │   ├── profile.html            # User profile page
│   │   ├── booking.html            # 3-step desk booking flow
│   │   ├── my-bookings.html        # View / cancel bookings
│   │   ├── payment.html            # Payment form (3 methods + countdown)
│   │   ├── employee-dashboard.html # Employee operations panel
│   │   ├── manager-dashboard.html  # Manager analytics & controls
│   │   ├── style.css               # Blue & white BEM design system
│   │   └── app.js                  # Shared frontend utilities
│   ├── server.js                   # Express server + all API endpoints
│   ├── server.test.js              # Jest/Supertest API tests
│   ├── Dockerfile                  # Multi-stage Docker build
│   ├── .dockerignore               # Docker build exclusions
│   ├── sonar-project.properties    # SonarCloud configuration
│   └── package.json
├── Emerald_D3_AILog.md             # AI usage transparency log
└── README.md                       # This file
```

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v20+)
- A free [Neon](https://neon.tech) database account
- [Docker](https://www.docker.com/) (optional, for containerized runs)

### Local Development

1. **Clone the repository**
   ```bash
   git clone https://github.com/Title-v/co-working-space.git
   cd co-working-space
   ```

2. **Install dependencies from the repository root**
   ```bash
   npm ci
   ```

3. **Link and deploy Neon Postgres**

   Run these commands from the repository root with a Neon account that has access to the project.
   ```bash
   npm i -g neon@latest
   neon init -y --org-id org-green-glade-45544333 --project-id misty-lab-89980545 --branch production --services postgres
   neon deploy
   ```

   Neon writes `DATABASE_URL` and `DATABASE_URL_UNPOOLED` to the root `.env.local`, or `.env` if it already exists. Express uses the pooled URL for requests and the direct URL to initialize the schema. Environment variables supplied by the host take precedence.

   Set `ENCRYPTION_KEY` in the same local file. Reuse the original 64-character hex key for a database that already holds encrypted profiles. For a new database, generate a key with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` and store it securely. Set `INITIAL_MANAGER_PASSWORD` to a strong password to create the first manager as `admin@spacehub.co`.

4. **Build and start the server**
   ```bash
   npm run build
   npm start
   ```

   The build checks the server and packages the Express app and its static assets into `implementations/coworking-space-1.0.0.tgz`. On first startup, the server creates the tables, indexes, 50 desks and equipment inventory.

5. Open [SpaceHub on localhost](http://localhost:3000).

### Run with Docker

```bash
# Build the image
docker build -t co-working-space ./implementations

# Run with the same local environment used by npm start
docker run -p 3000:3000 --env-file .env.local co-working-space
```

### Run Tests

```bash
npm test
```

### Run Linter

```bash
cd implementations
npm run lint
```

## API Endpoints

### Authentication
| Method | Endpoint         | Description              |
|--------|------------------|--------------------------|
| POST   | `/api/register`  | Create a new account     |
| POST   | `/api/login`     | Authenticate a user      |

### Membership
| Method | Endpoint                          | Description                  |
|--------|-----------------------------------|------------------------------|
| POST   | `/api/membership`                 | Create a membership plan     |
| POST   | `/api/membership/:membershipId/pay` | Pay for pending membership |
| GET    | `/api/membership/:userId`         | Check membership status      |
| GET    | `/api/pricing`                    | Get pricing for all plans    |

### Booking (Customer)
| Method | Endpoint                            | Description                        |
|--------|-------------------------------------|------------------------------------|
| GET    | `/api/bookings/availability`        | Check desk availability by date    |
| GET    | `/api/timeslots`                    | Get available time slots           |
| POST   | `/api/bookings`                     | Create a new booking               |
| GET    | `/api/bookings/user/:userId`        | List user's bookings               |
| GET    | `/api/bookings/:bookingId`          | Get a single booking               |
| POST   | `/api/bookings/:bookingId/pay`      | Pay for a pending booking          |
| POST   | `/api/bookings/:bookingId/cancel`   | Cancel a booking                   |

### Employee
| Method | Endpoint                       | Description                    |
|--------|--------------------------------|--------------------------------|
| GET    | `/api/employee/reservations`   | View reservations by date      |
| POST   | `/api/employee/checkin`        | Check in a customer            |
| GET    | `/api/employee/equipment`      | List equipment inventory       |
| PUT    | `/api/employee/equipment/:id`  | Update equipment stock         |
| POST   | `/api/employee/expenses`       | Record an expense              |
| GET    | `/api/employee/expenses`       | List expenses by date          |
| GET    | `/api/employee/cctv`           | Simulated CCTV camera status   |

### Manager
| Method | Endpoint                       | Description                        |
|--------|--------------------------------|------------------------------------|
| GET    | `/api/manager/summary`         | Daily summary stats                |
| GET    | `/api/manager/revenue`         | Revenue summary (daily/monthly)    |
| GET    | `/api/manager/report`          | Income report with expenses        |
| GET    | `/api/manager/employees`       | List all employees                 |
| POST   | `/api/manager/employees`       | Add a new employee                 |
| PUT    | `/api/manager/employees/:id`   | Update an employee                 |
| DELETE | `/api/manager/employees/:id`   | Remove an employee                 |

### Simulated External APIs
| Method | Endpoint             | Description                    |
|--------|----------------------|--------------------------------|
| POST   | `/api/bank/transfer` | Simulated banking transfer API |

## Cancellation Policy

| Booking Status | Rule |
|---|---|
| **Pending** (unpaid) | Can be cancelled anytime |
| **Confirmed** (paid) | Requires 1+ day notice before booking date |

## User Roles

| Role       | Access                                                    |
|------------|-----------------------------------------------------------|
| `customer` | Dashboard, Profile, Booking, My Bookings, Membership      |
| `employee` | Reservations, Check-In, Equipment, Expenses, CCTV         |
| `manager`  | Revenue, Income Reports, Employee Management, Daily Summary |

After login, users are automatically redirected to their role-specific dashboard.

## CI/CD Pipeline

The full pipeline is defined in `.github/workflows/workflow.yml`:

```
Push/PR to main → CI (lint + Jest tests + Docker build test)
                → SonarCloud analysis (code quality + coverage)
Merge to main   → CI + CD (build → push to GHCR → deploy to Render)
```

| Trigger             | Jobs                                                     |
|---------------------|----------------------------------------------------------|
| Push / PR to `main` | **CI** — Lint + Jest tests + Docker image build          |
| Push / PR to `main` | **SonarCloud** — Code quality analysis + test coverage   |
| Push to `main` only | **CD** — Push image to GHCR + deploy to Render           |

### Required Secrets

| Secret                  | Where to get it                              |
|-------------------------|----------------------------------------------|
| `RENDER_DEPLOY_HOOK_URL`| Render dashboard → Settings → Deploy Hook    |
| `SONAR_TOKEN`           | SonarCloud → My Account → Security           |

> **Note:** GHCR authentication uses the built-in `GITHUB_TOKEN` — no extra setup needed.

### Render Configuration

- **Runtime:** Docker
- **Auto-Deploy:** Off (controlled by GitHub Actions deploy hook)
- **Environment Variables:**
  - `DATABASE_URL` = your Neon connection string
  - `ENCRYPTION_KEY` = 64-character hex string for AES-256-GCM encryption

### Team Members <br>
6688139&emsp;Naruebordint Veangnont <br>
6688141&emsp;Rattee Watperatam <br>
6688155&emsp;Nattaphong Jullayakiat <br>
6688164&emsp;Veerakron Kaewthong <br>
6688172&emsp;Veerakorn No-in <br>
6688239&emsp;Piyada Chalermnontakarn <br>

# co-working-space
