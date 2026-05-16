import { setHttpCallback } from '@citizenfx/http-wrapper';

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';
import Koa from 'koa';
import Router from 'koa-router';
import koaBody from 'koa-body';
import mv from 'mv';
const FormData = require('form-data');

// Config is loaded from config.js (runs before this script via fxmanifest)
const Config = (globalThis as any).CfxCaptureConfig || {};

// ============================================================================
// Structured Error Types and Helpers
// ============================================================================

interface CaptureError {
    code: string;
    message: string;
    retryAfter?: number;
    details?: Record<string, any>;
}

const ErrorCodes = {
    TOO_SOON: 'too_soon',
    RATE_LIMITED: 'rate_limited',
    GLOBAL_THROTTLE: 'global_throttle',
    RECORDING_RATE_LIMITED: 'recording_rate_limited',
    INVALID_TOKEN: 'invalid_token',
    EXPIRED_TOKEN: 'expired_token',
    PLAYER_MISMATCH: 'player_mismatch',
    FILE_TOO_LARGE: 'file_too_large',
    INVALID_TYPE: 'invalid_type',
    MISSING_FILE: 'missing_file',
    INVALID_FILE_NAME: 'invalid_file_name',
    SAVE_FAILED: 'save_failed',
    PROVIDER_NOT_CONFIGURED: 'provider_not_configured',
    PROVIDER_DISABLED: 'provider_disabled',
    PROVIDER_NOT_FOUND: 'provider_not_found',
    PROVIDER_UPLOAD_FAILED: 'provider_upload_failed',
    PROVIDER_TIMEOUT: 'provider_timeout',
    SESSION_NOT_FOUND: 'session_not_found',
    UPLOAD_ERROR: 'upload_error',
    UNKNOWN_ERROR: 'unknown_error',
} as const;

const ErrorMessages: Record<string, string> = {
    [ErrorCodes.TOO_SOON]: 'Request too soon after last capture',
    [ErrorCodes.RATE_LIMITED]: 'Rate limit exceeded for this player',
    [ErrorCodes.GLOBAL_THROTTLE]: 'Server is processing too many requests',
    [ErrorCodes.RECORDING_RATE_LIMITED]: 'Recording rate limit exceeded',
    [ErrorCodes.INVALID_TOKEN]: 'Invalid or malformed token',
    [ErrorCodes.EXPIRED_TOKEN]: 'Token has expired',
    [ErrorCodes.PLAYER_MISMATCH]: 'Token does not match requesting player',
    [ErrorCodes.FILE_TOO_LARGE]: 'File exceeds maximum allowed size',
    [ErrorCodes.INVALID_TYPE]: 'Invalid file type (must be JPEG, PNG, or WebP)',
    [ErrorCodes.MISSING_FILE]: 'No file was uploaded',
    [ErrorCodes.INVALID_FILE_NAME]: 'Invalid or unsafe file name',
    [ErrorCodes.SAVE_FAILED]: 'Failed to save file to disk',
    [ErrorCodes.PROVIDER_NOT_CONFIGURED]: 'Provider is not configured',
    [ErrorCodes.PROVIDER_DISABLED]: 'Provider is disabled in configuration',
    [ErrorCodes.PROVIDER_NOT_FOUND]: 'Could not determine provider from URL',
    [ErrorCodes.PROVIDER_UPLOAD_FAILED]: 'Failed to upload to provider',
    [ErrorCodes.PROVIDER_TIMEOUT]: 'Upload to provider timed out',
    [ErrorCodes.SESSION_NOT_FOUND]: 'Recording session not found',
    [ErrorCodes.UPLOAD_ERROR]: 'An error occurred during upload',
    [ErrorCodes.UNKNOWN_ERROR]: 'An unknown error occurred',
};

// HTTP request helper using Node's https module with timeout support
function httpRequest(
    url: string,
    options: { method: string; headers: any; body?: any },
    timeoutMs?: number
): Promise<{ status: number; text: string }> {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(url);
        const isHttps = parsedUrl.protocol === 'https:';
        const lib = isHttps ? https : http;

        // Use provided timeout or get from convar (default 30s)
        const timeout = timeoutMs || parseIntConvar('cfx_capture_upload_timeout_ms', 30000);

        const req = lib.request({
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (isHttps ? 443 : 80),
            path: parsedUrl.pathname + parsedUrl.search,
            method: options.method,
            headers: options.headers,
            timeout: timeout
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve({ status: res.statusCode || 0, text: data }));
        });

        // Handle timeout
        req.on('timeout', () => {
            req.destroy();
            reject(new Error(`Request timed out after ${timeout}ms`));
        });

        req.on('error', (err) => {
            reject(err);
        });

        if (options.body) {
            if (options.body.pipe) {
                options.body.pipe(req);
            } else {
                req.write(options.body);
                req.end();
            }
        } else {
            req.end();
        }
    });
}

const app = new Koa();
const router = new Router();

class UploadData {
    player: string;
    fileName: string | null;
    maxBytes: number;
    expiresAt: number;
    returnBlob: boolean;

    cb: (err: string | boolean, data: string | CaptureError) => void;
}

// External upload pending data
class ExternalUploadData {
    player: string;
    provider: string;
    options: any;
    expiresAt: number;
    cb: (err: string | boolean, data: any | CaptureError) => void;
}

// Recording session data
interface RecordingSessionData {
    sessionId: string;
    player: string;
    recordingType: 'evidence' | 'clip' | 'bug' | 'event';
    metadata: {
        playerName: string;
        playerIdentifiers: Record<string, string>;
        serverName: string;
        coordinates: { x: number; y: number; z: number };
        timestamp: number;
        customTags?: Record<string, any>;
    };
    startTime: number;
    endTime?: number;
    status: 'recording' | 'complete' | 'partial' | 'failed';
    filePath?: string;
    fileSize?: number;
    uploadUrl?: string;
    performanceMetrics?: any;
    expiresAt: number;
    callback: (err: string | boolean, data: any | CaptureError) => void;
}

