# CFX-Capture

A screenshot and video recording resource for FiveM servers.

Built on the foundation of screenshot-basic by the CitizenFX team and screencapture by itschip. Redesigned for production environments with security and reliability as core principles.

---

## Why CFX-Capture

**Reliability.** A queue-based system processes requests sequentially, eliminating failures under concurrent load.

**Security.** External uploads are proxied through the server. API keys never reach the client. HMAC-signed tokens with expiration prevent replay attacks.

**Performance.** Adaptive quality scaling reduces file sizes automatically. Configurable rate limits protect server resources.

**Flexibility.** Built-in support for Fivemanage, Discord webhooks, and custom endpoints. Video recording with automatic retention policies.

---

## Installation

1. Download the latest release
2. Extract to your resources folder
3. Add `ensure cfx-capture` to server.cfg
4. Configure `config.js` with your provider API keys

---

## Configuration

Edit `config.js` to set your preferences and API keys.

```js
const Config = {
    MaxSizeMB: 8,
    TokenTTLms: 15000,
    RateLimitPerMin: 6,
    MaxPendingGlobal: 50,
    MaxWidth: 1920,
    MaxHeight: 1080,
    MinIntervalMs: 500,
    UploadTimeoutMs: 30000,
    OutputDir: "cache/cfx-capture",

    Providers: {
        fivemanage: {
            enabled: true,
            url: "https://api.fivemanage.com/api/image",
            apiKey: "YOUR_API_KEY",
            field: "image"
        },
        discord: {
            enabled: false,
            webhookUrl: "",
            field: "file"
        },
        custom: {
            enabled: false,
            url: "",
            headers: {},
            field: "file"
        }
    },

    DefaultProvider: "fivemanage"
};
```

### ConVars

Override configuration at runtime without modifying files.

| ConVar | Default | Description |
|--------|---------|-------------|
| `cfx_capture_max_size_mb` | 8 | Maximum file size in MB |
| `cfx_capture_token_ttl_ms` | 15000 | Token lifetime in milliseconds |
| `cfx_capture_rate_limit_per_min` | 6 | Screenshots per player per minute |
| `cfx_capture_max_pending_global` | 50 | Maximum concurrent uploads |
| `cfx_capture_upload_timeout_ms` | 30000 | Provider upload timeout |
| `cfx_capture_min_interval_ms` | 500 | Minimum time between captures |

---

## Server Exports

### requestClientScreenshot

Capture a screenshot from a player and receive the data on the server.

```lua
exports['cfx-capture']:requestClientScreenshot(playerId, options, callback)
```

**Parameters**
- `playerId` - Player server ID
- `options` - Configuration table
- `callback` - Function receiving `(err, data)`

**Options**
| Option | Type | Description |
|--------|------|-------------|
| `encoding` | string | `jpg`, `png`, or `webp` |
| `quality` | number | 0.0 to 1.0 |
| `width` | number | Capture width |
| `height` | number | Capture height |
| `fileName` | string | Save to file instead of returning data |
| `returnBlob` | boolean | Return JSON with base64 instead of data URI |

**Example**
```lua
exports['cfx-capture']:requestClientScreenshot(source, {
    encoding = 'jpg',
    quality = 0.85,
    width = 1920,
    height = 1080
}, function(err, data)
    if err then
        print('Error:', err)
        print('Details:', json.encode(data))
        return
    end
    print('Screenshot captured:', #data, 'bytes')
end)
```

**Example with file save**
```lua
exports['cfx-capture']:requestClientScreenshot(source, {
    fileName = 'evidence_' .. os.time() .. '.jpg'
}, function(err, filePath)
    if not err then
        print('Saved to:', filePath)
    end
end)
```

---

### requestClientScreenshotUpload

Capture a screenshot and upload to an external provider through the server.

```lua
exports['cfx-capture']:requestClientScreenshotUpload(playerId, provider, options, callback)
```

**Parameters**
- `playerId` - Player server ID
- `provider` - Provider name (`fivemanage`, `discord`, `custom`) or URL
- `options` - Configuration table
- `callback` - Function receiving `(err, result)`

**Options**
| Option | Type | Description |
|--------|------|-------------|
| `encoding` | string | `jpg`, `png`, or `webp` |
| `quality` | number | 0.0 to 1.0 |
| `metadata` | table | Provider-specific metadata |
| `content` | string | Message content for Discord |
| `fileName` | string | Filename for the upload |

