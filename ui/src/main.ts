import {
    OrthographicCamera,
    Scene,
    WebGLRenderTarget,
    LinearFilter,
    NearestFilter,
    RGBAFormat,
    UnsignedByteType,
    CfxTexture,
    ShaderMaterial,
    PlaneBufferGeometry,
    Mesh,
    WebGLRenderer
} from '@citizenfx/three';

import { ScreenshotRequest, RecordingOptions, RecordingSession } from './types';
import { PerformanceMonitor, DynamicQualityAdjuster } from './performance-monitor';

// Security: Only allow uploads to internal server endpoints
function isInternalEndpoint(url: string): boolean {
    if (!url) {
        return false;
    }

    try {
        const parsed = new URL(url);
        const host = parsed.hostname.toLowerCase();

        // Allow localhost and 127.0.0.1 (internal NUI callbacks)
        if (host === 'localhost' || host === '127.0.0.1') {
            return true;
        }

        // Allow FiveM resource endpoints (format: http://resourceName/...)
        // These don't have a dot in the hostname and are handled by FiveM internally
        if (!host.includes('.') && !host.includes(':')) {
            return true;
        }

        // Allow server endpoint (IP:port format for server-side uploads)
        // Server endpoints typically look like http://IP:PORT/resource/...
        if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?$/.test(host) || /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(parsed.host)) {
            return true;
        }

        return false;
    } catch (e) {
        return false;
    }
}

function dataURItoBlob(dataURI: string) {
    const byteString = atob(dataURI.split(',')[1]);
    const mimeString = dataURI.split(',')[0].split(':')[1].split(';')[0];

    const ab = new ArrayBuffer(byteString.length);
    const ia = new Uint8Array(ab);

    for (let i = 0; i < byteString.length; i++) {
        ia[i] = byteString.charCodeAt(i);
    }

    const blob = new Blob([ab], { type: mimeString });
    return blob;
}

class ScreenshotUI {
    renderer: any;
    rtTexture: any;
    sceneRTT: any;
    cameraRTT: any;
    material: any;
    requestQueue: ScreenshotRequest[] = [];
    processing: boolean = false;
    canvas: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;
    readBuffer: Uint8Array;
    clamped: Uint8ClampedArray;
    imageData: ImageData;
    captureWidth: number = 0;
    captureHeight: number = 0;
    // Track frames rendered to ensure CfxTexture has valid game data before first capture.
    // The CfxTexture needs a few frames to receive game render data.
    frameCount: number = 0;
    static readonly MIN_FRAMES_BEFORE_CAPTURE = 3;

    // Recording management
    recordingSessions: Map<string, RecordingSession> = new Map();
    performanceMonitor: PerformanceMonitor = new PerformanceMonitor();
    qualityAdjuster: DynamicQualityAdjuster = new DynamicQualityAdjuster();
    recordingCanvas: HTMLCanvasElement | null = null;
    recordingCtx: CanvasRenderingContext2D | null = null;
    recordingFrameCount: number = 0;  // Separate counter for recording frame skipping
    // Recording buffers (same approach as screenshot capture)
    recordingRtTexture: any = null;
    recordingReadBuffer: Uint8Array | null = null;
    recordingImageData: ImageData | null = null;

    initialize() {
        window.addEventListener('message', event => {
            if (event.data && event.data.action === 'startRecording') {
                this.startRecording(event.data as RecordingOptions);
            } else if (event.data && event.data.action === 'stopRecording') {
                this.stopRecording(event.data.sessionId);
            } else if (event.data && event.data.request) {
                this.requestQueue.push(event.data.request as ScreenshotRequest);
            }
        });

        window.addEventListener('resize', () => {
            this.resize();
        });

        const cameraRTT: any = new OrthographicCamera(window.innerWidth / -2, window.innerWidth / 2, window.innerHeight / 2, window.innerHeight / -2, -10000, 10000);
        cameraRTT.position.z = 100;

        const sceneRTT: any = new Scene();

        const rtTexture = new WebGLRenderTarget(window.innerWidth, window.innerHeight, { minFilter: LinearFilter, magFilter: NearestFilter, format: RGBAFormat, type: UnsignedByteType });
        const gameTexture: any = new CfxTexture();
        gameTexture.needsUpdate = true;

        const material = new ShaderMaterial({
            uniforms: { "tDiffuse": { value: gameTexture } },
            vertexShader: `
            varying vec2 vUv;

            void main() {
                vUv = vec2(uv.x, 1.0-uv.y);
                gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
            }
            `,
            fragmentShader: `
            varying vec2 vUv;
            uniform sampler2D tDiffuse;

            void main() {
                gl_FragColor = texture2D( tDiffuse, vUv );
            }
            `
        });

        this.material = material;

        const plane = new PlaneBufferGeometry(window.innerWidth, window.innerHeight);
        const quad: any = new Mesh(plane, material);
        quad.position.z = -100;
        sceneRTT.add(quad);

        const renderer = new WebGLRenderer();
        renderer.setPixelRatio(window.devicePixelRatio);
        renderer.setSize(window.innerWidth, window.innerHeight);
        renderer.autoClear = false;

        document.getElementById('app').appendChild(renderer.domElement);
        document.getElementById('app').style.display = 'none';

        this.renderer = renderer;
        this.rtTexture = rtTexture;
        this.sceneRTT = sceneRTT;
        this.cameraRTT = cameraRTT;

        this.animate = this.animate.bind(this);
        requestAnimationFrame(this.animate);
    }

