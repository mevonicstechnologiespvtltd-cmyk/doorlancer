const { getDb } = require('../config/firebase');

// Connected devices: machineId -> { ws, device, ip, ... }
const connectedDevices = new Map();
// Connected mobile apps: userId -> [{ ws, machineId }]
const connectedApps = new Map();

function setupWebSocket(wss) {
    // Send WebSocket PING frames every 20s to keep Railway's reverse proxy alive.
    // Without this, Railway drops idle WS connections after ~30s.
    const pingInterval = setInterval(() => {
        wss.clients.forEach((ws) => {
            if (ws.isAlive === false) {
                ws.terminate();
                return;
            }
            ws.isAlive = false;
            ws.ping();
        });
    }, 20000);

    wss.on('close', () => clearInterval(pingInterval));

    wss.on('connection', (ws, req) => {
        ws.isAlive = true;
        ws.on('pong', () => { ws.isAlive = true; });

        console.log('[WS] New connection from:', req.socket.remoteAddress);

        let deviceInfo = null;

        ws.on('message', async (data) => {
            try {
                const message = JSON.parse(data.toString());
                console.log('[WS] Message:', message.type);

                switch (message.type) {
                    case 'register':
                        await handleDeviceRegistration(ws, message);
                        deviceInfo = { machineId: message.machineId, device: message.device };
                        break;

                    case 'app_connect':
                        handleAppConnection(ws, message);
                        deviceInfo = { userId: message.userId, type: 'app' };
                        break;

                    case 'heartbeat':
                        handleHeartbeat(message);
                        break;

                    case 'status':
                        await handleStatusUpdate(message);
                        // Forward status to connected apps
                        broadcastToApps(message.machineId, message);
                        break;

                    case 'command_response':
                        // Forward command responses to the app
                        if (deviceInfo?.machineId) {
                            broadcastToApps(deviceInfo.machineId, message);
                        }
                        break;

                    case 'motion_detected':
                        // ESP32 detected motion via PIR, fetch image from ESP-CAM
                        console.log(`[WS] Motion detected for machine ${message.machineId}`);
                        await handleMotionFromESP32(message.machineId);
                        break;

                    case 'doorbell_pressed':
                        console.log(`[WS] Doorbell pressed for machine ${message.machineId}`);
                        await handleDoorbellPress(message.machineId);
                        break;

                    default:
                        console.log('[WS] Unknown message type:', message.type);
                }
            } catch (err) {
                console.error('[WS] Error processing message:', err);
            }
        });

        ws.on('close', () => {
            if (deviceInfo) {
                if (deviceInfo.type === 'app') {
                    removeAppConnection(deviceInfo.userId, ws);
                } else if (deviceInfo.machineId) {
                    connectedDevices.delete(`${deviceInfo.machineId}_${deviceInfo.device}`);
                    console.log(`[WS] Device disconnected: ${deviceInfo.device} (${deviceInfo.machineId})`);
                    updateDeviceStatus(deviceInfo.machineId, deviceInfo.device, 'offline');
                    broadcastToApps(deviceInfo.machineId, {
                        type: 'device_status',
                        machineId: deviceInfo.machineId,
                        esp32Status: deviceInfo.device === 'esp32_controller' ? 'offline' : undefined,
                        espcamStatus: deviceInfo.device === 'espcam' ? 'offline' : undefined,
                    });
                }
            }
        });

        ws.on('error', (err) => {
            console.error('[WS] Error:', err);
        });
    });

    console.log('WebSocket server initialized');
}

