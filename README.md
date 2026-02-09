# Contact Form App

This project is a Node.js contact form that uploads attachments to S3 and stores form data in an RDS (MySQL) database. DB connection details are fetched from AWS SSM Parameter Store and the DB password is fetched from AWS Secrets Manager (no .env file required).

Quick setup

1. Install dependencies:

```bash
npm install
```

2. Provide the following environment variables (set these in your environment or using your deployment tooling):

- `AWS_REGION` (optional, default us-east-1)
- `S3_BUCKET_PARAM` (optional) — SSM parameter name for S3 bucket name (default: /contactform/s3/bucket); required only if you upload files
- `DB_HOST_PARAM` (optional) — SSM parameter name for DB host (default: /contactform/db/host)
- `DB_USER_PARAM` (optional) — SSM parameter name for DB user (default: /contactform/db/user)
- `DB_NAME_PARAM` (optional) — SSM parameter name for DB name (default: /contactform/db/name)
- `DB_PORT_PARAM` (optional) — SSM parameter name for DB port (default: /contactform/db/port)
- `DB_PASSWORD_SECRET_NAME_PARAM` (optional) — SSM parameter name that contains the Secrets Manager secret name for the DB password (default: /contactform/db/secretname)

3. Ensure your runtime provides AWS credentials with permissions to access S3, SSM (GetParameter), and Secrets Manager (GetSecretValue), and RDS connectivity (network & security groups).

4. Start the server:

```bash
npm start
```

Notes

- The first successful submission will cause the application to automatically create the `contacts` table in the configured MySQL database if it does not already exist.
- This implementation expects AWS credentials provided via environment or an attached IAM role (no .env file used).

Security approach

The DB password is fetched using a **two-tier approach:**
1. The app reads the Secrets Manager secret name from SSM Parameter Store (`/contactform/db/secretname`)
2. The app then uses that secret name to fetch the actual password from AWS Secrets Manager

This ensures sensitive data (the password) is stored in Secrets Manager while the secret reference is stored in SSM Parameter Store, providing both security and flexibility.

Region detection

If `AWS_REGION` is not set, the server will attempt to detect region from EC2 instance metadata (when running on EC2). It falls back to `us-east-1`.

Querying the database

Connect to your RDS database:

```bash
mysql -h database-2.cyucot0xapry.us-east-1.rds.amazonaws.com \
	-u admin \
	-p \
	innocent_db
```

Once connected, use these SQL commands:

```sql
-- Show all tables
SHOW TABLES;

-- Show the structure of the contacts table
DESCRIBE contacts;

-- Show all data in the contacts table
SELECT * FROM contacts;

-- Show formatted contact data
SELECT id, name, email, message, attachment_url, created_at FROM contacts;

-- Count total contacts
SELECT COUNT(*) as total_contacts FROM contacts;

-- Show most recent contacts
SELECT * FROM contacts ORDER BY created_at DESC LIMIT 10;

-- Show contacts with file attachments only
SELECT * FROM contacts WHERE attachment_url IS NOT NULL;
```

If you'd like, I can:
- Add input validation and recaptcha
- Add server-side pagination and admin UI
- Add CloudFormation / CDK to provision S3 + RDS + parameters
