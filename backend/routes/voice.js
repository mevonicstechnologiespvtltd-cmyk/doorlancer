const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { speechToText, generateDoorResponse, textToSpeech, convertToPcm } = require('../services/voiceService');
const { getDb } = require('../config/firebase');

// Cached welcome audio path
let cachedWelcomeUrl = null;
let cachedWelcomePcmUrl = null;

/**
 * GET /api/voice/welcome
 * Returns a cached welcome greeting audio URL (PCM for ESP32 raw I2S playback).
 */
router.get('/welcome', async (req, res) => {
    try {
        // Check if cached PCM file still exists
        if (cachedWelcomePcmUrl) {
            const filePath = path.join(__dirname, '..', cachedWelcomePcmUrl);
            if (fs.existsSync(filePath)) {
                return res.json({ audioUrl: cachedWelcomeUrl, pcmUrl: cachedWelcomePcmUrl });
            }
            cachedWelcomePcmUrl = null;
            cachedWelcomeUrl = null;
        }

        // Generate welcome TTS (MP3) then convert to PCM
        console.log('[Voice] Generating welcome audio...');
        const welcomeText = 'Welcome to Doorlance! How can I help you today?';
        const audioUrl = await textToSpeech(welcomeText);
        cachedWelcomeUrl = audioUrl;

        // Convert to raw PCM for ESP32
        const mp3Path = path.join(__dirname, '..', audioUrl);
        const pcmPath = convertToPcm(mp3Path);
        let pcmUrl = null;
        if (pcmPath) {
            pcmUrl = audioUrl.replace(/\.(mp3|wav)$/i, '.pcm');
            cachedWelcomePcmUrl = pcmUrl;
        }

        console.log(`[Voice] Welcome cached: mp3=${audioUrl}, pcm=${pcmUrl}`);
        res.json({ audioUrl, pcmUrl });
    } catch (err) {
        console.error('[Voice] Welcome TTS error:', err);
        res.status(500).json({ error: 'Failed to generate welcome audio' });
    }
});

/**
 * POST /api/voice/doorbell
 * ESP32 sends recorded audio after doorbell press.
 * Flow: STT → AI response → TTS → return audio URL
 * Body: raw WAV audio (application/octet-stream or audio/wav)
 * Query: machineId
 */
