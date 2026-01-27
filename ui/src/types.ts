/**
 * Type definitions for CFX-Capture
 */

// ============================================================================
// Structured Error Types
// ============================================================================

export interface CaptureError {
    code: string;
    message: string;
    retryAfter?: number;      // Milliseconds until retry is allowed
    details?: Record<string, any>;
}

export const ErrorCodes = {
    // Rate limiting errors
    TOO_SOON: 'too_soon',
    RATE_LIMITED: 'rate_limited',
    GLOBAL_THROTTLE: 'global_throttle',
    RECORDING_RATE_LIMITED: 'recording_rate_limited',

    // Token/auth errors
    INVALID_TOKEN: 'invalid_token',
    EXPIRED_TOKEN: 'expired_token',
    PLAYER_MISMATCH: 'player_mismatch',

    // File errors
    FILE_TOO_LARGE: 'file_too_large',
    INVALID_TYPE: 'invalid_type',
    MISSING_FILE: 'missing_file',
    INVALID_FILE_NAME: 'invalid_file_name',
    SAVE_FAILED: 'save_failed',

    // Provider errors
    PROVIDER_NOT_CONFIGURED: 'provider_not_configured',
    PROVIDER_DISABLED: 'provider_disabled',
    PROVIDER_NOT_FOUND: 'provider_not_found',
    PROVIDER_UPLOAD_FAILED: 'provider_upload_failed',
    PROVIDER_TIMEOUT: 'provider_timeout',

    // Recording errors
    SESSION_NOT_FOUND: 'session_not_found',

    // General errors
    UPLOAD_ERROR: 'upload_error',
    UNKNOWN_ERROR: 'unknown_error',
} as const;

export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes];

export const ErrorMessages: Record<string, string> = {
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

// ============================================================================
// Screenshot Types
// ============================================================================

export interface ScreenshotRequest {
    encoding: 'jpg' | 'png' | 'webp';
    quality: number;
    headers: any;
    maxSizeBytes: number;
    returnBlob?: boolean;
    width?: number;
    height?: number;
    uploadFileName?: string;
    formFields?: { [key: string]: string };
    correlation: string;
    resultURL: string;
    targetURL: string;
    targetField: string;
}

export interface RecordingOptions {
    sessionId: string;
    token: string;
    maxDuration: number;  // milliseconds (default 300000 = 5min)
    recordingType: 'evidence' | 'clip' | 'bug' | 'event';
    metadata?: Record<string, any>;  // Custom tags
    targetURL: string;  // Upload endpoint
    correlation: string;  // For callback handling
}

export interface RecordingSession {
    sessionId: string;
    startTime: number;
    frameCount: number;
    targetFPS: number;
    currentFPS: number;  // Tracked for dynamic quality
    resolution: { width: number; height: number };
    bitrate: number;  // Dynamically adjusted

    mediaStream: MediaStream | null;
    mediaRecorder: MediaRecorder | null;
    chunks: Blob[];

    isRecording: boolean;
    status: 'recording' | 'encoding' | 'complete' | 'failed' | 'partial';

    // Performance tracking
    performanceMetrics: {
        fpsDrops: number;  // Count of frames below 50fps
        avgEncodingTime: number;  // ms per chunk
        peakMemory: number;  // MB
    };

    // Session details
    token: string;
    targetURL: string;
    correlation: string;
    maxDurationTimer?: number;  // setTimeout handle
}

export interface PerformanceMetrics {
    currentFPS: number;
    avgEncodingTime: number;
    totalFrames: number;
    fpsDrops: number;
}
