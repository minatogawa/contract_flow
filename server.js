import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_PATH = path.join(DATA_DIR, 'app.db');
const LEGACY_JSON_DB_PATH = path.join(DATA_DIR, 'db.json');
let sqlite = null;

loadEnv();

const PORT = Number(process.env.PORT || 3140);
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
const FREE_QUESTION_LIMIT = Number(process.env.FREE_QUESTION_LIMIT || 10);
const FREE_DOCUMENT_LIMIT = Number(process.env.FREE_DOCUMENT_LIMIT || 6);
const MP_API_BASE = (process.env.MP_API_BASE || 'https://api.mercadopago.com').replace(/\/+$/, '');
const MP_PREMIUM_AMOUNT = Number(process.env.MP_PREMIUM_AMOUNT || 249000);
const MP_PREMIUM_CURRENCY = process.env.MP_PREMIUM_CURRENCY || 'CLP';
const MP_PREMIUM_TITLE = process.env.MP_PREMIUM_TITLE || 'ContractFlow Premium';
const MP_FORCE_CALLBACKS = String(process.env.MP_FORCE_CALLBACKS || '').toLowerCase() === 'true';
const SESSION_DAYS = 14;
const MAX_UPLOAD_BYTES = 35 * 1024 * 1024;
const MAX_FILE_BYTES = 16 * 1024 * 1024;

await ensureStore();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, APP_URL);

    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }

    await serveStatic(req, res, url);
  } catch (error) {
    console.error(error);
    json(res, 500, { error: 'internal_error', message: 'Erro interno do servidor.' });
  }
});

server.listen(PORT, () => {
  const localUrl = `http://localhost:${PORT}`;
  const appUrlNote = APP_URL === localUrl ? '' : ` (APP_URL=${APP_URL})`;
  console.log(`ContractFlow demo listening on ${localUrl}${appUrlNote}`);
});

function loadEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const index = trimmed.indexOf('=');
    if (index === -1) continue;

    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

