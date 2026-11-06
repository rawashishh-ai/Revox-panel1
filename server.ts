import express from 'express';
import { createServer as createViteServer } from 'vite';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = 3000;

const RUPAYEX_API_BASE = 'https://rupayex.net/api';
const FIXED_KEY_PRICE = 210;
const CONFIG_FILE = path.join(process.cwd(), '.rupayex-config.json');

// Enable CORS for custom domain deployments (e.g., revoxpanel.site)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const UNLOCK_KEY_VALUE = 'THEUPCYBER111asx';

function deriveDeterministicLicenseKey(
  orderId: string,
  deviceId: string,
  secret: string
): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const hash = crypto
    .createHmac('sha256', secret || 'revox_secret')
    .update(`${orderId}:${deviceId}`)
    .digest();
  const segment = (offset: number) =>
    Array.from({ length: 4 }, (_, i) => chars[hash[offset + i] % chars.length]).join('');
  return `${segment(0)}-${segment(4)}-${segment(8)}-${segment(12)}`;
}

function getServerRupayexToken(): string {
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
    if (fs.existsSync(CONFIG_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
      if (parsed.userToken && String(parsed.userToken).trim().length > 4) {
        return String(parsed.userToken).trim();
      }
    }
  } catch (err) {
    console.error('Failed to read server gateway config:', err);
  }

  return '';
}

interface CustomerDetails {
  name: string;
  email: string;
  mobile: string;
}

interface OrderRecord {
  orderId: string;
  rupayexOrderId: string;
  deviceId: string;
  deviceSecret: string;
  uid?: string;
  amount: number;
  customer: CustomerDetails;
  paymentUrl: string;
  status: 'PENDING' | 'PAID' | 'FAILED' | 'CANCELLED';
  unlockKey: string | null;
  licenseKey: string | null;
  createdAt: number;
  paidAt?: number;
  utr?: string;
  failureReason?: string;
}

const orders = new Map<string, OrderRecord>();
const paidOrderByDevice = new Map<string, string>();

// Check if THIS specific device has already paid and unlocked its key
app.post('/api/rupayex/device-session', (req, res) => {
  try {
    const { deviceId, deviceSecret } = req.body || {};
    if (!deviceId || !deviceSecret) {
      res.status(400).json({ unlocked: false });
      return;
    }

    const paidOrderId = paidOrderByDevice.get(deviceId);

    if (paidOrderId) {
      const record = orders.get(paidOrderId);
      if (
        record &&
        record.deviceId === deviceId &&
        record.deviceSecret === deviceSecret &&
        record.status === 'PAID' &&
        record.unlockKey
      ) {
        res.json({
          unlocked: true,
          orderId: record.orderId,
          amount: record.amount,
          unlockKey: record.unlockKey,
          licenseKey: record.licenseKey,
          paidAt: record.paidAt,
          utr: record.utr || null,
        });
        return;
      }
    }

    res.json({
      unlocked: false,
      amount: FIXED_KEY_PRICE,
    });
  } catch {
    res.json({ unlocked: false });
  }
});

