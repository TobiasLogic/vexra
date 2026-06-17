import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { CONFIG_DIR } from './config.js';

const CACHE_FILE = join(CONFIG_DIR, 'models.json');
const CACHE_TTL = 60 * 60 * 1000;

export async function fetchModels(baseUrl, apiKey, signal) {
  const cached = loadCache();
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.models;
  }

  const res = await fetch(`${baseUrl}/models`, {
    headers: { 'Authorization': `Bearer ${apiKey}` },
    signal,
  });

  if (!res.ok) throw new Error(`Failed to fetch models: ${res.status}`);

  const data = await res.json();
  const models = (data.data || data || []).map(m => ({
    id: m.id,
    name: m.name || m.id,
    contextLength: m.context_length || null,
    pricing: m.pricing || null,
  }));

  saveCache(models);
  return models;
}

function loadCache() {
  try {
    if (!existsSync(CACHE_FILE)) return null;
    return JSON.parse(readFileSync(CACHE_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

function saveCache(models) {
  try {
    mkdirSync(dirname(CACHE_FILE), { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify({ models, timestamp: Date.now() }, null, 2), 'utf-8');
  } catch {}
}

export function formatModelList(models) {
  return models.map(m => {
    const ctx = m.contextLength ? `${(m.contextLength / 1000).toFixed(0)}k ctx` : '';
    const price = m.pricing?.prompt ? `$${(parseFloat(m.pricing.prompt) * 1000000).toFixed(2)}/M` : '';
    return `${m.id}  ${ctx}  ${price}`.trim();
  });
}
