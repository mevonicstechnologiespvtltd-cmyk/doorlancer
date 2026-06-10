import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
    View, Text, TouchableOpacity, StyleSheet, Alert, RefreshControl, ScrollView, ActivityIndicator, Platform
} from 'react-native';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { getDoorStatus, unlockDoor, lockDoor, createWebSocket, getUnreadCount, registerPushToken } from '../services/api';

// Configure how notifications appear when app is in foreground
Notifications.setNotificationHandler({
    handleNotification: async () => ({
        shouldShowAlert: true,
        shouldPlaySound: true,
        shouldSetBadge: true,
    }),
});

export default function DashboardScreen({ navigation, machineId, machineName }) {
    const [status, setStatus] = useState(null);
    const [loading, setLoading] = useState(true);
    const [actionLoading, setActionLoading] = useState(false);
    const [unreadCount, setUnreadCount] = useState(0);
    const [refreshing, setRefreshing] = useState(false);
    const notificationListener = useRef();
    const responseListener = useRef();

    useEffect(() => {
        loadData();
        setupPushNotifications();

        return () => {
            if (notificationListener.current) {
                Notifications.removeNotificationSubscription(notificationListener.current);
            }
            if (responseListener.current) {
                Notifications.removeNotificationSubscription(responseListener.current);
            }
        };
    }, []);

    async function setupPushNotifications() {
        try {
            // Skip on web — Expo push tokens only work on native devices
            if (Platform.OS === 'web') {
                console.log('[Push] Skipping push setup on web');
                return;
            }

            if (!Device.isDevice) {
                console.log('[Push] Must use physical device for push notifications');
                return;
            }

            const { status: existingStatus } = await Notifications.getPermissionsAsync();
            let finalStatus = existingStatus;
            if (existingStatus !== 'granted') {
                const { status } = await Notifications.requestPermissionsAsync();
                finalStatus = status;
            }
            if (finalStatus !== 'granted') {
                console.log('[Push] Permission not granted');
                return;
            }

            const projectId = Constants.expoConfig?.extra?.eas?.projectId;
            const tokenData = await Notifications.getExpoPushTokenAsync({
                projectId,
            });
            const pushToken = tokenData.data;
            console.log('[Push] Token:', pushToken);

            // Register token with backend
            await registerPushToken(machineId, pushToken);
            console.log('[Push] Token registered with backend');

            // Set up Android notification channel
            if (Platform.OS === 'android') {
                Notifications.setNotificationChannelAsync('doorbell', {
                    name: 'Doorbell',
                    importance: Notifications.AndroidImportance.MAX,
                    vibrationPattern: [0, 250, 250, 250],
                    sound: 'default',
                });
            }

            // Listen for notifications when app is in foreground
            notificationListener.current = Notifications.addNotificationReceivedListener(notification => {
                console.log('[Push] Notification received:', notification);
                loadUnreadCount();
            });

            // Listen for when user taps on notification
            responseListener.current = Notifications.addNotificationResponseReceivedListener(response => {
                const data = response.notification.request.content.data;
                console.log('[Push] Notification tapped:', data);
                if (data.type === 'doorbell') {
                    navigation.navigate('Camera');
                }
            });
        } catch (err) {
            console.error('[Push] Setup error:', err);
        }
    }

    useEffect(() => {
        // Setup WebSocket for real-time updates
        const ws = createWebSocket('default-user', machineId, handleWsMessage);
        return () => ws?.close();
    }, []);

    function showAlert(title, message, buttons) {
        if (Platform.OS === 'web') {
            const result = window.confirm(`${title}\n\n${message}`);
            if (result && buttons) {
                const action = buttons.find(b => b.text !== 'Ignore' && b.text !== 'Cancel');
                if (action?.onPress) action.onPress();
            }
        } else {
            Alert.alert(title, message, buttons);
        }
    }

    function handleWsMessage(data) {
        if (data.type === 'status' || data.type === 'heartbeat') {
            setStatus(prev => prev ? { ...prev, doorLocked: data.doorLocked } : prev);
        } else if (data.type === 'visitor_alert') {
            showAlert(
                '⚠️ Unknown Person at Door',
                data.description || 'An unknown person is at your door!',
                [
                    { text: 'Ignore', style: 'cancel' },
                    { text: 'View Camera', onPress: () => navigation.navigate('Camera') },
                ]
            );
            loadUnreadCount();
        } else if (data.type === 'family_arrival') {
            showAlert(
                '✅ Family Member Arrived',
                data.message || `${data.familyMember} is at the door. Door unlocked automatically.`,
                [{ text: 'OK' }]
            );
            setStatus(prev => prev ? { ...prev, doorLocked: false } : prev);
            loadUnreadCount();
        } else if (data.type === 'motion_alert' || data.type === 'motion_info') {
            console.log('[WS] Motion info:', data.message);
        } else if (data.type === 'doorbell_alert') {
            showAlert(
                '🔔 Doorbell Ringing!',
                data.message || 'Someone is at your door!',
                [
                    { text: 'Ignore', style: 'cancel' },
                    { text: 'View Camera', onPress: () => navigation.navigate('Camera') },
                    { text: 'Unlock Door', onPress: () => handleUnlock() },
                ]
            );
            loadUnreadCount();
        } else if (data.type === 'command_response') {
            if (data.command === 'unlock') {
                setStatus(prev => prev ? { ...prev, doorLocked: false } : prev);
            } else if (data.command === 'lock') {
                setStatus(prev => prev ? { ...prev, doorLocked: true } : prev);
            }
        }
    }

    async function loadData() {
        try {
            const statusData = await getDoorStatus(machineId);
            setStatus(statusData);
            await loadUnreadCount();
        } catch (err) {
            console.error('Load data error:', err);
        } finally {
            setLoading(false);
            setRefreshing(false);
        }
    }

    async function loadUnreadCount() {
        try {
            const data = await getUnreadCount(machineId);
            setUnreadCount(data.count);
        } catch (err) {
            console.error('Unread count error:', err);
        }
    }

    async function handleUnlock() {
        if (!machineId) return;
        setActionLoading(true);
        try {
            await unlockDoor(machineId);
            setStatus(prev => prev ? { ...prev, doorLocked: false } : prev);
        } catch (err) {
            Alert.alert('Error', err.message);
        } finally {
            setActionLoading(false);
        }
    }

    async function handleLock() {
        if (!machineId) return;
        setActionLoading(true);
        try {
            await lockDoor(machineId);
            setStatus(prev => prev ? { ...prev, doorLocked: true } : prev);
        } catch (err) {
            Alert.alert('Error', err.message);
        } finally {
            setActionLoading(false);
        }
    }

    const onRefresh = useCallback(() => {
        setRefreshing(true);
        loadData();
    }, []);

    if (loading) {
        return (
            <View style={styles.centered}>
                <ActivityIndicator size="large" color="#1a73e8" />
                <Text style={styles.loadingText}>Loading...</Text>
            </View>
        );
    }

    const isLocked = status?.doorLocked !== false;
    const esp32Online = status?.esp32Status === 'online';
    const cameraOnline = status?.espcamStatus === 'online';

    return (
        <ScrollView
            style={styles.container}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        >
            {/* Machine Info */}
            <View style={styles.machineCard}>
                <Text style={styles.machineName}>{machineName}</Text>
                <Text style={styles.machineIdText}>ID: {machineId}</Text>
            </View>

            {/* Door Lock Status */}
            <View style={[styles.lockCard, isLocked ? styles.lockedCard : styles.unlockedCard]}>
                <Text style={styles.lockIcon}>{isLocked ? '🔒' : '🔓'}</Text>
                <Text style={styles.lockStatus}>{isLocked ? 'LOCKED' : 'UNLOCKED'}</Text>
                <Text style={styles.lockSubtext}>
                    {isLocked ? 'Your door is secure' : 'Door is currently open'}
                </Text>
            </View>

            {/* Control Buttons */}
            <View style={styles.controlRow}>
                <TouchableOpacity
                    style={[styles.controlBtn, styles.unlockBtn]}
                    onPress={handleUnlock}
                    disabled={actionLoading}
                >
                    {actionLoading ? (
                        <ActivityIndicator color="#fff" />
                    ) : (
                        <>
                            <Text style={styles.controlIcon}>🔓</Text>
                            <Text style={styles.controlText}>Unlock</Text>
                        </>
                    )}
                </TouchableOpacity>

                <TouchableOpacity
                    style={[styles.controlBtn, styles.lockBtn]}
                    onPress={handleLock}
                    disabled={actionLoading}
                >
                    {actionLoading ? (
                        <ActivityIndicator color="#fff" />
                    ) : (
                        <>
                            <Text style={styles.controlIcon}>🔒</Text>
                            <Text style={styles.controlText}>Lock</Text>
                        </>
                    )}
                </TouchableOpacity>
            </View>

            {/* Device Status */}
            <View style={styles.statusSection}>
                <Text style={styles.sectionTitle}>Device Status</Text>

                <View style={styles.statusRow}>
                    <View style={styles.statusItem}>
                        <View style={[styles.statusDot, esp32Online ? styles.online : styles.offline]} />
                        <Text style={styles.statusLabel}>{machineName || 'Doorlance'}</Text>
                        <Text style={styles.statusValue}>{esp32Online ? 'Online' : 'Offline'}</Text>
                    </View>

                    <View style={styles.statusItem}>
                        <View style={[styles.statusDot, cameraOnline ? styles.online : styles.offline]} />
                        <Text style={styles.statusLabel}>Camera</Text>
                        <Text style={styles.statusValue}>{cameraOnline ? 'Online' : 'Offline'}</Text>
                    </View>
                </View>
            </View>

            {/* Quick Actions */}
            <View style={styles.quickSection}>
                <Text style={styles.sectionTitle}>Quick Actions</Text>

                <TouchableOpacity
                    style={styles.quickAction}
                    onPress={() => navigation.navigate('Camera')}
                >
                    <Text style={styles.quickIcon}>📷</Text>
                    <View style={styles.quickInfo}>
                        <Text style={styles.quickTitle}>View Camera</Text>
                        <Text style={styles.quickDesc}>See who's at the door</Text>
                    </View>
                    <Text style={styles.quickArrow}>›</Text>
                </TouchableOpacity>

                <TouchableOpacity
                    style={styles.quickAction}
                    onPress={() => navigation.navigate('Alerts')}
                >
                    <Text style={styles.quickIcon}>🔔</Text>
                    <View style={styles.quickInfo}>
                        <Text style={styles.quickTitle}>Notifications</Text>
                        <Text style={styles.quickDesc}>
                            {unreadCount > 0 ? `${unreadCount} unread alerts` : 'No new alerts'}
                        </Text>
                    </View>
                    {unreadCount > 0 && (
                        <View style={styles.badge}>
                            <Text style={styles.badgeText}>{unreadCount}</Text>
                        </View>
                    )}
                    <Text style={styles.quickArrow}>›</Text>
                </TouchableOpacity>
            </View>

            <View style={{ height: 30 }} />
        </ScrollView>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#f5f5f5' },
    centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },
    loadingText: { marginTop: 10, color: '#666' },
    machineCard: {
        backgroundColor: '#1a73e8',
        padding: 20,
        marginHorizontal: 16,
        marginTop: 16,
        borderRadius: 16,
    },
    machineName: { fontSize: 22, fontWeight: 'bold', color: '#fff' },
    machineIdText: { fontSize: 12, color: 'rgba(255,255,255,0.7)', marginTop: 4 },
    lockCard: {
        alignItems: 'center',
        padding: 30,
        marginHorizontal: 16,
        marginTop: 16,
        borderRadius: 16,
    },
    lockedCard: { backgroundColor: '#e8f5e9' },
    unlockedCard: { backgroundColor: '#fff3e0' },
    lockIcon: { fontSize: 60 },
    lockStatus: { fontSize: 28, fontWeight: 'bold', marginTop: 10, color: '#333' },
    lockSubtext: { fontSize: 14, color: '#666', marginTop: 5 },
    controlRow: {
        flexDirection: 'row',
        marginHorizontal: 16,
        marginTop: 16,
        gap: 12,
    },
    controlBtn: {
        flex: 1,
        paddingVertical: 18,
        borderRadius: 16,
        alignItems: 'center',
        flexDirection: 'row',
        justifyContent: 'center',
        gap: 8,
    },
    unlockBtn: { backgroundColor: '#4CAF50' },
    lockBtn: { backgroundColor: '#f44336' },
    controlIcon: { fontSize: 24 },
    controlText: { fontSize: 18, fontWeight: 'bold', color: '#fff' },
    statusSection: { marginHorizontal: 16, marginTop: 20 },
    sectionTitle: { fontSize: 18, fontWeight: 'bold', color: '#333', marginBottom: 12 },
    statusRow: { flexDirection: 'row', gap: 12 },
    statusItem: {
        flex: 1,
        backgroundColor: '#fff',
        borderRadius: 12,
        padding: 16,
        alignItems: 'center',
        elevation: 1,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.1,
        shadowRadius: 2,
    },
    statusDot: { width: 12, height: 12, borderRadius: 6, marginBottom: 8 },
    online: { backgroundColor: '#4CAF50' },
    offline: { backgroundColor: '#f44336' },
    statusLabel: { fontSize: 12, color: '#666' },
    statusValue: { fontSize: 14, fontWeight: 'bold', color: '#333', marginTop: 2 },
    quickSection: { marginHorizontal: 16, marginTop: 20 },
    quickAction: {
        backgroundColor: '#fff',
        borderRadius: 12,
        padding: 16,
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 10,
        elevation: 1,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.1,
        shadowRadius: 2,
    },
    quickIcon: { fontSize: 28, marginRight: 14 },
    quickInfo: { flex: 1 },
    quickTitle: { fontSize: 16, fontWeight: '600', color: '#333' },
    quickDesc: { fontSize: 12, color: '#666', marginTop: 2 },
    quickArrow: { fontSize: 24, color: '#ccc' },
    badge: {
        backgroundColor: '#f44336',
        borderRadius: 10,
        minWidth: 20,
        height: 20,
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: 8,
    },
    badgeText: { color: '#fff', fontSize: 11, fontWeight: 'bold' },
    logoutBtn: {
        marginHorizontal: 16,
        marginTop: 20,
        paddingVertical: 14,
        alignItems: 'center',
        borderRadius: 12,
        borderWidth: 1,
        borderColor: '#e0e0e0',
    },
    logoutText: { color: '#f44336', fontSize: 16, fontWeight: '600' },
});
