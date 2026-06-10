import React, { useState } from 'react';
import {
    View, Text, TextInput, TouchableOpacity, StyleSheet, Alert, ActivityIndicator, KeyboardAvoidingView, Platform
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

const COLORS = ['#1a73e8', '#e91e63', '#9c27b0', '#FF9800', '#009688', '#4CAF50', '#795548', '#607D8B'];

export default function AddMachineScreen({ navigation }) {
    const [machineId, setMachineId] = useState('');
    const [password, setPassword] = useState('');
    const [name, setName] = useState('');
    const [loading, setLoading] = useState(false);

    function showAlert(title, message, onOk) {
        if (Platform.OS === 'web') {
            window.alert(`${title}\n${message}`);
            if (onOk) onOk();
        } else {
            const buttons = onOk
                ? [{ text: 'OK', onPress: onOk }]
                : [{ text: 'OK' }];
            Alert.alert(title, message, buttons);
        }
    }

    async function handleAdd() {
        const id = machineId.trim();
        const pass = password.trim();
        const machineName = name.trim() || id;

        if (!id) {
            showAlert('Error', 'Please enter the Machine ID');
            return;
        }
        if (!pass) {
            showAlert('Error', 'Please enter the Machine Password');
            return;
        }

        setLoading(true);
        try {
            // Check if already added
            const stored = await AsyncStorage.getItem('machines');
            const list = stored ? JSON.parse(stored) : [];

            if (list.some(m => m.id === id)) {
                showAlert('Already Added', 'This machine is already in your list');
                setLoading(false);
                return;
            }

            // Save machine locally
            const color = COLORS[list.length % COLORS.length];
            const newMachine = {
                id,
                password: pass,
                name: machineName,
                color,
                addedAt: new Date().toISOString(),
            };

            list.push(newMachine);
            await AsyncStorage.setItem('machines', JSON.stringify(list));

            showAlert('Success', `"${machineName}" has been added!`, () => navigation.goBack());
        } catch (err) {
            showAlert('Error', err.message || 'Failed to add machine');
        } finally {
            setLoading(false);
        }
    }

    return (
        <KeyboardAvoidingView
            style={styles.container}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
            <View style={styles.content}>
                <View style={styles.iconContainer}>
                    <Text style={styles.icon}>🔐</Text>
                </View>
                <Text style={styles.title}>Add Doorlance</Text>
                <Text style={styles.subtitle}>
                    Enter the machine ID and password found on your device or provided by the admin
                </Text>

                <View style={styles.form}>
                    <Text style={styles.label}>Machine ID *</Text>
                    <TextInput
                        style={styles.input}
                        placeholder="e.g. doorlance-001"
                        placeholderTextColor="#aaa"
                        value={machineId}
                        onChangeText={setMachineId}
                        autoCapitalize="none"
                        autoCorrect={false}
                    />

                    <Text style={styles.label}>Machine Password *</Text>
                    <TextInput
                        style={styles.input}
                        placeholder="Enter machine password"
                        placeholderTextColor="#aaa"
                        value={password}
                        onChangeText={setPassword}
                        secureTextEntry
                    />

                    <Text style={styles.label}>Display Name (optional)</Text>
                    <TextInput
                        style={styles.input}
                        placeholder="e.g. Front Door, Office Door"
                        placeholderTextColor="#aaa"
                        value={name}
                        onChangeText={setName}
                    />

                    <View style={styles.infoBox}>
                        <Text style={styles.infoTitle}>ℹ️  Where to find credentials?</Text>
                        <Text style={styles.infoText}>
                            Machine ID and Password are set in your ESP32 device's config.h file (MACHINE_ID and MACHINE_PASSWORD).
                        </Text>
                    </View>

                    <TouchableOpacity
                        style={[styles.addBtn, loading && styles.btnDisabled]}
                        onPress={handleAdd}
                        disabled={loading}
                    >
                        {loading ? (
                            <ActivityIndicator color="#fff" />
                        ) : (
                            <Text style={styles.addBtnText}>Add Machine</Text>
                        )}
                    </TouchableOpacity>
                </View>
            </View>
        </KeyboardAvoidingView>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#f5f5f5' },
    content: { flex: 1, padding: 24 },
    iconContainer: { alignItems: 'center', marginTop: 20 },
    icon: { fontSize: 60 },
    title: { fontSize: 24, fontWeight: 'bold', color: '#333', textAlign: 'center', marginTop: 16 },
    subtitle: { fontSize: 14, color: '#888', textAlign: 'center', marginTop: 8, lineHeight: 20, paddingHorizontal: 10 },
    form: { marginTop: 24 },
    label: { fontSize: 14, fontWeight: '600', color: '#555', marginBottom: 6, marginTop: 14 },
    input: {
        backgroundColor: '#fff',
        borderRadius: 12,
        paddingHorizontal: 16,
        paddingVertical: 14,
        fontSize: 16,
        color: '#333',
        borderWidth: 1,
        borderColor: '#e0e0e0',
    },
    infoBox: {
        backgroundColor: '#e8f0fe',
        borderRadius: 12,
        padding: 14,
        marginTop: 20,
    },
    infoTitle: { fontSize: 13, fontWeight: 'bold', color: '#1a73e8' },
    infoText: { fontSize: 12, color: '#555', marginTop: 4, lineHeight: 18 },
    addBtn: {
        backgroundColor: '#1a73e8',
        borderRadius: 12,
        paddingVertical: 16,
        alignItems: 'center',
        marginTop: 24,
    },
    btnDisabled: { opacity: 0.7 },
    addBtnText: { color: '#fff', fontSize: 17, fontWeight: 'bold' },
});
