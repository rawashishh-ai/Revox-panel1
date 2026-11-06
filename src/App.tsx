/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { onAuthStateChanged, User } from 'firebase/auth';
import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  serverTimestamp,
} from 'firebase/firestore';
import {
  KeyRound,
  Lock,
  Unlock,
  Copy,
  Check,
  X,
  CheckCircle2,
  Download,
  AlertCircle,
  ArrowRight,
  ShieldCheck,
  Loader2,
} from 'lucide-react';
import { RedParticlesCanvas } from './components/RedParticlesCanvas';
import {
  db,
  auth,
  getOrCreateDeviceId,
  getOrCreateDeviceSecret,
  handleFirestoreError,
  OperationType,
} from './firebase';

const FIXED_KEY_PRICE = 210;
const LOCKED_BLUR_PLACEHOLDER = 'THEUPCYBER••••••';
const ACTIVE_ORDER_STORAGE_KEY = 'revox_rupayex_active_order_v5';
const RECEIPT_STORAGE_KEY = 'revox_rupayex_receipt_v5';

const BACKEND_ORIGINS = [
  '',
  'https://ais-pre-jfvgsgbq4nps66sk6v2ogj-412645379901.asia-southeast1.run.app',
  'https://ais-dev-jfvgsgbq4nps66sk6v2ogj-412645379901.asia-southeast1.run.app',
];

