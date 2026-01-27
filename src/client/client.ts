const exp = (<any>global).exports;

RegisterNuiCallbackType('cfx_capture_created');

class ResultData {
    cb: (data: string) => void;
}

const results: { [id: string]: ResultData } = {};
let correlationId = 0;

function registerCorrelation(cb: (result: string) => void) {
    const id = correlationId.toString();
    results[id] = { cb };
    correlationId++;
    return id;
}

// ============================================================================
// Client Export: requestScreenshot (local capture, unchanged)
// ============================================================================

exp('requestScreenshot', (options: any, cb: (result: string) => void) => {
    const realOptions = (cb !== undefined) ? options : {
        encoding: 'jpg'
    };

    const realCb = (cb !== undefined) ? cb : options;

    realOptions.resultURL = null;
    realOptions.targetField = null;
    realOptions.targetURL = `http://${GetCurrentResourceName()}/cfx_capture_created`;

    realOptions.correlation = registerCorrelation(realCb);

    SendNuiMessage(JSON.stringify({
        request: realOptions
    }));
});

// ============================================================================
// Client Export: requestScreenshotUpload (routes through server for security)
// ============================================================================

exp('requestScreenshotUpload', (urlOrProvider: string, fieldOrOptions: string | any, optionsOrCb?: any, cb?: (result: string) => void) => {
    // Handle flexible argument signatures:
    // 1. (provider, options, cb) - new style
    // 2. (url, field, cb) - legacy style
    // 3. (url, field, options, cb) - legacy with options

    let provider: string;
    let realOptions: any;
    let realCb: (result: string) => void;

    if (typeof fieldOrOptions === 'string') {
        // Legacy style: (url, field, [options], cb)
        provider = urlOrProvider;
        if (typeof optionsOrCb === 'function') {
            realOptions = {};
            realCb = optionsOrCb;
        } else {
            realOptions = optionsOrCb || {};
            realCb = cb;
        }
    } else {
        // New style: (provider, options, cb)
        provider = urlOrProvider;
        realOptions = fieldOrOptions || {};
        realCb = optionsOrCb;
    }

    if (!realOptions.encoding) {
        realOptions.encoding = 'jpg';
    }

    const correlation = registerCorrelation(realCb);
    realOptions.correlation = correlation;

    // Send request to server - server will validate provider and initiate capture
    emitNet('cfx_capture:clientRequestExternalUpload', provider, realOptions);
});

// ============================================================================
// NUI Callback Handler
// ============================================================================

on('__cfx_nui:cfx_capture_created', (body: any, cb: (arg: any) => void) => {
    cb(true);

    if (body && body.id !== undefined && results[body.id]) {
        results[body.id].cb(body.data);
        delete results[body.id];
    }
});

// ============================================================================
// Server Event Handlers
// ============================================================================

// Handle server-initiated screenshot capture (for internal server upload)
onNet('cfx_capture:requestScreenshot', (options: any, url: string) => {
    options.encoding = options.encoding || 'jpg';

    options.targetURL = `http://${GetCurrentServerEndpoint()}${url}`;
    options.targetField = 'file';
    options.resultURL = null;

    options.correlation = registerCorrelation(() => {});

    SendNuiMessage(JSON.stringify({
        request: options
    }));
});

// Handle server-initiated external upload capture
onNet('cfx_capture:requestExternalUpload', (options: any, url: string) => {
    options.encoding = options.encoding || 'jpg';

    // Upload to server's proxy endpoint (server will forward to external provider)
    options.targetURL = `http://${GetCurrentServerEndpoint()}${url}`;
    options.targetField = 'file';
    options.resultURL = null;

    options.correlation = registerCorrelation(() => {});

    SendNuiMessage(JSON.stringify({
        request: options
    }));
});

// Handle external upload result from server
onNet('cfx_capture:externalUploadResult', (correlation: string, result: any) => {
    if (correlation && results[correlation]) {
        results[correlation].cb(JSON.stringify(result));
        delete results[correlation];
    }
});

// ============================================================================
// Backward Compatibility: screenshot_basic events
// ============================================================================

onNet('screenshot_basic:requestScreenshot', (options: any, url: string) => {
    options.encoding = options.encoding || 'jpg';

    options.targetURL = `http://${GetCurrentServerEndpoint()}${url}`;
    options.targetField = 'file';
    options.resultURL = null;

    options.correlation = registerCorrelation(() => {});

    SendNuiMessage(JSON.stringify({
        request: options
    }));
});

// ============================================================================
// Video Recording Event Handlers
// ============================================================================

// Server initiates recording
onNet('cfx_capture:startRecording', (options: {
    sessionId: string;
    token: string;
    maxDuration: number;
    recordingType: string;
    metadata?: any;
    targetPath: string;
    correlation: string;
}) => {
    // Construct full URL (same as screenshots)
    const targetURL = `http://${GetCurrentServerEndpoint()}${options.targetPath}`;

    // Forward to NUI with action type
    SendNuiMessage(JSON.stringify({
        action: 'startRecording',
        ...options,
        targetURL
    }));
});

// Server confirms recording completion
onNet('cfx_capture:recordingComplete', (data: {
    sessionId: string;
    filePath: string;
    uploadUrl?: string;
    metadata: any;
}) => {
    // Emit event for other resources to listen
    emit('cfx-capture:onRecordingComplete', data);
});