async function handleDeviceRegistration(ws, message) {
    const { machineId, password, device } = message;

    const db = getDb();
    const bcrypt = require('bcryptjs');
    let machineDoc = await db.collection('machines').doc(machineId).get();

    if (!machineDoc.exists) {
        // Auto-create machine on first ESP32 registration
        const passwordHash = await bcrypt.hash(password, 10);
        await db.collection('machines').doc(machineId).set({
            machineId,
            passwordHash,
            doorLocked: true,
            esp32Status: 'offline',
            espcamStatus: 'offline',
            createdAt: new Date().toISOString(),
            lastActivity: new Date().toISOString(),
        });
        console.log(`[WS] Auto-created machine: ${machineId}`);
    } else {
        const machineData = machineDoc.data();
        if (machineData.passwordHash) {
            const passwordValid = await bcrypt.compare(password, machineData.passwordHash);
            if (!passwordValid) {
                ws.send(JSON.stringify({ type: 'error', message: 'Invalid credentials' }));
                ws.close();
                return;
            }
        }
    }

    // Store connection
    const key = `${machineId}_${device}`;
    connectedDevices.set(key, { ws, machineId, device, connectedAt: new Date() });

    // Update device status in Firestore
    await updateDeviceStatus(machineId, device, 'online');

    ws.send(JSON.stringify({ type: 'registered', message: `${device} registered successfully` }));
    console.log(`[WS] Device registered: ${device} (${machineId})`);

    // Tell all connected apps that this device just came online
    broadcastToApps(machineId, {
        type: 'device_status',
        machineId,
        esp32Status: device === 'esp32_controller' ? 'online' : undefined,
        espcamStatus: device === 'espcam' ? 'online' : undefined,
    });
}

function handleAppConnection(ws, message) {
    const { userId, machineId } = message;

    if (!connectedApps.has(userId)) {
        connectedApps.set(userId, []);
    }
    connectedApps.get(userId).push({ ws, machineId });
    console.log(`[WS] App connected: user ${userId} for machine ${machineId}`);

    // Send current device status
    const esp32Key = `${machineId}_esp32_controller`;
    const esp32 = connectedDevices.get(esp32Key);
    if (esp32) {
        ws.send(JSON.stringify({
            type: 'device_status',
            esp32: 'online'
        }));
    }
}

function removeAppConnection(userId, ws) {
    const connections = connectedApps.get(userId);
    if (connections) {
        const idx = connections.findIndex(c => c.ws === ws);
        if (idx >= 0) connections.splice(idx, 1);
        if (connections.length === 0) connectedApps.delete(userId);
    }
}

function handleHeartbeat(message) {
    const key = `${message.machineId}_${message.device}`;
    const device = connectedDevices.get(key);
    if (device) {
        device.lastHeartbeat = new Date();
    }
}

async function handleStatusUpdate(message) {
    try {
        const db = getDb();
        await db.collection('machines').doc(message.machineId).update({
            doorLocked: message.doorLocked,
            lastActivity: new Date().toISOString(),
        });
    } catch (err) {
        console.error('Status update error:', err);
    }
}

async function updateDeviceStatus(machineId, device, status) {
    try {
        const db = getDb();
        const field = device === 'esp32_controller' ? 'esp32Status' : 'espcamStatus';
        await db.collection('machines').doc(machineId).update({
            [field]: status,
            lastActivity: new Date().toISOString(),
        });
    } catch (err) {
        console.error('Device status update error:', err);
    }
}

// Send command to a specific ESP32
function sendCommandToDevice(machineId, device, command) {
    const key = `${machineId}_${device}`;
    const deviceConn = connectedDevices.get(key);

    if (deviceConn && deviceConn.ws.readyState === 1) {
        deviceConn.ws.send(JSON.stringify(command));
        return true;
    }
    return false;
}

// Broadcast message to all app connections for a machine
function broadcastToApps(machineId, message) {
    connectedApps.forEach((connections, userId) => {
        connections.forEach(({ ws, machineId: mId }) => {
            if (mId === machineId && ws.readyState === 1) {
                ws.send(JSON.stringify(message));
            }
        });
    });
}

// Broadcast to specific user
function sendToUser(userId, message) {
    const connections = connectedApps.get(userId);
    if (connections) {
        connections.forEach(({ ws }) => {
            if (ws.readyState === 1) {
                ws.send(JSON.stringify(message));
            }
        });
    }
}

/**
 * Handle motion detected by ESP32's PIR sensor.
 * 1. Fetches image from ESP-CAM
 * 2. Runs Groq AI to check if human
 * 3. If human, compares face against family members
 * 4. If family match → auto-unlock door + notify owner
 * 5. If stranger → notify owner (do NOT unlock)
 * 6. If not human → ignore
 */