router.post('/doorbell', express.raw({ type: ['audio/wav', 'application/octet-stream'], limit: '500kb' }), async (req, res) => {
    const machineId = req.query.machineId;
    if (!machineId) {
        return res.status(400).json({ error: 'machineId required' });
    }

    console.log(`[Voice] Doorbell audio received: ${req.body.length} bytes from ${machineId}`);

    let transcript = '';
    let visitorType = 'unknown';
    let visitorName = null;
    let responseText = '';
    let audioUrl = '';
    let pcmUrl = null;

    try {
        // 1. Speech-to-Text
        console.log('[Voice] Running STT...');
        try {
            transcript = await speechToText(req.body);
            console.log(`[Voice] Transcript: "${transcript}"`);
        } catch (sttErr) {
            console.error('[Voice] STT failed:', sttErr.message);
            transcript = '';
        }

        // 2. Try camera capture + face recognition (non-blocking, don't fail if unavailable)
        try {
            const db = getDb();
            const machineDoc = await db.collection('machines').doc(machineId).get();
            if (machineDoc.exists) {
                const machineData = machineDoc.data();
                if (machineData.captureUrl && machineData.espcamStatus === 'online') {
                    const fetch = (await import('node-fetch')).default;
                    const camResponse = await fetch(machineData.captureUrl, { timeout: 5000 });
                    if (camResponse.ok) {
                        const imageBuffer = await camResponse.buffer();
                        const base64Image = imageBuffer.toString('base64');

                        const { detectHuman, matchFace } = require('../services/groqService');
                        const humanResult = await detectHuman(base64Image);

                        if (humanResult.isHuman) {
                            // Check family members
                            const familySnapshot = await db.collection('machines')
                                .doc(machineId).collection('family').get();

                            if (!familySnapshot.empty) {
                                const fs = require('fs');
                                const path = require('path');
                                const familyMembers = [];
                                for (const doc of familySnapshot.docs) {
                                    const data = doc.data();
                                    if (data.imagePath) {
                                        try {
                                            const localPath = path.join(__dirname, '..', data.imagePath);
                                            const buf = fs.readFileSync(localPath);
                                            familyMembers.push({ name: data.name, imageBase64: buf.toString('base64') });
                                        } catch (e) { /* skip */ }
                                    }
                                }

                                if (familyMembers.length > 0) {
                                    const matchResult = await matchFace(base64Image, familyMembers);
                                    if (matchResult.isMatch && matchResult.confidence !== 'low') {
                                        visitorType = 'family';
                                        visitorName = matchResult.matchedName;
                                    }
                                }
                            }
                        }
                    }
                }
            }
        } catch (camErr) {
            console.log('[Voice] Camera/face recognition skipped:', camErr.message);
        }

        // 3. Generate AI response
        console.log(`[Voice] Generating AI response (visitor: ${visitorType})...`);
        responseText = await generateDoorResponse(transcript, visitorType, visitorName);
        console.log(`[Voice] AI: "${responseText}"`);

        // 4. Text-to-Speech
        console.log('[Voice] Generating TTS...');
        audioUrl = await textToSpeech(responseText);
        console.log(`[Voice] TTS audio: ${audioUrl}`);

        // 4b. Convert to raw PCM for ESP32
        const mp3Path = path.join(__dirname, '..', audioUrl);
        const pcmPath = convertToPcm(mp3Path);
        if (pcmPath) {
            pcmUrl = audioUrl.replace(/\.(mp3|wav)$/i, '.pcm');
            console.log(`[Voice] PCM: ${pcmUrl}`);
        }

        // 5. Store notification
        try {
            const { storeNotification, sendPushNotification } = require('../services/notificationService');
            const title = transcript
                ? `🗣️ Visitor: "${transcript.substring(0, 50)}${transcript.length > 50 ? '...' : ''}"`
                : '🔔 Doorbell pressed';
            const body = `AI responded: "${responseText}"`;

            await storeNotification(machineId, machineId, 'doorbell_voice', title, body, null);
            await sendPushNotification(machineId, title, body, {
                type: 'doorbell_voice',
                machineId,
                transcript,
                response: responseText,
            });
        } catch (notifErr) {
            console.error('[Voice] Notification error:', notifErr.message);
        }

        // 6. Broadcast to connected apps
        try {
            const { broadcastToApps } = require('../services/websocketService');
            broadcastToApps(machineId, {
                type: 'doorbell_voice',
                machineId,
                transcript,
                response: responseText,
                visitorType,
                visitorName,
                audioUrl,
                timestamp: new Date().toISOString(),
            });
        } catch (wsErr) {
            console.error('[Voice] WS broadcast error:', wsErr.message);
        }

    } catch (err) {
        console.error('[Voice] Processing error:', err);
        // Generate a fallback response
        responseText = 'Hello, the homeowner has been notified of your visit.';
        try {
            audioUrl = await textToSpeech(responseText);
        } catch (ttsErr) {
            return res.status(500).json({ error: 'Voice processing failed' });
        }
    }

    res.json({ transcript, response: responseText, audioUrl, pcmUrl: pcmUrl || null, visitorType, visitorName });
});

/**
 * POST /api/voice/doorbell-text
 * ESP32 sends transcript text (from Deepgram STT on device).
 * Flow: AI response → TTS → return PCM URL
 * Body: { text, machineId }
 */
