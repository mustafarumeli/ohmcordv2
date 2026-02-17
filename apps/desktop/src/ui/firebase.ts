import { initializeApp, type FirebaseApp } from "firebase/app";
import { getAuth, signInAnonymously, type Auth, type User } from "firebase/auth";
import { initializeFirestore, type Firestore } from "firebase/firestore";

type FirebaseEnv = {
  VITE_FIREBASE_API_KEY?: string;
  VITE_FIREBASE_AUTH_DOMAIN?: string;
  VITE_FIREBASE_PROJECT_ID?: string;
  VITE_FIREBASE_APP_ID?: string;
  VITE_FIREBASE_STORAGE_BUCKET?: string;
  VITE_FIREBASE_MESSAGING_SENDER_ID?: string;
  VITE_FIREBASE_MEASUREMENT_ID?: string;
};

function readFirebaseEnv(): FirebaseEnv {
  // Vite exposes only VITE_* keys.
  return import.meta.env as unknown as FirebaseEnv;
}

function requireKey(name: keyof FirebaseEnv, v: string | undefined): string {
  if (!v) throw new Error(`Missing ${String(name)}. Set it in your Vite env (e.g. .env).`);
  return v;
}

let appSingleton: FirebaseApp | null = null;
let authSingleton: Auth | null = null;
let dbSingleton: Firestore | null = null;

export function getFirebaseApp(): FirebaseApp {
  if (appSingleton) return appSingleton;
  const env = readFirebaseEnv();
  appSingleton = initializeApp({
    apiKey: requireKey("VITE_FIREBASE_API_KEY", env.VITE_FIREBASE_API_KEY),
    authDomain: requireKey("VITE_FIREBASE_AUTH_DOMAIN", env.VITE_FIREBASE_AUTH_DOMAIN),
    projectId: requireKey("VITE_FIREBASE_PROJECT_ID", env.VITE_FIREBASE_PROJECT_ID),
    appId: requireKey("VITE_FIREBASE_APP_ID", env.VITE_FIREBASE_APP_ID),
    storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    measurementId: env.VITE_FIREBASE_MEASUREMENT_ID
  });
  return appSingleton;
}

export function getFirebaseAuth(): Auth {
  if (authSingleton) return authSingleton;
  authSingleton = getAuth(getFirebaseApp());
  return authSingleton;
}

export function getFirebaseDb(): Firestore {
  if (dbSingleton) return dbSingleton;
  dbSingleton = initializeFirestore(getFirebaseApp(), {
    // More resilient on restrictive proxies/firewalls; helps dev environments.
    experimentalAutoDetectLongPolling: true
  });
  return dbSingleton;
}

export async function ensureAnonUser(): Promise<User> {
  const auth = getFirebaseAuth();
  if (auth.currentUser) return auth.currentUser;
  const cred = await signInAnonymously(auth);
  return cred.user;
}

export function displayNameFromUid(uid: string): string {
  const short = uid.slice(0, 4).toUpperCase();
  return `User-${short}`;
}

