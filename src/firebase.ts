import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider } from 'firebase/auth';
import {
  initializeFirestore,
  setLogLevel,
} from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json';

// Suppress noisy internal WebChannel retry warnings in restricted proxy/mobile networks
setLogLevel('silent');

const app = initializeApp(firebaseConfig);

// Use experimentalAutoDetectLongPolling so Firestore works reliably across mobile networks and iframe proxies
export const db = initializeFirestore(
  app,
  {
    experimentalAutoDetectLongPolling: true,
  },
  firebaseConfig.firestoreDatabaseId
);

export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: boolean | string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): void {
  const message = error instanceof Error ? error.message : String(error);
  // Ignore transient offline/unavailable network states so the app keeps working smoothly
  if (
    message.includes('client is offline') ||
    message.includes('unavailable') ||
    message.includes('Could not reach Cloud Firestore backend')
  ) {
    return;
  }

  const errInfo: FirestoreErrorInfo = {
    error: message,
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.warn('Firestore Notice: ', JSON.stringify(errInfo));
}

// Generate or retrieve a unique, cryptographically strong per-device identifier
// Matches schema pattern ^[a-zA-Z0-9_\-]+$ and length 8..128
export function getOrCreateDeviceId(): string {
  const storageKey = 'revox_unique_device_id';
  let existing = localStorage.getItem(storageKey);
  if (existing && /^[a-zA-Z0-9_-]{8,128}$/.test(existing)) {
    return existing;
  }

  const randomBytes = new Uint8Array(16);
  window.crypto.getRandomValues(randomBytes);
  const hex = Array.from(randomBytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  existing = `dev_${hex}`;
  localStorage.setItem(storageKey, existing);
  return existing;
}

export function getOrCreateDeviceSecret(): string {
  const storageKey = 'revox_unique_device_secret';
  let existing = localStorage.getItem(storageKey);
  if (existing && /^[a-zA-Z0-9_-]{16,128}$/.test(existing)) {
    return existing;
  }

  const randomBytes = new Uint8Array(24);
  window.crypto.getRandomValues(randomBytes);
  const hex = Array.from(randomBytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  existing = `sec_${hex}`;
  localStorage.setItem(storageKey, existing);
  return existing;
}
