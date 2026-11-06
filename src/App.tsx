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
  Hand,
  Download,
  AlertCircle,
  AlertTriangle,
  ArrowRight,
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

const BASE_START_AMOUNT = 100;
const PRICE_STEP_AMOUNT = 20;
const LOCKED_BLUR_PLACEHOLDER = 'THEUPCYBER••••••';
const AMOUNT_STORAGE_KEY = 'revox_rupayex_amount_v4';
const STOPPED_STORAGE_KEY = 'revox_rupayex_stopped_v4';
const ACTIVE_ORDER_STORAGE_KEY = 'revox_rupayex_active_order_v4';
const RECEIPT_STORAGE_KEY = 'revox_rupayex_receipt_v4';

interface SavedReceipt {
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

  // Clean up old localStorage keys so it starts cleanly at ₹100
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
  }, []);

  // Dynamically calculated payment amount: starts at ₹100 (or resumes where it stopped/left off)
  const [currentAmount, setCurrentAmount] = useState<number>(() => {
    const saved = Number(localStorage.getItem(AMOUNT_STORAGE_KEY));
    return saved >= BASE_START_AMOUNT ? saved : BASE_START_AMOUNT;
  });

  // Only becomes true when user clicks "RUK JAO PAYMENT KARTA HU" (or payment is completed)
  const [isPriceStopped, setIsPriceStopped] = useState<boolean>(() => {
    return localStorage.getItem(STOPPED_STORAGE_KEY) === 'true';
  });

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

  // Persist currentAmount and isPriceStopped to localStorage and server
  useEffect(() => {
    localStorage.setItem(AMOUNT_STORAGE_KEY, String(currentAmount));
    localStorage.setItem(STOPPED_STORAGE_KEY, String(isPriceStopped));

    fetch('/api/rupayex/sync-device-price', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId,
        amount: currentAmount,
        isStopped: isPriceStopped,
      }),
    }).catch(() => {});
  }, [deviceId, currentAmount, isPriceStopped]);

  // Every 5 seconds while payment page is open, increase amount by +₹20 UNTIL user clicks "RUK JAO PAYMENT KARTA HU"
  useEffect(() => {
    if (
      !showPaymentPage ||
      isPaid ||
      isPriceStopped ||
      isSubmittingPayment ||
      isVerifyingReturn
    ) {
      return;
    }

    const interval = setInterval(() => {
      setCurrentAmount((prev) => {
        const next = prev + PRICE_STEP_AMOUNT;
        localStorage.setItem(AMOUNT_STORAGE_KEY, String(next));
        return next;
      });
    }, 5000);

    return () => clearInterval(interval);
  }, [
    showPaymentPage,
    isPaid,
    isPriceStopped,
    isSubmittingPayment,
    isVerifyingReturn,
  ]);

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
            amount: Math.max(BASE_START_AMOUNT, amountToSave),
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
                amount: Math.max(
                  existingData.amount || BASE_START_AMOUNT,
                  amountToSave
                ),
                orderId: orderId.slice(0, 128),
                updatedAt: serverTimestamp(),
              });
            } else {
              await updateDoc(docRef, {
                amount: Math.max(
                  existingData.amount || BASE_START_AMOUNT,
                  amountToSave
                ),
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

  // Save verified receipt to localStorage
  const persistVerifiedReceipt = useCallback(
    (
      orderId: string,
      amount: number,
      key: string,
      licKey?: string,
      utr?: string | null
    ) => {
      const receipt: SavedReceipt = {
        orderId,
        amount,
        unlockKey: key,
        licenseKey: licKey,
        utr: utr || null,
        paidAt: Date.now(),
      };
      localStorage.setItem(RECEIPT_STORAGE_KEY, JSON.stringify(receipt));
    },
    []
  );

  // Server-side verification of an order ID via POST /api/rupayex/verify-order
  const verifyOrderOnServer = useCallback(
    async (orderIdToVerify: string) => {
      setIsVerifyingReturn(true);
      setPaymentError(null);

      try {
        const res = await fetch('/api/rupayex/verify-order', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            orderId: orderIdToVerify,
            deviceId,
            deviceSecret,
          }),
        });

        const data = await res.json();

        if (!res.ok) {
          setPaymentError(
            data.message || 'Unable to verify payment status with RupayEx.'
          );
          return;
        }

        if (data.status === 'PAID' && data.unlockKey && data.deviceId === deviceId) {
          setUnlockedKey(data.unlockKey);
          setLicenseKey(data.licenseKey || null);
          setVerifiedOrderId(data.orderId);
          setIsPaid(true);
          setIsPriceStopped(true);
          localStorage.removeItem(ACTIVE_ORDER_STORAGE_KEY);
          persistVerifiedReceipt(
            data.orderId,
            data.amount || currentAmount,
            data.unlockKey,
            data.licenseKey,
            data.utr
          );
          await syncDeviceOrderToFirestore(
            data.orderId,
            data.amount || currentAmount,
            'PAID',
            data.unlockKey
          );
        } else if (data.status === 'FAILED') {
          localStorage.removeItem(ACTIVE_ORDER_STORAGE_KEY);
          setPaymentError(
            data.message || 'Payment failed or was declined. Please try again.'
          );
        } else if (data.status === 'CANCELLED') {
          localStorage.removeItem(ACTIVE_ORDER_STORAGE_KEY);
          setPaymentError(
            data.message || 'Payment was cancelled. Please click PAY NOW to try again.'
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
    [
      deviceId,
      deviceSecret,
      currentAmount,
      persistVerifiedReceipt,
      syncDeviceOrderToFirestore,
    ]
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

      try {
        const res = await fetch('/api/rupayex/device-session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deviceId, deviceSecret }),
        });
        if (res.ok) {
          const data = await res.json();
          if (!cancelled) {
            if (data.savedAmount && data.savedAmount > currentAmount) {
              setCurrentAmount(data.savedAmount);
            }
            if (data.unlocked && data.unlockKey) {
              setUnlockedKey(data.unlockKey);
              setLicenseKey(data.licenseKey || null);
              setVerifiedOrderId(data.orderId || 'VERIFIED');
              setIsPaid(true);
              setIsPriceStopped(true);
              return;
            }
          }
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
            if (typeof record.amount === 'number' && record.amount > currentAmount) {
              setCurrentAmount(record.amount);
            }
            if (
              record.ownerId === currentUser.uid &&
              record.deviceId === deviceId &&
              record.status === 'PAID' &&
              typeof record.unlockKey === 'string'
            ) {
              setUnlockedKey(record.unlockKey);
              setVerifiedOrderId(record.orderId || 'VERIFIED');
              setIsPaid(true);
              setIsPriceStopped(true);
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
  }, [deviceId, deviceSecret, authReady, currentUser, currentAmount, verifyOrderOnServer]);

  // Freeze dynamic price when user clicks "RUK JAO PAYMENT KARTA HU"
  const handleFreezePriceClick = () => {
    setIsPriceStopped(true);
    localStorage.setItem(STOPPED_STORAGE_KEY, 'true');
    localStorage.setItem(AMOUNT_STORAGE_KEY, String(currentAmount));
  };

  // Initiate RupayEx Payment when user clicks "PAY NOW" and redirect directly to checkout URL
  const handlePayNowClick = async () => {
    if (isPaid || isSubmittingPayment || paymentLockRef.current) return;

    paymentLockRef.current = true;
    setIsSubmittingPayment(true);
    setPaymentError(null);
    setCheckoutUrl(null);

    try {
      const response = await fetch('/api/rupayex/create-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceId,
          deviceSecret,
          uid: currentUser?.uid,
          amount: currentAmount,
          customerName: currentUser?.displayName || 'Revox Customer',
          customerEmail: currentUser?.email || 'user@revoxpanel.site',
          customerMobile: '9876543210',
          originUrl: window.location.origin,
        }),
      });

      const data = await response.json();

      // Prevent duplicate payment if server reports this device is already paid
      if (response.status === 409 && data.error === 'ALREADY_PAID' && data.unlockKey) {
        setUnlockedKey(data.unlockKey);
        setLicenseKey(data.licenseKey || null);
        setVerifiedOrderId(data.orderId || 'VERIFIED');
        setIsPaid(true);
        setIsPriceStopped(true);
        return;
      }

      if (!response.ok || !data.paymentUrl) {
        setPaymentError(
          data.message || 'Failed to initiate payment with RupayEx gateway.'
        );
        return;
      }

      // Lock the price now that the gateway order is created
      setIsPriceStopped(true);
      localStorage.setItem(STOPPED_STORAGE_KEY, 'true');
      localStorage.setItem(AMOUNT_STORAGE_KEY, String(currentAmount));

      setActiveOrderId(data.orderId);
      setCheckoutUrl(data.paymentUrl);
      localStorage.setItem(ACTIVE_ORDER_STORAGE_KEY, data.orderId);

      if (currentUser?.emailVerified) {
        await syncDeviceOrderToFirestore(data.orderId, data.amount, 'PENDING');
      }

      // Redirect customer directly to the payment gateway checkout URL returned by RupayEx API
      try {
        if (window.top && window.top !== window.self) {
          window.top.location.href = data.paymentUrl;
        } else {
          window.location.href = data.paymentUrl;
        }
      } catch {
        window.location.assign(data.paymentUrl);
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
      `Amount Paid  : INR ${currentAmount}`,
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

      {/* CLEAN, SIMPLE & PROFESSIONAL FULL-SCREEN PAYMENT PAGE (NO SETTINGS BUTTON, NO QR) */}
      {showPaymentPage && (
        <div className="fixed inset-0 z-50 w-full h-full min-h-screen bg-[#060102] flex flex-col justify-between px-5 py-6 sm:p-10 text-white overflow-y-auto">
          {/* Clean Top Bar — Only Title & Close Button (Settings Deleted) */}
          <div className="w-full max-w-md mx-auto flex items-center justify-between">
            <span className="font-['Orbitron'] text-xs sm:text-sm font-bold tracking-[0.18em] text-[#ff1e27] uppercase">
              REVOX KEY PAYMENT
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

          {/* Center Clean & Simple Checkout Container */}
          <div className="flex-1 flex flex-col items-center justify-center w-full max-w-md mx-auto my-4 space-y-5">
            {/* BIG PROMINENT WARNING BANNER (+₹20 EVERY 5 SECONDS) */}
            {!isPaid && (
              <div
                className={`w-full rounded-2xl px-4 py-3.5 text-center transition-all ${
                  isPriceStopped
                    ? 'bg-emerald-950/35 border border-emerald-600/40'
                    : 'bg-amber-500/15 border-2 border-amber-500/70 shadow-[0_0_25px_rgba(245,158,11,0.25)]'
                }`}
              >
                {!isPriceStopped ? (
                  <div className="flex flex-col items-center justify-center gap-1">
                    <div className="flex items-center justify-center gap-2 text-amber-300 font-mono text-sm sm:text-base font-extrabold tracking-wide uppercase">
                      <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 animate-pulse" />
                      <span>⚠️ WARNING: +₹20 EVERY 5 SECONDS!</span>
                    </div>
                    <p className="font-mono text-xs text-amber-100/90 font-medium">
                      Har 5 second mein price ₹20 badh raha hai!
                    </p>
                  </div>
                ) : (
                  <div className="flex items-center justify-center gap-2 text-emerald-300 font-mono text-xs sm:text-sm font-bold tracking-wider uppercase">
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                    <span>PRICE STOPPED & LOCKED AT ₹{currentAmount}</span>
                  </div>
                )}
              </div>
            )}

            {/* Giant Live Amount Display */}
            <div className="text-center py-1">
              <p className="font-mono text-[11px] tracking-[0.22em] text-zinc-400 uppercase mb-1">
                {isPaid ? 'PAYMENT COMPLETED' : 'PAYABLE AMOUNT'}
              </p>
              <div className="font-['Orbitron'] text-5xl sm:text-6xl font-black tracking-tight text-white tabular-nums">
                ₹{currentAmount}
              </div>
              {(verifiedOrderId || activeOrderId) && (
                <p className="font-mono text-[10px] tracking-[0.14em] text-zinc-500 mt-1.5">
                  ORDER ID: {verifiedOrderId || activeOrderId}
                </p>
              )}
            </div>

            {/* PROMINENT "RUK JAO PAYMENT KARTA HU" BUTTON — Clearly visible so users can stop the timer */}
            {!isPaid && !isPriceStopped && (
              <button
                type="button"
                onClick={handleFreezePriceClick}
                className="w-full py-4 px-5 bg-amber-500 hover:bg-amber-400 active:scale-[0.99] text-black font-mono text-sm sm:text-base font-extrabold tracking-[0.12em] uppercase rounded-2xl shadow-[0_8px_28px_rgba(245,158,11,0.4)] flex items-center justify-center gap-2.5 cursor-pointer transition-all"
              >
                <Hand className="w-5 h-5 stroke-[2.5] shrink-0" />
                <span>RUK JAO PAYMENT KARTA HU</span>
              </button>
            )}

            {/* Error / Failure / Cancellation Message Banner */}
            {paymentError && (
              <div className="w-full bg-red-950/50 border border-red-700/60 rounded-2xl p-4 text-left flex items-start gap-3">
                <AlertCircle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
                <p className="font-mono text-xs text-red-200 leading-relaxed">
                  {paymentError}
                </p>
              </div>
            )}

            {/* Verifying Return Spinner */}
            {isVerifyingReturn && (
              <div className="w-full bg-white/[0.04] rounded-2xl p-6 flex flex-col items-center justify-center text-center">
                <Loader2 className="w-8 h-8 text-[#ff1e27] animate-spin mb-3" />
                <span className="font-mono text-xs tracking-[0.16em] text-zinc-300 uppercase">
                  VERIFYING PAYMENT STATUS...
                </span>
              </div>
            )}

            {/* Clean Primary PAY NOW Button */}
            {!isPaid && !isVerifyingReturn && (
              <div className="w-full space-y-3">
                <button
                  type="button"
                  disabled={isSubmittingPayment}
                  onClick={handlePayNowClick}
                  className="w-full py-4 px-6 bg-[#e11d24] hover:bg-[#f0222a] disabled:opacity-60 active:scale-[0.99] text-white font-mono text-sm sm:text-base font-bold tracking-[0.18em] uppercase rounded-2xl shadow-[0_10px_32px_rgba(225,29,36,0.5)] flex items-center justify-center gap-3 cursor-pointer transition-all"
                >
                  {isSubmittingPayment ? (
                    <>
                      <Loader2 className="w-5 h-5 animate-spin shrink-0" />
                      <span>OPENING PAYMENT GATEWAY...</span>
                    </>
                  ) : (
                    <>
                      <span>PAY NOW · ₹{currentAmount}</span>
                      <ArrowRight className="w-5 h-5 shrink-0" />
                    </>
                  )}
                </button>

                {checkoutUrl && (
                  <a
                    href={checkoutUrl}
                    target="_top"
                    rel="noopener noreferrer"
                    className="w-full py-3 px-4 bg-white/10 hover:bg-white/15 text-center text-white font-mono text-xs font-semibold tracking-wider uppercase rounded-xl block transition-colors"
                  >
                    CONTINUE TO PAYMENT CHECKOUT
                  </a>
                )}
              </div>
            )}

            {/* Confirmed Payment Success Banner */}
            {isPaid && (
              <div className="w-full bg-emerald-950/35 border border-emerald-700/50 rounded-2xl p-5 flex items-center gap-3.5 text-left">
                <CheckCircle2 className="w-8 h-8 text-emerald-400 shrink-0" />
                <div>
                  <p className="font-['Orbitron'] text-xs sm:text-sm font-bold tracking-wider text-white uppercase">
                    PAYMENT CONFIRMED
                  </p>
                  <p className="font-mono text-[11px] text-emerald-300 mt-0.5">
                    Device Unlock Key Activated Below
                  </p>
                </div>
              </div>
            )}

            {/* Device Unlock Key Box — Blurred until server confirms payment */}
            <div className="w-full bg-white/[0.04] rounded-2xl p-4">
              <div className="flex items-center justify-between text-[10px] font-mono tracking-wider uppercase mb-1.5">
                <span className="text-zinc-400 flex items-center gap-1.5">
                  {isPaid ? (
                    <Unlock className="w-3.5 h-3.5 text-emerald-400" />
                  ) : (
                    <Lock className="w-3.5 h-3.5 text-[#ff2a34]" />
                  )}
                  <span>DEVICE UNLOCK KEY</span>
                </span>
                <span className={isPaid ? 'text-emerald-400 font-semibold' : 'text-zinc-500'}>
                  {isPaid ? 'UNLOCKED' : 'LOCKED UNTIL PAID'}
                </span>
              </div>

              <div className="flex items-center justify-between gap-2 pt-1">
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
                <div className="mt-2.5 pt-2.5 border-t border-white/10 flex items-center justify-between font-mono text-[11px] text-zinc-400">
                  <span>LICENSE ID</span>
                  <span className="text-white font-semibold tracking-wider select-all">
                    {licenseKey}
                  </span>
                </div>
              )}
            </div>
          </div>

          <div className="h-1" />
        </div>
      )}
    </div>
  );
}