const uploads: { [nonce: string]: UploadData } = {};
const externalUploads: { [nonce: string]: ExternalUploadData } = {};
const recordingSessions: Map<string, RecordingSessionData> = new Map();
let pendingGlobal = 0;

function parseIntConvar(name: string, defaultValue: number) {
    const raw = GetConvar(name, defaultValue.toString());
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : defaultValue;
}

const configMaxSizeMB = parseIntConvar('cfx_capture_max_size_mb', 8);
const configMaxBytes = Math.max(1, configMaxSizeMB) * 1024 * 1024;
const tokenTTLms = parseIntConvar('cfx_capture_token_ttl_ms', 15000);
const rateLimitPerMin = parseIntConvar('cfx_capture_rate_limit_per_min', 6);
const maxPendingGlobal = parseIntConvar('cfx_capture_max_pending_global', 50);
const maxWidth = parseIntConvar('cfx_capture_max_width', 1920);
const maxHeight = parseIntConvar('cfx_capture_max_height', 1080);
const minIntervalMs = parseIntConvar('cfx_capture_min_interval_ms', 500);
const outputDir = GetResourcePath("straye-capture") + "/cache"; 
const secretFromConvar = GetConvar('cfx_capture_secret', '');
const secret = secretFromConvar || crypto.randomBytes(32).toString('hex');

// Create structured error helper (must be after convar definitions)
function createError(code: string, details?: Record<string, any>): CaptureError {
    const error: CaptureError = {
        code,
        message: ErrorMessages[code] || ErrorMessages[ErrorCodes.UNKNOWN_ERROR],
    };

    // Add retryAfter for rate limit errors
    if (code === ErrorCodes.TOO_SOON) {
        error.retryAfter = minIntervalMs;
    } else if (code === ErrorCodes.RATE_LIMITED) {
        error.retryAfter = 60000; // 1 minute window
    } else if (code === ErrorCodes.GLOBAL_THROTTLE) {
        error.retryAfter = 5000; // Suggest retry in 5s
    } else if (code === ErrorCodes.RECORDING_RATE_LIMITED) {
        error.retryAfter = parseIntConvar('cfx_capture_recording_window_ms', 600000);
    }

    if (details) {
        error.details = details;
    }

    return error;
}

if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
}

// ============================================================================
// Provider Configuration (loaded from Lua Config)
// ============================================================================

interface ProviderConfig {
    enabled: boolean;
    url?: string;
    apiKey?: string;
    webhookUrl?: string;
    headers?: { [key: string]: string };
    field: string;
}

function getProviderConfig(providerName: string): ProviderConfig | null {
    if (!Config || !Config.Providers) {
        return null;
    }
    return Config.Providers[providerName] || null;
}

function getDefaultProvider(): string {
    return Config?.DefaultProvider || 'fivemanage';
}

// Map legacy URLs to provider names for backward compatibility
function mapUrlToProvider(url: string): string | null {
    const urlLower = url.toLowerCase();
    if (urlLower.includes('fivemanage.com') || urlLower.includes('fmapi.net') || urlLower.includes('fmfile.com')) {
        return 'fivemanage';
    }
    if (urlLower.includes('discord.com/api/webhooks') || urlLower.includes('discordapp.com/api/webhooks')) {
        return 'discord';
    }
    return null;
}

// ============================================================================
// External Upload via fetch
// ============================================================================

function uploadToProvider(
    providerName: string,
    imageData: Buffer,
    mimeType: string,
    options: any,
    cb: (err: string | null, result: any) => void
) {
    const provider = getProviderConfig(providerName);
    if (!provider) {
        cb(`Provider '${providerName}' not configured`, null);
        return;
    }

    if (!provider.enabled) {
        cb(`Provider '${providerName}' is disabled`, null);
        return;
    }

    const extension = mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg';
    const fileName = options?.fileName || `screenshot_${Date.now()}.${extension}`;

    if (providerName === 'fivemanage') {
        uploadToFivemanage(provider, imageData, mimeType, fileName, options, cb);
    } else if (providerName === 'discord') {
        uploadToDiscord(provider, imageData, mimeType, fileName, options, cb);
    } else if (providerName === 'custom') {
        uploadToCustom(provider, imageData, mimeType, fileName, options, cb);
    } else {
        cb(`Unknown provider type: ${providerName}`, null);
    }
}

async function uploadToFivemanage(
    provider: ProviderConfig,
    imageData: Buffer,
    mimeType: string,
    fileName: string,
    options: any,
    cb: (err: string | null, result: any) => void
) {
    if (!provider.apiKey) {
        cb('Fivemanage API key not configured', null);
        return;
    }

    try {
        const form = new FormData();

        if (options?.metadata) {
            for (const [key, value] of Object.entries(options.metadata)) {
                form.append(key, String(value));
            }
        }

        form.append(provider.field || 'image', imageData, {
            filename: fileName,
            contentType: mimeType
        });

        const response = await httpRequest(provider.url, {
            method: 'POST',
            headers: {
                'Authorization': provider.apiKey,
                ...form.getHeaders()
            },
            body: form
        });

        if (response.status >= 200 && response.status < 300) {
            try {
                const data = JSON.parse(response.text);
                cb(null, {
                    success: true,
                    url: data.url || data.imageUrl || data.link,
                    response: data
                });
            } catch (e) {
                cb(null, { success: true, url: response.text, response: response.text });
            }
        } else {
            cb(`Fivemanage upload failed: HTTP ${response.status} - ${response.text}`, null);
        }
    } catch (e) {
        cb(`Fivemanage upload error: ${e.message}`, null);
    }
}

