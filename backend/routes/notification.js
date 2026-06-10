const express = require('express');
const router = express.Router();
const { getDb } = require('../config/firebase');
const { authenticateUser } = require('../middleware/auth');

// GET /api/notification/list - Get notifications for machine
router.get('/list', async (req, res) => {
    try {
        const db = getDb();
        const { machineId, limit: queryLimit, unreadOnly } = req.query;

        if (!machineId) {
            return res.status(400).json({ error: 'machineId query param required' });
        }

        // Fetch by machineId only (no composite index required), then sort/limit in memory.
        const snapshot = await db.collection('notifications')
            .where('machineId', '==', machineId)
            .get();

        let notifications = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

        // Sort newest-first by createdAt
        notifications.sort((a, b) => {
            const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
            const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
            return tb - ta;
        });

        if (unreadOnly === 'true') {
            notifications = notifications.filter(n => !n.read);
        }

        const max = parseInt(queryLimit) || 50;
        notifications = notifications.slice(0, max);

        res.json({ notifications });
    } catch (err) {
        console.error('List notifications error:', err);
        res.status(500).json({ error: 'Failed to get notifications' });
    }
});

// GET /api/notification/unread-count - Get unread notification count
router.get('/unread-count', async (req, res) => {
    try {
        const db = getDb();
        const { machineId } = req.query;

        if (!machineId) {
            return res.json({ count: 0 });
        }

        // Single-field query (no composite index needed)
        const snapshot = await db.collection('notifications')
            .where('machineId', '==', machineId)
            .get();

        const count = snapshot.docs.filter(d => d.data().read === false).length;
        res.json({ count });
    } catch (err) {
        console.error('Unread count error:', err);
        res.status(500).json({ error: 'Failed to get count' });
    }
});

// PUT /api/notification/mark-read/:notificationId - Mark notification as read
router.put('/mark-read/:notificationId', async (req, res) => {
    try {
        const { notificationId } = req.params;
        const db = getDb();

        const notifRef = db.collection('notifications').doc(notificationId);
        const notifDoc = await notifRef.get();

        if (!notifDoc.exists) {
            return res.status(404).json({ error: 'Notification not found' });
        }

        await notifRef.update({ read: true });
        res.json({ message: 'Notification marked as read' });
    } catch (err) {
        console.error('Mark read error:', err);
        res.status(500).json({ error: 'Failed to update notification' });
    }
});

// PUT /api/notification/mark-all-read - Mark all notifications as read
router.put('/mark-all-read', async (req, res) => {
    try {
        const db = getDb();
        const { machineId } = req.body;

        if (!machineId) {
            return res.status(400).json({ error: 'machineId required' });
        }

        const snapshot = await db.collection('notifications')
            .where('machineId', '==', machineId)
            .where('read', '==', false)
            .get();

        const batch = db.batch();
        snapshot.docs.forEach(doc => {
            batch.update(doc.ref, { read: true });
        });

        await batch.commit();
        res.json({ message: `Marked ${snapshot.size} notifications as read` });
    } catch (err) {
        console.error('Mark all read error:', err);
        res.status(500).json({ error: 'Failed to update notifications' });
    }
});

// POST /api/notification/register-push-token - Register Expo push token for a machine
router.post('/register-push-token', async (req, res) => {
    try {
        const { machineId, token } = req.body;

        if (!machineId || !token) {
            return res.status(400).json({ error: 'machineId and token are required' });
        }

        const db = getDb();
        // Use token as doc ID to avoid duplicates
        const tokenId = Buffer.from(token).toString('base64').replace(/[/+=]/g, '_').substring(0, 128);

        await db.collection('machines')
            .doc(machineId)
            .collection('pushTokens')
            .doc(tokenId)
            .set({
                token,
                updatedAt: new Date().toISOString(),
            });

        console.log(`[Push] Token registered for machine ${machineId}`);
        res.json({ message: 'Push token registered' });
    } catch (err) {
        console.error('Register push token error:', err);
        res.status(500).json({ error: 'Failed to register token' });
    }
});

module.exports = router;
