const express = require('express');
const router = express.Router();
const { getDb } = require('../config/firebase');
const { authenticateUser, verifyMachineOwnership } = require('../middleware/auth');
const { sendCommandToDevice, broadcastToApps } = require('../services/websocketService');

async function sendWithRetry(machineId, device, payload, timeoutMs = 6000) {
    let sent = sendCommandToDevice(machineId, device, payload);
    if (sent) return true;
    const deadline = Date.now() + timeoutMs;
    while (!sent && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 500));
        sent = sendCommandToDevice(machineId, device, payload);
    }
    return sent;
}

// POST /api/door/unlock - Unlock the door
router.post('/unlock', authenticateUser, async (req, res) => {
    try {
        const { machineId } = req.body;
        if (!machineId) {
            return res.status(400).json({ error: 'Machine ID required' });
        }

        // Retry for up to 6s — ESP32 may be briefly reconnecting after audio upload
        const sent = await sendWithRetry(machineId, 'esp32_controller', {
            command: 'unlock',
            autoRelock: false,
            initiatedBy: 'app',
        });

        if (!sent) {
            return res.status(503).json({ error: 'ESP32 is not connected' });
        }

        const db = getDb();
        await db.collection('activity_logs').add({
            machineId,
            action: 'unlock',
            method: 'app_manual',
            timestamp: new Date().toISOString(),
        });

        await db.collection('machines').doc(machineId).update({
            doorLocked: false,
            lastActivity: new Date().toISOString(),
        });

        res.json({ message: 'Unlock command sent', doorLocked: false });
    } catch (err) {
        console.error('Unlock error:', err);
        res.status(500).json({ error: 'Failed to unlock door' });
    }
});

// POST /api/door/lock - Lock the door
router.post('/lock', authenticateUser, async (req, res) => {
    try {
        const { machineId } = req.body;
        if (!machineId) {
            return res.status(400).json({ error: 'Machine ID required' });
        }

        // Retry for up to 6s — ESP32 may be briefly reconnecting after audio upload
        const sent = await sendWithRetry(machineId, 'esp32_controller', {
            command: 'lock',
            initiatedBy: 'app',
        });

        if (!sent) {
            return res.status(503).json({ error: 'ESP32 is not connected' });
        }

        const db = getDb();
        await db.collection('activity_logs').add({
            machineId,
            action: 'lock',
            method: 'app_manual',
            timestamp: new Date().toISOString(),
        });

        await db.collection('machines').doc(machineId).update({
            doorLocked: true,
            lastActivity: new Date().toISOString(),
        });

        res.json({ message: 'Lock command sent', doorLocked: true });
    } catch (err) {
        console.error('Lock error:', err);
        res.status(500).json({ error: 'Failed to lock door' });
    }
});

// GET /api/door/status/:machineId - Get door status
router.get('/status/:machineId', async (req, res) => {
    try {
        const { machineId } = req.params;

        const db = getDb();
        const machineDoc = await db.collection('machines').doc(machineId).get();

        if (!machineDoc.exists) {
            return res.json({
                machineId,
                doorLocked: true,
                esp32Status: 'offline',
                espcamStatus: 'offline',
            });
        }

        const data = machineDoc.data();
        res.json({
            machineId,
            name: data.name,
            doorLocked: data.doorLocked,
            esp32Status: data.esp32Status,
            espcamStatus: data.espcamStatus,
            lastActivity: data.lastActivity,
        });
    } catch (err) {
        console.error('Status error:', err);
        res.status(500).json({ error: 'Failed to get status' });
    }
});

// GET /api/door/logs/:machineId - Get activity logs
router.get('/logs/:machineId', async (req, res) => {
    try {
        const { machineId } = req.params;

        const db = getDb();
        const logsSnapshot = await db.collection('activity_logs')
            .where('machineId', '==', machineId)
            .orderBy('timestamp', 'desc')
            .limit(50)
            .get();

        const logs = logsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        res.json({ logs });
    } catch (err) {
        console.error('Logs error:', err);
        res.status(500).json({ error: 'Failed to get logs' });
    }
});

module.exports = router;
