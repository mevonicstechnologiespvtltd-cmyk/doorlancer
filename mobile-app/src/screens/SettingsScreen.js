import React, { useState, useEffect } from 'react';
import {
    View, Text, TouchableOpacity, StyleSheet, ScrollView, Switch, TextInput,
    ActivityIndicator, Alert, Platform, KeyboardAvoidingView,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { getSettings, updateSettings } from '../services/api';

export default function SettingsScreen({ machineId }) {
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [autoResponse, setAutoResponse] = useState(true);
    const [presets, setPresets] = useState([]);
    const [newLabel, setNewLabel] = useState('');
    const [newText, setNewText] = useState('');

    useEffect(() => { load(); }, [machineId]);

    useFocusEffect(
        React.useCallback(() => { load(); }, [machineId])
    );

    async function load() {
        if (!machineId) return;
        try {
            const data = await getSettings(machineId);
            setAutoResponse(data.autoResponse !== false);
            setPresets(Array.isArray(data.presetReplies) ? data.presetReplies : []);
        } catch (err) {
            console.error('Settings load error:', err);
        } finally {
            setLoading(false);
        }
    }

    function notify(title, msg) {
        if (Platform.OS === 'web') window.alert(`${title}: ${msg}`);
        else Alert.alert(title, msg);
    }

    async function persist(updated) {
        setSaving(true);
        try {
            await updateSettings(machineId, updated);
        } catch (err) {
            notify('Save Failed', err.message || 'Could not save settings');
            // revert by reloading
            load();
        } finally {
            setSaving(false);
        }
    }

    async function toggleAuto(value) {
        setAutoResponse(value);
        await persist({ autoResponse: value });
    }

    async function addPreset() {
        const text = newText.trim();
        if (!text) {
            notify('Missing text', 'Type the reply message.');
            return;
        }
        const label = (newLabel.trim() || text).slice(0, 30);
        const updated = [
            ...presets,
            { id: `p${Date.now()}`, label, text },
        ];
        setPresets(updated);
        setNewLabel('');
        setNewText('');
        await persist({ presetReplies: updated });
    }

    async function removePreset(id) {
        const updated = presets.filter((p) => p.id !== id);
        setPresets(updated);
        await persist({ presetReplies: updated });
    }

    async function updatePresetField(id, field, value) {
        const updated = presets.map((p) => p.id === id ? { ...p, [field]: value } : p);
        setPresets(updated);
    }

    async function savePresetEdits() {
        await persist({ presetReplies: presets });
    }

    if (loading) {
        return (
            <View style={styles.centered}>
                <ActivityIndicator size="large" color="#1a73e8" />
            </View>
        );
    }

    return (
        <KeyboardAvoidingView
            style={{ flex: 1 }}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
            <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 40 }}>
                {/* Auto-response card */}
                <View style={styles.card}>
                    <View style={styles.row}>
                        <View style={{ flex: 1 }}>
                            <Text style={styles.cardTitle}>🤖 Auto Response</Text>
                            <Text style={styles.cardSubtitle}>
                                {autoResponse
                                    ? 'AI will speak to visitors automatically.'
                                    : 'You will be notified to reply manually from the Live Camera screen.'}
                            </Text>
                        </View>
                        <Switch
                            value={autoResponse}
                            onValueChange={toggleAuto}
                            trackColor={{ false: '#ccc', true: '#1a73e8' }}
                            thumbColor="#fff"
                            disabled={saving}
                        />
                    </View>
                </View>

                {/* Presets card */}
                <View style={styles.card}>
                    <Text style={styles.cardTitle}>💬 Default Replies</Text>
                    <Text style={styles.cardSubtitle}>
                        These appear as quick-reply buttons on the Live Camera screen and play through the door speaker.
                    </Text>

                    {presets.length === 0 ? (
                        <Text style={styles.empty}>No presets yet. Add one below.</Text>
                    ) : (
                        presets.map((p) => (
                            <View key={p.id} style={styles.presetItem}>
                                <TextInput
                                    style={styles.presetLabel}
                                    value={p.label}
                                    onChangeText={(v) => updatePresetField(p.id, 'label', v)}
                                    onBlur={savePresetEdits}
                                    placeholder="Label"
                                    placeholderTextColor="#888"
                                />
                                <TextInput
                                    style={styles.presetText}
                                    value={p.text}
                                    onChangeText={(v) => updatePresetField(p.id, 'text', v)}
                                    onBlur={savePresetEdits}
                                    placeholder="Reply message"
                                    placeholderTextColor="#888"
                                    multiline
                                />
                                <TouchableOpacity
                                    style={styles.removeBtn}
                                    onPress={() => removePreset(p.id)}
                                >
                                    <Text style={styles.removeBtnText}>🗑 Remove</Text>
                                </TouchableOpacity>
                            </View>
                        ))
                    )}

                    {/* Add new */}
                    <View style={styles.addBox}>
                        <Text style={styles.addTitle}>Add new reply</Text>
                        <TextInput
                            style={styles.input}
                            value={newLabel}
                            onChangeText={setNewLabel}
                            placeholder="Label (e.g. Coming)"
                            placeholderTextColor="#888"
                        />
                        <TextInput
                            style={[styles.input, { minHeight: 60 }]}
                            value={newText}
                            onChangeText={setNewText}
                            placeholder="What should the door say?"
                            placeholderTextColor="#888"
                            multiline
                        />
                        <TouchableOpacity
                            style={[styles.addBtn, (!newText.trim() || saving) && styles.btnDisabled]}
                            onPress={addPreset}
                            disabled={!newText.trim() || saving}
                        >
                            {saving ? (
                                <ActivityIndicator color="#fff" size="small" />
                            ) : (
                                <Text style={styles.addBtnText}>+ Add Preset</Text>
                            )}
                        </TouchableOpacity>
                    </View>
                </View>

                {saving ? (
                    <Text style={styles.savingText}>Saving…</Text>
                ) : null}
            </ScrollView>
        </KeyboardAvoidingView>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#f5f7fa' },
    centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },
    card: {
        backgroundColor: '#fff',
        marginHorizontal: 12,
        marginTop: 12,
        padding: 16,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: '#e0e6ef',
    },
    row: { flexDirection: 'row', alignItems: 'center' },
    cardTitle: { fontSize: 16, fontWeight: 'bold', color: '#222' },
    cardSubtitle: { fontSize: 12, color: '#666', marginTop: 4 },
    empty: { fontSize: 13, color: '#888', fontStyle: 'italic', marginTop: 12 },

    presetItem: {
        marginTop: 12,
        padding: 10,
        backgroundColor: '#f8fafc',
        borderRadius: 8,
        borderWidth: 1,
        borderColor: '#e2e8f0',
    },
    presetLabel: {
        fontSize: 14,
        fontWeight: '600',
        color: '#1a73e8',
        borderBottomWidth: 1,
        borderBottomColor: '#e2e8f0',
        paddingVertical: 4,
    },
    presetText: {
        fontSize: 14,
        color: '#222',
        paddingVertical: 6,
        marginTop: 4,
    },
    removeBtn: { alignSelf: 'flex-end', paddingVertical: 4, paddingHorizontal: 8 },
    removeBtnText: { color: '#d32f2f', fontSize: 12 },

    addBox: {
        marginTop: 16,
        paddingTop: 12,
        borderTopWidth: 1,
        borderTopColor: '#e0e6ef',
    },
    addTitle: { fontSize: 13, fontWeight: '600', color: '#444', marginBottom: 8 },
    input: {
        borderWidth: 1,
        borderColor: '#cfd8e3',
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 8,
        marginBottom: 8,
        fontSize: 14,
        color: '#222',
        backgroundColor: '#fff',
    },
    addBtn: {
        backgroundColor: '#1a73e8',
        paddingVertical: 12,
        borderRadius: 8,
        alignItems: 'center',
    },
    btnDisabled: { backgroundColor: '#9bb8e0' },
    addBtnText: { color: '#fff', fontWeight: 'bold' },

    savingText: { textAlign: 'center', color: '#888', marginTop: 8, fontSize: 12 },
});