async function uploadToDiscord(
    provider: ProviderConfig,
    imageData: Buffer,
    mimeType: string,
    fileName: string,
    options: any,
    cb: (err: string | null, result: any) => void
) {
    if (!provider.webhookUrl) {
        cb('Discord webhook URL not configured', null);
        return;
    }

    try {
        const form = new FormData();

        if (options?.content) {
            form.append('content', options.content);
        }

        form.append(provider.field || 'file', imageData, {
            filename: fileName,
            contentType: mimeType
        });

        const response = await httpRequest(provider.webhookUrl, {
            method: 'POST',
            headers: form.getHeaders(),
            body: form
        });

        if (response.status >= 200 && response.status < 300) {
            try {
                const data = JSON.parse(response.text);
                const attachments = data.attachments || [];
                const url = attachments.length > 0 ? attachments[0].url : null;
                cb(null, { success: true, url, response: data });
            } catch (e) {
                cb(null, { success: true, response: response.text });
            }
        } else {
            cb(`Discord upload failed: HTTP ${response.status} - ${response.text}`, null);
        }
    } catch (e) {
        cb(`Discord upload error: ${e.message}`, null);
    }
}

async function uploadToCustom(
    provider: ProviderConfig,
    imageData: Buffer,
    mimeType: string,
    fileName: string,
    options: any,
    cb: (err: string | null, result: any) => void
) {
    if (!provider.url) {
        cb('Custom provider URL not configured', null);
        return;
    }

    try {
        const form = new FormData();

        if (options?.formFields) {
            for (const [key, value] of Object.entries(options.formFields)) {
                form.append(key, String(value));
            }
        }

        form.append(provider.field || 'file', imageData, {
            filename: fileName,
            contentType: mimeType
        });

        const response = await httpRequest(provider.url, {
            method: 'POST',
            headers: {
                ...(provider.headers || {}),
                ...form.getHeaders()
            },
            body: form
        });

        if (response.status >= 200 && response.status < 300) {
            try {
                const data = JSON.parse(response.text);
                cb(null, { success: true, url: data.url || data.link, response: data });
            } catch (e) {
                cb(null, { success: true, response: response.text });
            }
        } else {
            cb(`Custom upload failed: HTTP ${response.status} - ${response.text}`, null);
        }
    } catch (e) {
        cb(`Custom upload error: ${e.message}`, null);
    }
}

// ============================================================================
// Token and Security Functions
// ============================================================================

function base64url(input: Buffer) {
    return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64urlToBuffer(input: string) {
    let padded = input.replace(/-/g, '+').replace(/_/g, '/');
    while (padded.length % 4 !== 0) {
        padded += '=';
    }
    return Buffer.from(padded, 'base64');
}

function signPayload(payloadB64: string) {
    return base64url(crypto.createHmac('sha256', secret).update(payloadB64).digest());
}

function createToken(payload: any) {
    const payloadB64 = base64url(Buffer.from(JSON.stringify(payload)));
    const sig = signPayload(payloadB64);
    return `${payloadB64}.${sig}`;
}

function verifyToken(token: string) {
    const parts = token.split('.');
    if (parts.length !== 2) {
        return null;
    }

    const payloadB64 = parts[0];
    const sig = parts[1];
    const expected = signPayload(payloadB64);

    const sigBuf = Buffer.from(sig);
    const expectedBuf = Buffer.from(expected);

    if (sigBuf.length !== expectedBuf.length) {
        return null;
    }

    if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) {
        return null;
    }

    try {
        const payload = JSON.parse(base64urlToBuffer(payloadB64).toString('utf8'));
        return payload;
    } catch (e) {
        return null;
    }
}

function cleanupExpiredUploads() {
    const now = Date.now();
    for (const nonce of Object.keys(uploads)) {
        if (uploads[nonce].expiresAt <= now) {
            delete uploads[nonce];
            pendingGlobal = Math.max(0, pendingGlobal - 1);
        }
    }
    for (const nonce of Object.keys(externalUploads)) {
        if (externalUploads[nonce].expiresAt <= now) {
            delete externalUploads[nonce];
            pendingGlobal = Math.max(0, pendingGlobal - 1);
        }
    }
}

function removeUpload(nonce: string) {
    if (uploads[nonce]) {
        delete uploads[nonce];
        pendingGlobal = Math.max(0, pendingGlobal - 1);
    }
}

function removeExternalUpload(nonce: string) {
    if (externalUploads[nonce]) {
        delete externalUploads[nonce];
        pendingGlobal = Math.max(0, pendingGlobal - 1);
    }
}

const rateState: { [player: string]: { windowStart: number; count: number } } = {};
const lastCaptureAt: { [player: string]: number } = {};
const recordingRateState: { [player: string]: { windowStart: number; count: number } } = {};

function allowRate(player: string) {
    const now = Date.now();
    const windowMs = 60000;
    const state = rateState[player];

    if (!state || now - state.windowStart >= windowMs) {
        rateState[player] = { windowStart: now, count: 1 };
        return true;
    }

    if (state.count >= rateLimitPerMin) {
        return false;
    }

    state.count++;
    return true;
}

// Recording rate limiting (separate from screenshot rate limiting)
function allowRecordingRate(player: string): boolean {
    const now = Date.now();
    const recordingsPerWindow = parseIntConvar('cfx_capture_recordings_per_window', 3);
    const windowMs = parseIntConvar('cfx_capture_recording_window_ms', 600000);  // 10 minutes

    const state = recordingRateState[player];

    if (!state || now - state.windowStart >= windowMs) {
        recordingRateState[player] = { windowStart: now, count: 1 };
        return true;
    }

    if (state.count >= recordingsPerWindow) {
        return false;
    }

    state.count++;
    return true;
}

function sanitizeOutputPath(fileName: string) {
    if (!fileName || fileName.length === 0) {
        return null;
    }

    if (path.isAbsolute(fileName)) {
        return null;
    }

    const resolved = path.resolve(outputDir, fileName);
    const base = path.resolve(outputDir);

    if (resolved === base || resolved.startsWith(base + path.sep)) {
        return resolved;
    }

    return null;
}

