import { getServerRupayexToken } from './_config.js';

const RUPAYEX_API_BASE = 'https://rupayex.net/api';
const FIXED_KEY_PRICE = 210;

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
    const {
      deviceId,
      deviceSecret,
      customerName,
      customerEmail,
      customerMobile,
      originUrl,
    } = body;

    if (
      typeof deviceId !== 'string' ||
      !/^[a-zA-Z0-9_-]{8,128}$/.test(deviceId) ||
      typeof deviceSecret !== 'string' ||
      !/^[a-zA-Z0-9_-]{16,128}$/.test(deviceSecret)
    ) {
      return res.status(400).json({
        error: 'INVALID_DEVICE_IDENTITY',
        message: 'Valid per-device identity is required.',
      });
    }

    const userToken = getServerRupayexToken();
    if (!userToken) {
      return res.status(400).json({
        error: 'GATEWAY_TOKEN_MISSING',
        message: 'RUPAYEX_API_TOKEN is not configured on the server.',
      });
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

    const baseRedirectUrl = (
      String(originUrl || process.env.APP_URL || '').trim() ||
      'https://revoxpanel.site'
    ).replace(/\/$/, '');

    const orderId = `RX${Date.now()}${Math.floor(1000 + Math.random() * 9000)}`;
    const redirectUrl = `${baseRedirectUrl}/?order_id=${encodeURIComponent(orderId)}`;

    const formParams = new URLSearchParams();
    formParams.append('user_token', userToken);
    formParams.append('amount', String(FIXED_KEY_PRICE));
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
    let createData = {};
    try {
      createData = JSON.parse(rawText);
    } catch {
      return res.status(502).json({
        error: 'BAD_GATEWAY_RESPONSE',
        message: 'Invalid response from RupayEx API.',
      });
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
      return res.status(400).json({
        error: 'ORDER_INITIATION_FAILED',
        message: createData.message || 'Failed to initiate payment with RupayEx.',
      });
    }

    const rupayexOrderId = String(
      createData.result?.orderId || createData.result?.order_id || orderId
    );

    return res.status(200).json({
      orderId,
      rupayexOrderId,
      amount: FIXED_KEY_PRICE,
      paymentUrl,
      status: 'PENDING',
    });
  } catch (err) {
    console.error('Vercel create-order error:', err);
    return res.status(500).json({
      error: 'SERVER_ERROR',
      message: 'Unable to initiate payment with RupayEx.',
    });
  }
}