async function handleMotionFromESP32(machineId) {
    try {
        const db = getDb();
        const machineDoc = await db.collection('machines').doc(machineId).get();

        if (!machineDoc.exists) {
            console.error(`[Motion] Machine ${machineId} not found`);
            return;
        }

        const machineData = machineDoc.data();

        if (!machineData.captureUrl || machineData.espcamStatus !== 'online') {
            console.log('[Motion] ESP-CAM not available, skipping');
            // Notify apps that motion was detected but camera unavailable
            broadcastToApps(machineId, {
                type: 'motion_alert',
                machineId,
                message: 'Motion detected but camera is offline',
                timestamp: new Date().toISOString(),
            });
            return;
        }

        // Step 1: Fetch image from ESP-CAM
        console.log(`[Motion] Fetching image from ESP-CAM: ${machineData.captureUrl}`);
        const fetch = (await import('node-fetch')).default;
        let camResponse;
        try {
            camResponse = await fetch(machineData.captureUrl, { timeout: 10000 });
        } catch (fetchErr) {
            console.error(`[Motion] ESP-CAM fetch failed: ${fetchErr.message}`);
            return;
        }

        if (!camResponse.ok) {
            console.error(`[Motion] ESP-CAM returned status: ${camResponse.status}`);
            return;
        }

        const imageBuffer = await camResponse.buffer();
        const base64Image = imageBuffer.toString('base64');
        console.log(`[Motion] Image captured: ${imageBuffer.length} bytes`);

        // Step 2: Run Groq AI human detection
        const { detectHuman, matchFace } = require('./groqService');
        let humanResult;
        try {
            humanResult = await detectHuman(base64Image);
        } catch (err) {
            console.error('[Motion] Human detection failed:', err.message);
            // If AI fails, treat as potential human for safety
            humanResult = { isHuman: true, confidence: 'low', description: 'AI detection unavailable, treating as potential visitor' };
        }

        console.log('[Motion] Human detection result:', JSON.stringify(humanResult));

        // Step 3: If NOT human → ignore (animal, shadow, wind, etc.)
        if (!humanResult.isHuman) {
            console.log('[Motion] No human detected, ignoring motion');
            broadcastToApps(machineId, {
                type: 'motion_info',
                machineId,
                message: `Motion detected: ${humanResult.description || 'No human found'}`,
                timestamp: new Date().toISOString(),
            });
            return;
        }

        // Step 4: Save captured image locally
        let imageUrl = null;
        try {
            const fs = require('fs');
            const path = require('path');
            const capturesDir = path.join(__dirname, '..', 'uploads', 'captures', machineId);
            fs.mkdirSync(capturesDir, { recursive: true });
            const imageName = `${Date.now()}.jpg`;
            fs.writeFileSync(path.join(capturesDir, imageName), imageBuffer);
            imageUrl = `/uploads/captures/${machineId}/${imageName}`;
            console.log(`[Motion] Image saved: ${imageUrl}`);
        } catch (uploadErr) {
            console.error('[Motion] Image save failed:', uploadErr.message);
            // Continue without image URL
        }

        // Step 5: Check against family members (stored under machines/{machineId}/family)
        const familySnapshot = await db.collection('machines')
            .doc(machineId)
            .collection('family')
            .get();

        let autoUnlocked = false;
        let matchResult = { isMatch: false };

        if (!familySnapshot.empty) {
            const fs = require('fs');
            const path = require('path');
            const familyMembers = [];

            for (const famDoc of familySnapshot.docs) {
                const memberData = famDoc.data();
                if (memberData.imagePath) {
                    try {
                        // Images are stored locally at backend/uploads/...
                        const localPath = path.join(__dirname, '..', memberData.imagePath);
                        const memberBuffer = fs.readFileSync(localPath);
                        familyMembers.push({
                            name: memberData.name,
                            imageBase64: memberBuffer.toString('base64'),
                        });
                    } catch (err) {
                        console.error(`[Motion] Failed to load image for ${memberData.name}:`, err.message);
                    }
                }
            }

            if (familyMembers.length > 0) {
                console.log(`[Motion] Comparing face against ${familyMembers.length} family members...`);
                try {
                    matchResult = await matchFace(base64Image, familyMembers);
                    console.log('[Motion] Face match result:', JSON.stringify(matchResult));
                } catch (err) {
                    console.error('[Motion] Face match failed:', err.message);
                }

                // Step 6: If family member → auto-unlock
                if (matchResult.isMatch && matchResult.confidence !== 'low') {
                    const sent = sendCommandToDevice(machineId, 'esp32_controller', {
                        command: 'unlock',
                        autoRelock: true,
                        reason: `Family member: ${matchResult.matchedName}`,
                    });

                    if (sent) {
                        autoUnlocked = true;
                        console.log(`[Motion] Door auto-unlocked for: ${matchResult.matchedName}`);

                        await db.collection('activity_logs').add({
                            machineId,
                            action: 'unlock',
                            method: 'auto_family',
                            familyMember: matchResult.matchedName,
                            timestamp: new Date().toISOString(),
                        });

                        // Store notification
                        const { storeNotification } = require('./notificationService');
                        await storeNotification(
                            machineId, machineId, 'family_arrival',
                            'Family Member Arrived',
                            `${matchResult.matchedName} is at the door. Door unlocked automatically.`,
                            imageUrl
                        );

                        // Real-time alert to all connected apps for this machine
                        broadcastToApps(machineId, {
                            type: 'family_arrival',
                            machineId,
                            familyMember: matchResult.matchedName,
                            imageUrl,
                            message: `${matchResult.matchedName} arrived. Door unlocked automatically.`,
                            timestamp: new Date().toISOString(),
                        });
                    }
                }
            }
        }

        // Step 7: If NOT family → send visitor alert (do NOT unlock)
        if (!autoUnlocked) {
            console.log('[Motion] Unknown person detected, notifying owner...');

            const { storeNotification } = require('./notificationService');
            await storeNotification(
                machineId, machineId, 'visitor',
                'Unknown Person at Door',
                humanResult.description || 'An unknown person is at your door.',
                imageUrl
            );

            // Real-time alert to all connected apps for this machine
            broadcastToApps(machineId, {
                type: 'visitor_alert',
                machineId,
                imageUrl,
                description: humanResult.description || 'An unknown person is at your door.',
                timestamp: new Date().toISOString(),
            });
        }

        console.log(`[Motion] Processing complete. Human: ${humanResult.isHuman}, AutoUnlocked: ${autoUnlocked}`);
    } catch (err) {
        console.error('[Motion] Error handling motion:', err);
    }
}

