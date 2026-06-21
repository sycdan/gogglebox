import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

import { AppConfig, GroupPreset } from './types';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

interface ConfigFile {
  household?: {
    username?: string;
    password?: string;
  };
  playback?: {
    watchedThreshold?: number;
  };
  groups?: GroupPreset[];
}

function readRequiredJsonFile<T>(filePath: string): T {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing required config file: ${filePath}. Copy config.example.json to config.json and fill it in.`);
  }

  const raw = fs.readFileSync(filePath, 'utf8').trim();
  if (!raw) {
    throw new Error(`Config file is empty: ${filePath}. Copy config.example.json to config.json and fill it in.`);
  }

  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new Error(`Config file is not valid JSON: ${filePath}. ${error instanceof Error ? error.message : String(error)}`);
  }
}

function clampThreshold(value: number): number {
  if (Number.isNaN(value)) {
    return 0.9;
  }

  return Math.min(0.99, Math.max(0.5, value));
}

function parseBooleanEnv(value: string | undefined, fallback = false): boolean {
  if (!value) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }

  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  return fallback;
}

function readHouseholdCredential(
  value: string | undefined,
  fallback: string | undefined,
  envName: 'PORTAL_USERNAME' | 'PORTAL_PASSWORD',
): string {
  const resolved = value?.trim() || fallback?.trim();
  if (!resolved) {
    throw new Error(`Missing ${envName}. Set it in .env or remove placeholder credentials from config files.`);
  }

  if (resolved === 'gogglebox' || resolved === 'changeme') {
    throw new Error(
      `${envName} cannot use placeholder credentials. Set a real household username/password in .env.`,
    );
  }

  return resolved;
}

export function loadConfig(): AppConfig {
  const root = process.cwd();
  const configPath = path.join(root, 'config.json');

  const fileSettings = readRequiredJsonFile<ConfigFile>(configPath);

  const jellyfinUrl = process.env.JELLYFIN_URL?.trim();
  const jellyfinApiKey = process.env.JELLYFIN_API_KEY?.trim();

  if (!jellyfinUrl || !jellyfinApiKey) {
    throw new Error('Missing JELLYFIN_URL or JELLYFIN_API_KEY in .env');
  }

  return {
    appName: 'Gogglebox',
    port: Number(process.env.PORT ?? 3000),
    sessionSecret: process.env.SESSION_SECRET ?? 'gogglebox-dev-session-secret',
    watchedThreshold: clampThreshold(
      Number(process.env.WATCHED_THRESHOLD ?? fileSettings.playback?.watchedThreshold ?? 0.9),
    ),
    portalAutoLogin: parseBooleanEnv(process.env.PORTAL_AUTO_LOGIN, false),
    jellyfinUrl: jellyfinUrl.replace(/\/$/, ''),
    jellyfinApiKey,
    household: {
      username: readHouseholdCredential(process.env.PORTAL_USERNAME, fileSettings.household?.username, 'PORTAL_USERNAME'),
      password: readHouseholdCredential(process.env.PORTAL_PASSWORD, fileSettings.household?.password, 'PORTAL_PASSWORD'),
    },
    viewers: [],
    groups: fileSettings.groups ?? [],
  };
}