router.post('/doorbell-text', express.json(), async (req, res) => {
    const { text, machineId } = req.body;
    if (!machineId) {
        return res.status(400).json({ error: 'machineId required' });
    }

    const transcript = text || '';
    console.log(`[Voice] Doorbell text from ${machineId}: "${transcript}"`);

    let visitorType = 'unknown';
    let visitorName = null;
    let responseText = '';
    let audioUrl = '';
    let pcmUrl = null;

    // 0. Check auto-response setting
    let autoResponse = true;
    try {
        const db = getDb();
        const machineDoc = await db.collection('machines').doc(machineId).get();
        if (machineDoc.exists) {
            const md = machineDoc.data() || {};
            autoResponse = md.autoResponse !== false; // default true
        }
    } catch (e) {
        console.log('[Voice] Could not read autoResponse setting, defaulting to true');
    }

    // === Manual mode: notify owner, do NOT generate AI reply, do NOT play on speaker ===
    if (!autoResponse) {
        console.log(`[Voice] Auto-response OFF — waiting for owner to reply manually`);

        // Store notification (high-priority "needs reply")
        try {
            const { storeNotification, sendPushNotification } = require('../services/notificationService');
            const title = transcript
                ? `🗣️ Visitor (awaiting reply): "${transcript.substring(0, 50)}${transcript.length > 50 ? '...' : ''}"`
                : '🔔 Doorbell pressed (awaiting your reply)';
            const body = 'Tap to reply from the Live Camera screen.';
            await storeNotification(machineId, machineId, 'doorbell_awaiting_owner', title, body, null);
            await sendPushNotification(machineId, title, body, {
                type: 'doorbell_awaiting_owner',
                machineId,
                transcript,
            });
        } catch (notifErr) {
            console.error('[Voice] Notification error:', notifErr.message);
        }

        // Broadcast to apps so the camera screen can show "Visitor is waiting"
        try {
            const { broadcastToApps } = require('../services/websocketService');
            broadcastToApps(machineId, {
                type: 'doorbell_awaiting_owner',
                machineId,
                transcript,
                timestamp: new Date().toISOString(),
            });
        } catch (wsErr) {
            console.error('[Voice] WS broadcast error:', wsErr.message);
        }

        // Tell ESP32: no audio reply right now — owner will respond
        return res.json({
            transcript,
            response: '',
            audioUrl: '',
            pcmUrl: null,
            visitorType,
            visitorName,
            autoResponse: false,
            awaitingOwner: true,
        });
    }

    try {
        // 1. Try camera capture + face recognition (non-blocking)
        try {
            const db = getDb();
            const machineDoc = await db.collection('machines').doc(machineId).get();
            if (machineDoc.exists) {
                const machineData = machineDoc.data();
                if (machineData.captureUrl && machineData.espcamStatus === 'online') {
                    const fetch = (await import('node-fetch')).default;
                    const camResponse = await fetch(machineData.captureUrl, { timeout: 5000 });
                    if (camResponse.ok) {
                        const imageBuffer = await camResponse.buffer();
                        const base64Image = imageBuffer.toString('base64');

                        const { detectHuman, matchFace } = require('../services/groqService');
                        const humanResult = await detectHuman(base64Image);

                        if (humanResult.isHuman) {
                            const familySnapshot = await db.collection('machines')
                                .doc(machineId).collection('family').get();

                            if (!familySnapshot.empty) {
                                const familyMembers = [];
                                for (const doc of familySnapshot.docs) {
                                    const data = doc.data();
                                    if (data.imagePath) {
                                        try {
                                            const localPath = path.join(__dirname, '..', data.imagePath);
                                            const buf = fs.readFileSync(localPath);
                                            familyMembers.push({ name: data.name, imageBase64: buf.toString('base64') });
                                        } catch (e) { /* skip */ }
                                    }
                                }

                                if (familyMembers.length > 0) {
                                    const matchResult = await matchFace(base64Image, familyMembers);
                                    if (matchResult.isMatch && matchResult.confidence !== 'low') {
                                        visitorType = 'family';
                                        visitorName = matchResult.matchedName;
                                    }
                                }
                            }
                        }
                    }
                }
            }
        } catch (camErr) {
            console.log('[Voice] Camera/face recognition skipped:', camErr.message);
        }

        // 2. Generate AI response
        console.log(`[Voice] Generating AI response (visitor: ${visitorType})...`);
        responseText = await generateDoorResponse(transcript, visitorType, visitorName);
        console.log(`[Voice] AI: "${responseText}"`);

        // 3. Text-to-Speech
        console.log('[Voice] Generating TTS...');
        audioUrl = await textToSpeech(responseText);
        console.log(`[Voice] TTS audio: ${audioUrl}`);

        // 3b. Convert to raw PCM for ESP32
        const mp3Path = path.join(__dirname, '..', audioUrl);
        const pcmPath = convertToPcm(mp3Path);
        if (pcmPath) {
            pcmUrl = audioUrl.replace(/\.(mp3|wav)$/i, '.pcm');
            console.log(`[Voice] PCM: ${pcmUrl}`);
        }

        // 4. Store notification
        try {
            const { storeNotification, sendPushNotification } = require('../services/notificationService');
            const title = transcript
                ? `🗣️ Visitor: "${transcript.substring(0, 50)}${transcript.length > 50 ? '...' : ''}"`
                : '🔔 Doorbell pressed';
            const body = `AI responded: "${responseText}"`;

            await storeNotification(machineId, machineId, 'doorbell_voice', title, body, null);
            await sendPushNotification(machineId, title, body, {
                type: 'doorbell_voice',
                machineId,
                transcript,
                response: responseText,
            });
        } catch (notifErr) {
            console.error('[Voice] Notification error:', notifErr.message);
        }

        // 5. Broadcast to connected apps
        try {
            const { broadcastToApps } = require('../services/websocketService');
            broadcastToApps(machineId, {
                type: 'doorbell_voice',
                machineId,
                transcript,
                response: responseText,
                visitorType,
                visitorName,
                audioUrl,
                timestamp: new Date().toISOString(),
            });
        } catch (wsErr) {
            console.error('[Voice] WS broadcast error:', wsErr.message);
        }

    } catch (err) {
        console.error('[Voice] Processing error:', err);
        responseText = 'Hello, the homeowner has been notified of your visit.';
        try {
            audioUrl = await textToSpeech(responseText);
            const mp3Path = path.join(__dirname, '..', audioUrl);
            const pcmPath = convertToPcm(mp3Path);
            if (pcmPath) {
                pcmUrl = audioUrl.replace(/\.(mp3|wav)$/i, '.pcm');
            }
        } catch (ttsErr) {
            return res.status(500).json({ error: 'Voice processing failed' });
        }
    }

    res.json({ transcript, response: responseText, audioUrl, pcmUrl: pcmUrl || null, visitorType, visitorName });
});