    resize() {
        const cameraRTT: any = new OrthographicCamera(window.innerWidth / -2, window.innerWidth / 2, window.innerHeight / 2, window.innerHeight / -2, -10000, 10000);
        cameraRTT.position.z = 100;

        this.cameraRTT = cameraRTT;

        const sceneRTT: any = new Scene();
        const plane = new PlaneBufferGeometry(window.innerWidth, window.innerHeight);
        const quad: any = new Mesh(plane, this.material);
        quad.position.z = -100;
        sceneRTT.add(quad);

        this.sceneRTT = sceneRTT;

        this.renderer.setSize(window.innerWidth, window.innerHeight);
    }

    animate() {
        requestAnimationFrame(this.animate);

        this.renderer.clear();
        this.renderer.render(this.sceneRTT, this.cameraRTT, this.rtTexture, true);

        // Track frames rendered to ensure CfxTexture has valid game data.
        // The CfxTexture needs a few frames to receive actual game render data,
        // otherwise the first screenshot would be black.
        if (this.frameCount < ScreenshotUI.MIN_FRAMES_BEFORE_CAPTURE) {
            this.frameCount++;
            return; // Don't process requests until we have valid game frames
        }

        // Update recording canvas if any recording is active
        this.updateRecordingCanvas();

        if (!this.processing && this.requestQueue.length > 0) {
            const request = this.requestQueue.shift();
            if (request) {
                this.processing = true;
                this.handleRequest(request)
                    .catch(() => {
                        // swallow to keep queue moving
                    })
                    .finally(() => {
                        this.processing = false;
                    });
            }
        }
    }

    /**
     * Calculate adaptive quality based on image dimensions.
     * Higher resolutions get lower quality to prevent oversized files and improve performance.
     */
    getAdaptiveQuality(width: number, height: number, requestedQuality: number): number {
        const pixels = width * height;

        // Adaptive quality thresholds based on pixel count
        // This prevents large images from being too slow/large while keeping small images sharp
        let maxQuality: number;
        if (pixels > 2_000_000) {
            // >2M pixels (e.g., 1920x1080 = 2.07M) - cap at 0.7
            maxQuality = 0.7;
        } else if (pixels > 1_400_000) {
            // >1.4M pixels (e.g., 1400x1000) - cap at 0.8
            maxQuality = 0.8;
        } else if (pixels > 800_000) {
            // >800K pixels (e.g., 1280x720 = 921K) - cap at 0.85
            maxQuality = 0.85;
        } else {
            // Smaller images can use full quality
            maxQuality = 1.0;
        }

        return Math.min(requestedQuality, maxQuality);
    }

