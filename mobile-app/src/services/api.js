import { Platform } from 'react-native';

// On web, use relative URLs so the webpack proxy forwards to the backend
// On mobile, use the direct backend IP
const LOCAL_BACKEND = 'http://10.122.106.43:3000';
export const API_BASE_URL = Platform.OS === 'web' ? '' : LOCAL_BACKEND;
const WS_URL = Platform.OS === 'web'
    ? `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`
    : 'ws://10.122.106.43:3000/ws';

function getHeaders() {
    return { 'Content-Type': 'application/json' };
}

async function apiRequest(endpoint, method = 'GET', body = null) {
    const headers = getHeaders();
    const config = { method, headers };

    if (body && method !== 'GET') {
        config.body = JSON.stringify(body);
    }

    let response;
    try {
        response = await fetch(`${API_BASE_URL}${endpoint}`, config);
    } catch (networkErr) {
        throw new Error('Cannot reach server. Check your network or server address.');
    }
    const data = await response.json();

    if (!response.ok) {
        throw new Error(data.error || 'Request failed');
    }

    return data;
}

async function apiUpload(endpoint, formData) {
    const response = await fetch(`${API_BASE_URL}${endpoint}`, {
        method: 'POST',
        body: formData,
    });

    const data = await response.json();
    if (!response.ok) {
        throw new Error(data.error || 'Upload failed');
    }
    return data;
}

// Auth APIs
export async function registerUser(email, password, name) {
    const response = await fetch(`${API_BASE_URL}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, name }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    return data;
}

export async function loginUser(email, password) {
    const response = await fetch(`${API_BASE_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    return data;
}

export async function addMachine(machineId, machinePassword, machineName) {
    return apiRequest('/api/auth/add-machine', 'POST', { machineId, machinePassword, machineName });
}

export async function loginMachine(machineId, machinePassword) {
    return apiRequest('/api/auth/login-machine', 'POST', { machineId, machinePassword });
}

export async function saveFcmToken(token) {
    return apiRequest('/api/auth/fcm-token', 'POST', { token });
}

// Door APIs
export async function unlockDoor(machineId) {
    return apiRequest('/api/door/unlock', 'POST', { machineId });
}

export async function lockDoor(machineId) {
    return apiRequest('/api/door/lock', 'POST', { machineId });
}

export async function getDoorStatus(machineId) {
    return apiRequest(`/api/door/status/${machineId}`);
}

export async function getActivityLogs(machineId) {
    return apiRequest(`/api/door/logs/${machineId}`);
}

// Camera APIs
export async function captureImage(machineId) {
    return apiRequest(`/api/camera/capture/${machineId}`);
}

export async function getStreamUrl(machineId) {
    return apiRequest(`/api/camera/stream-url/${machineId}`);
}

// Notification APIs
export async function getNotifications(machineId) {
    const query = machineId ? `?machineId=${machineId}` : '';
    return apiRequest(`/api/notification/list${query}`);
}

export async function getUnreadCount(machineId) {
    const query = machineId ? `?machineId=${machineId}` : '';
    return apiRequest(`/api/notification/unread-count${query}`);
}

export async function markNotificationRead(notificationId) {
    return apiRequest(`/api/notification/mark-read/${notificationId}`, 'PUT');
}

export async function markAllRead() {
    return apiRequest('/api/notification/mark-all-read', 'PUT');
}

export async function registerPushToken(machineId, token) {
    return apiRequest('/api/notification/register-push-token', 'POST', { machineId, token });
}

// Voice / Intercom APIs
export async function sendOwnerMessage(machineId, message) {
    return apiRequest('/api/voice/owner-say', 'POST', { machineId, message });
}

// Settings APIs (auto-response + preset replies)
export async function getSettings(machineId) {
    return apiRequest(`/api/settings/${machineId}`);
}

// Family member APIs
export async function getFamilyMembers(machineId) {
    return apiRequest(`/api/family/list?machineId=${machineId}`);
}

export async function addFamilyMember(machineId, name, relationship, imageUri) {
    const formData = new FormData();
    formData.append('machineId', machineId);
    formData.append('name', name);
    formData.append('relationship', relationship || 'family');

    if (Platform.OS === 'web') {
        // On web, imageUri is a blob: URL — fetch it to get a real Blob, then append as a File
        const res = await fetch(imageUri);
        const blob = await res.blob();
        const filename = `family_${Date.now()}.jpg`;
        const file = new File([blob], filename, { type: blob.type || 'image/jpeg' });
        formData.append('image', file, filename);
    } else {
        // On native, use React Native's { uri, name, type } FormData format
        const filename = imageUri.split('/').pop();
        const match = /\.(\w+)$/.exec(filename);
        const type = match ? `image/${match[1]}` : 'image/jpeg';
        formData.append('image', { uri: imageUri, name: filename || 'photo.jpg', type });
    }

    return apiUpload('/api/family/add', formData);
}

export async function deleteFamilyMember(machineId, memberId) {
    return apiRequest(`/api/family/remove/${memberId}?machineId=${machineId}`, 'DELETE');
}

export async function updateSettings(machineId, settings) {
    return apiRequest(`/api/settings/${machineId}`, 'PUT', settings);
}

export async function sendOwnerAudio(machineId, audioUri) {
    const formData = new FormData();
    formData.append('machineId', machineId);
    formData.append('audio', {
        uri: audioUri,
        name: 'voice.m4a',
        type: 'audio/m4a',
    });
    return apiUpload('/api/voice/owner-audio', formData);
}

// WebSocket connection
export function createWebSocket(userId, machineId, onMessage) {
    try {
        const ws = new WebSocket(WS_URL);

        ws.onopen = () => {
            console.log('[WS] Connected');
            ws.send(JSON.stringify({
                type: 'app_connect',
                userId,
                machineId,
            }));
        };

        ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                onMessage(data);
            } catch (err) {
                console.error('[WS] Parse error:', err);
            }
        };

        ws.onerror = (error) => {
            console.error('[WS] Error:', error);
        };

        ws.onclose = () => {
            console.log('[WS] Disconnected, reconnecting in 5s...');
            setTimeout(() => {
                try { createWebSocket(userId, machineId, onMessage); } catch (e) { /* ignore */ }
            }, 5000);
        };

        return ws;
    } catch (err) {
        console.warn('[WS] Failed to create WebSocket:', err.message);
        return null;
    }
}
