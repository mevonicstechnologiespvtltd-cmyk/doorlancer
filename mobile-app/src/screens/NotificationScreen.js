import React, { useState, useEffect } from 'react';
import {
    View, Text, TouchableOpacity, StyleSheet, FlatList, Image, ActivityIndicator, RefreshControl
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { getNotifications, markNotificationRead, markAllRead, createWebSocket } from '../services/api';

export default function NotificationScreen({ navigation, machineId }) {
    const [notifications, setNotifications] = useState([]);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);

    useEffect(() => {
        loadNotifications();
    }, []);

    // Reload every time the user navigates to this tab
    useFocusEffect(
        React.useCallback(() => {
            loadNotifications();
        }, [machineId])
    );

    // Live updates: refresh when a new doorbell/voice event arrives via WebSocket
    useEffect(() => {
        if (!machineId) return;
        let ws;
        try {
            ws = createWebSocket(machineId, machineId, (data) => {
                if (
                    data?.type === 'doorbell_voice' ||
                    data?.type === 'doorbell_alert' ||
                    data?.type === 'doorbell' ||
                    data?.type === 'visitor' ||
                    data?.type === 'family_arrival'
                ) {
                    loadNotifications();
                }
            });
        } catch (e) { /* ignore */ }
        return () => { try { ws && ws.close && ws.close(); } catch (e) {} };
    }, [machineId]);

    async function loadNotifications() {
        try {
            const data = await getNotifications(machineId);
            setNotifications(data.notifications || []);
        } catch (err) {
            console.error('Load notifications error:', err);
            setNotifications([]);
        } finally {
            setLoading(false);
            setRefreshing(false);
        }
    }

    async function handlePress(notification) {
        // Mark as read
        if (!notification.read) {
            try {
                await markNotificationRead(notification.id);
                setNotifications(prev =>
                    prev.map(n => n.id === notification.id ? { ...n, read: true } : n)
                );
            } catch (err) {
                console.error('Mark read error:', err);
            }
        }

        // Navigate to camera if it's a visitor notification
        if (notification.type === 'visitor' || notification.type === 'family_arrival') {
            navigation.navigate('Camera');
        }
    }

    async function handleMarkAllRead() {
        try {
            await markAllRead();
            setNotifications(prev => prev.map(n => ({ ...n, read: true })));
        } catch (err) {
            console.error('Mark all read error:', err);
        }
    }

    function getNotifIcon(type) {
        switch (type) {
            case 'visitor': return '🚶';
            case 'family_arrival': return '👨‍👩‍👧';
            case 'alert': return '⚠️';
            default: return '🔔';
        }
    }

    function getTimeAgo(dateStr) {
        const now = new Date();
        const date = new Date(dateStr);
        const diff = Math.floor((now - date) / 1000);

        if (diff < 60) return 'Just now';
        if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
        if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
        return `${Math.floor(diff / 86400)}d ago`;
    }

    function renderNotification({ item }) {
        return (
            <TouchableOpacity
                style={[styles.notifCard, !item.read && styles.unreadCard]}
                onPress={() => handlePress(item)}
            >
                <View style={styles.notifRow}>
                    <Text style={styles.notifIcon}>{getNotifIcon(item.type)}</Text>
                    <View style={styles.notifContent}>
                        <View style={styles.notifHeader}>
                            <Text style={[styles.notifTitle, !item.read && styles.unreadTitle]}>
                                {item.title}
                            </Text>
                            <Text style={styles.notifTime}>{getTimeAgo(item.createdAt)}</Text>
                        </View>
                        <Text style={styles.notifBody} numberOfLines={2}>{item.body}</Text>
                    </View>
                    {!item.read && <View style={styles.unreadDot} />}
                </View>

                {item.imageUrl && (
                    <Image
                        source={{ uri: item.imageUrl }}
                        style={styles.notifImage}
                        resizeMode="cover"
                    />
                )}
            </TouchableOpacity>
        );
    }

    if (loading) {
        return (
            <View style={styles.centered}>
                <ActivityIndicator size="large" color="#1a73e8" />
            </View>
        );
    }

    const unreadCount = notifications.filter(n => !n.read).length;

    return (
        <View style={styles.container}>
            {/* Header actions */}
            {unreadCount > 0 && (
                <TouchableOpacity style={styles.markAllBtn} onPress={handleMarkAllRead}>
                    <Text style={styles.markAllText}>Mark all as read ({unreadCount})</Text>
                </TouchableOpacity>
            )}

            <FlatList
                data={notifications}
                renderItem={renderNotification}
                keyExtractor={(item) => item.id}
                contentContainerStyle={notifications.length === 0 ? styles.emptyListContainer : styles.list}
                refreshControl={
                    <RefreshControl refreshing={refreshing} onRefresh={() => {
                        setRefreshing(true);
                        loadNotifications();
                    }} />
                }
                ListEmptyComponent={
                    <View style={styles.emptyState}>
                        <Text style={styles.emptyIcon}>🔔</Text>
                        <Text style={styles.emptyTitle}>No Notifications</Text>
                        <Text style={styles.emptyText}>
                            You'll receive alerts when someone visits your door. Pull down to refresh.
                        </Text>
                    </View>
                }
            />
        </View>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#f5f5f5' },
    centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },
    markAllBtn: {
        paddingHorizontal: 16,
        paddingVertical: 10,
        alignItems: 'flex-end',
    },
    markAllText: { color: '#1a73e8', fontSize: 14, fontWeight: '600' },
    list: { padding: 16, paddingTop: 4 },
    notifCard: {
        backgroundColor: '#fff',
        borderRadius: 12,
        padding: 14,
        marginBottom: 10,
        elevation: 1,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.1,
        shadowRadius: 2,
    },
    unreadCard: {
        backgroundColor: '#f0f7ff',
        borderLeftWidth: 3,
        borderLeftColor: '#1a73e8',
    },
    notifRow: { flexDirection: 'row', alignItems: 'flex-start' },
    notifIcon: { fontSize: 28, marginRight: 12 },
    notifContent: { flex: 1 },
    notifHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    notifTitle: { fontSize: 15, fontWeight: '500', color: '#333', flex: 1 },
    unreadTitle: { fontWeight: 'bold' },
    notifTime: { fontSize: 11, color: '#999', marginLeft: 8 },
    notifBody: { fontSize: 13, color: '#666', marginTop: 4 },
    unreadDot: {
        width: 8,
        height: 8,
        borderRadius: 4,
        backgroundColor: '#1a73e8',
        marginTop: 6,
        marginLeft: 8,
    },
    notifImage: {
        width: '100%',
        height: 150,
        borderRadius: 8,
        marginTop: 10,
        backgroundColor: '#e0e0e0',
    },
    emptyState: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 40 },
    emptyListContainer: { flexGrow: 1, justifyContent: 'center' },
    emptyIcon: { fontSize: 60 },
    emptyTitle: { fontSize: 20, fontWeight: 'bold', color: '#333', marginTop: 16 },
    emptyText: { fontSize: 14, color: '#666', textAlign: 'center', marginTop: 8 },
});
