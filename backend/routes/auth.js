const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../config/firebase');
const { authenticateUser } = require('../middleware/auth');

// POST /api/auth/register - Register a new user
router.post('/register', async (req, res) => {
    try {
        const { email, password, name } = req.body;

        if (!email || !password || !name) {
            return res.status(400).json({ error: 'Email, password, and name are required' });
        }

        const db = getDb();

        // Check if email already exists
        const existing = await db.collection('users').where('email', '==', email).limit(1).get();
        if (!existing.empty) {
            return res.status(409).json({ error: 'Email already registered' });
        }

        const userId = uuidv4();
        const passwordHash = await bcrypt.hash(password, 12);

        await db.collection('users').doc(userId).set({
            email,
            name,
            passwordHash,
            createdAt: new Date().toISOString(),
        });

        const token = jwt.sign(
            { userId, email, name },
            process.env.JWT_SECRET,
            { expiresIn: '30d' }
        );

        res.json({
            message: 'User registered successfully',
            token,
            user: { userId, email, name }
        });
    } catch (err) {
        console.error('Register error:', err);
        res.status(500).json({ error: 'Registration failed' });
    }
});

// POST /api/auth/login - User login
router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }

        const db = getDb();
        const usersSnapshot = await db.collection('users').where('email', '==', email).limit(1).get();

        if (usersSnapshot.empty) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const userDoc = usersSnapshot.docs[0];
        const userData = userDoc.data();

        const passwordValid = await bcrypt.compare(password, userData.passwordHash);
        if (!passwordValid) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const token = jwt.sign(
            { userId: userDoc.id, email: userData.email, name: userData.name },
            process.env.JWT_SECRET,
            { expiresIn: '30d' }
        );

        // Get user's machines
        const machinesSnapshot = await db.collection('machines')
            .where('ownerId', '==', userDoc.id)
            .get();

        const machines = machinesSnapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data(),
            passwordHash: undefined
        }));

        res.json({
            message: 'Login successful',
            token,
            user: { userId: userDoc.id, email: userData.email, name: userData.name },
            machines
        });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: 'Login failed' });
    }
});

// POST /api/auth/add-machine - Add/register a new machine
router.post('/add-machine', authenticateUser, async (req, res) => {
    try {
        const { machineId, machinePassword, machineName } = req.body;

        if (!machineId || !machinePassword) {
            return res.status(400).json({ error: 'Machine ID and password are required' });
        }

        const db = getDb();

        // Check if machine already exists
        const existing = await db.collection('machines').doc(machineId).get();
        if (existing.exists) {
            return res.status(409).json({ error: 'Machine ID already registered' });
        }

        const passwordHash = await bcrypt.hash(machinePassword, 12);

        await db.collection('machines').doc(machineId).set({
            name: machineName || `Doorlance ${machineId}`,
            ownerId: req.user.userId,
            passwordHash,
            doorLocked: true,
            esp32Status: 'offline',
            espcamStatus: 'offline',
            espcamIp: null,
            captureUrl: null,
            streamUrl: null,
            createdAt: new Date().toISOString(),
            lastActivity: new Date().toISOString(),
        });

        res.json({
            message: 'Machine registered successfully',
            machine: {
                id: machineId,
                name: machineName || `Doorlance ${machineId}`,
                doorLocked: true,
                esp32Status: 'offline',
                espcamStatus: 'offline',
            }
        });
    } catch (err) {
        console.error('Add machine error:', err);
        res.status(500).json({ error: 'Failed to add machine' });
    }
});

// POST /api/auth/login-machine - Login/link to existing machine
router.post('/login-machine', authenticateUser, async (req, res) => {
    try {
        const { machineId, machinePassword } = req.body;

        if (!machineId || !machinePassword) {
            return res.status(400).json({ error: 'Machine ID and password are required' });
        }

        const db = getDb();
        const machineDoc = await db.collection('machines').doc(machineId).get();

        if (!machineDoc.exists) {
            return res.status(404).json({ error: 'Machine not found' });
        }

        const machineData = machineDoc.data();
        const passwordValid = await bcrypt.compare(machinePassword, machineData.passwordHash);

        if (!passwordValid) {
            return res.status(401).json({ error: 'Invalid machine password' });
        }

        // Check if machine has a different owner
        if (machineData.ownerId && machineData.ownerId !== req.user.userId) {
            return res.status(403).json({ error: 'Machine belongs to another user' });
        }

        // Update owner if not set
        if (!machineData.ownerId) {
            await db.collection('machines').doc(machineId).update({
                ownerId: req.user.userId
            });
        }

        res.json({
            message: 'Machine login successful',
            machine: {
                id: machineId,
                name: machineData.name,
                doorLocked: machineData.doorLocked,
                esp32Status: machineData.esp32Status,
                espcamStatus: machineData.espcamStatus,
            }
        });
    } catch (err) {
        console.error('Machine login error:', err);
        res.status(500).json({ error: 'Machine login failed' });
    }
});

// POST /api/auth/fcm-token - Save FCM token for push notifications
router.post('/fcm-token', authenticateUser, async (req, res) => {
    try {
        const { token } = req.body;
        if (!token) {
            return res.status(400).json({ error: 'FCM token required' });
        }

        const db = getDb();
        await db.collection('users')
            .doc(req.user.userId)
            .collection('fcmTokens')
            .doc(token)
            .set({ token, updatedAt: new Date().toISOString() });

        res.json({ message: 'FCM token saved' });
    } catch (err) {
        console.error('FCM token error:', err);
        res.status(500).json({ error: 'Failed to save token' });
    }
});

module.exports = router;