async function ensureStore() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.mkdir(UPLOAD_DIR, { recursive: true });
  sqlite = new DatabaseSync(DB_PATH);
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
  `);
  migrateSqliteSchema();
  await migrateLegacyJsonStore();
  await reindexStoredDocumentsIfNeeded();
}

async function readDb() {
  ensureSqlite();
  return {
    users: sqlite.prepare(`
      SELECT id, email, password_hash, salt, plan, usage_questions, usage_uploads,
        mercado_pago_customer_id, premium_since, created_at
      FROM users
      ORDER BY created_at ASC
    `).all().map(rowToUser),
    sessions: sqlite.prepare(`
      SELECT token, user_id, expires_at, created_at
      FROM sessions
      ORDER BY created_at ASC
    `).all().map(rowToSession),
    payments: sqlite.prepare(`
      SELECT id, user_id, provider, status, status_detail, mp_preference_id, mp_payment_id,
        mp_init_point, mp_sandbox_init_point, amount, currency, raw_status, created_at, updated_at
      FROM payments
      ORDER BY created_at ASC
    `).all().map(rowToPayment),
    documents: sqlite.prepare(`
      SELECT id, user_id, file_name, stored_name, page_count, warning, reindexed_at, created_at
      FROM documents
      ORDER BY created_at ASC
    `).all().map(rowToDocument),
    chunks: sqlite.prepare(`
      SELECT id, doc_id, user_id, file_name, page, chunk_index, text, search_text, created_at
      FROM chunks
      ORDER BY created_at ASC, chunk_index ASC
    `).all().map(rowToChunk)
  };
}

async function writeDb(db) {
  ensureSqlite();
  const normalized = normalizeDb(db);
  sqlite.exec('BEGIN IMMEDIATE');
  try {
    sqlite.exec(`
      DELETE FROM chunks;
      DELETE FROM documents;
      DELETE FROM payments;
      DELETE FROM sessions;
      DELETE FROM users;
    `);

    const insertUser = sqlite.prepare(`
      INSERT INTO users (
        id, email, password_hash, salt, plan, usage_questions, usage_uploads,
        mercado_pago_customer_id, premium_since, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertSession = sqlite.prepare(`
      INSERT INTO sessions (token, user_id, expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `);
    const insertPayment = sqlite.prepare(`
      INSERT INTO payments (
        id, user_id, provider, status, status_detail, mp_preference_id, mp_payment_id,
        mp_init_point, mp_sandbox_init_point, amount, currency, raw_status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertDocument = sqlite.prepare(`
      INSERT INTO documents (
        id, user_id, file_name, stored_name, page_count, warning, reindexed_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertChunk = sqlite.prepare(`
      INSERT INTO chunks (
        id, doc_id, user_id, file_name, page, chunk_index, text, search_text, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const user of normalized.users) {
      insertUser.run(
        user.id,
        user.email,
        user.passwordHash,
        user.salt,
        user.plan || 'free',
        Number(user.usage?.questions || 0),
        Number(user.usage?.uploads || 0),
        user.mercadoPagoCustomerId || null,
        user.premiumSince || null,
        user.createdAt || new Date().toISOString()
      );
    }
    for (const session of normalized.sessions) {
      insertSession.run(session.token, session.userId, session.expiresAt, session.createdAt || new Date().toISOString());
    }
    for (const payment of normalized.payments) {
      insertPayment.run(
        payment.id,
        payment.userId,
        payment.provider || 'mercadopago',
        payment.status || 'created',
        payment.statusDetail || null,
        payment.mpPreferenceId || null,
        payment.mpPaymentId || null,
        payment.mpInitPoint || null,
        payment.mpSandboxInitPoint || null,
        Number(payment.amount || 0),
        payment.currency || null,
        payment.rawStatus ? JSON.stringify(payment.rawStatus) : null,
        payment.createdAt || new Date().toISOString(),
        payment.updatedAt || payment.createdAt || new Date().toISOString()
      );
    }
    for (const doc of normalized.documents) {
      insertDocument.run(
        doc.id,
        doc.userId,
        doc.fileName,
        doc.storedName || null,
        Number(doc.pageCount || 0),
        doc.warning || null,
        doc.reindexedAt || null,
        doc.createdAt || new Date().toISOString()
      );
    }
    for (const chunk of normalized.chunks) {
      insertChunk.run(
        chunk.id,
        chunk.docId,
        chunk.userId,
        chunk.fileName,
        Number(chunk.page || 0),
        Number(chunk.chunkIndex || 0),
        chunk.text || '',
        chunk.searchText || searchable(`${chunk.fileName || ''} ${chunk.text || ''}`),
        chunk.createdAt || new Date().toISOString()
      );
    }

    sqlite.exec('COMMIT');
  } catch (error) {
    sqlite.exec('ROLLBACK');
    throw error;
  }
}

function ensureSqlite() {
  if (!sqlite) throw new Error('SQLite store has not been initialized.');
}

function migrateSqliteSchema() {
  ensureSqlite();
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      plan TEXT NOT NULL DEFAULT 'free',
      usage_questions INTEGER NOT NULL DEFAULT 0,
      usage_uploads INTEGER NOT NULL DEFAULT 0,
      mercado_pago_customer_id TEXT,
      premium_since TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      status TEXT NOT NULL,
      status_detail TEXT,
      mp_preference_id TEXT,
      mp_payment_id TEXT,
      mp_init_point TEXT,
      mp_sandbox_init_point TEXT,
      amount REAL NOT NULL DEFAULT 0,
      currency TEXT,
      raw_status TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      file_name TEXT NOT NULL,
      stored_name TEXT,
      page_count INTEGER NOT NULL DEFAULT 0,
      warning TEXT,
      reindexed_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      doc_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      file_name TEXT NOT NULL,
      page INTEGER NOT NULL DEFAULT 0,
      chunk_index INTEGER NOT NULL DEFAULT 0,
      text TEXT NOT NULL,
      search_text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (doc_id) REFERENCES documents(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_documents_user_id ON documents(user_id);
    CREATE INDEX IF NOT EXISTS idx_chunks_doc_id ON chunks(doc_id);
    CREATE INDEX IF NOT EXISTS idx_chunks_user_id ON chunks(user_id);
    CREATE INDEX IF NOT EXISTS idx_payments_user_id ON payments(user_id);
    CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
    CREATE INDEX IF NOT EXISTS idx_payments_mp_payment_id ON payments(mp_payment_id);
    CREATE INDEX IF NOT EXISTS idx_payments_mp_preference_id ON payments(mp_preference_id);
  `);
}

async function migrateLegacyJsonStore() {
  ensureSqlite();
  if (storeMeta('legacy_json_migrated') === '1') return;

  if (!fs.existsSync(LEGACY_JSON_DB_PATH)) {
    setStoreMeta('legacy_json_migrated', '1');
    return;
  }

  if (!sqliteStoreIsEmpty()) {
    setStoreMeta('legacy_json_migrated', '1');
    return;
  }

  try {
    const raw = await fsp.readFile(LEGACY_JSON_DB_PATH, 'utf8');
    await writeDb(JSON.parse(raw));
    setStoreMeta('legacy_json_migrated', '1');
  } catch (error) {
    console.error('Nao foi possivel migrar data/db.json para SQLite:', error);
  }
}

function sqliteStoreIsEmpty() {
  const tables = ['users', 'sessions', 'payments', 'documents', 'chunks'];
  return tables.every((table) => sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count === 0);
}

function storeMeta(key) {
  return sqlite.prepare('SELECT value FROM app_meta WHERE key = ?').get(key)?.value || null;
}

function setStoreMeta(key, value) {
  sqlite.prepare(`
    INSERT INTO app_meta (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

function normalizeDb(db) {
  return {
    users: Array.isArray(db?.users) ? db.users : [],
    sessions: Array.isArray(db?.sessions) ? db.sessions : [],
    payments: Array.isArray(db?.payments) ? db.payments : [],
    documents: Array.isArray(db?.documents) ? db.documents : [],
    chunks: Array.isArray(db?.chunks) ? db.chunks : []
  };
}

function rowToUser(row) {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    salt: row.salt,
    plan: row.plan || 'free',
    usage: {
      questions: Number(row.usage_questions || 0),
      uploads: Number(row.usage_uploads || 0)
    },
    mercadoPagoCustomerId: row.mercado_pago_customer_id || null,
    premiumSince: row.premium_since || null,
    createdAt: row.created_at
  };
}

function rowToSession(row) {
  return {
    token: row.token,
    userId: row.user_id,
    expiresAt: row.expires_at,
    createdAt: row.created_at
  };
}

function rowToPayment(row) {
  return {
    id: row.id,
    userId: row.user_id,
    provider: row.provider,
    status: row.status,
    statusDetail: row.status_detail || null,
    mpPreferenceId: row.mp_preference_id || null,
    mpPaymentId: row.mp_payment_id || null,
    mpInitPoint: row.mp_init_point || null,
    mpSandboxInitPoint: row.mp_sandbox_init_point || null,
    amount: Number(row.amount || 0),
    currency: row.currency || null,
    rawStatus: parseStoredJson(row.raw_status),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function rowToDocument(row) {
  return {
    id: row.id,
    userId: row.user_id,
    fileName: row.file_name,
    storedName: row.stored_name || null,
    pageCount: Number(row.page_count || 0),
    warning: row.warning || null,
    reindexedAt: row.reindexed_at || null,
    createdAt: row.created_at
  };
}

function rowToChunk(row) {
  return {
    id: row.id,
    docId: row.doc_id,
    userId: row.user_id,
    fileName: row.file_name,
    page: Number(row.page || 0),
    chunkIndex: Number(row.chunk_index || 0),
    text: row.text,
    searchText: row.search_text,
    createdAt: row.created_at
  };
}

function parseStoredJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function reindexStoredDocumentsIfNeeded() {
  const db = await readDb();
  let changed = false;

  for (const doc of db.documents) {
    const existingChunks = db.chunks.filter((chunk) => chunk.docId === doc.id);
    const needsReindex = !existingChunks.length
      || existingChunks.some((chunk) => mojibakeScore(chunk.text) > 0)
      || existingChunks.some((chunk) => !chunk.searchText);

    if (!needsReindex || !doc.userId || !doc.storedName) continue;

    const storedPath = path.join(UPLOAD_DIR, doc.userId, doc.storedName);
    if (!fs.existsSync(storedPath)) continue;

    const extracted = extractPdfPages(await fsp.readFile(storedPath));
    const chunks = makeChunks(extracted.pages, doc.id, doc.userId, doc.fileName);
    doc.pageCount = extracted.pageCount;
    doc.warning = chunks.length
      ? extracted.warning || null
      : 'Nao consegui extrair texto pesquisavel. O PDF pode estar escaneado.';
    doc.reindexedAt = new Date().toISOString();

    db.chunks = db.chunks.filter((chunk) => chunk.docId !== doc.id);
    db.chunks.push(...chunks);
    changed = true;
  }

  if (changed) await writeDb(db);
}

async function handleApi(req, res, url) {
  if ((req.method === 'POST' || req.method === 'GET') && url.pathname === '/api/mercadopago/webhook') {
    await handleMercadoPagoWebhook(req, res, url);
    return;
  }

  if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/api/mercadopago/return') {
    await handleMercadoPagoReturn(req, res, url);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/register') {
    await handleRegister(req, res);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/login') {
    await handleLogin(req, res);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
    await handleLogout(req, res);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/me') {
    const db = await readDb();
    const user = await currentUser(req, db);
    json(res, 200, { user: user ? publicUser(user, db) : null, limits: usageLimits() });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/documents') {
    const db = await readDb();
    const user = await requireUser(req, res, db);
    if (!user) return;

    const documents = db.documents
      .filter((doc) => doc.userId === user.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((doc) => ({
        id: doc.id,
        fileName: doc.fileName,
        pageCount: doc.pageCount,
        chunkCount: db.chunks.filter((chunk) => chunk.docId === doc.id).length,
        createdAt: doc.createdAt,
        warning: doc.warning || null
      }));

    json(res, 200, { documents });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/documents') {
    await handleUpload(req, res);
    return;
  }

  const documentDeleteMatch = url.pathname.match(/^\/api\/documents\/([^/]+)$/);
  if (req.method === 'DELETE' && documentDeleteMatch) {
    await handleDeleteDocument(req, res, documentDeleteMatch[1]);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/ask') {
    await handleAsk(req, res);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/billing/checkout') {
    await handleCheckout(req, res);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/billing/sync') {
    await handleBillingSync(req, res);
    return;
  }

  json(res, 404, { error: 'not_found', message: 'Rota nao encontrada.' });
}

async function handleRegister(req, res) {
  const body = await readJson(req, 32 * 1024);
  const email = normalizeEmail(body.email);
  const password = String(body.password || '');

  if (!email || !email.includes('@')) {
    json(res, 400, { error: 'invalid_email', message: 'Informe um email valido.' });
    return;
  }
  if (password.length < 6) {
    json(res, 400, { error: 'weak_password', message: 'Use pelo menos 6 caracteres.' });
    return;
  }

  const db = await readDb();
  if (db.users.some((user) => user.email === email)) {
    json(res, 409, { error: 'email_exists', message: 'Esse email ja tem uma conta.' });
    return;
  }

  const passwordData = hashPassword(password);
  const user = {
    id: id('usr'),
    email,
    passwordHash: passwordData.hash,
    salt: passwordData.salt,
    plan: 'free',
    usage: { questions: 0, uploads: 0 },
    mercadoPagoCustomerId: null,
    createdAt: new Date().toISOString()
  };
  db.users.push(user);

  const token = addSession(db, user.id);
  await writeDb(db);
  setSessionCookie(res, token);
  json(res, 201, { user: publicUser(user, db), limits: usageLimits() });
}

async function handleLogin(req, res) {
  const body = await readJson(req, 32 * 1024);
  const email = normalizeEmail(body.email);
  const password = String(body.password || '');

  const db = await readDb();
  const user = db.users.find((candidate) => candidate.email === email);
  if (!user || !verifyPassword(password, user.salt, user.passwordHash)) {
    json(res, 401, { error: 'invalid_login', message: 'Email ou senha incorretos.' });
    return;
  }

  const token = addSession(db, user.id);
  await writeDb(db);
  setSessionCookie(res, token);
  json(res, 200, { user: publicUser(user, db), limits: usageLimits() });
}

async function handleLogout(req, res) {
  const cookies = parseCookies(req);
  const token = cookies.cf_session;
  const db = await readDb();
  db.sessions = db.sessions.filter((session) => session.token !== token);
  await writeDb(db);
  res.setHeader('Set-Cookie', 'cf_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  json(res, 200, { ok: true });
}

async function handleUpload(req, res) {
  const db = await readDb();
  const user = await requireUser(req, res, db);
  if (!user) return;

  const contentType = req.headers['content-type'] || '';
  if (!contentType.includes('multipart/form-data')) {
    json(res, 415, { error: 'invalid_content_type', message: 'Envie PDFs via multipart/form-data.' });
    return;
  }

  const raw = await readBody(req, MAX_UPLOAD_BYTES);
  const parsed = parseMultipart(raw, contentType);
  const files = parsed.files.filter((file) => file.name === 'documents' && file.filename);

  if (!files.length) {
    json(res, 400, { error: 'missing_files', message: 'Inclua pelo menos um PDF.' });
    return;
  }

  const currentDocumentCount = db.documents.filter((doc) => doc.userId === user.id).length;
  if (user.plan !== 'premium' && currentDocumentCount + files.length > FREE_DOCUMENT_LIMIT) {
    json(res, 402, {
      error: 'premium_required',
      message: `O plano gratis aceita ate ${FREE_DOCUMENT_LIMIT} documentos.`,
      trigger: 'documents'
    });
    return;
  }

  const userUploadDir = path.join(UPLOAD_DIR, user.id);
  await fsp.mkdir(userUploadDir, { recursive: true });

  const documents = [];
  for (const file of files) {
    const fileName = sanitizeFileName(file.filename);
    if (!fileName.toLowerCase().endsWith('.pdf')) {
      documents.push({ fileName, warning: 'Arquivo ignorado: envie PDF.' });
      continue;
    }
    if (file.data.length > MAX_FILE_BYTES) {
      documents.push({ fileName, warning: 'Arquivo ignorado: PDF maior que 16 MB.' });
      continue;
    }

    const docId = id('doc');
    const storedName = `${docId}-${fileName}`;
    const storedPath = path.join(userUploadDir, storedName);
    await fsp.writeFile(storedPath, file.data);

    const extracted = extractPdfPages(file.data);
    const chunks = makeChunks(extracted.pages, docId, user.id, fileName);
    const warning = chunks.length
      ? extracted.warning || null
      : 'Nao consegui extrair texto pesquisavel. O PDF pode estar escaneado.';

    const document = {
      id: docId,
      userId: user.id,
      fileName,
      storedName,
      pageCount: extracted.pageCount,
      warning,
      createdAt: new Date().toISOString()
    };

    db.documents.push(document);
    db.chunks.push(...chunks);
    documents.push({
      id: document.id,
      fileName: document.fileName,
      pageCount: document.pageCount,
      chunkCount: chunks.length,
      warning: document.warning
    });
  }

  user.usage.uploads = (user.usage.uploads || 0) + documents.filter((doc) => doc.id).length;
  await writeDb(db);
  json(res, 201, { documents, user: publicUser(user, db) });
}

async function handleDeleteDocument(req, res, documentId) {
  const db = await readDb();
  const user = await requireUser(req, res, db);
  if (!user) return;

  const doc = db.documents.find((candidate) => candidate.id === documentId && candidate.userId === user.id);
  if (!doc) {
    json(res, 404, { error: 'document_not_found', message: 'Documento nao encontrado.' });
    return;
  }

  db.documents = db.documents.filter((candidate) => candidate.id !== doc.id);
  db.chunks = db.chunks.filter((chunk) => chunk.docId !== doc.id);

  if (doc.storedName) {
    const storedPath = path.join(UPLOAD_DIR, user.id, doc.storedName);
    const resolvedUploadDir = path.resolve(UPLOAD_DIR, user.id);
    const resolvedFile = path.resolve(storedPath);
    if (resolvedFile.startsWith(resolvedUploadDir + path.sep) && fs.existsSync(resolvedFile)) {
      await fsp.unlink(resolvedFile);
    }
  }

  await writeDb(db);
  json(res, 200, { ok: true, user: publicUser(user, db) });
}

async function handleAsk(req, res) {
  const db = await readDb();
  const user = await requireUser(req, res, db);
  if (!user) return;

  if (user.plan !== 'premium' && (user.usage.questions || 0) >= FREE_QUESTION_LIMIT) {
    json(res, 402, {
      error: 'premium_required',
      message: `Voce usou as ${FREE_QUESTION_LIMIT} perguntas gratis.`,
      trigger: 'questions'
    });
    return;
  }

  const body = await readJson(req, 64 * 1024);
  const question = String(body.question || '').trim();
  if (question.length < 3) {
    json(res, 400, { error: 'empty_question', message: 'Escreva uma pergunta sobre o contrato.' });
    return;
  }

  const userChunks = db.chunks.filter((chunk) => chunk.userId === user.id);
  if (!userChunks.length) {
    json(res, 400, { error: 'no_documents', message: 'Suba pelo menos um PDF antes de perguntar.' });
    return;
  }

  const citations = searchChunks(question, userChunks, 12);
  if (!citations.length) {
    json(res, 200, {
      answer: 'Nao encontrei um trecho forte o suficiente nos documentos enviados. Tente perguntar usando palavras do contrato, como multa, prazo, termino, anexo ou pagamento.',
      citations: [],
      user: publicUser(user, db)
    });
    return;
  }

  const { answer, provider, warning } = await answerWithLlm(question, citations);
  const rankedCitations = rankCitationsForAnswer(citations, answer);
  user.usage.questions = (user.usage.questions || 0) + 1;
  await writeDb(db);

  json(res, 200, {
    answer,
    provider,
    warning,
    citations: rankedCitations.map(publicCitation),
    user: publicUser(user, db)
  });
}

async function handleCheckout(req, res) {
  const db = await readDb();
  const user = await requireUser(req, res, db);
  if (!user) return;

  if (user.plan === 'premium') {
    json(res, 200, { premium: true });
    return;
  }

  const accessToken = mercadoPagoAccessToken();
  if (!accessToken) {
    json(res, 501, {
      error: 'mercadopago_not_configured',
      message: 'Mercado Pago ainda nao esta configurado no .env.'
    });
    return;
  }

  const paymentId = id('pay');
  const preferenceBody = {
    items: [
      {
        id: 'contractflow-premium',
        title: MP_PREMIUM_TITLE,
        quantity: 1,
        currency_id: MP_PREMIUM_CURRENCY,
        unit_price: MP_PREMIUM_AMOUNT
      }
    ],
    payer: { email: user.email },
    external_reference: paymentId,
    metadata: {
      user_id: user.id,
      payment_id: paymentId
    },
    statement_descriptor: 'CONTRACTFLOW'
  };

  if (shouldSendMercadoPagoCallbacks()) {
    preferenceBody.back_urls = {
      success: `${APP_URL}/api/mercadopago/return?result=success`,
      pending: `${APP_URL}/api/mercadopago/return?result=pending`,
      failure: `${APP_URL}/api/mercadopago/return?result=failure`
    };
    preferenceBody.auto_return = 'approved';
    preferenceBody.notification_url = `${APP_URL}/api/mercadopago/webhook`;
  }

  const data = await mercadoPagoPost('/checkout/preferences', preferenceBody);
  const checkoutUrl = mercadoPagoCheckoutUrl(data);
  if (!checkoutUrl || !data.id) {
    json(res, 502, {
      error: 'mercadopago_invalid_response',
      message: 'Mercado Pago nao retornou URL de checkout.'
    });
    return;
  }

  db.payments.push({
    id: paymentId,
    userId: user.id,
    provider: 'mercadopago',
    status: 'created',
    mpPreferenceId: data.id,
    mpInitPoint: data.init_point || null,
    mpSandboxInitPoint: data.sandbox_init_point || null,
    amount: MP_PREMIUM_AMOUNT,
    currency: MP_PREMIUM_CURRENCY,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  await writeDb(db);

  json(res, 200, { url: checkoutUrl, preferenceId: data.id });
}

async function handleBillingSync(req, res) {
  const db = await readDb();
  const user = await requireUser(req, res, db);
  if (!user) return;

  if (!mercadoPagoAccessToken()) {
    json(res, 501, {
      error: 'mercadopago_not_configured',
      message: 'Mercado Pago ainda nao esta configurado no .env.'
    });
    return;
  }

  await syncUserMercadoPagoPayments(user.id);
  const nextDb = await readDb();
  const nextUser = nextDb.users.find((candidate) => candidate.id === user.id);
  json(res, 200, { user: nextUser ? publicUser(nextUser, nextDb) : null });
}

async function handleMercadoPagoReturn(req, res, url) {
  const paymentId = await readMercadoPagoPaymentId(req, url);
  if (paymentId) {
    await settleMercadoPagoPayment(paymentId, url.searchParams.get('preference_id'));
  }

  res.writeHead(303, { Location: `/app?billing=${encodeURIComponent(url.searchParams.get('result') || 'mercadopago_return')}` });
  res.end();
}

async function handleMercadoPagoWebhook(req, res, url) {
  const raw = req.method === 'POST' ? await readBody(req, 256 * 1024) : Buffer.alloc(0);
  let body = {};
  if (raw.length) {
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      body = {};
    }
  }

  const notificationPaymentId = mercadoPagoNotificationPaymentId(url, body);
  if (!notificationPaymentId) {
    json(res, 200, { received: true, ignored: true });
    return;
  }

  if (process.env.MP_WEBHOOK_SECRET && !verifyMercadoPagoSignature(req, url, notificationPaymentId)) {
    json(res, 401, { error: 'invalid_signature' });
    return;
  }

  await settleMercadoPagoPayment(notificationPaymentId);
  json(res, 200, { received: true });
}

async function settleMercadoPagoPayment(mpPaymentId, preferenceId = null) {
  if (!mercadoPagoAccessToken()) return null;

  const paymentStatus = await mercadoPagoGet(`/v1/payments/${encodeURIComponent(mpPaymentId)}`);
  const db = await readDb();
  const externalReference = paymentStatus.external_reference || paymentStatus.metadata?.payment_id || null;
  const payment = db.payments.find((candidate) => candidate.id === externalReference)
    || db.payments.find((candidate) => candidate.mpPaymentId && String(candidate.mpPaymentId) === String(mpPaymentId))
    || db.payments.find((candidate) => preferenceId && candidate.mpPreferenceId === preferenceId);

  if (!payment) return paymentStatus;

  payment.mpPaymentId = String(paymentStatus.id || mpPaymentId);
  payment.mpPreferenceId = paymentStatus.preference_id || preferenceId || payment.mpPreferenceId || null;
  payment.status = paymentStatus.status || 'unknown';
  payment.statusDetail = paymentStatus.status_detail || null;
  payment.updatedAt = new Date().toISOString();
  payment.rawStatus = paymentStatus;

  if (paymentStatus.status === 'approved') {
    const user = db.users.find((candidate) => candidate.id === payment.userId);
    if (user) {
      user.plan = 'premium';
      user.mercadoPagoCustomerId = paymentStatus.payer?.id || user.mercadoPagoCustomerId || null;
      user.premiumSince = new Date().toISOString();
    }
  }

  await writeDb(db);
  return paymentStatus;
}

async function syncUserMercadoPagoPayments(userId) {
  const db = await readDb();
  const pendingPayments = db.payments
    .filter((payment) => payment.userId === userId && payment.provider === 'mercadopago')
    .filter((payment) => !['approved', 'cancelled', 'rejected', 'refunded', 'charged_back'].includes(payment.status))
    .slice(-8);

  for (const payment of pendingPayments) {
    try {
      const search = await mercadoPagoGet('/v1/payments/search', {
        sort: 'date_created',
        criteria: 'desc',
        external_reference: payment.id,
        limit: '5',
        offset: '0'
      });
      const approved = (search.results || []).find((candidate) => candidate.status === 'approved');
      const latest = approved || search.results?.[0];
      if (latest?.id) await settleMercadoPagoPayment(latest.id, payment.mpPreferenceId);
    } catch (error) {
      console.error(error);
    }
  }
}

async function readMercadoPagoPaymentId(req, url) {
  const fromQuery = url.searchParams.get('payment_id') || url.searchParams.get('collection_id') || url.searchParams.get('data.id') || url.searchParams.get('id');
  if (fromQuery) return String(fromQuery);

  const contentType = req.headers['content-type'] || '';
  if (req.method !== 'POST') return '';

  if (contentType.includes('application/json')) {
    const raw = await readBody(req, 64 * 1024);
    const body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
    return String(body.data?.id || body.id || '').trim();
  }

  const raw = await readBody(req, 64 * 1024);
  const params = new URLSearchParams(raw.toString('utf8'));
  return String(params.get('payment_id') || params.get('collection_id') || params.get('data.id') || params.get('id') || '').trim();
}

async function mercadoPagoPost(endpoint, body) {
  const response = await fetch(`${MP_API_BASE}${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${mercadoPagoAccessToken()}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.message || data.error || `Mercado Pago respondeu HTTP ${response.status}.`);
  }
  return data;
}

async function mercadoPagoGet(endpoint, params = null) {
  const query = params ? `?${new URLSearchParams(params)}` : '';
  const response = await fetch(`${MP_API_BASE}${endpoint}${query}`, {
    headers: { Authorization: `Bearer ${mercadoPagoAccessToken()}` }
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.message || data.error || `Mercado Pago respondeu HTTP ${response.status}.`);
  }
  return data;
}

function mercadoPagoAccessToken() {
  return process.env.MP_ACCESS_TOKEN || process.env.MERCADOPAGO_ACCESS_TOKEN || '';
}

function shouldSendMercadoPagoCallbacks() {
  return MP_FORCE_CALLBACKS || APP_URL.startsWith('https://');
}

function mercadoPagoCheckoutUrl(preference) {
  const token = mercadoPagoAccessToken();
  const preferSandbox = token.startsWith('TEST-') || String(process.env.MP_CHECKOUT_MODE || '').toLowerCase() === 'sandbox';
  return preferSandbox
    ? preference.sandbox_init_point || preference.init_point
    : preference.init_point || preference.sandbox_init_point;
}

function mercadoPagoNotificationPaymentId(url, body) {
  return String(
    url.searchParams.get('data.id')
    || url.searchParams.get('id')
    || body?.data?.id
    || body?.id
    || ''
  ).trim();
}

function verifyMercadoPagoSignature(req, url, paymentId) {
  const signature = req.headers['x-signature'] || '';
  const requestId = req.headers['x-request-id'] || '';
  const ts = String(signature).split(',').find((part) => part.trim().startsWith('ts='))?.split('=')[1];
  const v1 = String(signature).split(',').find((part) => part.trim().startsWith('v1='))?.split('=')[1];
  if (!ts || !v1 || !requestId) return false;

  const dataId = url.searchParams.get('data.id') || paymentId;
  const template = `id:${dataId};request-id:${requestId};ts:${ts};`;
  const expected = crypto.createHmac('sha256', process.env.MP_WEBHOOK_SECRET || '').update(template).digest('hex');
  const actual = Buffer.from(v1, 'hex');
  const target = Buffer.from(expected, 'hex');
  return actual.length === target.length && crypto.timingSafeEqual(actual, target);
}

async function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    res.end();
    return;
  }

  let filePath;
  if (url.pathname === '/' || url.pathname === '/contractflow.html') {
    filePath = path.join(ROOT, 'contractflow.html');
  } else if (url.pathname === '/app') {
    filePath = path.join(PUBLIC_DIR, 'app.html');
  } else {
    const requested = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    filePath = path.join(PUBLIC_DIR, requested);
  }

  const normalized = path.normalize(filePath);
  const allowed =
    normalized === path.join(ROOT, 'contractflow.html') ||
    normalized.startsWith(PUBLIC_DIR + path.sep);

  if (!allowed || !fs.existsSync(normalized) || fs.statSync(normalized).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }

  res.writeHead(200, { 'Content-Type': contentType(normalized) });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  fs.createReadStream(normalized).pipe(res);
}