// Initiate Payment Request via POST https://rupayex.net/api/create-order for fixed ₹210
app.post('/api/rupayex/create-order', async (req, res) => {
  try {
    const {
      deviceId,
      deviceSecret,
      uid,
      customerName,
      customerEmail,
      customerMobile,
      originUrl,
    } = req.body || {};

    if (
      typeof deviceId !== 'string' ||
      !/^[a-zA-Z0-9_-]{8,128}$/.test(deviceId) ||
      typeof deviceSecret !== 'string' ||
      !/^[a-zA-Z0-9_-]{16,128}$/.test(deviceSecret)
    ) {
      res.status(400).json({
        error: 'INVALID_DEVICE_IDENTITY',
        message: 'Valid per-device identity is required.',
      });
      return;
    }

    // Prevent duplicate payment and duplicate key generation if this device is already unlocked
    const existingPaidOrderId = paidOrderByDevice.get(deviceId);
    if (existingPaidOrderId) {
      const existingRecord = orders.get(existingPaidOrderId);
      if (
        existingRecord &&
        existingRecord.deviceId === deviceId &&
        existingRecord.deviceSecret === deviceSecret &&
        existingRecord.status === 'PAID' &&
        existingRecord.unlockKey
      ) {
        res.status(409).json({
          error: 'ALREADY_PAID',
          message: 'Payment is already completed for this device.',
          orderId: existingRecord.orderId,
          amount: existingRecord.amount,
          unlockKey: existingRecord.unlockKey,
          licenseKey: existingRecord.licenseKey,
        });
        return;
      }
    }

    const userToken = getServerRupayexToken();
    if (!userToken) {
      res.status(400).json({
        error: 'GATEWAY_TOKEN_MISSING',
        message:
          'RUPAYEX_API_TOKEN is not set in server environment (.env). Please configure RUPAYEX_API_TOKEN on the server.',
      });
      return;
    }

    const cleanMobile =
      String(customerMobile || '9876543210')
        .replace(/\D/g, '')
        .slice(-10) || '9876543210';

    const cleanName =
      String(customerName || 'Revox Customer')
        .trim()
        .slice(0, 60) || 'Revox Customer';

    const cleanEmail =
      String(customerEmail || 'user@revoxpanel.site')
        .trim()
        .slice(0, 80) || 'user@revoxpanel.site';

    const amount = FIXED_KEY_PRICE;

    const baseRedirectUrl = (
      String(originUrl || process.env.APP_URL || '').trim() ||
      'https://revoxpanel.site'
    ).replace(/\/$/, '');

    const orderId = `RX${Date.now()}${Math.floor(1000 + Math.random() * 9000)}`;
    const redirectUrl = `${baseRedirectUrl}/?order_id=${encodeURIComponent(orderId)}`;

    const formParams = new URLSearchParams();
    formParams.append('user_token', userToken);
    formParams.append('amount', String(amount));
    formParams.append('order_id', orderId);
    formParams.append('customer_mobile', cleanMobile);
    formParams.append('redirect_url', redirectUrl);
    formParams.append('remark1', cleanName);
    formParams.append('remark2', cleanEmail);

    const createResp = await fetch(`${RUPAYEX_API_BASE}/create-order`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: formParams.toString(),
    });

    const rawText = await createResp.text();
    let createData: {
      status?: boolean | string;
      message?: string;
      result?: {
        orderId?: string;
        order_id?: string;
        payment_url?: string;
        paymentUrl?: string;
        url?: string;
      };
      payment_url?: string;
      paymentUrl?: string;
    } = {};

    try {
      createData = JSON.parse(rawText);
    } catch {
      res.status(502).json({
        error: 'BAD_GATEWAY_RESPONSE',
        message:
          'Received an invalid response from https://rupayex.net/api/create-order.',
      });
      return;
    }

    const paymentUrl =
      createData.result?.payment_url ||
      createData.result?.paymentUrl ||
      createData.result?.url ||
      createData.payment_url ||
      createData.paymentUrl ||
      '';

    const isSuccess =
      (createData.status === true ||
        createData.status === 'true' ||
        createData.status === 'SUCCESS' ||
        createData.status === '200') &&
      Boolean(paymentUrl);

    if (!isSuccess || !paymentUrl) {
      const msg =
        createData.message || 'Failed to initiate payment with RupayEx gateway.';
      res.status(400).json({
        error: 'ORDER_INITIATION_FAILED',
        message: msg,
      });
      return;
    }

    const rupayexOrderId = String(
      createData.result?.orderId || createData.result?.order_id || orderId
    );

    const record: OrderRecord = {
      orderId,
      rupayexOrderId,
      deviceId,
      deviceSecret,
      uid: typeof uid === 'string' ? uid : undefined,
      amount,
      customer: {
        name: cleanName,
        email: cleanEmail,
        mobile: cleanMobile,
      },
      paymentUrl,
      status: 'PENDING',
      unlockKey: null,
      licenseKey: null,
      createdAt: Date.now(),
    };

    orders.set(orderId, record);

    res.json({
      orderId,
      rupayexOrderId,
      amount,
      paymentUrl,
      status: 'PENDING',
    });
  } catch (error) {
    console.error('Error initiating RupayEx checkout:', error);
    res.status(500).json({
      error: 'SERVER_ERROR',
      message: 'Unable to initiate payment request with https://rupayex.net/api.',
    });
  }
});