    encodeImage(canvas: HTMLCanvasElement, request: ScreenshotRequest) {
        let type = 'image/png';

        switch (request.encoding) {
            case 'jpg':
                type = 'image/jpeg';
                break;
            case 'png':
                type = 'image/png';
                break;
            case 'webp':
                type = 'image/webp';
                break;
        }

        // Apply adaptive quality based on resolution (only for lossy formats)
        let quality = request.quality || 0.92;
        if (type === 'image/jpeg' || type === 'image/webp') {
            quality = this.getAdaptiveQuality(canvas.width, canvas.height, quality);
        }

        let imageURL = canvas.toDataURL(type, quality);
        let blob = dataURItoBlob(imageURL);

        // Further reduce quality if still over size limit
        if (request.maxSizeBytes && blob.size > request.maxSizeBytes && (type === 'image/jpeg' || type === 'image/webp')) {
            while (blob.size > request.maxSizeBytes && quality > 0.4) {
                quality = Math.max(0.4, quality - 0.1);
                imageURL = canvas.toDataURL(type, quality);
                blob = dataURItoBlob(imageURL);
            }
        }

        const base64 = imageURL.split(',')[1] || '';
        return { imageURL, blob, type, base64, appliedQuality: quality };
    }

    async handleRequest(request: ScreenshotRequest) {
        // Security: Block direct uploads to external endpoints
        // All external uploads must go through the server proxy
        if (request.targetURL && request.targetField && !isInternalEndpoint(request.targetURL)) {
            console.error('[cfx-capture] Blocked external upload attempt to:', request.targetURL);
            const errorPayload = JSON.stringify({
                success: false,
                error: 'external_upload_blocked',
                message: 'Direct external uploads are not allowed. Use server proxy instead.',
                targetURL: request.targetURL
            });

            if (request.resultURL) {
                try {
                    await fetch(request.resultURL, {
                        method: 'POST',
                        mode: 'cors',
                        body: JSON.stringify({
                            data: errorPayload,
                            id: request.correlation
                        })
                    });
                } catch (e) {
                    // Ignore callback errors
                }
            }
            return;
        }

        const width = request.width || window.innerWidth;
        const height = request.height || window.innerHeight;

        this.ensureCaptureBuffers(width, height);

        // CRITICAL: Render to the render target BEFORE reading pixels.
        // This ensures the game texture is captured into the (possibly new) render target.
        // Without this, the first screenshot would be black because ensureCaptureBuffers()
        // may have created a new render target that hasn't been rendered to yet.
        this.renderer.clear();
        this.renderer.render(this.sceneRTT, this.cameraRTT, this.rtTexture, true);

        this.renderer.readRenderTargetPixels(this.rtTexture, 0, 0, width, height, this.readBuffer);
        this.imageData.data.set(this.clamped);
        this.ctx.putImageData(this.imageData, 0, 0);

        const encoded = this.encodeImage(this.canvas, request);
        const imageURL = encoded.imageURL;
        const base64 = encoded.base64;

        const getFormData = () => {
            const formData = new FormData();
            if (request.formFields) {
                Object.keys(request.formFields).forEach((key) => {
                    formData.append(key, request.formFields[key]);
                });
            }
            const fileName = request.uploadFileName || `screenshot.${request.encoding}`;
            formData.append(request.targetField, dataURItoBlob(imageURL), fileName);
            return formData;
        };

        try {
            const headers = request.headers ? { ...request.headers } : undefined;
            if (headers) {
                Object.keys(headers).forEach((key) => {
                    if (key.toLowerCase() === 'content-type' && request.targetField) {
                        delete headers[key];
                    }
                });
            }

            const response = await fetch(request.targetURL, {
                method: 'POST',
                mode: 'cors',
                headers,
                body: (request.targetField) ? getFormData() : JSON.stringify({
                    data: request.returnBlob ? {
                        blob: true,
                        mime: encoded.type,
                        base64
                    } : imageURL,
                    id: request.correlation
                })
            });

            const text = await response.text();
            if (request.resultURL) {
                await fetch(request.resultURL, {
                    method: 'POST',
                    mode: 'cors',
                    body: JSON.stringify({
                        data: text,
                        id: request.correlation
                    })
                });
            }
        } catch (e) {
            // Always invoke the callback with error details so the caller knows what happened.
            // Include error message for debugging (e.g., CORS issues, network errors).
            const errorMsg = (e instanceof Error) ? e.message : 'upload_failed';
            const errorPayload = JSON.stringify({
                success: false,
                error: 'upload_failed',
                message: errorMsg,
                targetURL: request.targetURL
            });

            if (request.resultURL) {
                try {
                    await fetch(request.resultURL, {
                        method: 'POST',
                        mode: 'cors',
                        body: JSON.stringify({
                            data: errorPayload,
                            id: request.correlation
                        })
                    });
                } catch (resultFetchError) {
                    // If even the result callback fails, log to console for debugging
                    console.error('[cfx-capture] Failed to send error callback:', resultFetchError);
                }
            }
        }
    }