// ============================================================================
// HTTP Routes
// ============================================================================

app.use(async (ctx, next) => {
    try {
        await next();
    } catch (err) {
        ctx.status = err.status || 500;
        ctx.body = { success: false, ...createError(ErrorCodes.UPLOAD_ERROR) };
    }
});

router.post('/upload/:token', async (ctx) => {
    cleanupExpiredUploads();

    const tokenStr: string = ctx.params['token'];

    ctx.response.append('Access-Control-Allow-Origin', '*');
    ctx.response.append('Access-Control-Allow-Methods', 'GET, POST');

    const payload = verifyToken(tokenStr);
    if (!payload || !payload.nonce || !payload.player || !payload.exp) {
        ctx.status = 403;
        ctx.body = { success: false, ...createError(ErrorCodes.INVALID_TOKEN) };
        return;
    }

    const upload = uploads[payload.nonce];
    if (!upload) {
        ctx.status = 403;
        ctx.body = { success: false, ...createError(ErrorCodes.EXPIRED_TOKEN) };
        return;
    }

    const now = Date.now();
    if (upload.expiresAt <= now || payload.exp <= now) {
        removeUpload(payload.nonce);
        ctx.status = 403;
        ctx.body = { success: false, ...createError(ErrorCodes.EXPIRED_TOKEN) };
        return;
    }

    if (upload.player !== payload.player) {
        ctx.status = 403;
        ctx.body = { success: false, ...createError(ErrorCodes.PLAYER_MISMATCH) };
        return;
    }

    const reqAny = ctx.request as any;
    const f = reqAny && reqAny.files ? (reqAny.files['file'] as any) : null;
    if (!f) {
        ctx.status = 400;
        ctx.body = { success: false, ...createError(ErrorCodes.MISSING_FILE) };
        return;
    }

    if (f.size > upload.maxBytes) {
        removeUpload(payload.nonce);
        ctx.status = 413;
        ctx.body = { success: false, ...createError(ErrorCodes.FILE_TOO_LARGE, { size: f.size, maxBytes: upload.maxBytes }) };
        return;
    }

    const allowedTypes = [ 'image/jpeg', 'image/png', 'image/webp' ];
    if (f.type && allowedTypes.indexOf(f.type) === -1) {
        removeUpload(payload.nonce);
        ctx.status = 415;
        ctx.body = { success: false, ...createError(ErrorCodes.INVALID_TYPE, { type: f.type, allowed: allowedTypes }) };
        return;
    }

    const finish = (err: string, data: string) => {
        setImmediate(() => {
            upload.cb(err || false, data);
        });
    };

    if (upload.fileName) {
        mv(f.path, upload.fileName, (err) => {
            removeUpload(payload.nonce);

            if (err) {
                finish(err.message, null);
                return;
            }

            finish(null, upload.fileName);
        });
    } else {
        fs.readFile(f.path, (err, data) => {
            if (err) {
                removeUpload(payload.nonce);
                finish(err.message, null);
                return;
            }

            fs.unlink(f.path, () => {
                removeUpload(payload.nonce);
                const mime = f.type || 'image/jpeg';
                const base64 = data.toString('base64');
                if (upload.returnBlob) {
                    finish(null, JSON.stringify({ blob: true, mime, base64 }));
                } else {
                    const dataUri = `data:${mime};base64,${base64}`;
                    finish(null, dataUri);
                }
            });
        });
    }

    ctx.body = { success: true };
});

// External upload proxy endpoint - receives image from NUI and forwards to provider
router.post('/external-upload/:token', async (ctx) => {
    cleanupExpiredUploads();

    const tokenStr: string = ctx.params['token'];

    ctx.response.append('Access-Control-Allow-Origin', '*');
    ctx.response.append('Access-Control-Allow-Methods', 'GET, POST');

    const payload = verifyToken(tokenStr);
    if (!payload || !payload.nonce || !payload.player || !payload.exp) {
        ctx.status = 403;
        ctx.body = { success: false, ...createError(ErrorCodes.INVALID_TOKEN) };
        return;
    }

    const extUpload = externalUploads[payload.nonce];
    if (!extUpload) {
        ctx.status = 403;
        ctx.body = { success: false, ...createError(ErrorCodes.EXPIRED_TOKEN) };
        return;
    }

    const now = Date.now();
    if (extUpload.expiresAt <= now || payload.exp <= now) {
        removeExternalUpload(payload.nonce);
        ctx.status = 403;
        ctx.body = { success: false, ...createError(ErrorCodes.EXPIRED_TOKEN) };
        return;
    }

    if (extUpload.player !== payload.player) {
        ctx.status = 403;
        ctx.body = { success: false, ...createError(ErrorCodes.PLAYER_MISMATCH) };
        return;
    }

    const reqAny = ctx.request as any;
    const f = reqAny && reqAny.files ? (reqAny.files['file'] as any) : null;
    if (!f) {
        ctx.status = 400;
        ctx.body = { success: false, ...createError(ErrorCodes.MISSING_FILE) };
        return;
    }

    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
    if (f.type && allowedTypes.indexOf(f.type) === -1) {
        removeExternalUpload(payload.nonce);
        ctx.status = 415;
        ctx.body = { success: false, ...createError(ErrorCodes.INVALID_TYPE, { type: f.type, allowed: allowedTypes }) };
        return;
    }

    // Read file and upload to provider
    fs.readFile(f.path, (err, imageData) => {
        fs.unlink(f.path, () => {}); // Clean up temp file

        if (err) {
            removeExternalUpload(payload.nonce);
            extUpload.cb(ErrorCodes.UPLOAD_ERROR, createError(ErrorCodes.UPLOAD_ERROR, { reason: err.message }));
            return;
        }

        const mimeType = f.type || 'image/jpeg';
        uploadToProvider(extUpload.provider, imageData, mimeType, extUpload.options, (uploadErr, result) => {
            removeExternalUpload(payload.nonce);
            if (uploadErr) {
                // Detect timeout errors specifically
                const isTimeout = typeof uploadErr === 'string' && uploadErr.toLowerCase().includes('timed out');
                const errorCode = isTimeout ? ErrorCodes.PROVIDER_TIMEOUT : ErrorCodes.PROVIDER_UPLOAD_FAILED;
                extUpload.cb(errorCode, createError(errorCode, { reason: uploadErr, provider: extUpload.provider }));
            } else {
                extUpload.cb(false, result);
            }
        });
    });

    ctx.body = { success: true };
});

