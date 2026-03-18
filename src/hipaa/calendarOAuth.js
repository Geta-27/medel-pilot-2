/**
 * CareX — Provider Calendar OAuth Connect
 *
 * Providers grant CareX read access to their calendar.
 * Supports Google Calendar and Microsoft Outlook/Office 365.
 */

import crypto from 'node:crypto';
import db from '../database/db.js';
import {
  logProviderConnected,
  logCalendarAccess,
  logError,
  ACTIONS,
  log,
} from './auditLogger.js';

// ─── Config ──────────────────────────────────────────────────
const CONFIG = {
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    redirectUri: `${process.env.OAUTH_REDIRECT_BASE_URL}/auth/google/callback`,
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: [
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/calendar.events.readonly',
    ],
  },
  microsoft: {
    clientId: process.env.MICROSOFT_CLIENT_ID,
    clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
    redirectUri: `${process.env.OAUTH_REDIRECT_BASE_URL}/auth/microsoft/callback`,
    authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scopes: [
      'Calendars.Read',
      'offline_access',
    ],
  },
};

// ─── Token Encryption ────────────────────────────────────────
const rawKey =
  process.env.TOKEN_ENCRYPTION_KEY ||
  crypto.randomBytes(32).toString('hex');

const ENCRYPTION_KEY = Buffer.from(rawKey, 'hex');

function encryptToken(token) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(token), 'utf8'),
    cipher.final(),
  ]);
  return `${iv.toString('hex')}:${encrypted.toString('hex')}`;
}

function decryptToken(encryptedStr) {
  const [ivHex, dataHex] = encryptedStr.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataHex, 'hex')),
    decipher.final(),
  ]);
  return JSON.parse(decrypted.toString('utf8'));
}

// ─── In-Memory Stores ────────────────────────────────────────
const tokenStore = new Map(); // providerId → encrypted token data
const stateStore = new Map(); // oauthState → { providerId, calendarType, createdAt }

// ─── Step 1: Generate Authorization URL ─────────────────────
export function getAuthorizationUrl(providerId, calendarType) {
  if (!['google', 'microsoft'].includes(calendarType)) {
    throw new Error(`Unsupported calendar type: ${calendarType}`);
  }

  const config = CONFIG[calendarType];
  const state = crypto.randomBytes(16).toString('hex');

  stateStore.set(state, {
    providerId,
    calendarType,
    createdAt: Date.now(),
  });

  for (const [s, data] of stateStore.entries()) {
    if (Date.now() - data.createdAt > 10 * 60 * 1000) {
      stateStore.delete(s);
    }
  }

  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: config.scopes.join(' '),
    state,
    access_type: 'offline',
    prompt: 'consent',
  });

  return {
    url: `${config.authUrl}?${params.toString()}`,
    state,
  };
}

// ─── Step 2: Handle OAuth Callback ──────────────────────────
export async function handleCallback(code, state, calendarType) {
  if (!stateStore.has(state)) {
    throw new Error('Invalid or expired OAuth state — possible CSRF attempt');
  }

  const { providerId } = stateStore.get(state);
  stateStore.delete(state);

  const config = CONFIG[calendarType];

  const tokenResponse = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: 'authorization_code',
    }),
  });

  if (!tokenResponse.ok) {
    const err = await tokenResponse.text();
    throw new Error(`Token exchange failed: ${err}`);
  }

  const tokens = await tokenResponse.json();

  const tokenData = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + (tokens.expires_in * 1000),
    calendarType,
    connectedAt: new Date().toISOString(),
    scopes: config.scopes,
  };

  const encryptedToken = encryptToken(tokenData);
  tokenStore.set(providerId, encryptedToken);
  await db.updateProviderCalendarToken(providerId, encryptedToken, calendarType, config.scopes);

  logProviderConnected({
    providerId,
    calendarType,
    oauthScopes: config.scopes,
  });
  return {
    connectedAt: tokenData.connectedAt,
    scopes: config.scopes,
  };
}

// ─── Step 3: Get Valid Access Token ─────────────────────────
export 
async function getValidToken(providerId) {
  if (!tokenStore.has(providerId)) {
    const provider = await db.getProvider(providerId);
    if (!provider?.calendar_token_enc) {
      throw new Error(`Provider ${providerId} has not connected a calendar`);
    }
    tokenStore.set(providerId, provider.calendar_token_enc);
  }

  const tokenData = decryptToken(tokenStore.get(providerId));

  if (Date.now() > tokenData.expiresAt - (5 * 60 * 1000)) {
    if (!tokenData.refreshToken) {
      throw new Error('No refresh token available — provider must reconnect');
    }
    return await refreshAccessToken(providerId, tokenData);
  }

  return tokenData.accessToken;
}