    ensureCaptureBuffers(width: number, height: number) {
        if (this.captureWidth === width && this.captureHeight === height) {
            return;
        }

        this.captureWidth = width;
        this.captureHeight = height;

        if (this.rtTexture && this.rtTexture.dispose) {
            this.rtTexture.dispose();
        }
        this.rtTexture = new WebGLRenderTarget(width, height, { minFilter: LinearFilter, magFilter: NearestFilter, format: RGBAFormat, type: UnsignedByteType });

        this.readBuffer = new Uint8Array(width * height * 4);
        this.clamped = new Uint8ClampedArray(this.readBuffer.buffer);

        this.canvas = document.createElement('canvas');
        this.canvas.style.display = 'inline';
        this.canvas.width = width;
        this.canvas.height = height;
        this.ctx = this.canvas.getContext('2d');
        this.imageData = this.ctx.createImageData(width, height);
    }

    // ========================================================================
    // VIDEO RECORDING METHODS
    // ========================================================================

    startRecording(options: RecordingOptions) {
        console.log('[CFX-Capture] Starting recording:', options.sessionId);

        // Validate session doesn't exist
        if (this.recordingSessions.has(options.sessionId)) {
            console.error('[CFX-Capture] Recording session already exists:', options.sessionId);
            return;
        }

        // Wait for game frames before starting
        if (this.frameCount < ScreenshotUI.MIN_FRAMES_BEFORE_CAPTURE) {
            console.log('[CFX-Capture] Waiting for game frames before starting recording...');
            setTimeout(() => this.startRecording(options), 100);
            return;
        }

        try {
            // Recording resolution - PERFORMANCE preset (720p for minimal FPS impact)
            const recWidth = 1280;
            const recHeight = 720;

            // Create or resize recording canvas
            if (!this.recordingCanvas || this.recordingCanvas.width !== recWidth) {
                this.recordingCanvas = document.createElement('canvas');
                this.recordingCanvas.width = recWidth;
                this.recordingCanvas.height = recHeight;
                this.recordingCtx = this.recordingCanvas.getContext('2d');
                console.log(`[CFX-Capture] Recording canvas: ${recWidth}x${recHeight}`);
            }

            // Create recording render target and buffers (same approach as screenshots!)
            // This is CRITICAL - we must read from rtTexture, not renderer.domElement
            this.recordingRtTexture = new WebGLRenderTarget(recWidth, recHeight, {
                minFilter: LinearFilter,
                magFilter: NearestFilter,
                format: RGBAFormat,
                type: UnsignedByteType
            });
            this.recordingReadBuffer = new Uint8Array(recWidth * recHeight * 4);
            this.recordingImageData = this.recordingCtx.createImageData(recWidth, recHeight);

            // Draw initial frame to canvas BEFORE starting recording
            this.captureFrameToRecordingCanvas();
            console.log('[CFX-Capture] Initial frame captured to recording canvas');

            // PERFORMANCE preset - minimal FPS impact, good quality
            const targetFPS = 24;  // 24fps = cinematic, less CPU load
            const initialBitrate = 4000000;  // 4 Mbps (sharp quality at 720p)

            const resolution = {
                width: recWidth,
                height: recHeight
            };

            // Create MediaStream from recording canvas
            const mediaStream = this.recordingCanvas.captureStream(targetFPS);

            // Prefer VP8 for better performance (VP9 is slower but smaller)
            // H264 has best hardware support but not available in WebM
            let mimeType = 'video/webm;codecs=vp8';
            if (!MediaRecorder.isTypeSupported(mimeType)) {
                mimeType = 'video/webm;codecs=vp9';
                if (!MediaRecorder.isTypeSupported(mimeType)) {
                    mimeType = 'video/webm';  // Let browser choose
                }
            }

            console.log('[CFX-Capture] Using codec:', mimeType);

            // Create MediaRecorder with optimized settings
            const recorderOptions: any = {
                mimeType,
                videoBitsPerSecond: initialBitrate,
                // Hint to browser to prefer speed over compression
                bitsPerSecond: initialBitrate
            };

            const mediaRecorder = new MediaRecorder(mediaStream, recorderOptions);
            const chunks: Blob[] = [];

            // Create session
            const session: RecordingSession = {
                sessionId: options.sessionId,
                startTime: Date.now(),
                frameCount: 0,
                targetFPS,
                currentFPS: 60,
                resolution,
                bitrate: initialBitrate,
                mediaStream,
                mediaRecorder,
                chunks,
                isRecording: true,
                status: 'recording',
                performanceMetrics: {
                    fpsDrops: 0,
                    avgEncodingTime: 0,
                    peakMemory: 0
                },
                token: options.token,
                targetURL: options.targetURL,
                correlation: options.correlation
            };

            // Set up MediaRecorder event handlers
            mediaRecorder.ondataavailable = (event) => {
                if (event.data.size > 0) {
                    const chunkStart = performance.now();
                    session.chunks.push(event.data);
                    const chunkTime = performance.now() - chunkStart;
                    this.performanceMonitor.trackEncodingTime(chunkTime);

                    console.log(`[CFX-Capture] Chunk received: ${(event.data.size / 1024).toFixed(2)} KB`);
                }
            };

            mediaRecorder.onstop = () => {
                console.log('[CFX-Capture] MediaRecorder stopped');
                this.finalizeRecording(options.sessionId, false);
            };

            mediaRecorder.onerror = (error: any) => {
                console.error('[CFX-Capture] MediaRecorder error:', error);
                session.status = 'partial';
                this.finalizeRecording(options.sessionId, true);
            };

            // Start recording with 2 second timeslice (less encoding overhead)
            mediaRecorder.start(2000);

            // Set up max duration timer
            const maxDurationTimer = window.setTimeout(() => {
                console.log('[CFX-Capture] Max duration reached, stopping recording');
                this.stopRecording(options.sessionId);
            }, options.maxDuration);

            session.maxDurationTimer = maxDurationTimer;

            // Store session
            this.recordingSessions.set(options.sessionId, session);

            // Reset performance monitor for this session
            this.performanceMonitor.reset();

            console.log(`[CFX-Capture] Recording started: ${resolution.width}x${resolution.height} @ ${targetFPS}fps, ${(initialBitrate / 1000000).toFixed(1)} Mbps`);
        } catch (error) {
            console.error('[CFX-Capture] Failed to start recording:', error);
        }
    }