**Example**
```lua
exports['cfx-capture']:requestClientScreenshotUpload(source, 'fivemanage', {
    encoding = 'jpg',
    quality = 0.9,
    metadata = {
        name = 'Player Evidence',
        description = 'Captured by admin'
    }
}, function(err, result)
    if err then
        print('Upload failed:', err)
        return
    end
    print('Uploaded:', result.url)
end)
```

**Example with Discord**
```lua
exports['cfx-capture']:requestClientScreenshotUpload(source, 'discord', {
    content = 'Screenshot from ' .. GetPlayerName(source)
}, function(err, result)
    if not err then
        print('Posted to Discord')
    end
end)
```

---

### startRecording

Begin a video recording session for a player.

```lua
exports['cfx-capture']:startRecording(playerId, options, callback)
```

**Parameters**
- `playerId` - Player server ID
- `options` - Configuration table
- `callback` - Function receiving `(err, result)`

**Options**
| Option | Type | Description |
|--------|------|-------------|
| `recordingType` | string | `evidence`, `clip`, `bug`, or `event` |
| `maxDuration` | number | Maximum duration in milliseconds |
| `metadata` | table | Custom metadata tags |

**Example**
```lua
exports['cfx-capture']:startRecording(source, {
    recordingType = 'evidence',
    maxDuration = 60000,
    metadata = {
        reason = 'Suspected cheating',
        reportedBy = GetPlayerName(adminSource)
    }
}, function(err, result)
    if err then
        print('Recording failed:', err)
        return
    end
    print('Recording saved:', result.sessionId)
    print('File:', result.filePath)
    print('Duration:', result.duration, 'ms')
end)
```

---

### getRecordings

Query stored recordings with optional filters.

```lua
local recordings = exports['cfx-capture']:getRecordings(filters)
```

**Filters**
| Filter | Type | Description |
|--------|------|-------------|
| `player` | string | Filter by player identifier |
| `recordingType` | string | Filter by type |
| `startDate` | number | Minimum timestamp |
| `endDate` | number | Maximum timestamp |
| `limit` | number | Maximum results |

**Example**
```lua
local recordings = exports['cfx-capture']:getRecordings({
    recordingType = 'evidence',
    limit = 10
})

for _, rec in ipairs(recordings) do
    print(rec.sessionId, rec.playerName, rec.duration)
end
```

---

### deleteRecording

Remove a recording by session ID.

```lua
local deleted = exports['cfx-capture']:deleteRecording(sessionId)
```

**Example**
```lua
local success = exports['cfx-capture']:deleteRecording('abc123def456')
if success then
    print('Recording deleted')
end
```

---

## Client Exports

### requestScreenshot

Capture a screenshot on the client and receive the data locally.

```lua
exports['cfx-capture']:requestScreenshot(options, callback)
```

**Example**
```lua
exports['cfx-capture']:requestScreenshot({
    encoding = 'jpg',
    quality = 0.92
}, function(data)
    print('Screenshot captured:', #data, 'bytes')
end)
```

---

### requestScreenshotUpload

Capture a screenshot and upload through the server proxy.

```lua
exports['cfx-capture']:requestScreenshotUpload(provider, options, callback)
```

**Example**
```lua
exports['cfx-capture']:requestScreenshotUpload('fivemanage', {
    encoding = 'jpg'
}, function(result)
    local data = json.decode(result)
    if data.success then
        print('Uploaded:', data.url)
    else
        print('Failed:', data.error)
    end
end)
```

---

## Error Handling

All callbacks receive structured error information when something goes wrong.

```lua
exports['cfx-capture']:requestClientScreenshot(source, {}, function(err, data)
    if err then
        -- err is the error code string
        print('Error code:', err)

        -- data contains the full error object
        print('Message:', data.message)
        print('Retry after:', data.retryAfter, 'ms')
        print('Details:', json.encode(data.details))
        return
    end
end)
```

**Error Codes**
| Code | Description |
|------|-------------|
| `too_soon` | Request made before minimum interval |
| `rate_limited` | Player exceeded rate limit |
| `global_throttle` | Server at maximum concurrent uploads |
| `invalid_token` | Token validation failed |
| `expired_token` | Token has expired |
| `file_too_large` | File exceeds size limit |
| `provider_timeout` | Upload to provider timed out |
| `provider_disabled` | Provider not enabled in config |

---

## Backward Compatibility

CFX-Capture maintains compatibility with screenshot-basic.

```lua
-- This event still works
TriggerServerEvent('screenshot_basic:requestScreenshot', options, url)

-- Legacy export alias
exports['cfx-capture']:requestClientScreenshotLegacy(...)
```

---

## License

MIT License

---

Built by CFX Software. Based on work by the CitizenFX Collective and itschip.
