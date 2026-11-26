# CampusConnect — Campus Lost and Found Portal

A responsive, full-stack lost and found application for the Sai University campus. Built with HTML, CSS, JavaScript, Node.js, Express and MongoDB.

## Features

- Student registration, login and protected routes (JWT + bcrypt password hashing)
- Report lost/found items with optional JPG, PNG or WEBP image upload
- Search by keyword; filter by category, location and listing type; sort by date
- Submit claims with identifying details
- Listing owners can approve or reject claims
- Personal dashboard for listings, submitted claims and received claims
- Admin-only statistics, item management and status updates
- Responsive interface, API error handling, Helmet security headers and API rate limiting
- Seed script for 10 sample listings

## Requirements

- Node.js 18+
- MongoDB local server or MongoDB Atlas account
- Postman (for API testing)

## Setup in VS Code

1. Extract this project ZIP.
2. Open the `campus-lost-found-portal` folder in VS Code.
3. Open Terminal → New Terminal.
4. Install packages:

   ```bash
   npm install
   ```

5. Copy `.env.example` to a new file named `.env`.
6. Add your MongoDB connection string to `MONGODB_URI`.
   - Local MongoDB: `mongodb://127.0.0.1:27017/campus_lost_found`
   - Atlas: paste your own connection string and replace its password placeholder.
7. Change `JWT_SECRET` to a long random value. Change the admin password too.
8. Seed the sample records and admin account:

   ```bash
   npm run seed
   ```

9. Start the application:

   ```bash
   npm run dev
   ```

10. Open `http://localhost:3000`.

## Admin login

Use the `ADMIN_EMAIL` and `ADMIN_PASSWORD` values configured in `.env`. Change the example password before using or deploying the app. The seed script creates the admin only if that email does not already exist.

## API endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/health` | API health check |
| POST | `/api/auth/register` | Register student |
| POST | `/api/auth/login` | Login |
| GET | `/api/auth/me` | Current user (protected) |
| GET | `/api/items` | List/search/filter items |
| POST | `/api/items` | Create item (protected; multipart form) |
| GET | `/api/items/mine` | Current user's listings |
| GET | `/api/items/:id` | Get one item |
| PATCH | `/api/items/:id` | Update own item or admin update |
| DELETE | `/api/items/:id` | Delete own item or admin delete |
| POST | `/api/claims` | Submit claim (protected) |
| GET | `/api/claims/mine` | Claims submitted by current user |
| GET | `/api/claims/received` | Claims on current user's listings |
| PATCH | `/api/claims/:id/status` | Owner/admin approves or rejects |
| GET | `/api/admin/stats` | Admin statistics |
| GET | `/api/admin/items` | Admin item list |
| GET | `/api/admin/claims` | Admin claim list |
| PATCH | `/api/admin/items/:id/status` | Admin changes item status |

For protected endpoints, send `Authorization: Bearer YOUR_JWT_TOKEN`.

## Postman testing

Import `postman/Campus-Lost-Found.postman_collection.json` into Postman. Run health check, register, login and public item requests first. Copy the login token into the collection's `token` variable. Create an item, copy its ID to `itemId`, then test item retrieval, update and claim requests. The collection includes an unauthorised request that should return HTTP 401.

Your report should include screenshots of at least eight successful/expected API test cases, including invalid input and unauthorised access.

## Suggested GitHub workflow

```bash
git init
git add .
git commit -m "Initial CampusConnect project"
git branch -M main
git remote add origin YOUR_GITHUB_REPOSITORY_URL
git push -u origin main
```

Do not commit `.env`, real passwords, database credentials or private student information.

## Deployment notes

Deploy the Node application to an approved host such as Render and use MongoDB Atlas for a cloud database. Add `MONGODB_URI`, `JWT_SECRET`, `JWT_EXPIRES_IN`, `ADMIN_EMAIL` and `ADMIN_PASSWORD` as environment variables in the hosting dashboard. Set the start command to `npm start`. For production, use persistent/object storage for uploaded images; the local `uploads` folder may not persist on some hosting plans.

## Important next improvements before final submission

- Add email verification and password reset if required by your instructor.
- Use Cloudinary or another persistent image service for production uploads.
- Add pagination and stronger input sanitization.
- Add automated tests for authorization and claim workflows.
- Confirm the instructor's approved hosting platform and required project-report template.
- Capture your own screenshots and explain each module during the viva.

## Academic integrity

This starter project is intended to be studied, tested, customised and explained by the individual student. Review the code, make your own design and feature decisions, and disclose AI assistance according to the university's rules.
