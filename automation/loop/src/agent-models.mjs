import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ROOT } from './config.mjs';

const VALID_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/;
const VALID_THINKING = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']);
const ROLES = ['developer', 'reviewer'];

function optionalToken(value, key) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 180 || !VALID_TOKEN.test(value)) {
    throw new Error(`Invalid ${key}: use a Pi provider/model identifier, not CLI flags or shell syntax`);
  }
  return value;
}

/** Resolve explicit SOXU model selection; no API key or secret is stored here. */
export function resolveRoleModels(configuration, env = process.env) {
  if (!configuration || configuration.schemaVersion !== 1 || !configuration.roles || typeof configuration.roles !== 'object') {
    throw new Error('Invalid automation/agent-models.json schema');
  }
  const result = {};
  for (const role of ROLES) {
    const raw = configuration.roles[role];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`Missing model role: ${role}`);
    const prefix = `SOXU_${role.toUpperCase()}_`;
    const provider = optionalToken(env[`${prefix}PROVIDER`] ?? raw.provider, `${role}.provider`);
    const model = optionalToken(env[`${prefix}MODEL`] ?? raw.model, `${role}.model`);
    // Prevent accidental fallback to another provider's paid model.
    if (Boolean(provider) !== Boolean(model)) throw new Error(`${role}: provider and model must be set together (or both null to inherit Pi defaults)`);
    const thinking = optionalToken(env[`${prefix}THINKING`] ?? raw.thinking, `${role}.thinking`);
    if (thinking && !VALID_THINKING.has(thinking)) throw new Error(`${role}.thinking must be one of ${[...VALID_THINKING].join(', ')}`);
    result[role] = { provider, model, thinking };
  }
  return result;
}

export async function loadRoleModels(env = process.env) {
  const path = resolve(ROOT, 'automation/agent-models.json');
  const config = JSON.parse(await readFile(path, 'utf8'));
  return resolveRoleModels(config, env);
}

export function modelArgs(selection = {}) {
  const provider = optionalToken(selection.provider, 'provider');
  const model = optionalToken(selection.model, 'model');
  const thinking = optionalToken(selection.thinking, 'thinking');
  if (Boolean(provider) !== Boolean(model)) throw new Error('Pi model must specify both provider and model');
  if (thinking && !VALID_THINKING.has(thinking)) throw new Error('Unsupported Pi thinking level');
  return [...(provider ? ['--provider', provider, '--model', model] : []), ...(thinking ? ['--thinking', thinking] : [])];
}
