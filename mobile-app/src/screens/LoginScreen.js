import React, { useState } from 'react';
import {
    View, Text, TextInput, TouchableOpacity, StyleSheet, Alert, KeyboardAvoidingView, Platform, ActivityIndicator, ScrollView
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { loginUser } from '../services/api';

export default function LoginScreen({ navigation, onLogin }) {
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [loading, setLoading] = useState(false);

    async function handleLogin() {
        if (!email.trim() || !password.trim()) {
            Alert.alert('Error', 'Please enter email and password');
            return;
        }

        setLoading(true);
        try {
            const data = await loginUser(email.trim(), password);

            await AsyncStorage.setItem('authToken', data.token);
            await AsyncStorage.setItem('userId', data.user.userId);
            await AsyncStorage.setItem('userName', data.user.name);
            await AsyncStorage.setItem('userEmail', data.user.email);

            if (data.machines && data.machines.length > 0) {
                // User already has machines, go to main app
                await AsyncStorage.setItem('machineId', data.machines[0].id);
                await AsyncStorage.setItem('machineName', data.machines[0].name);
                onLogin();
            } else {
                // User has no machines, go to add machine screen
                navigation.navigate('AddMachine');
            }
        } catch (err) {
            Alert.alert('Login Failed', err.message);
        } finally {
            setLoading(false);
        }
    }

    return (
        <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
            <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
                <View style={styles.header}>
                    <Text style={styles.icon}>🔐</Text>
                    <Text style={styles.title}>Doorlance</Text>
                    <Text style={styles.subtitle}>Secure your home with intelligence</Text>
                </View>

                <View style={styles.form}>
                    <Text style={styles.formTitle}>Login</Text>

                    <TextInput
                        style={styles.input}
                        placeholder="Email"
                        placeholderTextColor="#999"
                        value={email}
                        onChangeText={setEmail}
                        keyboardType="email-address"
                        autoCapitalize="none"
                        editable={!loading}
                    />

                    <TextInput
                        style={styles.input}
                        placeholder="Password"
                        placeholderTextColor="#999"
                        value={password}
                        onChangeText={setPassword}
                        secureTextEntry
                        editable={!loading}
                    />

                    <TouchableOpacity
                        style={[styles.button, loading && styles.buttonDisabled]}
                        onPress={handleLogin}
                        disabled={loading}
                    >
                        {loading ? (
                            <ActivityIndicator color="#fff" />
                        ) : (
                            <Text style={styles.buttonText}>Login</Text>
                        )}
                    </TouchableOpacity>

                    <TouchableOpacity
                        style={styles.linkButton}
                        onPress={() => navigation.navigate('Register')}
                        disabled={loading}
                    >
                        <Text style={styles.linkText}>Don't have an account? <Text style={styles.linkBold}>Register</Text></Text>
                    </TouchableOpacity>
                </View>
            </ScrollView>
        </KeyboardAvoidingView>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#1a73e8' },
    scrollContent: { flexGrow: 1, justifyContent: 'center' },
    header: { alignItems: 'center', paddingVertical: 40 },
    icon: { fontSize: 60 },
    title: { fontSize: 32, fontWeight: 'bold', color: '#fff', marginTop: 10 },
    subtitle: { fontSize: 14, color: 'rgba(255,255,255,0.8)', marginTop: 5 },
    form: {
        backgroundColor: '#fff',
        borderTopLeftRadius: 30,
        borderTopRightRadius: 30,
        paddingHorizontal: 30,
        paddingTop: 30,
        paddingBottom: 50,
        flex: 1,
    },
    formTitle: { fontSize: 24, fontWeight: 'bold', color: '#333', marginBottom: 25 },
    input: {
        backgroundColor: '#f5f5f5',
        borderRadius: 12,
        paddingHorizontal: 16,
        paddingVertical: 14,
        fontSize: 16,
        marginBottom: 15,
        color: '#333',
    },
    button: {
        backgroundColor: '#1a73e8',
        borderRadius: 12,
        paddingVertical: 16,
        alignItems: 'center',
        marginTop: 10,
    },
    buttonDisabled: { opacity: 0.7 },
    buttonText: { color: '#fff', fontSize: 18, fontWeight: 'bold' },
    linkButton: { alignItems: 'center', marginTop: 20 },
    linkText: { color: '#666', fontSize: 14 },
    linkBold: { color: '#1a73e8', fontWeight: 'bold' },
});