    stopRecording(sessionId: string) {
        const session = this.recordingSessions.get(sessionId);
        if (!session) {
            console.error('[CFX-Capture] Recording session not found:', sessionId);
            return;
        }

        console.log('[CFX-Capture] Stopping recording:', sessionId);

        try {
            // Clear max duration timer
            if (session.maxDurationTimer) {
                clearTimeout(session.maxDurationTimer);
            }

            // Stop MediaRecorder (will trigger onstop event)
            if (session.mediaRecorder && session.mediaRecorder.state !== 'inactive') {
                session.mediaRecorder.stop();
            }

            // Stop media stream tracks
            if (session.mediaStream) {
                session.mediaStream.getTracks().forEach(track => track.stop());
            }

            session.isRecording = false;
            session.status = 'encoding';
        } catch (error) {
            console.error('[CFX-Capture] Error stopping recording:', error);
            session.status = 'failed';
            this.finalizeRecording(sessionId, true);
        }
    }

    async finalizeRecording(sessionId: string, isPartial: boolean) {
        const session = this.recordingSessions.get(sessionId);
        if (!session) {
            console.error('[CFX-Capture] Session not found for finalization:', sessionId);
            return;
        }

        console.log(`[CFX-Capture] Finalizing recording: ${sessionId} (partial: ${isPartial})`);

        try {
            // Create final blob from chunks
            const mimeType = session.mediaRecorder?.mimeType || 'video/webm';
            const completeBlob = new Blob(session.chunks, { type: mimeType });

            console.log(`[CFX-Capture] Recording blob created: ${(completeBlob.size / 1024 / 1024).toFixed(2)} MB`);

            // Update session status
            session.status = isPartial ? 'partial' : 'complete';

            // Get performance metrics
            const metrics = this.performanceMonitor.getMetrics();
            session.performanceMetrics.avgEncodingTime = metrics.avgEncodingTime;
            session.performanceMetrics.fpsDrops = metrics.fpsDrops;

            // Upload to server
            await this.uploadRecording(session, completeBlob, isPartial);

            // Clean up
            this.recordingSessions.delete(sessionId);
            this.performanceMonitor.reset();

            // Clean up recording resources if no more active recordings
            if (this.recordingSessions.size === 0) {
                this.cleanupRecordingResources();
            }

            console.log('[CFX-Capture] Recording finalized successfully');
        } catch (error) {
            console.error('[CFX-Capture] Error finalizing recording:', error);
            session.status = 'failed';
            this.recordingSessions.delete(sessionId);

            // Clean up recording resources if no more active recordings
            if (this.recordingSessions.size === 0) {
                this.cleanupRecordingResources();
            }
        }
    }