function addSession(db, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  const expiresAt = new Date(now + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  db.sessions = db.sessions.filter((session) => new Date(session.expiresAt).getTime() > now);
  db.sessions.push({ token, userId, expiresAt, createdAt: new Date().toISOString() });
  return token;
}

async function currentUser(req, db) {
  const token = parseCookies(req).cf_session;
  if (!token) return null;
  const session = db.sessions.find((candidate) => candidate.token === token);
  if (!session || new Date(session.expiresAt).getTime() < Date.now()) return null;
  return db.users.find((user) => user.id === session.userId) || null;
}

async function requireUser(req, res, db) {
  const user = await currentUser(req, db);
  if (!user) {
    json(res, 401, { error: 'unauthorized', message: 'Faca login para continuar.' });
    return null;
  }
  user.usage ||= { questions: 0, uploads: 0 };
  return user;
}

function publicUser(user, db) {
  const documentCount = db.documents.filter((doc) => doc.userId === user.id).length;
  return {
    id: user.id,
    email: user.email,
    plan: user.plan || 'free',
    usage: {
      questions: user.usage?.questions || 0,
      uploads: user.usage?.uploads || 0,
      documents: documentCount
    }
  };
}

function usageLimits() {
  return {
    freeQuestions: FREE_QUESTION_LIMIT,
    freeDocuments: FREE_DOCUMENT_LIMIT
  };
}

function setSessionCookie(res, token) {
  const maxAge = SESSION_DAYS * 24 * 60 * 60;
  res.setHeader('Set-Cookie', `cf_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, expectedHash) {
  try {
    const actual = Buffer.from(crypto.scryptSync(password, salt, 64).toString('hex'), 'hex');
    const expected = Buffer.from(expectedHash, 'hex');
    return expected.length === actual.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const cookies = {};
  for (const part of header.split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key) cookies[key] = decodeURIComponent(value.join('='));
  }
  return cookies;
}

async function readJson(req, maxBytes) {
  const raw = await readBody(req, maxBytes);
  if (!raw.length) return {};
  return JSON.parse(raw.toString('utf8'));
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseMultipart(buffer, contentType) {
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!match) return { fields: {}, files: [] };

  const boundary = Buffer.from(`--${match[1] || match[2]}`, 'latin1');
  const fields = {};
  const files = [];
  let cursor = buffer.indexOf(boundary);

  while (cursor !== -1) {
    cursor += boundary.length;
    if (buffer[cursor] === 45 && buffer[cursor + 1] === 45) break;
    if (buffer[cursor] === 13 && buffer[cursor + 1] === 10) cursor += 2;

    const headerEnd = buffer.indexOf(Buffer.from('\r\n\r\n'), cursor);
    if (headerEnd === -1) break;

    const headerText = buffer.slice(cursor, headerEnd).toString('utf8');
    const dataStart = headerEnd + 4;
    const nextBoundary = buffer.indexOf(boundary, dataStart);
    if (nextBoundary === -1) break;

    let dataEnd = nextBoundary;
    if (buffer[dataEnd - 2] === 13 && buffer[dataEnd - 1] === 10) dataEnd -= 2;
    const data = buffer.slice(dataStart, dataEnd);
    const disposition = headerText.match(/content-disposition:\s*form-data;([^\r\n]+)/i)?.[1] || '';
    const name = disposition.match(/name="([^"]+)"/i)?.[1] || '';
    const filename = disposition.match(/filename="([^"]*)"/i)?.[1] || '';
    const type = headerText.match(/content-type:\s*([^\r\n]+)/i)?.[1]?.trim() || '';

    if (filename) {
      files.push({ name, filename, type, data });
    } else if (name) {
      fields[name] = data.toString('utf8');
    }

    cursor = nextBoundary;
  }

  return { fields, files };
}

function extractPdfPages(buffer) {
  const source = buffer.toString('latin1');
  const objects = parsePdfObjects(source);
  const decodedStreams = new Map();

  for (const [objectId, body] of objects) {
    const decoded = decodePdfStream(body);
    if (decoded) decodedStreams.set(objectId, decoded);
  }

  const cmap = buildCMap(decodedStreams);
  const pageObjects = [...objects.entries()]
    .filter(([, body]) => /\/Type\s*\/Page(?!s)\b/.test(body))
    .map(([objectId, body]) => ({ objectId, body }));

  const pages = [];
  for (const page of pageObjects) {
    const refs = contentRefs(page.body);
    const content = refs.map((ref) => decodedStreams.get(ref) || '').join('\n');
    const text = normalizeText(extractTextFromPdfContent(content, cmap));
    pages.push({ page: pages.length + 1, text });
  }

  if (!pages.length) {
    const fallbackText = normalizeText(
      [...decodedStreams.values()]
        .map((stream) => extractTextFromPdfContent(stream, cmap))
        .join('\n')
    );
    if (fallbackText) return { pageCount: 1, pages: [{ page: 1, text: fallbackText }], warning: 'Paginacao aproximada.' };
  }

  const pageCount = pages.length || estimatePdfPageCount(source) || 1;
  return { pageCount, pages };
}

function parsePdfObjects(source) {
  const objects = new Map();
  const regex = /(\d+)\s+\d+\s+obj\b([\s\S]*?)\bendobj/g;
  let match;
  while ((match = regex.exec(source))) {
    objects.set(Number(match[1]), match[2]);
  }
  return objects;
}

function decodePdfStream(body) {
  const streamIndex = body.indexOf('stream');
  const endIndex = body.lastIndexOf('endstream');
  if (streamIndex === -1 || endIndex === -1 || endIndex <= streamIndex) return null;

  let start = streamIndex + 'stream'.length;
  if (body[start] === '\r' && body[start + 1] === '\n') start += 2;
  else if (body[start] === '\n') start += 1;

  let raw = Buffer.from(body.slice(start, endIndex), 'latin1');
  if (raw[raw.length - 1] === 10) raw = raw.slice(0, -1);
  if (raw[raw.length - 1] === 13) raw = raw.slice(0, -1);

  if (/\/Filter\s*(?:\/FlateDecode|\[[^\]]*\/FlateDecode)/.test(body)) {
    try {
      return zlib.inflateSync(raw).toString('latin1');
    } catch {
      try {
        return zlib.inflateRawSync(raw).toString('latin1');
      } catch {
        return '';
      }
    }
  }

  return raw.toString('latin1');
}

function contentRefs(pageBody) {
  const match = pageBody.match(/\/Contents\s+(\[[\s\S]*?\]|\d+\s+\d+\s+R)/);
  if (!match) return [];
  return [...match[1].matchAll(/(\d+)\s+\d+\s+R/g)].map((ref) => Number(ref[1]));
}

function buildCMap(streams) {
  const map = new Map();
  for (const stream of streams.values()) {
    for (const block of stream.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
      for (const pair of block[1].matchAll(/<([0-9A-Fa-f]+)>\s+<([0-9A-Fa-f]+)>/g)) {
        map.set(pair[1].toUpperCase(), unicodeHexToString(pair[2]));
      }
    }

    for (const block of stream.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
      const lines = block[1].split(/\r?\n/);
      for (const line of lines) {
        const arrayMatch = line.match(/<([0-9A-Fa-f]+)>\s+<([0-9A-Fa-f]+)>\s+\[([^\]]+)\]/);
        if (arrayMatch) {
          const start = Number.parseInt(arrayMatch[1], 16);
          const values = [...arrayMatch[3].matchAll(/<([0-9A-Fa-f]+)>/g)].map((item) => item[1]);
          for (let i = 0; i < values.length; i++) {
            const key = (start + i).toString(16).toUpperCase().padStart(arrayMatch[1].length, '0');
            map.set(key, unicodeHexToString(values[i]));
          }
          continue;
        }

        const rangeMatch = line.match(/<([0-9A-Fa-f]+)>\s+<([0-9A-Fa-f]+)>\s+<([0-9A-Fa-f]+)>/);
        if (rangeMatch) {
          const start = Number.parseInt(rangeMatch[1], 16);
          const end = Number.parseInt(rangeMatch[2], 16);
          const destStart = Number.parseInt(rangeMatch[3], 16);
          for (let value = start; value <= end && value - start < 512; value++) {
            const key = value.toString(16).toUpperCase().padStart(rangeMatch[1].length, '0');
            map.set(key, String.fromCodePoint(destStart + value - start));
          }
        }
      }
    }
  }
  return map;
}

function unicodeHexToString(hex) {
  const chars = [];
  for (let i = 0; i < hex.length; i += 4) {
    const code = Number.parseInt(hex.slice(i, i + 4), 16);
    if (Number.isFinite(code)) chars.push(String.fromCodePoint(code));
  }
  return chars.join('');
}

function extractTextFromPdfContent(content, cmap) {
  if (!content) return '';
  const parts = [];

  for (const match of content.matchAll(/\[(.*?)\]\s*TJ/gs)) {
    parts.push(extractPdfStrings(match[1], cmap).join(''));
  }
  for (const match of content.matchAll(/(\((?:\\.|[^\\()])*(?:\((?:\\.|[^\\()])*\)(?:\\.|[^\\()])*)*\)|<([0-9A-Fa-f\s]+)>)\s*Tj/g)) {
    parts.push(decodePdfToken(match[1], cmap));
  }
  for (const match of content.matchAll(/(\((?:\\.|[^\\()])+\)|<([0-9A-Fa-f\s]+)>)\s*'/g)) {
    parts.push(decodePdfToken(match[1], cmap));
  }
  for (const match of content.matchAll(/(\((?:\\.|[^\\()])+\)|<([0-9A-Fa-f\s]+)>)\s*"/g)) {
    parts.push(decodePdfToken(match[1], cmap));
  }

  return parts.join(' ');
}

function extractPdfStrings(source, cmap) {
  const values = [];
  let index = 0;
  while (index < source.length) {
    if (source[index] === '(') {
      const parsed = readLiteralPdfString(source, index);
      values.push(parsed.value);
      index = parsed.next;
      continue;
    }
    if (source[index] === '<' && source[index + 1] !== '<') {
      const end = source.indexOf('>', index + 1);
      if (end !== -1) {
        values.push(decodeHexPdfString(source.slice(index + 1, end), cmap));
        index = end + 1;
        continue;
      }
    }
    index++;
  }
  return values;
}

function decodePdfToken(token, cmap) {
  if (token.startsWith('(')) return readLiteralPdfString(token, 0).value;
  if (token.startsWith('<')) return decodeHexPdfString(token.slice(1, -1), cmap);
  return token;
}

function readLiteralPdfString(source, start) {
  let index = start + 1;
  let depth = 1;
  let value = '';

  while (index < source.length && depth > 0) {
    const char = source[index];
    if (char === '\\') {
      const next = source[index + 1];
      if (next === 'n') value += '\n';
      else if (next === 'r') value += '\r';
      else if (next === 't') value += '\t';
      else if (next === 'b') value += '\b';
      else if (next === 'f') value += '\f';
      else if (next === '(' || next === ')' || next === '\\') value += next;
      else if (/[0-7]/.test(next || '')) {
        const octal = source.slice(index + 1, index + 4).match(/^[0-7]{1,3}/)?.[0] || '';
        value += String.fromCharCode(Number.parseInt(octal, 8));
        index += octal.length;
        continue;
      }
      index += 2;
      continue;
    }
    if (char === '(') {
      depth++;
      value += char;
    } else if (char === ')') {
      depth--;
      if (depth > 0) value += char;
    } else {
      value += char;
    }
    index++;
  }

  return { value: fixEncoding(value), next: index };
}

function decodeHexPdfString(hex, cmap) {
  const clean = hex.replace(/\s+/g, '').toUpperCase();
  if (!clean) return '';

  if (cmap.size) {
    let output = '';
    let index = 0;
    const keySizes = [...new Set([...cmap.keys()].map((key) => key.length))].sort((a, b) => b - a);
    while (index < clean.length) {
      let matched = false;
      for (const size of keySizes) {
        const key = clean.slice(index, index + size);
        if (cmap.has(key)) {
          output += cmap.get(key);
          index += size;
          matched = true;
          break;
        }
      }
      if (!matched) {
        const byte = clean.slice(index, index + 2);
        output += String.fromCharCode(Number.parseInt(byte, 16));
        index += 2;
      }
    }
    return fixEncoding(output);
  }

  const bytes = [];
  for (let i = 0; i < clean.length; i += 2) bytes.push(Number.parseInt(clean.slice(i, i + 2), 16));
  return fixEncoding(Buffer.from(bytes).toString('latin1'));
}

function fixEncoding(text) {
  const value = String(text || '')
    .replace(/\u0000/g, '')
    .replace(/\x91|\x92/g, "'")
    .replace(/\x93|\x94/g, '"')
    .replace(/\x96|\x97/g, '-');

  if (!/[ÃÂâ�]/.test(value)) return value;

  try {
    const decoded = Buffer.from(value, 'latin1').toString('utf8');
    return mojibakeScore(decoded) <= mojibakeScore(value) ? decoded : value;
  } catch {
    return value;
  }
}

function mojibakeScore(text) {
  return (String(text || '').match(/Ã.|Â.|â..|�/g) || []).length;
}

function estimatePdfPageCount(source) {
  const matches = source.match(/\/Type\s*\/Page(?!s)\b/g);
  return matches ? matches.length : 0;
}

function normalizeText(text) {
  return fixEncoding(text)
    .replace(/\s+/g, ' ')
    .replace(/([a-z])-\s+([a-z])/gi, '$1$2')
    .trim();
}

function makeChunks(pages, docId, userId, fileName) {
  const chunks = [];
  for (const page of pages) {
    const text = normalizeText(page.text);
    if (!text) continue;

    const segments = splitText(text, 1100);
    for (let i = 0; i < segments.length; i++) {
      const chunkText = segments[i];
      chunks.push({
        id: id('chk'),
        docId,
        userId,
        fileName,
        page: page.page,
        chunkIndex: i,
        text: chunkText,
        searchText: searchable(`${fileName} ${chunkText}`),
        createdAt: new Date().toISOString()
      });
    }
  }
  return chunks;
}

function splitText(text, maxLength) {
  if (text.length <= maxLength) return [text];

  const sentences = text.match(/[^.!?;:]+[.!?;:]*/g) || [text];
  const chunks = [];
  let current = '';
  for (const sentence of sentences) {
    if ((current + sentence).length > maxLength && current.length > 250) {
      chunks.push(current.trim());
      current = '';
    }
    current += `${sentence.trim()} `;
  }
  if (current.trim()) chunks.push(current.trim());

  return chunks.flatMap((chunk) => {
    if (chunk.length <= maxLength * 1.25) return [chunk];
    const pieces = [];
    for (let i = 0; i < chunk.length; i += maxLength) pieces.push(chunk.slice(i, i + maxLength));
    return pieces;
  });
}

function searchChunks(question, chunks, limit) {
  const query = buildSearchQuery(question);
  const phrase = searchable(question);
  const totalChunks = Math.max(chunks.length, 1);
  const prepared = chunks.map((chunk) => {
    const text = normalizeText(chunk.text);
    const searchText = searchable(`${chunk.fileName} ${text}`);
    const tokens = tokenize(searchText);
    return {
      ...chunk,
      text,
      searchText,
      tokenSet: new Set(tokens),
      termCounts: tokenCounts(tokens)
    };
  });
  const docFrequency = documentFrequency(prepared, query.terms);

  return prepared
    .map((chunk) => {
      let score = 0;
      let matchedTerms = 0;

      if (phrase.length > 12 && chunk.searchText.includes(phrase)) score += 80;

      for (const [term, weight] of query.terms) {
        const exact = chunk.termCounts.get(term) || 0;
        if (exact) {
          const idf = Math.log(1 + totalChunks / (1 + (docFrequency.get(term) || 0)));
          score += (1 + Math.log(1 + exact)) * idf * weight * 10;
          matchedTerms++;
          continue;
        }

        if (term.length >= 5 && fuzzyTermHit(chunk.tokenSet, term)) {
          score += weight * 3.5;
          matchedTerms += 0.45;
        }
      }

      const coverage = query.requiredTerms.length
        ? query.requiredTerms.filter((term) => chunk.tokenSet.has(term) || fuzzyTermHit(chunk.tokenSet, term)).length / query.requiredTerms.length
        : 0;
      const density = query.requiredTerms.length
        ? matchedTerms / Math.max(query.requiredTerms.length, 1)
        : matchedTerms;

      score += coverage * 70;
      score += density * 18;
      if (matchedTerms >= 2) score += matchedTerms * 5;
      if (query.isOverview && chunk.page <= 3) score += 8;
      if (query.isOverview && /\b(objetivo|definicion|antecedente|introduccion|resumen|descripcion)\b/.test(chunk.searchText)) score += 8;
      if (query.isDateQuestion && /\b(fecha|plazo|cierre|hasta|inicio|termino|vencimiento|hora|periodo)\b/.test(chunk.searchText)) score += 8;
      if (query.isMoneyQuestion && /\b(monto|presupuesto|financiamiento|aporte|costo|valor|uf|clp|\$)\b/.test(chunk.searchText)) score += 8;

      const genericPenalty = Math.min((chunk.text.length / 1300) * 8, 10);
      const normalizedScore = Math.max(0, score - genericPenalty);

      return {
        ...chunk,
        score: Number(normalizedScore.toFixed(3)),
        coverage: Number(coverage.toFixed(3))
      };
    })
    .filter((chunk) => chunk.score > 0)
    .sort((a, b) => (b.coverage - a.coverage) || (b.score - a.score))
    .slice(0, limit);
}

function buildSearchQuery(question) {
  const baseTokens = tokenize(question);
  const terms = new Map();

  for (const token of baseTokens) {
    addWeightedTerm(terms, token, 1);
    for (const variant of termVariants(token)) addWeightedTerm(terms, variant, 0.82);
    for (const synonym of synonymsFor(token)) addWeightedTerm(terms, synonym, 0.72);
  }

  return {
    terms,
    requiredTerms: [...new Set(baseTokens.filter((token) => token.length > 3))],
    isOverview: /\b(resumo|resumen|sumario|sumariza|sintetiza|fala|trata|objetivo|objetivos|que es|do que|de que)\b/i.test(question),
    isDateQuestion: /\b(quando|cuando|data|fecha|prazo|plazo|cierre|vence|vencimiento|hasta|deadline)\b/i.test(question),
    isMoneyQuestion: /\b(valor|monto|quanto|cuanto|presupuesto|financiamento|financiamiento|costo|pago|aporte|uf|clp)\b/i.test(question)
  };
}

function rankCitationsForAnswer(citations, answer) {
  const answerText = searchable(answer);
  const pagesMentioned = new Set(
    [...String(answer || '').matchAll(/(?:pag(?:ina)?\.?|p[áa]g(?:ina)?\.?|p\.)\s*(\d+)/gi)]
      .map((match) => Number(match[1]))
      .filter(Number.isFinite)
  );

  return citations
    .map((citation, index) => {
      let answerScore = citation.score || 0;
      if (pagesMentioned.has(Number(citation.page))) answerScore += 160;

      const citationTokens = tokenize(citation.text).filter((token) => token.length > 4);
      const shared = citationTokens.filter((token) => answerText.includes(token)).length;
      answerScore += Math.min(shared, 20) * 4;

      return {
        ...citation,
        score: Number(answerScore.toFixed(3)),
        originalScore: citation.score,
        usedInAnswer: pagesMentioned.has(Number(citation.page)),
        originalRank: index + 1
      };
    })
    .sort((a, b) => (Number(b.usedInAnswer) - Number(a.usedInAnswer)) || (b.score - a.score));
}

function addWeightedTerm(map, term, weight) {
  const normalized = searchable(term);
  if (normalized.length < 3) return;
  map.set(normalized, Math.max(map.get(normalized) || 0, weight));
}

function termVariants(token) {
  const variants = new Set();
  if (token.length > 4) {
    variants.add(token.replace(/(es|s)$/i, ''));
    variants.add(token.replace(/(ciones)$/i, 'cion'));
    variants.add(token.replace(/(acoes)$/i, 'acao'));
    variants.add(token.replace(/(mente)$/i, ''));
  }
  if (token.endsWith('cion')) variants.add(`${token}es`);
  if (token.endsWith('cao')) variants.add(`${token}es`);
  return [...variants].filter((variant) => variant && variant !== token && variant.length > 2);
}

function synonymsFor(token) {
  const groups = [
    ['prazo', 'plazo', 'fecha', 'data', 'cierre', 'vencimiento', 'vence', 'termino', 'duracion', 'periodo', 'cronograma', 'entrega'],
    ['multa', 'sancion', 'penalidad', 'penalizacion', 'incumplimiento', 'atraso', 'retraso'],
    ['pagamento', 'pago', 'monto', 'valor', 'presupuesto', 'financiamiento', 'financiamento', 'aporte', 'costo', 'desembolso'],
    ['contrato', 'convenio', 'acuerdo', 'bases', 'licitacion', 'concurso', 'documento'],
    ['anexo', 'adjunto', 'apendice', 'bases', 'documento', 'archivo'],
    ['requisito', 'requisitos', 'exigencia', 'condicion', 'obligacion', 'deber', 'cumplimiento'],
    ['adjudicacion', 'seleccion', 'evaluacion', 'puntaje', 'calificacion', 'criterio'],
    ['postulacion', 'propuesta', 'solicitud', 'presentacion', 'patrocinio'],
    ['objetivo', 'finalidad', 'proposito', 'descripcion', 'resumen'],
    ['pagina', 'pag', 'seccion', 'clausula', 'articulo', 'numeral']
  ];

  const normalized = searchable(token);
  const group = groups.find((items) => items.includes(normalized));
  return group ? group.filter((item) => item !== normalized) : [];
}

function tokenCounts(tokens) {
  const counts = new Map();
  for (const token of tokens) counts.set(token, (counts.get(token) || 0) + 1);
  return counts;
}

function documentFrequency(chunks, terms) {
  const frequency = new Map();
  for (const term of terms.keys()) frequency.set(term, 0);
  for (const chunk of chunks) {
    for (const term of terms.keys()) {
      if (chunk.tokenSet.has(term)) frequency.set(term, frequency.get(term) + 1);
    }
  }
  return frequency;
}

function fuzzyTermHit(tokenSet, term) {
  const stem = term.replace(/(es|s|cion|cao)$/i, '');
  if (stem.length < 4) return false;
  for (const token of tokenSet) {
    if (token.length < 4) continue;
    if (token.startsWith(stem) || stem.startsWith(token)) return true;
  }
  return false;
}

function tokenize(text) {
  const stopwords = new Set([
    'a', 'o', 'os', 'as', 'um', 'uma', 'de', 'do', 'da', 'dos', 'das', 'e', 'ou',
    'que', 'com', 'para', 'por', 'no', 'na', 'nos', 'nas', 'en', 'el', 'la', 'los',
    'las', 'del', 'y', 'sobre', 'qual', 'cual', 'hay', 'tem', 'tiene', 'esta',
    'este', 'esta', 'esse', 'esa', 'eso', 'como', 'donde', 'onde', 'quais', 'cuales',
    'cuantos', 'quantos', 'puede', 'pode', 'debe', 'devo', 'me', 'mi', 'mis', 'minha',
    'minhas', 'tu', 'su', 'sus'
  ]);
  return searchable(text)
    .split(/\s+/)
    .filter((token) => token.length > 2 && !stopwords.has(token));
}

function searchable(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function answerWithLlm(question, citations) {
  const provider = (process.env.LLM_PROVIDER || 'mock').toLowerCase();
  const order = provider === 'gemini'
    ? ['gemini', 'deepseek']
    : provider === 'deepseek'
      ? ['deepseek', 'gemini']
      : [];

  for (const candidate of order) {
    if (candidate === 'gemini' && process.env.GEMINI_API_KEY) {
      try {
        return { answer: await callGemini(question, citations), provider: 'gemini' };
      } catch (error) {
        console.error(error);
      }
    }

    if (candidate === 'deepseek' && process.env.DEEPSEEK_API_KEY) {
      try {
        return { answer: await callDeepSeek(question, citations), provider: 'deepseek' };
      } catch (error) {
        console.error(error);
      }
    }
  }

  const warning = provider === 'gemini'
    ? 'Gemini nao respondeu; usei fallback local/mock.'
    : provider === 'deepseek'
      ? 'DeepSeek nao respondeu; usei fallback local/mock.'
      : undefined;

  return { answer: mockAnswer(question, citations), provider: 'mock', warning };
}

async function callGemini(question, citations) {
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`;
  const prompt = buildPrompt(question, citations);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);

  const response = await fetch(url, {
    method: 'POST',
    signal: controller.signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.15,
        maxOutputTokens: 700
      }
    })
  });
  clearTimeout(timeout);

  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || 'Gemini request failed');
  const answer = data.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('').trim();
  return answer || mockAnswer(question, citations);
}