// ============================================================================
// Recording upload endpoint
// ============================================================================
router.post('/recording/upload/:token', async (ctx) => {
    const tokenStr: string = ctx.params['token'];

    ctx.response.append('Access-Control-Allow-Origin', '*');
    ctx.response.append('Access-Control-Allow-Methods', 'GET, POST');

    // Verify token
    const payload = verifyToken(tokenStr);
    if (!payload || !payload.sessionId || payload.v !== 2) {
        ctx.status = 403;
        ctx.body = { success: false, ...createError(ErrorCodes.INVALID_TOKEN) };
        return;
    }

    // Get session
    const session = recordingSessions.get(payload.sessionId);
    if (!session) {
        ctx.status = 403;
        ctx.body = { success: false, ...createError(ErrorCodes.SESSION_NOT_FOUND, { sessionId: payload.sessionId }) };
        return;
    }

    // Validate player matches
    if (session.player !== payload.player) {
        ctx.status = 403;
        ctx.body = { success: false, ...createError(ErrorCodes.PLAYER_MISMATCH) };
        return;
    }

    // Get uploaded file
    const reqAny = ctx.request as any;
    console.log('[CFX-Capture] Files received:', reqAny.files ? Object.keys(reqAny.files) : 'none');

    const file = reqAny.files ? reqAny.files['recording'] : null;
    if (!file) {
        console.error('[CFX-Capture] Missing recording file. Available files:', reqAny.files);
        ctx.status = 400;
        ctx.body = { success: false, ...createError(ErrorCodes.MISSING_FILE, { availableFiles: reqAny.files ? Object.keys(reqAny.files) : [] }) };
        return;
    }

    console.log('[CFX-Capture] File received - type:', file.type, 'size:', file.size);

    // Validate MIME type (accept video/webm or variants, or no type if missing)
    if (file.type && !file.type.includes('webm') && !file.type.includes('video')) {
        console.error('[CFX-Capture] Invalid MIME type received:', file.type);
        ctx.status = 415;
        ctx.body = { success: false, ...createError(ErrorCodes.INVALID_TYPE, { type: file.type, expected: 'video/webm' }) };
        return;
    }

    // Validate file size (max 1GB)
    const maxSize = 1024 * 1024 * 1000;  // 1GB
    if (file.size > maxSize) {
        ctx.status = 413;
        ctx.body = { success: false, ...createError(ErrorCodes.FILE_TOO_LARGE, { size: file.size, maxBytes: maxSize }) };
        return;
    }

    // Save to disk
    const recordingDir = path.resolve(outputDir, 'recordings');
    if (!fs.existsSync(recordingDir)) {
        fs.mkdirSync(recordingDir, { recursive: true });
    }

    const fileName = `${session.sessionId}.webm`;
    const filePath = path.join(recordingDir, fileName);

    mv(file.path, filePath, async (err) => {
        if (err) {
            session.callback(ErrorCodes.SAVE_FAILED, createError(ErrorCodes.SAVE_FAILED, { reason: err.message }));
            recordingSessions.delete(session.sessionId);
            pendingGlobal = Math.max(0, pendingGlobal - 1);
            ctx.status = 500;
            ctx.body = { success: false, ...createError(ErrorCodes.SAVE_FAILED, { reason: err.message }) };
            return;
        }

        // Update session
        session.filePath = filePath;
        session.fileSize = file.size;
        session.endTime = Date.now();
        session.status = reqAny.body?.partial === 'true' ? 'partial' : 'complete';

        // Parse performance metrics from request
        if (reqAny.body?.performanceMetrics) {
            try {
                session.performanceMetrics = JSON.parse(reqAny.body.performanceMetrics);
            } catch (e) {
                // Ignore parsing errors
            }
        }

        // Save metadata
        const metadataPath = path.join(recordingDir, `${session.sessionId}.json`);
        const metadataContent = {
            ...session.metadata,
            sessionId: session.sessionId,
            duration: session.endTime - session.startTime,
            fileSize: session.fileSize,
            status: session.status,
            recordingType: session.recordingType,
            performanceMetrics: session.performanceMetrics
        };

        try {
            fs.writeFileSync(metadataPath, JSON.stringify(metadataContent, null, 2));
        } catch (e) {
            console.error('[CFX-Capture] Failed to write metadata:', e.message);
        }

        // Emit completion event
        emitNet('cfx_capture:recordingComplete', session.player, {
            sessionId: session.sessionId,
            filePath: session.filePath,
            uploadUrl: session.uploadUrl,
            metadata: session.metadata
        });

        // Callback
        session.callback(false, {
            sessionId: session.sessionId,
            filePath: session.filePath,
            uploadUrl: session.uploadUrl,
            duration: session.endTime - session.startTime,
            fileSize: session.fileSize,
            metadata: session.metadata,
            status: session.status
        });

        // Cleanup
        recordingSessions.delete(session.sessionId);
        pendingGlobal = Math.max(0, pendingGlobal - 1);

        console.log(`[CFX-Capture] Recording saved: ${fileName} (${(file.size / 1024 / 1024).toFixed(2)} MB, ${session.status})`);
    });

    ctx.body = { success: true };
});

