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

const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

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
	log('Initializing AWS clients...');
	if (!REGION) {
		try {
			log('Detecting region from EC2 metadata...');
			REGION = await getRegionFromIMDS();
			log(`Detected region: ${REGION}`);
		} catch (e) {
			log('Failed to detect region, using default us-east-1');
			REGION = 'us-east-1';
		}
	}
	s3 = new S3Client({ region: REGION });
	ssm = new SSMClient({ region: REGION });
	secrets = new SecretsManagerClient({ region: REGION });
	log(`AWS clients initialized for region: ${REGION}`);
}

// Parameter / secret names (set as environment variables externally)
const DB_HOST_PARAM = process.env.DB_HOST_PARAM || '/contactform/db/host';
const DB_USER_PARAM = process.env.DB_USER_PARAM || '/contactform/db/user';
const DB_NAME_PARAM = process.env.DB_NAME_PARAM || '/contactform/db/name';
const DB_PORT_PARAM = process.env.DB_PORT_PARAM || '/contactform/db/port';
const DB_PASSWORD_SECRET_NAME_PARAM = process.env.DB_PASSWORD_SECRET_NAME_PARAM || '/contactform/db/secretname';
const S3_BUCKET_PARAM = process.env.S3_BUCKET_PARAM || '/contactform/s3/bucket';

let cachedS3Bucket = null; // cached S3 bucket name

async function getParameter(name) {
	await initAwsClients();
	log(`Fetching parameter: ${name}`);
	const cmd = new GetParameterCommand({ Name: name, WithDecryption: true });
	const res = await ssm.send(cmd);
	const value = res.Parameter && res.Parameter.Value;
	if (value) log(`Parameter ${name} retrieved successfully`);
	else log(`Warning: Parameter ${name} not found`);
	return value;
}

async function getSecret(name) {
	await initAwsClients();
	log(`Fetching secret: ${name}`);
	const cmd = new GetSecretValueCommand({ SecretId: name });
	const res = await secrets.send(cmd);
	if (res.SecretString) log(`Secret ${name} retrieved successfully`);
	else log(`Warning: Secret ${name} returned no value`);
	if (res.SecretString) return res.SecretString;
	return null;
}

async function getDbConfig() {
	log('Loading database configuration...');
	const [host, user, database, port, secretName] = await Promise.all([
		getParameter(DB_HOST_PARAM),
		getParameter(DB_USER_PARAM),
		getParameter(DB_NAME_PARAM),
		getParameter(DB_PORT_PARAM),
		getParameter(DB_PASSWORD_SECRET_NAME_PARAM)
	]);

	if (!secretName) throw new Error('DB password secret name not found in Parameter Store');

	const passwordSecret = await getSecret(secretName);

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
	if (pool) {
		log('Using existing database pool');
		return pool;
	}
	log('Creating new database pool...');
	const cfg = await getDbConfig();
	log(`Connecting to database: ${cfg.host}:${cfg.port}/${cfg.database} as ${cfg.user}`);
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

	log('Creating contacts table if not exists...');
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
		log('Contacts table ready');
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
		log('Form submission received');
		const { name, email, message } = req.body;
		let attachmentUrl = null;

		if (req.file) {
			log(`Uploading file: ${req.file.originalname}`);
			const key = `uploads/${Date.now()}_${req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
			attachmentUrl = await uploadToS3(req.file.buffer, key, req.file.mimetype);
			log(`File uploaded to S3: ${attachmentUrl}`);
		}

		const db = await ensureDb();
		log(`Inserting contact: ${name} (${email})`);
		const insertSql = 'INSERT INTO contacts (name, email, message, attachment_url) VALUES (?, ?, ?, ?)';
		await db.execute(insertSql, [name, email, message || null, attachmentUrl]);
		log('Contact inserted successfully');

		res.json({ ok: true, attachmentUrl });
	} catch (err) {
		log(`Error during form submission: ${err.message}`);
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

const PORT = process.env.PORT || 3000;
log(`Starting server on port ${PORT}...`);
app.listen(PORT, () => {
	log(`Server listening on port ${PORT}`);
});