/**
 * POST /api/voice/owner-say
 * Owner sends a text message to be spoken through the door speaker.
 * Body: { machineId, message }
 */
router.post('/owner-say', async (req, res) => {
    const { machineId, message } = req.body;
    if (!machineId || !message) {
        return res.status(400).json({ error: 'machineId and message required' });
    }

    console.log(`[Voice] Owner message for ${machineId}: "${message}"`);

    try {
        // Generate TTS (MP3)
        const audioUrl = await textToSpeech(message);

        // Convert to raw PCM for ESP32 speaker (ESP32 I2S requires raw PCM, NOT MP3)
        const mp3Path = path.join(__dirname, '..', audioUrl);
        const pcmPath = convertToPcm(mp3Path);
        if (!pcmPath) {
            console.error('[Voice] PCM conversion failed — cannot send MP3 to ESP32');
            return res.status(500).json({ error: 'Audio conversion failed. TTS generated but could not convert to PCM for speaker.' });
        }
        const pcmUrl = audioUrl.replace(/\.(mp3|wav)$/i, '.pcm');

        // Send play command to ESP32 via WebSocket
        const { sendCommandToDevice } = require('../services/websocketService');
        const sent = sendCommandToDevice(machineId, 'esp32_controller', {
            command: 'play_audio',
            url: pcmUrl,
        });

        if (!sent) {
            return res.status(503).json({ error: 'ESP32 not connected' });
        }

        res.json({ success: true, audioUrl, pcmUrl, message: 'Message sent to door speaker' });
    } catch (err) {
        console.error('[Voice] Owner say error:', err);
        res.status(500).json({ error: 'Failed to generate or send audio' });
    }
});

/**
 * POST /api/voice/owner-audio
 * Owner sends a voice recording to be played through the door speaker.
 * Body: multipart form with 'audio' file field and 'machineId' field
 */
const multer = require('multer');
const voiceUpload = multer({
    dest: path.join(__dirname, '..', 'uploads', 'tts'),
    limits: { fileSize: 2 * 1024 * 1024 },  // 2MB max
});

router.post('/owner-audio', voiceUpload.single('audio'), async (req, res) => {
    const machineId = req.body.machineId;
    if (!machineId || !req.file) {
        return res.status(400).json({ error: 'machineId and audio file required' });
    }

    console.log(`[Voice] Owner audio received: ${req.file.size} bytes, ${req.file.mimetype}`);

    try {
        // Rename uploaded file with proper extension
        const ext = req.file.mimetype.includes('wav') ? '.wav'
            : req.file.mimetype.includes('webm') ? '.webm'
            : req.file.mimetype.includes('mp4') ? '.m4a'
            : '.audio';
        const audioFilename = `owner_${Date.now()}${ext}`;
        const audioPath = path.join(__dirname, '..', 'uploads', 'tts', audioFilename);
        fs.renameSync(req.file.path, audioPath);

        // Convert to raw PCM for ESP32
        const pcmPath = convertToPcm(audioPath);
        if (!pcmPath) {
            return res.status(500).json({ error: 'Failed to convert audio to PCM' });
        }

        const pcmUrl = `/uploads/tts/${audioFilename.replace(/\.[^.]+$/, '.pcm')}`;

        // Send to ESP32
        const { sendCommandToDevice } = require('../services/websocketService');
        const sent = sendCommandToDevice(machineId, 'esp32_controller', {
            command: 'play_audio',
            url: pcmUrl,
        });

        if (!sent) {
            return res.status(503).json({ error: 'ESP32 not connected' });
        }

        res.json({ success: true, message: 'Voice message sent to door speaker' });
    } catch (err) {
        console.error('[Voice] Owner audio error:', err);
        res.status(500).json({ error: 'Failed to process audio' });
    }
});

module.exports = router;
