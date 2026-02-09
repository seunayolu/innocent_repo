# Contact Form App

This project is a Node.js contact form that uploads attachments to S3 and stores form data in an RDS (MySQL) database. DB connection details are fetched from AWS SSM Parameter Store and the DB password is fetched from AWS Secrets Manager (no .env file required).

Quick setup

1. Install dependencies:

```bash
npm install
```

2. Provide the following environment variables (set these in your environment or using your deployment tooling):

- `AWS_REGION` (optional, default us-east-1)
- `S3_BUCKET_NAME` (optional) — S3 bucket where attachments will be stored; required only if you upload files
- `DB_HOST_PARAM` (optional) — SSM parameter name for DB host (default: /contactform/db/host)
- `DB_USER_PARAM` (optional) — SSM parameter name for DB user (default: /contactform/db/user)
- `DB_NAME_PARAM` (optional) — SSM parameter name for DB name (default: /contactform/db/name)
- `DB_PORT_PARAM` (optional) — SSM parameter name for DB port (default: /contactform/db/port)
- `DB_PASSWORD_SECRET` (optional) — Secrets Manager secret name containing DB password (default: contactform/db/password). Secret may be a plain string or JSON { "password": "..." }

3. Ensure your runtime provides AWS credentials with permissions to access S3, SSM (GetParameter), and Secrets Manager (GetSecretValue), and RDS connectivity (network & security groups).

4. Start the server:

```bash
npm start
```

Local testing

You can test the app locally without using SSM/Secrets Manager by enabling the local test endpoints. Set:

- `ALLOW_LOCAL_TEST=true`

Then visit `http://localhost:3000/local-test` and submit DB connection details (host, user, password, database, port). The app will use those values instead of reading from SSM/Secrets Manager for subsequent requests.

Notes

- The first successful submission will cause the application to automatically create the `contacts` table in the configured MySQL database if it does not already exist.
- This implementation expects AWS credentials provided via environment or an attached IAM role (no .env file used).

Region detection

If `AWS_REGION` is not set, the server will attempt to detect region from EC2 instance metadata (when running on EC2). It falls back to `us-east-1`.

If you'd like, I can:
- Add input validation and recaptcha
- Add server-side pagination and admin UI
- Add CloudFormation / CDK to provision S3 + RDS + parameters
