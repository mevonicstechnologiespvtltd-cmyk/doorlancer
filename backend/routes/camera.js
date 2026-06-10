const express = require('express');
const router = express.Router();
const multer = require('multer');

// In-memory snapshot cache: machineId -> { base64, timestamp }
// ESP-CAM pushes images here; app reads the latest instead of backend pulling from local IP
const lastSnapshots = {};
const { getDb } = require('../config/firebase');
const { authenticateUser } = require('../middleware/auth');
const { detectHuman, matchFace } = require('../services/groqService');
const { sendPushNotification, storeNotification } = require('../services/notificationService');
const { sendCommandToDevice, sendToUser } = require('../services/websocketService');
const { v4: uuidv4 } = require('uuid');

// Multer config for image uploads (in memory)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Only image files are allowed'));
        }
    }
});

// POST /api/camera/register - ESP-CAM registers itself
router.post('/register', async (req, res) => {
    try {
        const { machineId, password, ip, captureUrl, streamUrl } = req.body;

        if (!machineId || !password) {
            return res.status(400).json({ error: 'Machine ID and password required' });
        }

        const db = getDb();
        const bcrypt = require('bcryptjs');
        const machineDoc = await db.collection('machines').doc(machineId).get();

        if (!machineDoc.exists) {
            // Auto-create machine on first ESP-CAM registration
            const passwordHash = await bcrypt.hash(password, 10);
            await db.collection('machines').doc(machineId).set({
                machineId,
                passwordHash,
                doorLocked: true,
                esp32Status: 'offline',
                espcamStatus: 'online',
                espcamIp: ip,
                captureUrl,
                streamUrl,
                createdAt: new Date().toISOString(),
                lastActivity: new Date().toISOString(),
            });
            console.log(`[Camera] Auto-created machine ${machineId}, ESP-CAM registered at ${ip}`);
            return res.json({ message: 'ESP-CAM registered successfully' });
        }

        const machineData = machineDoc.data();
        if (machineData.passwordHash) {
            const passwordValid = await bcrypt.compare(password, machineData.passwordHash);
            if (!passwordValid) {
                return res.status(401).json({ error: 'Invalid credentials' });
            }
        }

        await db.collection('machines').doc(machineId).update({
            espcamStatus: 'online',
            espcamIp: ip,
            captureUrl,
            streamUrl,
            lastActivity: new Date().toISOString(),
        });

        console.log(`[Camera] ESP-CAM registered for machine ${machineId} at ${ip}`);
        res.json({ message: 'ESP-CAM registered successfully' });
    } catch (err) {
        console.error('Camera register error:', err);
        res.status(500).json({ error: 'Registration failed' });
    }
});

