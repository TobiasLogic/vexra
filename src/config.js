import dotenv from 'dotenv';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { readFileSync, writeFileSync, mkdirSync, existsSync, cpSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: resolve(__dirname, '..', '.env') });

export const CONFIG_DIR = join(homedir(), '.vexra');
export const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

const LEGACY_CONFIG_DIR = join(homedir(), '.ai-cli');

export let legacyConfigMigrated = false;

function migrateLegacyConfigDir() {
  try {
    if (existsSync(CONFIG_DIR) || !existsSync(LEGACY_CONFIG_DIR)) return;
    cpSync(LEGACY_CONFIG_DIR, CONFIG_DIR, { recursive: true });
    legacyConfigMigrated = true;
  } catch {}
}

migrateLegacyConfigDir();

const DEFAULTS = {
  baseUrl: 'https://openrouter.ai/api/v1',
  model: 'openai/gpt-4o',
  temperature: 0.7,
  maxTokens: 128000,
  referer: 'https://github.com/openchat/ai-cli',
  title: 'ai-cli',
};

function readConfigFile() {
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

const fileCfg = readConfigFile();

function clamp(n, min, max) {
  return n < min ? min : n > max ? max : n;
}

function resolveFloat(envRaw, fileVal, fallback, min, max) {
  if (envRaw !== undefined && envRaw !== '') {
    const n = Number(envRaw);
    if (!isNaN(n)) return clamp(n, min, max);
  }
  if (typeof fileVal === 'number' && !isNaN(fileVal)) return clamp(fileVal, min, max);
  return fallback;
}

function resolveInt(envRaw, fileVal, fallback, min) {
  if (envRaw !== undefined && envRaw !== '') {
    const n = parseInt(envRaw, 10);
    if (!isNaN(n)) return Math.max(min, n);
  }
  if (typeof fileVal === 'number' && Number.isFinite(fileVal)) {
    return Math.max(min, Math.trunc(fileVal));
  }
  return fallback;
}

function resolveString(envRaw, fileVal, fallback) {
  if (envRaw) return envRaw;
  if (typeof fileVal === 'string' && fileVal) return fileVal;
  return fallback;
}

export const config = {
  provider: fileCfg.provider || '',
  apiKey: process.env.OPENROUTER_API_KEY || fileCfg.apiKey || '',
  baseUrl: resolveString(process.env.OPENROUTER_BASE_URL, fileCfg.baseUrl, DEFAULTS.baseUrl),
  model: resolveString(process.env.OPENROUTER_MODEL, fileCfg.model, DEFAULTS.model),
  temperature: resolveFloat(process.env.OPENROUTER_TEMPERATURE, fileCfg.temperature, DEFAULTS.temperature, 0, 2),
  maxTokens: resolveInt(process.env.OPENROUTER_MAX_TOKENS, fileCfg.maxTokens, DEFAULTS.maxTokens, 1),
  referer: resolveString(process.env.OPENROUTER_REFERER, fileCfg.referer, DEFAULTS.referer),
  title: resolveString(process.env.OPENROUTER_TITLE, fileCfg.title, DEFAULTS.title),
  mcpServers: fileCfg.mcpServers && typeof fileCfg.mcpServers === 'object' ? fileCfg.mcpServers : {},
};

export function validateConfig(opts) {
  if (!opts.apiKey) {
    throw new Error('No API key set. Run /provider to configure one.');
  }
  if (typeof opts.temperature !== 'number' || isNaN(opts.temperature) || opts.temperature < 0 || opts.temperature > 2) {
    throw new Error(`temperature must be between 0.0 and 2.0, got ${opts.temperature}`);
  }
  if (!Number.isInteger(opts.maxTokens) || opts.maxTokens < 1) {
    throw new Error(`maxTokens must be a positive integer, got ${opts.maxTokens}`);
  }
  return true;
}

export function saveConfig(data) {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    let existing = {};
    try {
      existing = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
    } catch {}
    const merged = { ...existing, ...data };
    writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2), 'utf-8');
    return true;
  } catch {
    return false;
  }
}
