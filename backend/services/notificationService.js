const { getDb } = require('../config/firebase');

/**
 * Send Expo push notification to all registered devices for a machine
 */
async function sendPushNotification(machineId, title, body, data = {}) {
    try {
        const db = getDb();

        // Get Expo push tokens for this machine
        const tokensSnapshot = await db
            .collection('machines')
            .doc(machineId)
            .collection('pushTokens')
            .get();

        if (tokensSnapshot.empty) {
            console.log(`[Push] No push tokens for machine ${machineId}`);
            return;
        }

        const tokens = tokensSnapshot.docs.map(doc => doc.data().token);
        console.log(`[Push] Sending to ${tokens.length} device(s) for ${machineId}`);

        // Build Expo push messages
        const messages = tokens
            .filter(token => token && token.startsWith('ExponentPushToken'))
            .map(token => ({
                to: token,
                sound: 'default',
                title,
                body,
                data: { ...data, machineId, timestamp: new Date().toISOString() },
                priority: 'high',
            }));

        if (messages.length === 0) {
            console.log('[Push] No valid Expo push tokens');
            return;
        }

        // Send via Expo Push API
        const fetch = (await import('node-fetch')).default;
        const response = await fetch('https://exp.host/--/api/v2/push/send', {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(messages),
        });

        const result = await response.json();
        console.log(`[Push] Expo response:`, JSON.stringify(result.data || result));

        // Clean up invalid tokens
        if (result.data) {
            result.data.forEach((receipt, idx) => {
                if (receipt.status === 'error' && receipt.details?.error === 'DeviceNotRegistered') {
                    const tokenDoc = tokensSnapshot.docs[idx];
                    if (tokenDoc) tokenDoc.ref.delete();
                    console.log(`[Push] Removed invalid token`);
                }
            });
        }

        return result;
    } catch (err) {
        console.error('[Push] Error sending notification:', err);
    }
}

/**
 * Store notification in Firestore for in-app notification history
 */
async function storeNotification(userId, machineId, type, title, body, imageUrl = null) {
    try {
        const db = getDb();
        const notifRef = db.collection('notifications').doc();

        await notifRef.set({
            userId,
            machineId,
            type,
            title,
            body,
            imageUrl,
            read: false,
            createdAt: new Date().toISOString(),
        });

        return notifRef.id;
    } catch (err) {
        console.error('[Notification] Store error:', err);
        throw err;
    }
}

module.exports = { sendPushNotification, storeNotification };