async function callDeepSeek(question, citations) {
  const model = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);

  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    signal: controller.signal,
    headers: {
      Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      temperature: 0.15,
      max_tokens: 700,
      messages: [
        { role: 'system', content: 'Voce e o ContractFlow. Responda de forma objetiva e cite pagina/documento quando usar contexto.' },
        { role: 'user', content: buildPrompt(question, citations) }
      ]
    })
  });
  clearTimeout(timeout);

  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || 'DeepSeek request failed');
  return data.choices?.[0]?.message?.content?.trim() || mockAnswer(question, citations);
}

function buildPrompt(question, citations) {
  const context = citations
    .map((citation, index) => {
      return `[${index + 1}] Documento: ${citation.fileName}\nPagina: ${citation.page}\nScore: ${citation.score}\nTrecho: ${citation.text}`;
    })
    .join('\n\n');

  return [
    'Voce e um assistente de analise documental e contratual.',
    'Use somente os trechos recuperados abaixo. Eles estao em ordem de relevancia.',
    'Se a resposta estiver em um trecho, responda diretamente e cite documento e pagina.',
    'Se os trechos nao tiverem base suficiente, diga exatamente o que falta e sugira termos de busca.',
    'Nao invente clausulas, datas, valores, requisitos nem conclusoes.',
    'Responda no idioma da pergunta. Seja curto e pratico.',
    'Formato desejado: resposta em 2-5 frases + citacoes entre parenteses, por exemplo (documento.pdf, pag. 4).',
    '',
    `Pergunta: ${question}`,
    '',
    'Trechos recuperados:',
    context
  ].join('\n');
}