    async uploadRecording(session: RecordingSession, blob: Blob, isPartial: boolean) {
        try {
            // Create form data
            const formData = new FormData();
            formData.append('recording', blob, `${session.sessionId}.webm`);
            formData.append('sessionId', session.sessionId);
            formData.append('partial', String(isPartial));

            // Add performance metrics
            formData.append('performanceMetrics', JSON.stringify({
                avgEncodingTime: session.performanceMetrics.avgEncodingTime,
                fpsDrops: session.performanceMetrics.fpsDrops,
                duration: Date.now() - session.startTime,
                finalFPS: session.currentFPS
            }));

            console.log('[CFX-Capture] Uploading recording to:', session.targetURL);
            console.log('[CFX-Capture] Blob size:', blob.size, 'bytes');

            // Upload to server - use same approach as screenshot uploads
            const response = await fetch(session.targetURL, {
                method: 'POST',
                body: formData
            });

            const text = await response.text();
            console.log('[CFX-Capture] Server response:', response.status, text);

            if (!response.ok) {
                throw new Error(`Upload failed: ${response.status} - ${text}`);
            }

            console.log('[CFX-Capture] Upload successful');
        } catch (error) {
            console.error('[CFX-Capture] Upload failed:', error);
            // Don't throw - let the recording save locally at least
            console.log('[CFX-Capture] Recording data is still in memory, size:', blob.size);
        }
    }

    // Capture a single frame from the game to the recording canvas
    // Uses the same method as screenshots - reading from WebGLRenderTarget
    captureFrameToRecordingCanvas() {
        if (!this.recordingCanvas || !this.recordingCtx || !this.recordingRtTexture ||
            !this.recordingReadBuffer || !this.recordingImageData) {
            return;
        }

        const width = this.recordingCanvas.width;
        const height = this.recordingCanvas.height;

        // Render the scene to our recording render target (same as screenshot!)
        this.renderer.clear();
        this.renderer.render(this.sceneRTT, this.cameraRTT, this.recordingRtTexture, true);

        // Read pixels from render target
        this.renderer.readRenderTargetPixels(this.recordingRtTexture, 0, 0, width, height, this.recordingReadBuffer);

        // Copy to ImageData (readRenderTargetPixels returns RGBA)
        this.recordingImageData.data.set(new Uint8ClampedArray(this.recordingReadBuffer.buffer));

        // Put the image data onto the recording canvas
        this.recordingCtx.putImageData(this.recordingImageData, 0, 0);
    }

    updateRecordingCanvas() {
        // Update recording canvas with current game frame
        // This is called from the animate loop when a recording is active
        if (this.recordingSessions.size === 0 || !this.recordingCanvas) {
            return;
        }

        // OPTIMIZATION: Only update canvas every 2 frames (reduces CPU load by 50%)
        // At 60fps game, this gives us 30fps recording which is more than enough
        this.recordingFrameCount++;
        if (this.recordingFrameCount % 2 !== 0) {
            return;
        }

        // Capture game frame using the same method as screenshots
        this.captureFrameToRecordingCanvas();

        // Track performance for all active sessions (but don't check every frame)
        if (this.recordingFrameCount % 60 === 0) {  // Check every 60 frames (~1 second)
            this.performanceMonitor.trackFrame();
            const currentFPS = this.performanceMonitor.getCurrentFPS();

            // Check if quality adjustment is needed for any session
            this.recordingSessions.forEach((session) => {
                if (session.isRecording) {
                    session.currentFPS = currentFPS;
                    session.frameCount++;
                }
            });
        }
    }

    // Cleanup recording resources
    cleanupRecordingResources() {
        if (this.recordingRtTexture && this.recordingRtTexture.dispose) {
            this.recordingRtTexture.dispose();
        }
        this.recordingRtTexture = null;
        this.recordingReadBuffer = null;
        this.recordingImageData = null;
    }
}

const ui = new ScreenshotUI();
ui.initialize();