// Finalize confirmed PAID order idempotently (prevents duplicate key generation)
function markOrderPaidIdempotent(
  record: OrderRecord,
  userToken: string,
  utr?: string
) {
  if (record.status === 'PAID' && record.unlockKey && record.licenseKey) {
    return;
  }
  record.status = 'PAID';
  record.paidAt = record.paidAt || Date.now();
  record.unlockKey = record.unlockKey || UNLOCK_KEY_VALUE;
  record.licenseKey =
    record.licenseKey ||
    deriveDeterministicLicenseKey(record.orderId, record.deviceId, userToken);
  if (utr) {
    record.utr = utr;
  }
  orders.set(record.orderId, record);
  paidOrderByDevice.set(record.deviceId, record.orderId);
}

// Server-side verification with GET https://rupayex.net/api/order-status
async function verifyOrderWithRupayexServer(
  orderId: string,
  deviceId: string,
  deviceSecret: string
): Promise<{
  status: 'PENDING' | 'PAID' | 'FAILED' | 'CANCELLED';
  gatewayMessage?: string;
  amount: number;
  unlockKey: string | null;
  licenseKey: string | null;
  paidAt?: number;
  utr?: string;
}> {
  const existingRecord = orders.get(orderId);
  if (existingRecord && existingRecord.status === 'PAID' && existingRecord.unlockKey) {
    return {
      status: 'PAID',
      amount: existingRecord.amount,
      unlockKey: existingRecord.unlockKey,
      licenseKey: existingRecord.licenseKey,
      paidAt: existingRecord.paidAt,
      utr: existingRecord.utr,
    };
  }

  const userToken = getServerRupayexToken();
  if (!userToken) {
    return {
      status: existingRecord?.status || 'PENDING',
      gatewayMessage: 'Server API token is not configured.',
      amount: FIXED_KEY_PRICE,
      unlockKey: null,
      licenseKey: null,
    };
  }

  try {
    const statusUrl = `${RUPAYEX_API_BASE}/order-status?user_token=${encodeURIComponent(
      userToken
    )}&order_id=${encodeURIComponent(orderId)}`;

    const resp = await fetch(statusUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });

    if (!resp.ok) {
      return {
        status: existingRecord?.status || 'PENDING',
        gatewayMessage: 'Gateway status check returned non-200 HTTP response.',
        amount: FIXED_KEY_PRICE,
        unlockKey: null,
        licenseKey: null,
      };
    }

    const data = (await resp.json()) as {
      status?: boolean | string;
      payment_status?: string;
      txnStatus?: string;
      amount?: number | string;
      utr?: string | null;
      message?: string;
      result?: {
        payment_status?: string;
        txnStatus?: string;
        status?: string;
        orderStatus?: string;
        utr?: string;
        amount?: string | number;
      };
    };

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

    const record: OrderRecord = existingRecord || {
      orderId,
      rupayexOrderId: orderId,
      deviceId,
      deviceSecret,
      amount: Number(data.amount) || FIXED_KEY_PRICE,
      customer: {
        name: 'Revox Customer',
        email: 'user@revoxpanel.site',
        mobile: '9876543210',
      },
      paymentUrl: '',
      status: 'PENDING',
      unlockKey: null,
      licenseKey: null,
      createdAt: Date.now(),
    };

    if (
      rawStatus === 'SUCCESS' ||
      rawStatus === 'COMPLETED' ||
      rawStatus === 'PAID'
    ) {
      markOrderPaidIdempotent(
        record,
        userToken,
        data.utr || data.result?.utr || undefined
      );
      return {
        status: 'PAID',
        gatewayMessage: data.message || 'Payment verified successfully.',
        amount: record.amount,
        unlockKey: record.unlockKey,
        licenseKey: record.licenseKey,
        paidAt: record.paidAt,
        utr: record.utr,
      };
    }

    if (
      rawStatus === 'FAILED' ||
      rawStatus === 'FAILURE' ||
      rawStatus === 'ERROR' ||
      rawStatus === 'EXPIRED'
    ) {
      record.status = 'FAILED';
      record.failureReason =
        data.message || 'Payment failed or was declined by the gateway.';
      orders.set(orderId, record);
      return {
        status: 'FAILED',
        gatewayMessage: record.failureReason,
        amount: record.amount,
        unlockKey: null,
        licenseKey: null,
      };
    }

    if (rawStatus === 'CANCELLED' || rawStatus === 'CANCELED') {
      record.status = 'CANCELLED';
      record.failureReason = data.message || 'Payment was cancelled by the user.';
      orders.set(orderId, record);
      return {
        status: 'CANCELLED',
        gatewayMessage: record.failureReason,
        amount: record.amount,
        unlockKey: null,
        licenseKey: null,
      };
    }

    return {
      status: 'PENDING',
      gatewayMessage:
        data.message || 'Payment is still pending confirmation from RupayEx.',
      amount: record.amount,
      unlockKey: null,
      licenseKey: null,
    };
  } catch (err) {
    console.error('Error verifying order with RupayEx:', err);
    return {
      status: existingRecord?.status || 'PENDING',
      gatewayMessage: 'Unable to reach RupayEx verification server.',
      amount: FIXED_KEY_PRICE,
      unlockKey: null,
      licenseKey: null,
    };
  }
}