/**
 * Handle doorbell button press from ESP32.
 * 1. Store notification
 * 2. Send push notification (works even when app is closed)
 * 3. Broadcast real-time alert to connected apps
 */
async function handleDoorbellPress(machineId) {
    try {
        const db = getDb();
        const { storeNotification, sendPushNotification } = require('./notificationService');

        // Get machine name
        let machineName = 'Doorlance';
        try {
            const machineDoc = await db.collection('machines').doc(machineId).get();
            if (machineDoc.exists) {
                machineName = machineDoc.data().name || machineName;
            }
        } catch (e) {}

        const title = '🔔 Doorbell Ringing!';
        const body = `Someone is at your ${machineName} door`;

        // Store notification in Firestore
        await storeNotification(
            machineId, machineId, 'doorbell',
            title, body, null
        );

        // Send Expo push notification (works when app is closed)
        await sendPushNotification(machineId, title, body, {
            type: 'doorbell',
            machineId,
        });

        // Real-time WebSocket alert to connected apps
        broadcastToApps(machineId, {
            type: 'doorbell_alert',
            machineId,
            title,
            message: body,
            timestamp: new Date().toISOString(),
        });

        console.log(`[Doorbell] Alert sent for machine ${machineId}`);
    } catch (err) {
        console.error('[Doorbell] Error:', err);
    }
}

module.exports = {
    setupWebSocket,
    sendCommandToDevice,
    broadcastToApps,
    sendToUser,
    connectedDevices
};
