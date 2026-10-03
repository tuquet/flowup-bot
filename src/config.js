import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// Load environment variables
const envPath = path.join(rootDir, 'config', '.env');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
} else {
  dotenv.config();
}

// Load default settings
const configPath = path.join(rootDir, 'config', 'default.json');
let defaultConfig = {
  botName: 'FlowupAI_bot',
  defaultRepo: 'tuquet/tuquet.github.io',
  deployWorkflow: 'deploy-pages.yml',
  monitoredServices: ['flowup-bot', 'docker', 'ssh']
};

if (fs.existsSync(configPath)) {
  try {
    defaultConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    console.warn('[Config] Failed to parse default.json:', err.message);
  }
}

export const config = {
  token: process.env.TELEGRAM_BOT_TOKEN || '',
  allowedChats: (process.env.ALLOWED_CHAT_IDS || '')
    .split(',')
    .map(id => id.trim())
    .filter(Boolean),
  adminUsers: (process.env.ADMIN_USER_IDS || '')
    .split(',')
    .map(id => id.trim())
    .filter(Boolean),
  defaultRepo: process.env.GITHUB_DEFAULT_REPO || defaultConfig.defaultRepo,
  deployWorkflow: defaultConfig.deployWorkflow,
  websiteUrl: process.env.GITHUB_PAGES_URL || defaultConfig.websiteUrl,
  releasesApiUrl: process.env.RELEASES_API_URL || defaultConfig.releasesApiUrl || 'https://tuquet.netlify.app/api/releases',
  releasesFeedUrl: defaultConfig.releasesFeedUrl || 'https://tuquet.netlify.app/feed.xml',
  releasePollMinutes: defaultConfig.releasePollMinutes || 5,
  broadcastChats: (process.env.BROADCAST_CHAT_IDS || '')
    .split(',')
    .map(id => id.trim())
    .filter(Boolean),
  monitoredServices: defaultConfig.monitoredServices,
  rootDir,
  logsDir: path.join(rootDir, 'logs'),
  dataDir: path.join(rootDir, 'data'),
};

export function isAdmin(userId) {
  if (!userId) return false;
  const uidStr = String(userId);
  return config.adminUsers.includes(uidStr);
}

export function isAllowedChat(chatId) {
  if (!chatId) return false;
  // If allowedChats is empty, allow all by default; otherwise enforce whitelist
  if (config.allowedChats.length === 0) return true;
  const cidStr = String(chatId);
  return config.allowedChats.includes(cidStr);
}