function mockAnswer(question, citations) {
  const lead = citations[0];
  const other = citations[1];
  const second = other ? ` Tambem ha um trecho relacionado em ${other.fileName}, pag. ${other.page}.` : '';
  return [
    `O trecho mais provavel para a pergunta esta em ${lead.fileName}, pag. ${lead.page}.`,
    `Ele diz: "${truncate(lead.text, 360)}"`,
    `${second}Modo mock ativo: coloque GEMINI_API_KEY ou DEEPSEEK_API_KEY no .env e ajuste LLM_PROVIDER para gerar uma resposta juridica mais natural.`
  ].join('\n\n');
}

function publicCitation(citation) {
  return {
    id: citation.id,
    docId: citation.docId,
    fileName: citation.fileName,
    page: citation.page,
    text: citation.text,
    score: citation.score,
    originalScore: citation.originalScore,
    usedInAnswer: Boolean(citation.usedInAnswer),
    originalRank: citation.originalRank || null
  };
}

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function id(prefix) {
  return `${prefix}_${crypto.randomBytes(10).toString('hex')}`;
}

function sanitizeFileName(name) {
  return path.basename(String(name || 'documento.pdf')).replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 120);
}

function truncate(text, limit) {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit).trim()}...`;
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.ico': 'image/x-icon'
  };
  return types[ext] || 'application/octet-stream';
}