app.use(koaBody({
        patchKoa: true,
        multipart: true,
        formidable: {
            maxFileSize: 1024 * 1024 * 1000,  // Increase to 1GB for recordings
            keepExtensions: true
        }
    }))
   .use(router.routes())
   .use(router.allowedMethods());

setHttpCallback(app.callback());

const exp = (<any>global).exports;

// ============================================================================
// Server Export: requestClientScreenshot (unchanged)
// ============================================================================

function requestClientScreenshot(player: string | number, options: any, cb: (err: string | boolean, data: string | CaptureError) => void) {
    cleanupExpiredUploads();

    const playerId = String(player);
    const now = Date.now();
    const last = lastCaptureAt[playerId] || 0;
    if (now - last < minIntervalMs) {
        cb(ErrorCodes.TOO_SOON, createError(ErrorCodes.TOO_SOON, { lastCapture: last, now, interval: minIntervalMs }));
        return;
    }

    if (!allowRate(playerId)) {
        cb(ErrorCodes.RATE_LIMITED, createError(ErrorCodes.RATE_LIMITED, { limit: rateLimitPerMin, window: '60s' }));
        return;
    }

    if (pendingGlobal >= maxPendingGlobal) {
        cb(ErrorCodes.GLOBAL_THROTTLE, createError(ErrorCodes.GLOBAL_THROTTLE, { pending: pendingGlobal, max: maxPendingGlobal }));
        return;
    }

    const nonce = crypto.randomBytes(16).toString('hex');
    const expiresAt = now + tokenTTLms;

    const safeOptions = options || {};
    const returnBlob = safeOptions.returnBlob === true;
    const requestedMax = safeOptions.maxSizeMB ? Math.max(1, parseInt(safeOptions.maxSizeMB, 10)) * 1024 * 1024 : configMaxBytes;
    const maxBytes = Math.min(configMaxBytes, requestedMax);
    safeOptions.maxSizeBytes = maxBytes;

    const defaultWidth = returnBlob ? 1280 : 1920;
    const defaultHeight = returnBlob ? 720 : 1080;
    const requestedWidth = safeOptions.width ? Math.max(1, parseInt(safeOptions.width, 10)) : defaultWidth;
    const requestedHeight = safeOptions.height ? Math.max(1, parseInt(safeOptions.height, 10)) : defaultHeight;
    safeOptions.width = Math.min(maxWidth, requestedWidth);
    safeOptions.height = Math.min(maxHeight, requestedHeight);

    if (returnBlob) {
        if (!safeOptions.encoding) {
            safeOptions.encoding = 'jpg';
        }
        if (safeOptions.quality === undefined || safeOptions.quality === null) {
            safeOptions.quality = 0.8;
        }
    }

    let fileName: string | null = null;
    if (safeOptions.fileName) {
        const safe = sanitizeOutputPath(safeOptions.fileName);
        if (!safe) {
            cb(ErrorCodes.INVALID_FILE_NAME, createError(ErrorCodes.INVALID_FILE_NAME, { fileName: safeOptions.fileName }));
            return;
        }
        fileName = safe;
    }

    delete safeOptions['fileName'];

    uploads[nonce] = {
        player: playerId,
        fileName,
        maxBytes,
        expiresAt,
        cb,
        returnBlob
    };
    pendingGlobal++;
    lastCaptureAt[playerId] = now;

    const payload = {
        v: 1,
        nonce,
        player: playerId,
        exp: expiresAt,
        max: maxBytes
    };

    const token = createToken(payload);
    const url = `/${GetCurrentResourceName()}/upload/${token}`;

    emitNet('cfx_capture:requestScreenshot', player, safeOptions, url);
}

exp('requestClientScreenshot', requestClientScreenshot);

// Backward-compatible export name
exp('requestClientScreenshotLegacy', requestClientScreenshot);

// ============================================================================
// Server Export: requestClientScreenshotUpload (NEW - secure external upload)
// ============================================================================

function requestClientScreenshotUpload(
    player: string | number,
    providerOrUrl: string,
    options: any,
    cb: (err: string | boolean, data: any | CaptureError) => void
) {
    cleanupExpiredUploads();

    const playerId = String(player);
    const now = Date.now();
    const last = lastCaptureAt[playerId] || 0;
    if (now - last < minIntervalMs) {
        cb(ErrorCodes.TOO_SOON, createError(ErrorCodes.TOO_SOON, { lastCapture: last, now, interval: minIntervalMs }));
        return;
    }

    if (!allowRate(playerId)) {
        cb(ErrorCodes.RATE_LIMITED, createError(ErrorCodes.RATE_LIMITED, { limit: rateLimitPerMin, window: '60s' }));
        return;
    }

    if (pendingGlobal >= maxPendingGlobal) {
        cb(ErrorCodes.GLOBAL_THROTTLE, createError(ErrorCodes.GLOBAL_THROTTLE, { pending: pendingGlobal, max: maxPendingGlobal }));
        return;
    }

    // Determine provider - either by name or map from URL
    let provider = providerOrUrl;
    if (providerOrUrl.startsWith('http://') || providerOrUrl.startsWith('https://')) {
        const mapped = mapUrlToProvider(providerOrUrl);
        if (mapped) {
            provider = mapped;
        } else {
            cb(ErrorCodes.PROVIDER_NOT_FOUND, createError(ErrorCodes.PROVIDER_NOT_FOUND, { url: providerOrUrl }));
            return;
        }
    }

    // Validate provider exists and is enabled
    const providerConfig = getProviderConfig(provider);
    if (!providerConfig) {
        cb(ErrorCodes.PROVIDER_NOT_CONFIGURED, createError(ErrorCodes.PROVIDER_NOT_CONFIGURED, { provider }));
        return;
    }

    if (!providerConfig.enabled) {
        cb(ErrorCodes.PROVIDER_DISABLED, createError(ErrorCodes.PROVIDER_DISABLED, { provider }));
        return;
    }

    const nonce = crypto.randomBytes(16).toString('hex');
    const expiresAt = now + tokenTTLms;

    const safeOptions = options || {};
    const requestedMax = safeOptions.maxSizeMB ? Math.max(1, parseInt(safeOptions.maxSizeMB, 10)) * 1024 * 1024 : configMaxBytes;
    const maxBytes = Math.min(configMaxBytes, requestedMax);
    safeOptions.maxSizeBytes = maxBytes;

    const requestedWidth = safeOptions.width ? Math.max(1, parseInt(safeOptions.width, 10)) : 1920;
    const requestedHeight = safeOptions.height ? Math.max(1, parseInt(safeOptions.height, 10)) : 1080;
    safeOptions.width = Math.min(maxWidth, requestedWidth);
    safeOptions.height = Math.min(maxHeight, requestedHeight);

    if (!safeOptions.encoding) {
        safeOptions.encoding = 'jpg';
    }
    if (safeOptions.quality === undefined || safeOptions.quality === null) {
        safeOptions.quality = 0.92;
    }

    externalUploads[nonce] = {
        player: playerId,
        provider,
        options: safeOptions,
        expiresAt,
        cb
    };
    pendingGlobal++;
    lastCaptureAt[playerId] = now;

    const payload = {
        v: 1,
        nonce,
        player: playerId,
        exp: expiresAt,
        max: maxBytes
    };

    const token = createToken(payload);
    const url = `/${GetCurrentResourceName()}/external-upload/${token}`;

    // Tell client to capture and upload to our proxy endpoint
    emitNet('cfx_capture:requestExternalUpload', player, safeOptions, url);
}