// POST /api/camera/motion-detected - ESP-CAM sends image on motion detection
router.post('/motion-detected', upload.single('image'), async (req, res) => {
    try {
        const machineId = req.body.machineId;
        if (!machineId) {
            return res.status(400).json({ error: 'Machine ID required' });
        }
        if (!req.file) {
            return res.status(400).json({ error: 'Image required' });
        }

        const fsLocal = require('fs');
        const pathLocal = require('path');
        const db = getDb();

        // Quick machine lookup
        const machineDoc = await db.collection('machines').doc(machineId).get();
        if (!machineDoc.exists) {
            return res.status(404).json({ error: 'Machine not found' });
        }
        const machineData = machineDoc.data();
        const base64Image = req.file.buffer.toString('base64');

        // Cache this frame so /capture can serve it (backend can't reach ESP-CAM local IP from cloud)
        lastSnapshots[machineId] = { base64: base64Image, timestamp: new Date().toISOString() };

        console.log(`[Camera] Image received for ${machineId} (${req.file.size} bytes) — checking family members...`);

        // Step 1: Load family members (skip human detection — too slow and unreliable for active scans)
        const familySnapshot = await db.collection('machines')
            .doc(machineId)
            .collection('family')
            .get();

        if (familySnapshot.empty) {
            console.log('[Camera] No family members registered, skipping face match');
            return res.json({ action: 'ignored', reason: 'No family members registered' });
        }

        const familyMembers = [];
        for (const famDoc of familySnapshot.docs) {
            const memberData = famDoc.data();
            if (memberData.imagePath) {
                try {
                    // Strip leading slash so path.join works correctly on all platforms
                    const relativePath = memberData.imagePath.replace(/^\//, '');
                    const localPath = pathLocal.join(__dirname, '..', relativePath);
                    const imageBuffer = fsLocal.readFileSync(localPath);
                    familyMembers.push({ name: memberData.name, imageBase64: imageBuffer.toString('base64') });
                    console.log(`[Camera] Loaded image for family member: ${memberData.name}`);
                } catch (err) {
                    console.error(`[Camera] Could not load image for ${memberData.name}: ${err.message}`);
                }
            }
        }

        if (familyMembers.length === 0) {
            console.log('[Camera] No family images could be loaded from disk');
            return res.json({ action: 'ignored', reason: 'Family images unavailable' });
        }

        // Step 2: Face match against all family members
        let matchResult;
        try {
            matchResult = await matchFace(base64Image, familyMembers);
            console.log('[Camera] Face match result:', JSON.stringify(matchResult));
        } catch (err) {
            console.error('[Camera] Face match error:', err);
            return res.json({ action: 'error', reason: 'Face match failed' });
        }

        // Step 3: Unlock if any match found (confidence check removed — any match triggers unlock)
        if (matchResult.isMatch && matchResult.matchedName) {
            // Save captured image for the log entry
            const capturesDir = pathLocal.join(__dirname, '..', 'uploads', 'captures', machineId);
            fsLocal.mkdirSync(capturesDir, { recursive: true });
            const captureImageName = `${Date.now()}.jpg`;
            fsLocal.writeFileSync(pathLocal.join(capturesDir, captureImageName), req.file.buffer);
            const imageUrl = `/uploads/captures/${machineId}/${captureImageName}`;

            // Send unlock command to ESP32 main controller via WebSocket
            const sent = sendCommandToDevice(machineId, 'esp32_controller', {
                command: 'unlock',
                autoRelock: true,
                reason: `Family member: ${matchResult.matchedName}`,
            });

            if (sent) {
                console.log(`[Camera] ✅ Unlock sent for ${matchResult.matchedName} (confidence: ${matchResult.confidence})`);
            } else {
                console.warn(`[Camera] ⚠️  ESP32 not connected via WebSocket — unlock command could NOT be delivered for ${matchResult.matchedName}`);
            }

            // Log + notify (non-blocking, don't let these failures affect the response)
            try {
                await db.collection('activity_logs').add({
                    machineId,
                    action: 'unlock',
                    method: 'auto_family',
                    familyMember: matchResult.matchedName,
                    confidence: matchResult.confidence || 'unknown',
                    commandSent: sent,
                    timestamp: new Date().toISOString(),
                });
            } catch (e) { console.error('[Camera] Activity log error:', e.message); }

            try {
                await sendPushNotification(
                    machineId,
                    'Family Member Arrived',
                    `${matchResult.matchedName} is at the door. Door unlocked automatically.`,
                    { machineId, type: 'family_arrival', imageUrl }
                );
                await storeNotification(
                    machineId, machineId, 'family_arrival',
                    'Family Member Arrived',
                    `${matchResult.matchedName} is at the door. Door unlocked automatically.`,
                    imageUrl
                );
                sendToUser(machineData.ownerId || machineId, {
                    type: 'family_arrival',
                    machineId,
                    familyMember: matchResult.matchedName,
                    imageUrl,
                    message: `${matchResult.matchedName} arrived. Door unlocked automatically.`,
                    timestamp: new Date().toISOString(),
                });
            } catch (e) { console.error('[Camera] Notification error:', e.message); }

            return res.json({
                action: 'auto_unlocked',
                familyMember: matchResult.matchedName,
                confidence: matchResult.confidence,
                commandSent: sent,
            });
        }

        // No match — periodic scan, no notification needed
        console.log('[Camera] No family member match in this frame');
        return res.json({ action: 'no_match' });

    } catch (err) {
        console.error('Motion detection error:', err);
        res.status(500).json({ error: 'Processing failed' });
    }
});

// POST /api/camera/push-snapshot - ESP-CAM pushes a snapshot (fast, no AI, just caches for app)
router.post('/push-snapshot', upload.single('image'), async (req, res) => {
    try {
        const machineId = req.body.machineId;
        if (!machineId || !req.file) {
            return res.status(400).json({ error: 'Machine ID and image required' });
        }
        lastSnapshots[machineId] = {
            base64: req.file.buffer.toString('base64'),
            timestamp: new Date().toISOString(),
        };
        res.json({ ok: true });
    } catch (err) {
        console.error('Push snapshot error:', err);
        res.status(500).json({ error: 'Failed to store snapshot' });
    }
});

// GET /api/camera/capture/:machineId - Returns latest cached snapshot from ESP-CAM push
// (ESP-CAM local IP is unreachable from Railway cloud; ESP-CAM pushes images to us instead)
router.get('/capture/:machineId', async (req, res) => {
    try {
        const { machineId } = req.params;

        const db = getDb();
        const machineDoc = await db.collection('machines').doc(machineId).get();

        if (!machineDoc.exists) {
            return res.status(404).json({ error: 'Machine not found' });
        }

        const machineData = machineDoc.data();
        if (machineData.espcamStatus !== 'online') {
            return res.status(503).json({ error: 'Camera is offline' });
        }

        const snap = lastSnapshots[machineId];
        if (snap) {
            return res.json({
                image: `data:image/jpeg;base64,${snap.base64}`,
                timestamp: snap.timestamp,
            });
        }

        // ESP-CAM is online but no frame has arrived yet (happens briefly after startup)
        return res.status(503).json({ error: 'Camera warming up, please try again in a few seconds' });
    } catch (err) {
        console.error('Capture error:', err);
        res.status(500).json({ error: 'Capture failed' });
    }
});

// GET /api/camera/stream-url/:machineId - Get stream URL
router.get('/stream-url/:machineId', async (req, res) => {
    try {
        const { machineId } = req.params;

        const db = getDb();
        const machineDoc = await db.collection('machines').doc(machineId).get();

        if (!machineDoc.exists) {
            return res.status(404).json({ error: 'Machine not found' });
        }

        const machineData = machineDoc.data();

        res.json({
            streamUrl: machineData.streamUrl,
            captureUrl: machineData.captureUrl,
            espcamStatus: machineData.espcamStatus,
        });
    } catch (err) {
        console.error('Stream URL error:', err);
        res.status(500).json({ error: 'Failed to get stream URL' });
    }
});

module.exports = router;