async function postGatewayApi(
  endpointPath: string,
  payload: Record<string, unknown>
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  let lastError: unknown = null;

  for (const baseOrigin of BACKEND_ORIGINS) {
    try {
      const response = await fetch(`${baseOrigin}${endpointPath}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(payload),
      });

      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        // Current host returned HTML 404 (e.g. static host without /api route); try next backend origin
        continue;
      }

      const data = (await response.json()) as Record<string, unknown>;
      return {
        ok: response.ok,
        status: response.status,
        data,
      };
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error('Gateway server unreachable');
}

interface SavedReceipt {
  deviceId: string;
  orderId: string;
  amount: number;
  unlockKey: string;
  licenseKey?: string;
  utr?: string | null;
  paidAt: number;
}

export default function App() {
  const [deviceId] = useState<string>(() => getOrCreateDeviceId());
  const [deviceSecret] = useState<string>(() => getOrCreateDeviceSecret());
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState<boolean>(false);

  // Clean up legacy localStorage keys
  useEffect(() => {
    localStorage.removeItem('revox_device_current_amount_v1');
    localStorage.removeItem('revox_device_price_stopped_v1');
    localStorage.removeItem('revox_device_saved_receipt');
    localStorage.removeItem('revox_rupayex_amount_v2');
    localStorage.removeItem('revox_rupayex_stopped_v2');
    localStorage.removeItem('revox_rupayex_receipt_v2');
    localStorage.removeItem('revox_rupayex_amount_v3');
    localStorage.removeItem('revox_rupayex_stopped_v3');
    localStorage.removeItem('revox_rupayex_active_order_v3');
    localStorage.removeItem('revox_rupayex_receipt_v3');
    localStorage.removeItem('revox_rupayex_amount_v4');
    localStorage.removeItem('revox_rupayex_stopped_v4');
    localStorage.removeItem('revox_rupayex_active_order_v4');
    localStorage.removeItem('revox_rupayex_receipt_v4');
  }, []);

  // Payment & Key Unlock States
  const [showPaymentPage, setShowPaymentPage] = useState<boolean>(false);
  const [isPaid, setIsPaid] = useState<boolean>(false);
  const [unlockedKey, setUnlockedKey] = useState<string | null>(null);
  const [licenseKey, setLicenseKey] = useState<string | null>(null);
  const [verifiedOrderId, setVerifiedOrderId] = useState<string | null>(null);
  const [activeOrderId, setActiveOrderId] = useState<string | null>(() =>
    localStorage.getItem(ACTIVE_ORDER_STORAGE_KEY)
  );
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);

  const [isSubmittingPayment, setIsSubmittingPayment] = useState<boolean>(false);
  const [isVerifyingReturn, setIsVerifyingReturn] = useState<boolean>(false);
  const [paymentError, setPaymentError] = useState<string | null>(null);

  const [copied, setCopied] = useState<boolean>(false);
  const paymentLockRef = useRef<boolean>(false);

  // Track Firebase Auth state
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (user) => {
      setCurrentUser(user);
      setAuthReady(true);
    });
    return () => unsub();
  }, []);

  // Sync per-device order & unlock state to Firestore when user is signed in
  const syncDeviceOrderToFirestore = useCallback(
    async (
      orderId: string,
      amountToSave: number,
      status: 'PENDING' | 'PAID',
      keyToSave?: string
    ) => {
      if (!currentUser || !currentUser.emailVerified) return;
      const docId = `${currentUser.uid}_${deviceId}`.slice(0, 120);
      const docRef = doc(db, 'deviceUnlocks', docId);
      const path = `deviceUnlocks/${docId}`;

      try {
        const existingSnap = await getDoc(docRef);
        if (!existingSnap.exists()) {
          const payload: Record<string, unknown> = {
            ownerId: currentUser.uid.slice(0, 128),
            deviceId: deviceId.slice(0, 128),
            orderId: orderId.slice(0, 128),
            amount: amountToSave,
            status,
            createdAt: serverTimestamp(),
          };
          if (status === 'PAID' && keyToSave) {
            payload.unlockKey = keyToSave.slice(0, 64);
          }
          await setDoc(docRef, payload);
        } else {
          const existingData = existingSnap.data();
          if (existingData.status !== 'PAID') {
            if (status === 'PAID' && keyToSave) {
              await updateDoc(docRef, {
                status: 'PAID',
                unlockKey: keyToSave.slice(0, 64),
                amount: amountToSave,
                orderId: orderId.slice(0, 128),
                updatedAt: serverTimestamp(),
              });
            } else {
              await updateDoc(docRef, {
                amount: amountToSave,
                orderId: orderId.slice(0, 128),
                updatedAt: serverTimestamp(),
              });
            }
          }
        }
      } catch (error) {
        handleFirestoreError(error, OperationType.WRITE, path);
      }
    },
    [currentUser, deviceId]
  );

  // Save verified receipt to localStorage bound to this deviceId
  const persistVerifiedReceipt = useCallback(
    (
      orderId: string,
      amount: number,
      key: string,
      licKey?: string,
      utr?: string | null
    ) => {
      const receipt: SavedReceipt = {
        deviceId,
        orderId,
        amount,
        unlockKey: key,
        licenseKey: licKey,
        utr: utr || null,
        paidAt: Date.now(),
      };
      localStorage.setItem(RECEIPT_STORAGE_KEY, JSON.stringify(receipt));
    },
    [deviceId]
  );

  // Server-side verification of an order ID via POST /api/rupayex/verify-order
  const verifyOrderOnServer = useCallback(
    async (orderIdToVerify: string) => {
      setIsVerifyingReturn(true);
      setPaymentError(null);

      try {
        const res = await postGatewayApi('/api/rupayex/verify-order', {
          orderId: orderIdToVerify,
          deviceId,
          deviceSecret,
        });

        const data = res.data;

        if (!res.ok) {
          setPaymentError(
            String(data.message || 'Unable to verify payment status with RupayEx.')
          );
          return;
        }

        if (
          data.status === 'PAID' &&
          typeof data.unlockKey === 'string' &&
          data.deviceId === deviceId
        ) {
          const verifiedKey = data.unlockKey;
          const verifiedLic =
            typeof data.licenseKey === 'string' ? data.licenseKey : undefined;
          const verifiedId = String(data.orderId || orderIdToVerify);

          setUnlockedKey(verifiedKey);
          setLicenseKey(verifiedLic || null);
          setVerifiedOrderId(verifiedId);
          setIsPaid(true);
          localStorage.removeItem(ACTIVE_ORDER_STORAGE_KEY);
          persistVerifiedReceipt(
            verifiedId,
            FIXED_KEY_PRICE,
            verifiedKey,
            verifiedLic,
            typeof data.utr === 'string' ? data.utr : null
          );
          await syncDeviceOrderToFirestore(
            verifiedId,
            FIXED_KEY_PRICE,
            'PAID',
            verifiedKey
          );
        } else if (data.status === 'FAILED') {
          localStorage.removeItem(ACTIVE_ORDER_STORAGE_KEY);
          setPaymentError(
            String(
              data.message || 'Payment failed or was declined. Please try again.'
            )
          );
        } else if (data.status === 'CANCELLED') {
          localStorage.removeItem(ACTIVE_ORDER_STORAGE_KEY);
          setPaymentError(
            String(
              data.message || 'Payment was cancelled. Please click PAY NOW to try again.'
            )
          );
        } else {
          setPaymentError(
            'Payment was not completed. Click PAY NOW to complete your payment.'
          );
        }
      } catch {
        setPaymentError('Network error while verifying transaction status.');
      } finally {
        setIsVerifyingReturn(false);
      }
    },
    [deviceId, deviceSecret, persistVerifiedReceipt, syncDeviceOrderToFirestore]
  );

  // On boot: check if returning from RupayEx redirect (?order_id=...) or if device is already unlocked
  useEffect(() => {
    let cancelled = false;

    async function initDeviceAndCheckRedirect() {
      const params = new URLSearchParams(window.location.search);
      const returnedOrderId =
        params.get('order_id') || params.get('orderId') || '';

      if (returnedOrderId) {
        const cleanUrl = window.location.pathname + window.location.hash;
        window.history.replaceState({}, document.title, cleanUrl);
        setShowPaymentPage(true);
        setActiveOrderId(returnedOrderId);
        await verifyOrderOnServer(returnedOrderId);
        return;
      }

      // Check saved verified receipt for this specific device
      try {
        const rawReceipt = localStorage.getItem(RECEIPT_STORAGE_KEY);
        if (rawReceipt) {
          const parsed = JSON.parse(rawReceipt) as SavedReceipt;
          if (
            parsed &&
            parsed.deviceId === deviceId &&
            typeof parsed.unlockKey === 'string' &&
            parsed.unlockKey.length > 4
          ) {
            setUnlockedKey(parsed.unlockKey);
            setLicenseKey(parsed.licenseKey || null);
            setVerifiedOrderId(parsed.orderId || 'VERIFIED');
            setIsPaid(true);
            return;
          }
        }
      } catch {
        // Ignore storage parse error
      }

      try {
        const res = await postGatewayApi('/api/rupayex/device-session', {
          deviceId,
          deviceSecret,
        });
        if (
          res.ok &&
          !cancelled &&
          res.data.unlocked &&
          typeof res.data.unlockKey === 'string'
        ) {
          setUnlockedKey(res.data.unlockKey);
          setLicenseKey(
            typeof res.data.licenseKey === 'string' ? res.data.licenseKey : null
          );
          setVerifiedOrderId(String(res.data.orderId || 'VERIFIED'));
          setIsPaid(true);
          return;
        }
      } catch {
        // Ignore network error
      }

      if (authReady && currentUser && currentUser.emailVerified) {
        const docId = `${currentUser.uid}_${deviceId}`.slice(0, 120);
        const path = `deviceUnlocks/${docId}`;
        try {
          const snap = await getDoc(doc(db, 'deviceUnlocks', docId));
          if (!cancelled && snap.exists()) {
            const record = snap.data();
            if (
              record.ownerId === currentUser.uid &&
              record.deviceId === deviceId &&
              record.status === 'PAID' &&
              typeof record.unlockKey === 'string'
            ) {
              setUnlockedKey(record.unlockKey);
              setVerifiedOrderId(record.orderId || 'VERIFIED');
              setIsPaid(true);
            }
          }
        } catch (error) {
          handleFirestoreError(error, OperationType.GET, path);
        }
      }
    }

    initDeviceAndCheckRedirect();
    return () => {
      cancelled = true;
    };
  }, [deviceId, deviceSecret, authReady, currentUser, verifyOrderOnServer]);

  // Initiate RupayEx Payment for fixed ₹210 when user clicks "PAY NOW"
  const handlePayNowClick = async () => {
    if (isPaid || isSubmittingPayment || paymentLockRef.current) return;

    paymentLockRef.current = true;
    setIsSubmittingPayment(true);
    setPaymentError(null);
    setCheckoutUrl(null);

    try {
      const response = await postGatewayApi('/api/rupayex/create-order', {
        deviceId,
        deviceSecret,
        uid: currentUser?.uid,
        amount: FIXED_KEY_PRICE,
        customerName: currentUser?.displayName || 'Revox Customer',
        customerEmail: currentUser?.email || 'user@revoxpanel.site',
        customerMobile: '9876543210',
        originUrl: window.location.origin,
      });

      const data = response.data;

      if (
        response.status === 409 &&
        data.error === 'ALREADY_PAID' &&
        typeof data.unlockKey === 'string'
      ) {
        setUnlockedKey(data.unlockKey);
        setLicenseKey(
          typeof data.licenseKey === 'string' ? data.licenseKey : null
        );
        setVerifiedOrderId(String(data.orderId || 'VERIFIED'));
        setIsPaid(true);
        return;
      }

      const paymentUrl =
        typeof data.paymentUrl === 'string' ? data.paymentUrl : '';
      const orderId = typeof data.orderId === 'string' ? data.orderId : '';

      if (!response.ok || !paymentUrl) {
        setPaymentError(
          String(
            data.message || 'Failed to initiate payment with RupayEx gateway.'
          )
        );
        return;
      }

      setActiveOrderId(orderId);
      setCheckoutUrl(paymentUrl);
      localStorage.setItem(ACTIVE_ORDER_STORAGE_KEY, orderId);

      if (currentUser?.emailVerified && orderId) {
        await syncDeviceOrderToFirestore(orderId, FIXED_KEY_PRICE, 'PENDING');
      }

      // Redirect customer directly to the payment gateway checkout URL returned by RupayEx API
      try {
        if (window.top && window.top !== window.self) {
          window.top.location.href = paymentUrl;
        } else {
          window.location.href = paymentUrl;
        }
      } catch {
        window.location.assign(paymentUrl);
      }
    } catch {
      setPaymentError('Unable to reach payment gateway server. Please try again.');
    } finally {
      setIsSubmittingPayment(false);
      paymentLockRef.current = false;
    }
  };

  const handleCopyKey = async () => {
    if (!isPaid || !unlockedKey) return;
    try {
      await navigator.clipboard.writeText(unlockedKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2200);
    } catch {
      setCopied(true);
      setTimeout(() => setCopied(false), 2200);
    }
  };

  const handleDownloadReceipt = () => {
    if (!isPaid || !unlockedKey) return;
    const text = [
      '==========================================',
      '        REVOX KEY - PAYMENT RECEIPT       ',
      '==========================================',
      `Gateway      : RupayEx (https://rupayex.net/api)`,
      `Order ID     : ${verifiedOrderId || activeOrderId || 'VERIFIED'}`,
      `Amount Paid  : INR ${FIXED_KEY_PRICE}`,
      `Unlock Key   : ${unlockedKey}`,
      licenseKey ? `License ID   : ${licenseKey}` : '',
      `Device ID    : ${deviceId}`,
      `Date         : ${new Date().toLocaleString()}`,
      '==========================================',
    ]
      .filter(Boolean)
      .join('\n');

    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `REVOX_KEY_${verifiedOrderId || 'RECEIPT'}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="relative min-h-screen w-full revox-grid-bg text-white flex flex-col justify-between select-none overflow-hidden">
      {/* Floating Red Particles matching the reference video */}
      <RedParticlesCanvas />

      {/* Top Navigation Bar — Clean with ONLY REVOX KEY */}
      <header className="relative z-20 w-full flex items-center justify-between px-5 sm:px-8 py-4 border-b border-red-900/35 bg-[#070102]/85 backdrop-blur-md">
        <a
          href="#top"
          className="font-['Orbitron'] font-extrabold text-lg sm:text-xl tracking-[0.12em] text-[#ff1e27] drop-shadow-[0_0_12px_rgba(255,30,39,0.8)] whitespace-nowrap shrink-0"
        >
          REVOX KEY
        </a>
      </header>

      {/* Main Centered Hero & Single Unlock Key Button */}
      <main className="relative z-10 flex-1 flex flex-col items-center justify-center px-4 py-10 sm:py-14 w-full max-w-xl mx-auto text-center">
        {/* SYSTEM ONLINE Badge */}
        <div className="inline-flex items-center gap-2.5 px-4 py-1.5 mb-7 border border-red-800/65 bg-[#130204]/90 shadow-[0_0_20px_rgba(220,20,30,0.2)]">
          <span className="w-2 h-2 rounded-full bg-[#ff1e27] shadow-[0_0_8px_#ff1e27]" />
          <span className="font-mono text-[11px] tracking-[0.28em] text-[#ff3b44] font-semibold uppercase">
            SYSTEM ONLINE
          </span>
        </div>

        {/* Giant 2-Line Title: REVOX / KEY */}
        <div className="flex flex-col items-center justify-center leading-none mb-6">
          <h1 className="flex flex-col items-center">
            <span className="title-revox-white text-6xl sm:text-7xl md:text-8xl font-black uppercase tracking-wider block leading-[0.95]">
              REVOX
            </span>
            <span className="title-revox-red text-5xl sm:text-6xl md:text-7xl font-black uppercase tracking-widest block mt-1 leading-[0.98]">
              KEY
            </span>
          </h1>
        </div>

        {/* Subtitle Lockup */}
        <div className="flex flex-col items-center mb-10">
          <p className="font-mono text-xs sm:text-sm tracking-[0.36em] text-zinc-300/90 uppercase leading-relaxed">
            NEXT-GEN MONITORING
            <span className="block mt-0.5">SYSTEM</span>
          </p>
          <div className="w-12 h-[1.5px] bg-red-600/80 my-3 shadow-[0_0_8px_#ef4444]" />
          <p className="font-mono text-[11px] tracking-[0.3em] text-[#ff2a34] font-semibold uppercase">
            BY REVOX
          </p>
        </div>

        {/* SINGLE OPTION BUTTON: GET DEVICE UNLOCK KEY */}
        <div className="w-full max-w-[240px] sm:max-w-[260px] flex flex-col items-center mt-2">
          <button
            type="button"
            onClick={() => setShowPaymentPage(true)}
            className="skew-btn-primary w-full py-3.5 px-6 cursor-pointer group"
          >
            <span className="skew-btn-content flex items-center justify-center gap-2.5 font-mono text-xs font-bold tracking-[0.18em] text-white uppercase whitespace-nowrap">
              <KeyRound className="w-4 h-4 text-white stroke-[2.5]" />
              <span>GET DEVICE UNLOCK KEY</span>
            </span>
          </button>
        </div>
      </main>

      {/* PREMIUM, CLEAN & SIMPLE FULL-SCREEN PAYMENT PAGE — FIXED ₹210 */}
      {showPaymentPage && (
        <div className="fixed inset-0 z-50 w-full h-full min-h-screen bg-[#060102] flex flex-col justify-between px-5 py-6 sm:p-10 text-white overflow-y-auto">
          {/* Minimal Header */}
          <div className="w-full max-w-sm mx-auto flex items-center justify-between">
            <span className="font-['Orbitron'] text-xs sm:text-sm font-bold tracking-[0.2em] text-[#ff1e27] uppercase">
              REVOX KEY ACCESS
            </span>

            <button
              type="button"
              onClick={() => setShowPaymentPage(false)}
              aria-label="Close Payment Page"
              className="w-9 h-9 bg-white/5 hover:bg-white/10 flex items-center justify-center text-zinc-400 hover:text-white transition-colors cursor-pointer rounded-full"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Center Premium Checkout Card */}
          <div className="flex-1 flex flex-col items-center justify-center w-full max-w-sm mx-auto my-4">
            <div className="w-full rounded-3xl bg-gradient-to-b from-white/[0.05] to-white/[0.02] border border-white/10 p-6 sm:p-7 shadow-[0_24px_60px_rgba(0,0,0,0.8)] space-y-6">
              {/* Top Badge & Price Lockup */}
              <div className="text-center">
                <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-red-500/10 border border-red-500/25 mb-4">
                  <ShieldCheck className="w-3.5 h-3.5 text-[#ff2a34]" />
                  <span className="font-mono text-[10px] font-semibold tracking-[0.2em] text-red-300 uppercase">
                    INSTANT LICENSE DELIVERY
                  </span>
                </div>

                <p className="font-mono text-[11px] tracking-[0.24em] text-zinc-400 uppercase mb-1.5">
                  DEVICE UNLOCK KEY PRICE
                </p>

                <div className="font-['Orbitron'] text-5xl sm:text-6xl font-black tracking-tight text-white tabular-nums">
                  ₹{FIXED_KEY_PRICE}
                </div>

                {(verifiedOrderId || activeOrderId) && (
                  <p className="font-mono text-[10px] tracking-[0.14em] text-zinc-500 mt-2">
                    ORDER ID: {verifiedOrderId || activeOrderId}
                  </p>
                )}
              </div>

              {/* Error / Failure / Cancellation Message */}
              {paymentError && (
                <div className="w-full bg-red-950/50 border border-red-700/60 rounded-2xl p-3.5 text-left flex items-start gap-2.5">
                  <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                  <p className="font-mono text-[11px] text-red-200 leading-relaxed">
                    {paymentError}
                  </p>
                </div>
              )}

              {/* Verifying Return Spinner */}
              {isVerifyingReturn && (
                <div className="w-full bg-black/40 rounded-2xl p-5 flex flex-col items-center justify-center text-center">
                  <Loader2 className="w-7 h-7 text-[#ff1e27] animate-spin mb-2.5" />
                  <span className="font-mono text-xs tracking-[0.16em] text-zinc-300 uppercase">
                    VERIFYING PAYMENT...
                  </span>
                </div>
              )}

              {/* Primary PAY NOW Button */}
              {!isPaid && !isVerifyingReturn && (
                <div className="w-full space-y-2.5">
                  <button
                    type="button"
                    disabled={isSubmittingPayment}
                    onClick={handlePayNowClick}
                    className="w-full py-4 px-6 bg-gradient-to-r from-[#e11d24] to-[#c81018] hover:from-[#f0222a] hover:to-[#d9141d] disabled:opacity-60 active:scale-[0.99] text-white font-mono text-sm font-bold tracking-[0.2em] uppercase rounded-2xl shadow-[0_10px_30px_rgba(225,29,36,0.45)] flex items-center justify-center gap-2.5 cursor-pointer transition-all"
                  >
                    {isSubmittingPayment ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                        <span>OPENING CHECKOUT...</span>
                      </>
                    ) : (
                      <>
                        <span>PAY NOW · ₹{FIXED_KEY_PRICE}</span>
                        <ArrowRight className="w-4 h-4 shrink-0" />
                      </>
                    )}
                  </button>

                  {checkoutUrl && (
                    <a
                      href={checkoutUrl}
                      target="_top"
                      rel="noopener noreferrer"
                      className="w-full py-2.5 px-4 bg-white/10 hover:bg-white/15 text-center text-white font-mono text-[11px] font-semibold tracking-wider uppercase rounded-xl block transition-colors"
                    >
                      CONTINUE TO CHECKOUT
                    </a>
                  )}
                </div>
              )}

              {/* Confirmed Payment Success Banner */}
              {isPaid && (
                <div className="w-full bg-emerald-950/35 border border-emerald-700/50 rounded-2xl p-4 flex items-center gap-3 text-left">
                  <CheckCircle2 className="w-7 h-7 text-emerald-400 shrink-0" />
                  <div>
                    <p className="font-['Orbitron'] text-xs font-bold tracking-wider text-white uppercase">
                      PAYMENT SUCCESSFUL
                    </p>
                    <p className="font-mono text-[11px] text-emerald-300 mt-0.5">
                      Your Device Key is Unlocked Below
                    </p>
                  </div>
                </div>
              )}

              {/* Device Unlock Key Box — Blurred until server confirms payment */}
              <div className="w-full bg-black/50 border border-white/10 rounded-2xl p-4">
                <div className="flex items-center justify-between text-[10px] font-mono tracking-wider uppercase mb-2">
                  <span className="text-zinc-400 flex items-center gap-1.5">
                    {isPaid ? (
                      <Unlock className="w-3.5 h-3.5 text-emerald-400" />
                    ) : (
                      <Lock className="w-3.5 h-3.5 text-[#ff2a34]" />
                    )}
                    <span>DEVICE UNLOCK KEY</span>
                  </span>
                  <span
                    className={
                      isPaid ? 'text-emerald-400 font-semibold' : 'text-zinc-500'
                    }
                  >
                    {isPaid ? 'UNLOCKED' : 'LOCKED'}
                  </span>
                </div>

                <div className="flex items-center justify-between gap-2">
                  <span
                    className={`font-mono text-lg sm:text-xl font-bold tracking-[0.14em] transition-all duration-500 ${
                      isPaid && unlockedKey
                        ? 'text-white blur-0 select-all'
                        : 'text-zinc-300/70 blur-[7px] select-none pointer-events-none'
                    }`}
                  >
                    {isPaid && unlockedKey ? unlockedKey : LOCKED_BLUR_PLACEHOLDER}
                  </span>

                  {isPaid && unlockedKey && (
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        type="button"
                        onClick={handleCopyKey}
                        className="px-3.5 py-2 bg-red-600 hover:bg-red-500 text-white font-mono text-xs font-bold tracking-wider uppercase flex items-center gap-1.5 cursor-pointer rounded-xl"
                      >
                        {copied ? (
                          <>
                            <Check className="w-4 h-4" />
                            <span>COPIED</span>
                          </>
                        ) : (
                          <>
                            <Copy className="w-4 h-4" />
                            <span>COPY</span>
                          </>
                        )}
                      </button>

                      <button
                        type="button"
                        onClick={handleDownloadReceipt}
                        title="Download Receipt"
                        className="p-2 bg-white/10 hover:bg-white/20 text-white rounded-xl cursor-pointer transition-colors"
                      >
                        <Download className="w-4 h-4" />
                      </button>
                    </div>
                  )}
                </div>

                {isPaid && licenseKey && (
                  <div className="mt-3 pt-2.5 border-t border-white/10 flex items-center justify-between font-mono text-[11px] text-zinc-400">
                    <span>LICENSE ID</span>
                    <span className="text-white font-semibold tracking-wider select-all">
                      {licenseKey}
                    </span>
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="h-1" />
        </div>
      )}
    </div>
  );
}
