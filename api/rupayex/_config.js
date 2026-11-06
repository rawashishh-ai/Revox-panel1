import fs from 'fs';
import path from 'path';

// Server-side only fallback token from merchant's .rupayex-config.json
// Never imported by frontend code (/src/*)
const CONFIGURED_MERCHANT_TOKEN = 'a49e9238076b83c460f31849a3cb7e8e';

export function getServerRupayexToken() {
  const envToken = (
    process.env.RUPAYEX_API_TOKEN ||
    process.env.RUPAYEX_USER_TOKEN ||
    process.env.USER_TOKEN ||
    process.env.API_TOKEN ||
    ''
  ).trim();

  if (envToken && !envToken.includes('MY_') && envToken.length > 4) {
    return envToken;
  }

  try {
    const configPath = path.join(process.cwd(), '.rupayex-config.json');
    if (fs.existsSync(configPath)) {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (parsed.userToken && String(parsed.userToken).trim().length > 4) {
        return String(parsed.userToken).trim();
      }
    }
  } catch {
    // Ignore filesystem error in serverless environment
  }

  return CONFIGURED_MERCHANT_TOKEN;
}