exp('requestClientScreenshotUpload', requestClientScreenshotUpload);

// ============================================================================
// Client Event Handler: External upload request from client export
// ============================================================================

onNet('cfx_capture:clientRequestExternalUpload', (providerOrUrl: string, options: any) => {
    const player = source;
    const playerId = String(player);

    // Determine provider
    let provider = providerOrUrl;
    if (!providerOrUrl || providerOrUrl === '') {
        provider = getDefaultProvider();
    } else if (providerOrUrl.startsWith('http://') || providerOrUrl.startsWith('https://')) {
        const mapped = mapUrlToProvider(providerOrUrl);
        if (mapped) {
            provider = mapped;
        } else {
            const error = createError(ErrorCodes.PROVIDER_NOT_FOUND, { url: providerOrUrl });
            emitNet('cfx_capture:externalUploadResult', player, options?.correlation, {
                success: false,
                ...error
            });
            return;
        }
    }

    // Validate provider
    const providerConfig = getProviderConfig(provider);
    if (!providerConfig || !providerConfig.enabled) {
        const error = createError(ErrorCodes.PROVIDER_DISABLED, { provider });
        emitNet('cfx_capture:externalUploadResult', player, options?.correlation, {
            success: false,
            ...error
        });
        return;
    }

    // Use the server export to handle the upload
    requestClientScreenshotUpload(player, provider, options, (err, result) => {
        if (err) {
            // If result is already a CaptureError, use it; otherwise create one
            const errorData = (result && result.code) ? result : createError(typeof err === 'string' ? err : ErrorCodes.UPLOAD_ERROR);
            emitNet('cfx_capture:externalUploadResult', player, options?.correlation, {
                success: false,
                ...errorData
            });
        } else {
            emitNet('cfx_capture:externalUploadResult', player, options?.correlation, result);
        }
    });
});

// ============================================================================
// Video Recording Exports
// ============================================================================

// Helper function to get player identifiers
function getPlayerIdentifiers(playerId: string): Record<string, string> {
    const identifiers: Record<string, string> = {};

    // Common identifier types in FiveM
    const types = ['steam', 'license', 'license2', 'xbl', 'live', 'discord', 'fivem', 'ip'];

    for (const type of types) {
        try {
            // @ts-ignore - FiveM native function
            const identifier = GetPlayerIdentifierByType(playerId, type);
            if (identifier) {
                identifiers[type] = identifier;
            }
        } catch (e) {
            // Identifier type not available
        }
    }

    return identifiers;
}

// Create recording session token
function createRecordingToken(sessionData: RecordingSessionData): string {
    const payload = {
        v: 2,  // Version 2 for recording tokens
        sessionId: sessionData.sessionId,
        player: sessionData.player,
        type: sessionData.recordingType,
        exp: sessionData.expiresAt,
        iat: Date.now()
    };

    return createToken(payload);
}

