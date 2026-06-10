const express = require('express');
const router = express.Router();
const { getDb } = require('../config/firebase');

const DEFAULT_PRESETS = [
    { id: 'p1', label: 'Coming', text: "I'm coming, please wait a moment." },
    { id: 'p2', label: 'Busy', text: "Sorry, I'm busy right now. Please leave a message." },
    { id: 'p3', label: 'Not Home', text: "I'm not home right now. Please come back later." },
    { id: 'p4', label: 'Leave it', text: "Please leave the package at the door. Thank you!" },
];

/**
 * GET /api/settings/:machineId
 * Returns auto-response settings + preset replies for a machine.
 */
router.get('/:machineId', async (req, res) => {
    try {
        const { machineId } = req.params;
        const db = getDb();
        const doc = await db.collection('machines').doc(machineId).get();

        if (!doc.exists) {
            return res.json({
                autoResponse: true,
                presetReplies: DEFAULT_PRESETS,
            });
        }

        const data = doc.data() || {};
        res.json({
            autoResponse: data.autoResponse !== false, // default true
            presetReplies: Array.isArray(data.presetReplies) && data.presetReplies.length > 0
                ? data.presetReplies
                : DEFAULT_PRESETS,
        });
    } catch (err) {
        console.error('[Settings] get error:', err);
        res.status(500).json({ error: 'Failed to load settings' });
    }
});

/**
 * PUT /api/settings/:machineId
 * Body: { autoResponse?: boolean, presetReplies?: [{id, label, text}] }
 */
router.put('/:machineId', express.json(), async (req, res) => {
    try {
        const { machineId } = req.params;
        const { autoResponse, presetReplies } = req.body;

        const update = {};
        if (typeof autoResponse === 'boolean') update.autoResponse = autoResponse;
        if (Array.isArray(presetReplies)) {
            // sanitize
            update.presetReplies = presetReplies
                .filter((p) => p && typeof p.text === 'string' && p.text.trim())
                .slice(0, 20)
                .map((p, i) => ({
                    id: String(p.id || `p${Date.now()}_${i}`),
                    label: String(p.label || p.text).slice(0, 40),
                    text: String(p.text).slice(0, 300),
                }));
        }

        if (Object.keys(update).length === 0) {
            return res.status(400).json({ error: 'Nothing to update' });
        }

        const db = getDb();
        await db.collection('machines').doc(machineId).set(update, { merge: true });

        // Broadcast change so connected apps can refresh
        try {
            const { broadcastToApps } = require('../services/websocketService');
            broadcastToApps(machineId, {
                type: 'settings_updated',
                machineId,
                ...update,
                timestamp: new Date().toISOString(),
            });
        } catch (e) { /* ignore */ }

        res.json({ success: true, ...update });
    } catch (err) {
        console.error('[Settings] update error:', err);
        res.status(500).json({ error: 'Failed to update settings' });
    }
});

module.exports = router;