async function refreshAccessToken(providerId, tokenData) {
  const config = CONFIG[tokenData.calendarType];

  const response = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: tokenData.refreshToken,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: 'refresh_token',
    }),
  });

  if (!response.ok) {
    tokenStore.delete(providerId);
    throw new Error('Token refresh failed — provider must reconnect calendar');
  }

  const tokens = await response.json();

  const updated = {
    ...tokenData,
    accessToken: tokens.access_token,
    expiresAt: Date.now() + (tokens.expires_in * 1000),
    refreshToken: tokens.refresh_token || tokenData.refreshToken,
  };

  const encryptedUpdated = encryptToken(updated);
  tokenStore.set(providerId, encryptedUpdated);
  await db.updateProviderCalendarToken(providerId, encryptedUpdated, tokenData.calendarType, tokenData.scopes || config.scopes);
  return updated.accessToken;
}

// ─── Step 4: Fetch Provider Schedule ────────────────────────
export async function fetchTodaySchedule(providerId) {
  if (!tokenStore.has(providerId)) {
    const provider = await db.getProvider(providerId);
    if (!provider?.calendar_token_enc) {
      throw new Error(`Provider ${providerId} has not connected a calendar`);
    }
    tokenStore.set(providerId, provider.calendar_token_enc);
  }

  const tokenData = decryptToken(tokenStore.get(providerId));
  const accessToken = await getValidToken(providerId);

  const today = new Date();
  const startOfDayDate = new Date(today);
  startOfDayDate.setHours(0, 0, 0, 0);
  const endOfDayDate = new Date(today);
  endOfDayDate.setHours(23, 59, 59, 999);

  const startOfDay = startOfDayDate.toISOString();
  const endOfDay = endOfDayDate.toISOString();

  let events = [];

  try {
    if (tokenData.calendarType === 'google') {
      events = await fetchGoogleEvents(accessToken, startOfDay, endOfDay);
    } else if (tokenData.calendarType === 'microsoft') {
      events = await fetchMicrosoftEvents(accessToken, startOfDay, endOfDay);
    }

    logCalendarAccess({
      providerId,
      calendarType: tokenData.calendarType,
      slotCount: events.length,
      webhookEvent: null,
    });

    return events;
  } catch (error) {
    logError({
      action: 'FETCH_TODAY_SCHEDULE',
      error,
      context: { providerId, calendarType: tokenData.calendarType },
    });
    throw error;
  }
}

async function fetchGoogleEvents(accessToken, startTime, endTime) {
  const params = new URLSearchParams({
    timeMin: startTime,
    timeMax: endTime,
    singleEvents: 'true',
    orderBy: 'startTime',
  });

  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params.toString()}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (!response.ok) {
    throw new Error(`Google Calendar API error: ${response.status}`);
  }

  const data = await response.json();

  return (data.items || []).map((event) => ({
    eventId: event.id,
    title: event.summary || '',
    start: event.start?.dateTime || event.start?.date,
    end: event.end?.dateTime || event.end?.date,
    status: event.status,
    attendees: (event.attendees || []).map((a) => a.email),
    notes: event.description || '',
    source: 'google',
  }));
}

async function fetchMicrosoftEvents(accessToken, startTime, endTime) {
  const params = new URLSearchParams({
    '$filter': `start/dateTime ge '${startTime}' and end/dateTime le '${endTime}'`,
    '$orderby': 'start/dateTime',
    '$top': '50',
  });

  const response = await fetch(
    `https://graph.microsoft.com/v1.0/me/events?${params.toString()}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (!response.ok) {
    throw new Error(`Microsoft Graph API error: ${response.status}`);
  }

  const data = await response.json();

  return (data.value || []).map((event) => ({
    eventId: event.id,
    title: event.subject || '',
    start: event.start?.dateTime,
    end: event.end?.dateTime,
    status: event.isCancelled ? 'cancelled' : 'confirmed',
    attendees: (event.attendees || []).map((a) => a.emailAddress?.address),
    notes: event.body?.content || '',
    source: 'microsoft',
  }));
}

// ─── Step 5: Disconnect ─────────────────────────────────────
export function disconnectProvider(providerId, reason = 'provider_requested') {
  if (!tokenStore.has(providerId)) {
    return { success: false, message: 'Provider not connected' };
  }

  tokenStore.delete(providerId);

  log(ACTIONS.PROVIDER_DISCONNECTED, {
    actorId: providerId,
    actorType: 'provider',
    reason,
    outcome: 'success',
  });

  return {
    success: true,
    message: 'Calendar disconnected. All tokens deleted immediately.',
    providerId,
    disconnectedAt: new Date().toISOString(),
  };
}

// ─── Status Check ───────────────────────────────────────────
export function getConnectionStatus(providerId) {
  if (!tokenStore.has(providerId)) {
    return { connected: false };
  }

  const tokenData = decryptToken(tokenStore.get(providerId));
  return {
    connected: true,
    calendarType: tokenData.calendarType,
    connectedAt: tokenData.connectedAt,
    tokenExpiry: new Date(tokenData.expiresAt).toISOString(),
    scopes: tokenData.scopes,
  };
}

export default {
  getAuthorizationUrl,
  handleCallback,
  getValidToken,
  fetchTodaySchedule,
  disconnectProvider,
  getConnectionStatus,
};
