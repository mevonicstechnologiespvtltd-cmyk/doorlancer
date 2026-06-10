const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../config/firebase');

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, '..', 'uploads', 'family');
fs.mkdirSync(uploadsDir, { recursive: true });

// Multer config for family image uploads
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Only image files are allowed'));
        }
    }
});

// POST /api/family/add - Add a family member with photo
router.post('/add', upload.single('image'), async (req, res) => {
    try {
        const { name, relationship, machineId } = req.body;

        if (!machineId) {
            return res.status(400).json({ error: 'Machine ID is required' });
        }
        if (!name || !req.file) {
            return res.status(400).json({ error: 'Name and image are required' });
        }

        const db = getDb();
        const memberId = uuidv4();

        // Save image to local filesystem
        const machineDir = path.join(uploadsDir, machineId);
        fs.mkdirSync(machineDir, { recursive: true });
        const imageName = `${memberId}.jpg`;
        const imagePath = path.join(machineDir, imageName);
        fs.writeFileSync(imagePath, req.file.buffer);

        // URL served via express.static
        const imageUrl = `/uploads/family/${machineId}/${imageName}`;

        // Save family member data under machine
        await db.collection('machines')
            .doc(machineId)
            .collection('family')
            .doc(memberId)
            .set({
                name,
                relationship: relationship || 'family',
                imagePath: imageUrl,
                imageUrl,
                addedAt: new Date().toISOString(),
            });

        res.json({
            message: 'Family member added successfully',
            member: { id: memberId, name, relationship, imageUrl }
        });
    } catch (err) {
        console.error('Add family member error:', err);
        res.status(500).json({ error: 'Failed to add family member' });
    }
});

// GET /api/family/list - List all family members
router.get('/list', async (req, res) => {
    try {
        const { machineId } = req.query;
        if (!machineId) {
            return res.status(400).json({ error: 'machineId query param required' });
        }

        const db = getDb();
        const familySnapshot = await db.collection('machines')
            .doc(machineId)
            .collection('family')
            .orderBy('addedAt', 'desc')
            .get();

        const family = familySnapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data(),
            imagePath: undefined,
        }));

        res.json({ family });
    } catch (err) {
        console.error('List family error:', err);
        res.status(500).json({ error: 'Failed to list family members' });
    }
});

// PUT /api/family/update/:memberId - Update family member
router.put('/update/:memberId', upload.single('image'), async (req, res) => {
    try {
        const { memberId } = req.params;
        const { name, relationship, machineId } = req.body;

        if (!machineId) {
            return res.status(400).json({ error: 'Machine ID required' });
        }

        const db = getDb();
        const memberRef = db.collection('machines')
            .doc(machineId)
            .collection('family')
            .doc(memberId);

        const memberDoc = await memberRef.get();
        if (!memberDoc.exists) {
            return res.status(404).json({ error: 'Family member not found' });
        }

        const updates = {};
        if (name) updates.name = name;
        if (relationship) updates.relationship = relationship;

        // If new image uploaded, replace it
        if (req.file) {
            const machineDir = path.join(uploadsDir, machineId);
            fs.mkdirSync(machineDir, { recursive: true });
            const imageName = `${memberId}.jpg`;
            const imagePath = path.join(machineDir, imageName);
            fs.writeFileSync(imagePath, req.file.buffer);
            updates.imageUrl = `/uploads/family/${machineId}/${imageName}`;
            updates.imagePath = updates.imageUrl;
        }

        updates.updatedAt = new Date().toISOString();
        await memberRef.update(updates);

        res.json({ message: 'Family member updated', memberId });
    } catch (err) {
        console.error('Update family error:', err);
        res.status(500).json({ error: 'Failed to update family member' });
    }
});

// DELETE /api/family/remove/:memberId - Remove family member
router.delete('/remove/:memberId', async (req, res) => {
    try {
        const { memberId } = req.params;
        const { machineId } = req.query;

        if (!machineId) {
            return res.status(400).json({ error: 'machineId query param required' });
        }

        const db = getDb();

        const memberRef = db.collection('machines')
            .doc(machineId)
            .collection('family')
            .doc(memberId);

        const memberDoc = await memberRef.get();
        if (!memberDoc.exists) {
            return res.status(404).json({ error: 'Family member not found' });
        }

        // Delete local image file
        const localImagePath = path.join(uploadsDir, machineId, `${memberId}.jpg`);
        try {
            if (fs.existsSync(localImagePath)) {
                fs.unlinkSync(localImagePath);
            }
        } catch (err) {
            console.warn('Image delete warning:', err.message);
        }

        await memberRef.delete();
        res.json({ message: 'Family member removed', memberId });
    } catch (err) {
        console.error('Remove family error:', err);
        res.status(500).json({ error: 'Failed to remove family member' });
    }
});

module.exports = router;
