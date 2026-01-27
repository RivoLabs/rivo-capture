/**
 * CFX-Capture - Configuration
 * Edit these settings to customize the resource behavior.
 *
 * IMPORTANT: This file is SERVER-SIDE ONLY to protect API keys.
 */

const Config = {
    // ========================================================================
    // SERVER SETTINGS
    // ========================================================================

    // Maximum screenshot file size in MB
    MaxSizeMB: 8,

    // Token time-to-live in milliseconds (how long upload tokens are valid)
    TokenTTLms: 15000,

    // Rate limit: max screenshots per player per minute
    RateLimitPerMin: 6,

    // Maximum pending uploads globally (prevents memory exhaustion)
    MaxPendingGlobal: 50,

    // Maximum capture resolution
    MaxWidth: 1920,
    MaxHeight: 1080,

    // Minimum interval between screenshots in milliseconds
    MinIntervalMs: 500,

    // Upload timeout in milliseconds (how long to wait for provider response)
    UploadTimeoutMs: 30000,

    // Output directory for saved screenshots (relative to resource)
    OutputDir: "cache/cfx-capture",

    // ========================================================================
    // EXTERNAL UPLOAD PROVIDERS (Server-side only - API keys are secure)
    // ========================================================================

    Providers: {
        // Fivemanage provider
        fivemanage: {
            enabled: true,
            url: "https://api.fivemanage.com/api/image",
            apiKey: "YOUR_FIVEMANAGE_API_KEY",
            field: "image"
        },

        // Discord webhook provider
        discord: {
            enabled: false,
            webhookUrl: "",  // Set your Discord webhook URL here
            field: "file"
        },

        // Custom provider (for self-hosted solutions)
        custom: {
            enabled: false,
            url: "",
            headers: {},  // Additional headers to send
            field: "file"
        }
    },

    // Default provider for uploads when none specified
    DefaultProvider: "fivemanage",

    // ========================================================================
    // LOGGING
    // ========================================================================

    // Log level: "debug", "info", "warn", "error"
    LogLevel: "info",

    // ========================================================================
    // VIDEO RECORDING SETTINGS
    // ========================================================================

    Recording: {
        // Enable/disable recording feature
        Enabled: true,

        // Maximum recording duration in milliseconds (5 minutes default)
        MaxDurationMs: 300000,

        // Target bitrate for video encoding (1.5 Mbps = optimized for 720p)
        TargetBitrate: 1500000,

        // Frames per second for recording (24 fps = smooth + performant)
        TargetFPS: 24,

        // Dynamic quality adjustment
        DynamicQuality: {
            Enabled: true,
            MinFPS: 50,  // Drop quality if FPS below this
            MinResolution: { width: 1280, height: 720 },  // Don't go below 720p
            MinBitrate: 1000000  // Don't go below 1 Mbps
        },

        // Rate limiting for recordings
        RateLimit: {
            RecordingsPerWindow: 3,
            WindowMs: 600000  // 10 minutes
        },

        // Storage settings
        Storage: {
            Directory: "recordings",  // Relative to outputDir
            MaxStorageGB: 50,  // Maximum total storage for recordings

            // Retention policies (days)
            Retention: {
                evidence: 30,
                clip: 7,
                bug: 14,
                event: 3
            }
        },

        // Performance monitoring
        Monitoring: {
            LogFPSDrops: true,
            LogEncodingPerformance: true,
            WarnStorageThreshold: 0.8  // Warn at 80% storage usage
        }
    }
};

// Export as global for server.js to access
globalThis.CfxCaptureConfig = Config;
