'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024;

function readRequiredEnv(name) {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function normalizeFunctionUrl(value, functionName, envName) {
  const trimmed = value.trim();
  const hosted = new RegExp(`^https://[^?#\\s]+/functions/v1/${functionName}/?$`);
  const local = new RegExp(`^http://127\\.0\\.0\\.1:\\d+/functions/v1/${functionName}/?$`);
  if ((!hosted.test(trimmed) && !local.test(trimmed)) || trimmed.includes('@')) {
    throw new Error(`${envName} must point to /functions/v1/${functionName}`);
  }
  return trimmed.replace(/\/$/, '');
}

function byteLength(value) {
  return Buffer.byteLength(value, 'utf8');
}

function parseResponse(action, status, text) {
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch (error) {
    throw new Error(`${action} returned invalid JSON: ${error.message}`);
  }
  if (status < 200 || status >= 300 || body.error) {
    const message = body && body.error && body.error.message ? body.error.message : `HTTP ${status}`;
    throw new Error(`${action} failed: ${message}`);
  }
  return body.data;
}

function createApiClient(config) {
  const timeoutMs = config.timeoutMs || DEFAULT_TIMEOUT_MS;
  const maxBodyBytes = config.maxBodyBytes || DEFAULT_MAX_BODY_BYTES;

  async function request(action, payload) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const body = JSON.stringify({ action, payload: payload || {} });
    const bodyBytes = byteLength(body);
    if (bodyBytes > maxBodyBytes) {
      throw new Error(`${action} request body is ${bodyBytes} bytes; limit is ${maxBodyBytes} bytes`);
    }
    try {
      const response = await fetch(config.apiUrl, {
        method: 'POST',
        headers: config.headers,
        body,
        signal: controller.signal,
      });
      return parseResponse(action, response.status, await response.text());
    } finally {
      clearTimeout(timeout);
    }
  }

  return { apiUrl: config.apiUrl, request };
}

function createOwnerApiClient(options = {}) {
  const token = options.token || readRequiredEnv('DAILY_CS_OWNER_ACCESS_TOKEN');
  return createApiClient({
    apiUrl: normalizeFunctionUrl(
      options.apiUrl || readRequiredEnv('DAILY_CS_OWNER_API_URL'),
      'owner-api',
      'DAILY_CS_OWNER_API_URL',
    ),
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    timeoutMs: options.timeoutMs,
    maxBodyBytes: options.maxBodyBytes,
  });
}

function createBackupApiClient(options = {}) {
  const token = options.token || readRequiredEnv('DAILY_CS_BACKUP_API_KEY');
  return createApiClient({
    apiUrl: normalizeFunctionUrl(
      options.apiUrl || readRequiredEnv('DAILY_CS_BACKUP_API_URL'),
      'backup-api',
      'DAILY_CS_BACKUP_API_URL',
    ),
    headers: {
      'content-type': 'application/json',
      'X-Daily-CS-Backup-Key': token,
    },
    timeoutMs: options.timeoutMs,
    maxBodyBytes: options.maxBodyBytes,
  });
}

function writeJsonAtomic(filePath, value) {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const tempPath = `${resolved}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempPath, resolved);
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8'));
}

module.exports = {
  createBackupApiClient,
  createOwnerApiClient,
  byteLength,
  readJsonFile,
  readRequiredEnv,
  writeJsonAtomic,
};
