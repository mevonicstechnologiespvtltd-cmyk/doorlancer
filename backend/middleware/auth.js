const { getDb } = require('../config/firebase');
const bcrypt = require('bcryptjs');

// Authenticate by machine credentials (machineId + machinePassword)
// Accepts from body, query, or headers
async function authenticateUser(req, res, next) {
    const machineId = req.body.machineId || req.query.machineId || req.headers['x-machine-id'];
    const machinePassword = req.body.machinePassword || req.query.machinePassword || req.headers['x-machine-password'];

    if (!machineId) {
        return res.status(400).json({ error: 'Machine ID required' });
    }

    try {
        const db = getDb();
        const machineDoc = await db.collection('machines').doc(machineId).get();

        if (!machineDoc.exists) {
            // Auto-create machine document on first use
            const hash = machinePassword ? await bcrypt.hash(machinePassword, 10) : null;
            await db.collection('machines').doc(machineId).set({
                machineId,
                passwordHash: hash,
                doorLocked: true,
                esp32Status: 'offline',
                espcamStatus: 'offline',
                createdAt: new Date().toISOString(),
                lastActivity: new Date().toISOString(),
            });
            req.user = { machineId };
            req.machine = { id: machineId };
            return next();
        }

        // Machine exists - verify password if one is stored
        const machineData = machineDoc.data();
        if (machineData.passwordHash && machinePassword) {
            const valid = await bcrypt.compare(machinePassword, machineData.passwordHash);
            if (!valid) {
                return res.status(403).json({ error: 'Invalid machine password' });
            }
        }

        req.user = { machineId, userId: machineId };
        req.machine = { id: machineId, ...machineData };
        next();
    } catch (err) {
        console.error('Auth error:', err);
        return res.status(500).json({ error: 'Authentication failed' });
    }
}

// No-op for backward compat - machine ownership is checked in authenticateUser
async function verifyMachineOwnership(req, res, next) {
    next();
}

module.exports = { authenticateUser, verifyMachineOwnership };
