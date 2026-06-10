const admin = require('firebase-admin');

let db, storage, auth, messaging;

function initializeFirebase() {
    const serviceAccount = {
        type: 'service_account',
        project_id: process.env.FIREBASE_PROJECT_ID,
        private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
        private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        client_email: process.env.FIREBASE_CLIENT_EMAIL,
        client_id: process.env.FIREBASE_CLIENT_ID,
        auth_uri: process.env.FIREBASE_AUTH_URI,
        token_uri: process.env.FIREBASE_TOKEN_URI,
    };

    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    });

    db = admin.firestore();
    storage = admin.storage().bucket();
    auth = admin.auth();

    try {
        messaging = admin.messaging();
    } catch (e) {
        console.warn('Firebase Messaging not available:', e.message);
    }

    console.log('Firebase initialized successfully');
}

function getDb() { return db; }
function getStorage() { return storage; }
function getAuth() { return auth; }
function getMessaging() { return messaging; }

module.exports = {
    initializeFirebase,
    getDb,
    getStorage,
    getAuth,
    getMessaging,
    admin
};
