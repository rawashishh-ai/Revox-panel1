import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const RUPAYEX_API_BASE = 'https://rupayex.net/api';
const FIXED_KEY_PRICE = 210;
const UNLOCK_KEY_VALUE = 'THEUPCYBER111asx';

function getServerRupayexToken() {
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
    // Ignore file read errors
  }

  return '';
}

function deriveDeterministicLicenseKey(orderId, deviceId, secret) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const hash = crypto
    .createHmac('sha256', secret || 'revox_secret')
    .update(`${orderId}:${deviceId}`)
    .digest();
  const segment = (offset) =>
    Array.from({ length: 4 }, (_, i) => chars[hash[offset + i] % chars.length]).join('');
  return `${segment(0)}-${segment(4)}-${segment(8)}-${segment(12)}`;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'METHOD_NOT_ALLOWED', message: 'POST required' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    const { orderId, deviceId, deviceSecret } = body;

    if (!orderId || typeof orderId !== 'string') {
      return res.status(400).json({
        error: 'MISSING_ORDER_ID',
        message: 'Order ID is required for verification.',
      });
    }

    if (
      typeof deviceId !== 'string' ||
      !/^[a-zA-Z0-9_-]{8,128}$/.test(deviceId) ||
      typeof deviceSecret !== 'string' ||
      !/^[a-zA-Z0-9_-]{16,128}$/.test(deviceSecret)
    ) {
      return res.status(400).json({
        error: 'INVALID_DEVICE_IDENTITY',
        message: 'Valid device identity is required.',
      });
    }

    const userToken = getServerRupayexToken();
    if (!userToken) {
      return res.status(400).json({
        error: 'GATEWAY_TOKEN_MISSING',
        message: 'Server API token is not configured.',
      });
    }

    const statusUrl = `${RUPAYEX_API_BASE}/order-status?user_token=${encodeURIComponent(
      userToken
    )}&order_id=${encodeURIComponent(orderId)}`;

    const resp = await fetch(statusUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });

    if (!resp.ok) {
      return res.status(502).json({
        error: 'GATEWAY_UNAVAILABLE',
        message: 'Unable to verify payment status with RupayEx.',
      });
    }

    const data = await resp.json();

    const rawStatus = String(
      data.payment_status ||
        data.result?.payment_status ||
        data.result?.txnStatus ||
        data.result?.status ||
        data.result?.orderStatus ||
        data.txnStatus ||
        (typeof data.status === 'string' ? data.status : '') ||
        ''
    ).toUpperCase();

    if (
      rawStatus === 'SUCCESS' ||
      rawStatus === 'COMPLETED' ||
      rawStatus === 'PAID'
    ) {
      const licenseKey = deriveDeterministicLicenseKey(orderId, deviceId, userToken);
      return res.status(200).json({
        orderId,
        deviceId,
        status: 'PAID',
        message: 'Payment verified successfully.',
        amount: Number(data.amount) || FIXED_KEY_PRICE,
        unlockKey: UNLOCK_KEY_VALUE,
        licenseKey,
        paidAt: Date.now(),
        utr: data.utr || data.result?.utr || null,
      });
    }

    if (
      rawStatus === 'FAILED' ||
      rawStatus === 'FAILURE' ||
      rawStatus === 'ERROR' ||
      rawStatus === 'EXPIRED'
    ) {
      return res.status(200).json({
        orderId,
        deviceId,
        status: 'FAILED',
        message: data.message || 'Payment failed or was declined.',
        amount: FIXED_KEY_PRICE,
        unlockKey: null,
        licenseKey: null,
      });
    }

    if (rawStatus === 'CANCELLED' || rawStatus === 'CANCELED') {
      return res.status(200).json({
        orderId,
        deviceId,
        status: 'CANCELLED',
        message: data.message || 'Payment was cancelled.',
        amount: FIXED_KEY_PRICE,
        unlockKey: null,
        licenseKey: null,
      });
    }

    return res.status(200).json({
      orderId,
      deviceId,
      status: 'PENDING',
      message: data.message || 'Payment is still pending confirmation.',
      amount: FIXED_KEY_PRICE,
      unlockKey: null,
      licenseKey: null,
    });
  } catch (err) {
    console.error('Vercel verify-order error:', err);
    return res.status(500).json({
      error: 'SERVER_ERROR',
      message: 'Failed to verify transaction with RupayEx.',
    });
  }
}