exp('startRecording', (
    player: string | number,
    options: {
        recordingType?: 'evidence' | 'clip' | 'bug' | 'event';
        maxDuration?: number;  // milliseconds
        metadata?: Record<string, any>;
    },
    callback: (err: string | boolean, data: any | CaptureError) => void
) => {
    const playerId = String(player);
    const now = Date.now();

    options = options || {};

    // Rate limiting
    if (!allowRecordingRate(playerId)) {
        const recordingsPerWindow = parseIntConvar('cfx_capture_recordings_per_window', 3);
        callback(ErrorCodes.RECORDING_RATE_LIMITED, createError(ErrorCodes.RECORDING_RATE_LIMITED, { limit: recordingsPerWindow }));
        return;
    }

    // Global throttle (reuse screenshot limit)
    if (pendingGlobal >= maxPendingGlobal) {
        callback(ErrorCodes.GLOBAL_THROTTLE, createError(ErrorCodes.GLOBAL_THROTTLE, { pending: pendingGlobal, max: maxPendingGlobal }));
        return;
    }

    // Generate session ID
    const sessionId = crypto.randomBytes(16).toString('hex');

    // Get max duration from options or config
    const maxDuration = options.maxDuration || parseIntConvar('cfx_capture_max_duration_ms', 300000);

    // Gather metadata
    let playerCoords = [0, 0, 0];
    let playerName = 'Unknown';

    try {
        // @ts-ignore - FiveM native functions
        const playerPed = GetPlayerPed(String(playerId));
        if (playerPed > 0) {
            // @ts-ignore
            playerCoords = GetEntityCoords(playerPed);
        }
        // @ts-ignore
        playerName = GetPlayerName(String(playerId)) || 'Unknown';
    } catch (e) {
        // Failed to get player data
    }

    const sessionData: RecordingSessionData = {
        sessionId,
        player: playerId,
        recordingType: options.recordingType || 'clip',
        metadata: {
            playerName,
            playerIdentifiers: getPlayerIdentifiers(playerId),
            serverName: GetConvar('sv_hostname', 'FiveM Server'),
            coordinates: { x: playerCoords[0], y: playerCoords[1], z: playerCoords[2] },
            timestamp: now,
            customTags: options.metadata || {}
        },
        startTime: now,
        status: 'recording',
        expiresAt: now + maxDuration,
        callback
    };

    // Store session
    recordingSessions.set(sessionId, sessionData);
    pendingGlobal++;

    // Generate token
    const token = createRecordingToken(sessionData);
    const url = `/${GetCurrentResourceName()}/recording/upload/${token}`;

    // Send to client (client will construct full URL)
    emitNet('cfx_capture:startRecording', player, {
        sessionId,
        token,
        maxDuration,
        recordingType: sessionData.recordingType,
        metadata: options.metadata,
        targetPath: url,  // Just send path, client constructs full URL
        correlation: sessionId  // Use sessionId as correlation
    });

    console.log(`[CFX-Capture] Recording started for player ${playerId}: ${sessionId} (${sessionData.recordingType}, ${maxDuration}ms)`);
});

exp('getRecordings', (
    filters?: {
        player?: string;
        recordingType?: string;
        startDate?: number;
        endDate?: number;
        limit?: number;
    }
) => {
    const recordingDir = path.resolve(outputDir, 'recordings');
    if (!fs.existsSync(recordingDir)) {
        return [];
    }

    const metadataFiles = fs.readdirSync(recordingDir)
        .filter(f => f.endsWith('.json'));

    const recordings: any[] = [];
    for (const file of metadataFiles) {
        try {
            const content = fs.readFileSync(path.join(recordingDir, file), 'utf8');
            const metadata = JSON.parse(content);
            recordings.push(metadata);
        } catch (e) {
            console.error(`[CFX-Capture] Failed to read metadata: ${file}`, e.message);
        }
    }

    // Apply filters
    let filtered = recordings;
    if (filters) {
        if (filters.player) {
            filtered = filtered.filter(r =>
                r.playerIdentifiers?.license === filters.player ||
                r.playerIdentifiers?.steam === filters.player
            );
        }
        if (filters.recordingType) {
            filtered = filtered.filter(r => r.recordingType === filters.recordingType);
        }
        if (filters.startDate) {
            filtered = filtered.filter(r => r.timestamp >= filters.startDate);
        }
        if (filters.endDate) {
            filtered = filtered.filter(r => r.timestamp <= filters.endDate);
        }
    }

    // Sort by timestamp descending
    filtered.sort((a, b) => b.timestamp - a.timestamp);

    // Limit results
    if (filters?.limit) {
        filtered = filtered.slice(0, filters.limit);
    }

    return filtered;
});

exp('deleteRecording', (sessionId: string) => {
    const recordingDir = path.resolve(outputDir, 'recordings');
    const videoPath = path.join(recordingDir, `${sessionId}.webm`);
    const metadataPath = path.join(recordingDir, `${sessionId}.json`);

    let deleted = false;

    if (fs.existsSync(videoPath)) {
        fs.unlinkSync(videoPath);
        deleted = true;
    }

    if (fs.existsSync(metadataPath)) {
        fs.unlinkSync(metadataPath);
        deleted = true;
    }

    if (deleted) {
        console.log(`[CFX-Capture] Deleted recording: ${sessionId}`);
    }

    return deleted;
});

// Retention policy cleanup (runs every hour)
setInterval(() => {
    const recordingDir = path.resolve(outputDir, 'recordings');
    if (!fs.existsSync(recordingDir)) return;

    const now = Date.now();
    const retentionPolicies = {
        evidence: parseIntConvar('cfx_capture_retention_evidence', 30) * 24 * 60 * 60 * 1000,
        clip: parseIntConvar('cfx_capture_retention_clip', 7) * 24 * 60 * 60 * 1000,
        bug: parseIntConvar('cfx_capture_retention_bug', 14) * 24 * 60 * 60 * 1000,
        event: parseIntConvar('cfx_capture_retention_event', 3) * 24 * 60 * 60 * 1000
    };

    const metadataFiles = fs.readdirSync(recordingDir).filter(f => f.endsWith('.json'));

    for (const file of metadataFiles) {
        try {
            const metadataPath = path.join(recordingDir, file);
            const content = fs.readFileSync(metadataPath, 'utf8');
            const metadata = JSON.parse(content);

            const retentionTime = retentionPolicies[metadata.recordingType] || retentionPolicies.clip;
            const age = now - metadata.timestamp;

            if (age > retentionTime) {
                // Delete video file
                const videoPath = path.join(recordingDir, `${metadata.sessionId}.webm`);
                if (fs.existsSync(videoPath)) {
                    fs.unlinkSync(videoPath);
                }

                // Delete metadata
                fs.unlinkSync(metadataPath);

                console.log(`[CFX-Capture] Deleted old recording: ${metadata.sessionId} (${metadata.recordingType}, ${Math.floor(age / 86400000)} days old)`);
            }
        } catch (e) {
            console.error(`[CFX-Capture] Error in retention cleanup: ${file}`, e.message);
        }
    }
}, 3600000);  // Run every hour

console.log('[CFX-Capture] Initialized (with video recording support)');
