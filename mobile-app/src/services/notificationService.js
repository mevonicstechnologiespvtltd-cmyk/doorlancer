import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { saveFcmToken } from './api';

// Configure notification behavior
Notifications.setNotificationHandler({
    handleNotification: async () => ({
        shouldShowAlert: true,
        shouldPlaySound: true,
        shouldSetBadge: true,
    }),
});

export async function setupNotifications() {
    try {
        // Request permissions
        const { status: existingStatus } = await Notifications.getPermissionsAsync();
        let finalStatus = existingStatus;

        if (existingStatus !== 'granted') {
            const { status } = await Notifications.requestPermissionsAsync();
            finalStatus = status;
        }

        if (finalStatus !== 'granted') {
            console.log('Notification permission not granted');
            return null;
        }

        // Get push token
        const tokenData = await Notifications.getExpoPushTokenAsync();
        const token = tokenData.data;
        console.log('Push token:', token);

        // Save token to backend
        try {
            await saveFcmToken(token);
        } catch (err) {
            console.log('Token save deferred (not logged in yet)');
        }

        // Android notification channel
        if (Platform.OS === 'android') {
            Notifications.setNotificationChannelAsync('door-alerts', {
                name: 'Door Alerts',
                importance: Notifications.AndroidImportance.MAX,
                vibrationPattern: [0, 250, 250, 250],
                lightColor: '#1a73e8',
                sound: 'default',
            });
        }

        return token;
    } catch (err) {
        console.error('Notification setup error:', err);
        return null;
    }
}

export function addNotificationListener(callback) {
    const subscription = Notifications.addNotificationReceivedListener(callback);
    return subscription;
}

export function addNotificationResponseListener(callback) {
    const subscription = Notifications.addNotificationResponseReceivedListener(callback);
    return subscription;
}