// RupayEx Webhook / Server Callback Handler
app.post('/api/rupayex/webhook', async (req, res) => {
  try {
    const orderId = String(
      req.body?.order_id ||
        req.body?.orderId ||
        req.body?.result?.orderId ||
        req.body?.result?.order_id ||
        ''
    ).trim();

    if (!orderId) {
      res.status(400).json({ status: false, message: 'Missing order_id' });
      return;
    }

    const record = orders.get(orderId);
    await verifyOrderWithRupayexServer(
      orderId,
      record?.deviceId || 'webhook_device',
      record?.deviceSecret || 'webhook_secret_key'
    );

    res.json({ status: true });
  } catch {
    res.status(200).json({ status: true });
  }
});

// Verify Order Endpoint called after redirect (stateless-compatible)
app.post('/api/rupayex/verify-order', async (req, res) => {
  try {
    const { orderId, deviceId, deviceSecret } = req.body || {};
    if (!orderId || typeof orderId !== 'string') {
      res.status(400).json({
        error: 'MISSING_ORDER_ID',
        message: 'Order ID is required for verification.',
      });
      return;
    }

    if (
      typeof deviceId !== 'string' ||
      !/^[a-zA-Z0-9_-]{8,128}$/.test(deviceId) ||
      typeof deviceSecret !== 'string' ||
      !/^[a-zA-Z0-9_-]{16,128}$/.test(deviceSecret)
    ) {
      res.status(400).json({
        error: 'INVALID_DEVICE_IDENTITY',
        message: 'Valid device identity is required.',
      });
      return;
    }

    const existingRecord = orders.get(orderId);
    if (
      existingRecord &&
      (existingRecord.deviceId !== deviceId ||
        existingRecord.deviceSecret !== deviceSecret)
    ) {
      res.status(403).json({
        error: 'FORBIDDEN_DEVICE',
        message: 'This order belongs to a different device.',
      });
      return;
    }

    const verification = await verifyOrderWithRupayexServer(
      orderId,
      deviceId,
      deviceSecret
    );

    res.json({
      orderId,
      deviceId,
      status: verification.status,
      message: verification.gatewayMessage,
      amount: verification.amount,
      unlockKey: verification.unlockKey,
      licenseKey: verification.licenseKey,
      paidAt: verification.paidAt || null,
      utr: verification.utr || null,
    });
  } catch (error) {
    console.error('Error in /api/rupayex/verify-order:', error);
    res.status(500).json({
      error: 'SERVER_ERROR',
      message: 'Failed to verify transaction with RupayEx.',
    });
  }
});

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*all', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`REVOX KEY Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
