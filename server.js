const express = require('express');
const multer = require('multer');
const path = require('path');
const http = require('http');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const mysql = require('mysql2/promise');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

let REGION = process.env.AWS_REGION || null;

let s3 = null;
let ssm = null;
let secrets = null;

async function getRegionFromIMDS() {
	return new Promise((resolve) => {
		const options = { host: '169.254.169.254', path: '/latest/dynamic/instance-identity/document', timeout: 1000 };
		const req = http.get(options, (res) => {
			let data = '';
			res.on('data', (chunk) => (data += chunk));
			res.on('end', () => {
				try {
					const doc = JSON.parse(data);
					resolve(doc.region || 'us-east-1');
				} catch (e) {
					resolve('us-east-1');
				}
			});
		});
		req.on('error', () => resolve('us-east-1'));
		req.setTimeout(1000, () => {
			req.abort();
			resolve('us-east-1');
		});
	});
}

async function initAwsClients() {
	if (s3 && ssm && secrets) return;
	if (!REGION) {
		try {
			REGION = await getRegionFromIMDS();
		} catch (e) {
			REGION = 'us-east-1';
		}
	}
	s3 = new S3Client({ region: REGION });
	ssm = new SSMClient({ region: REGION });
	secrets = new SecretsManagerClient({ region: REGION });
}

// Parameter / secret names (set as environment variables externally)
const DB_HOST_PARAM = process.env.DB_HOST_PARAM || '/contactform/db/host';
const DB_USER_PARAM = process.env.DB_USER_PARAM || '/contactform/db/user';
const DB_NAME_PARAM = process.env.DB_NAME_PARAM || '/contactform/db/name';
const DB_PORT_PARAM = process.env.DB_PORT_PARAM || '/contactform/db/port';
const DB_PASSWORD_SECRET = process.env.DB_PASSWORD_SECRET || 'contactform/db/password';
const S3_BUCKET_PARAM = process.env.S3_BUCKET_PARAM || '/contactform/s3/bucket';
const ALLOW_LOCAL_TEST = process.env.ALLOW_LOCAL_TEST === 'true';

let localDbConfig = null; // populated via /local-config when ALLOW_LOCAL_TEST is true
let cachedS3Bucket = null; // cached S3 bucket name

async function getParameter(name) {
	await initAwsClients();
	const cmd = new GetParameterCommand({ Name: name, WithDecryption: true });
	const res = await ssm.send(cmd);
	return res.Parameter && res.Parameter.Value;
}

async function getSecret(name) {
	await initAwsClients();
	const cmd = new GetSecretValueCommand({ SecretId: name });
	const res = await secrets.send(cmd);
	if (res.SecretString) return res.SecretString;
	return null;
}

async function getDbConfig() {
	if (localDbConfig) return localDbConfig;
	const [host, user, database, port, passwordSecret] = await Promise.all([
		getParameter(DB_HOST_PARAM),
		getParameter(DB_USER_PARAM),
		getParameter(DB_NAME_PARAM),
		getParameter(DB_PORT_PARAM),
		getSecret(DB_PASSWORD_SECRET)
	]);

	const password = (() => {
		try {
			const parsed = JSON.parse(passwordSecret || '{}');
			return parsed.password || passwordSecret;
		} catch (e) {
			return passwordSecret;
		}
	})();

	return {
		host,
		user,
		database,
		port: port ? parseInt(port, 10) : 3306,
		password
	};
}

let pool = null;

async function ensureDb() {
	if (pool) return pool;
	const cfg = await getDbConfig();
	pool = mysql.createPool({
		host: cfg.host,
		user: cfg.user,
		password: cfg.password,
		database: cfg.database,
		port: cfg.port,
		waitForConnections: true,
		connectionLimit: 10,
		queueLimit: 0
	});

	const createSql = `
		CREATE TABLE IF NOT EXISTS contacts (
			id INT AUTO_INCREMENT PRIMARY KEY,
			name VARCHAR(255) NOT NULL,
			email VARCHAR(255) NOT NULL,
			message TEXT,
			attachment_url VARCHAR(2048),
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
		) ENGINE=InnoDB;
	`;
	const conn = await pool.getConnection();
	try {
		await conn.query(createSql);
	} finally {
		conn.release();
	}

	return pool;
}

async function uploadToS3(buffer, key, contentType) {
	if (!cachedS3Bucket) {
		cachedS3Bucket = await getParameter(S3_BUCKET_PARAM);
	}
	if (!cachedS3Bucket) throw new Error('S3_BUCKET_NAME not configured in Parameter Store');
	await initAwsClients();
	const cmd = new PutObjectCommand({ Bucket: cachedS3Bucket, Key: key, Body: buffer, ContentType: contentType });
	await s3.send(cmd);
	return `https://${cachedS3Bucket}.s3.${REGION}.amazonaws.com/${encodeURIComponent(key)}`;
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.post('/submit', upload.single('attachment'), async (req, res) => {
	try {
		const { name, email, message } = req.body;
		let attachmentUrl = null;

		if (req.file) {
		const key = `uploads/${Date.now()}_${req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
		}

		const db = await ensureDb();
		const insertSql = 'INSERT INTO contacts (name, email, message, attachment_url) VALUES (?, ?, ?, ?)';
		await db.execute(insertSql, [name, email, message || null, attachmentUrl]);

		res.json({ ok: true, attachmentUrl });
	} catch (err) {
		console.error(err);
		res.status(500).json({ ok: false, error: err.message });
	}
});

app.get('/health', async (req, res) => {
	try {
		await ensureDb();
		res.json({ ok: true });
	} catch (err) {
		res.status(500).json({ ok: false, error: err.message });
	}
});

// Local test endpoints (only when explicitly enabled)
if (ALLOW_LOCAL_TEST) {
	app.get('/local-test', (req, res) => {
		res.type('html').send(`
			<form method="post" action="/local-config">
				<label>Host: <input name="host"/></label><br/>
				<label>User: <input name="user"/></label><br/>
				<label>Password: <input name="password"/></label><br/>
				<label>Database: <input name="database"/></label><br/>
				<label>Port: <input name="port" value="3306"/></label><br/>
				<button type="submit">Set local DB config</button>
			</form>
		`);
	});

	app.post('/local-config', express.urlencoded({ extended: true }), (req, res) => {
		const { host, user, password, database, port } = req.body;
		localDbConfig = { host, user, password, database, port: port ? parseInt(port, 10) : 3306 };
		res.send('Local DB config saved. You can now submit the form.');
	});
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
	console.log(`Server listening on port ${PORT}`);
});
