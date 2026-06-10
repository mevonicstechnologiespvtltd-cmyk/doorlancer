import React, { useState, useCallback } from 'react';
import {
    View, Text, TouchableOpacity, StyleSheet, FlatList, Image,
    TextInput, Alert, ActivityIndicator, Platform, Modal, ScrollView,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { useFocusEffect } from '@react-navigation/native';
import { getFamilyMembers, addFamilyMember, deleteFamilyMember, API_BASE_URL } from '../services/api';

export default function FamilyScreen({ machineId }) {
    const [members, setMembers] = useState([]);
    const [loading, setLoading] = useState(true);
    const [showAddModal, setShowAddModal] = useState(false);
    const [name, setName] = useState('');
    const [relationship, setRelationship] = useState('');
    const [imageUri, setImageUri] = useState(null);
    const [saving, setSaving] = useState(false);

    useFocusEffect(
        useCallback(() => { loadMembers(); }, [machineId])
    );

    async function loadMembers() {
        if (!machineId) return;
        try {
            setLoading(true);
            const data = await getFamilyMembers(machineId);
            setMembers(data.family || []);
        } catch (err) {
            console.error('Load family error:', err);
        } finally {
            setLoading(false);
        }
    }

    function notify(title, msg) {
        if (Platform.OS === 'web') window.alert(`${title}: ${msg}`);
        else Alert.alert(title, msg);
    }

    async function pickFromGallery() {
        // On web, the browser handles file access natively — no permission prompt needed
        if (Platform.OS !== 'web') {
            const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
            if (status !== 'granted') { notify('Permission needed', 'Camera roll access is required.'); return; }
        }
        const result = await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ImagePicker.MediaTypeOptions.Images,
            allowsEditing: Platform.OS !== 'web', // crop UI not reliable on web
            aspect: [1, 1],
            quality: 0.8,
        });
        if (!result.canceled && result.assets?.[0]) setImageUri(result.assets[0].uri);
    }

    async function takePhoto() {
        if (Platform.OS === 'web') { notify('Not supported', 'Use Gallery to select a photo on web.'); return; }
        const { status } = await ImagePicker.requestCameraPermissionsAsync();
        if (status !== 'granted') { notify('Permission needed', 'Camera access is required.'); return; }
        const result = await ImagePicker.launchCameraAsync({
            allowsEditing: true,
            aspect: [1, 1],
            quality: 0.8,
        });
        if (!result.canceled && result.assets?.[0]) setImageUri(result.assets[0].uri);
    }

    async function handleAdd() {
        if (!name.trim()) { notify('Missing name', 'Please enter a name.'); return; }
        if (!imageUri) { notify('Missing photo', 'Please select a clear face photo.'); return; }
        setSaving(true);
        try {
            await addFamilyMember(machineId, name.trim(), relationship.trim() || 'family', imageUri);
            setName(''); setRelationship(''); setImageUri(null);
            setShowAddModal(false);
            await loadMembers();
        } catch (err) {
            notify('Error', err.message || 'Failed to add member');
        } finally {
            setSaving(false);
        }
    }

    function confirmDelete(member) {
        if (Platform.OS === 'web') {
            if (window.confirm(`Remove ${member.name} from recognized family members?`)) handleDelete(member.id);
        } else {
            Alert.alert('Remove Member', `Remove ${member.name} from recognized family members?`, [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Remove', style: 'destructive', onPress: () => handleDelete(member.id) },
            ]);
        }
    }

    async function handleDelete(memberId) {
        try {
            await deleteFamilyMember(machineId, memberId);
            setMembers(prev => prev.filter(m => m.id !== memberId));
        } catch (err) {
            notify('Error', err.message || 'Failed to remove member');
        }
    }

    function closeModal() {
        setShowAddModal(false);
        setName(''); setRelationship(''); setImageUri(null);
    }

    function renderMember({ item }) {
        const imgUrl = item.imageUrl ? `${API_BASE_URL}${item.imageUrl}` : null;
        return (
            <View style={styles.memberCard}>
                {imgUrl ? (
                    <Image source={{ uri: imgUrl }} style={styles.memberPhoto} />
                ) : (
                    <View style={[styles.memberPhoto, styles.memberPhotoPlaceholder]}>
                        <Text style={{ fontSize: 28 }}>👤</Text>
                    </View>
                )}
                <View style={styles.memberInfo}>
                    <Text style={styles.memberName}>{item.name}</Text>
                    <Text style={styles.memberRelation}>{item.relationship || 'Family'}</Text>
                    <Text style={styles.memberStatus}>✅ Auto-unlock enabled</Text>
                </View>
                <TouchableOpacity onPress={() => confirmDelete(item)} style={styles.deleteBtn}>
                    <Text style={{ fontSize: 20 }}>🗑️</Text>
                </TouchableOpacity>
            </View>
        );
    }

    return (
        <View style={styles.container}>
            <View style={styles.header}>
                <Text style={styles.headerTitle}>Recognized Family Members</Text>
                <Text style={styles.headerSub}>Door unlocks automatically when they appear at camera</Text>
            </View>

            {loading ? (
                <ActivityIndicator size="large" color="#1a73e8" style={{ marginTop: 40 }} />
            ) : members.length === 0 ? (
                <View style={styles.empty}>
                    <Text style={styles.emptyIcon}>👨‍👩‍👧</Text>
                    <Text style={styles.emptyText}>No family members added</Text>
                    <Text style={styles.emptySub}>
                        Add clear face photos of family members. The camera will recognize them and unlock the door automatically.
                    </Text>
                </View>
            ) : (
                <FlatList
                    data={members}
                    keyExtractor={item => item.id}
                    renderItem={renderMember}
                    contentContainerStyle={{ padding: 16, paddingBottom: 100 }}
                />
            )}

            <TouchableOpacity style={styles.addButton} onPress={() => setShowAddModal(true)}>
                <Text style={styles.addButtonText}>+ Add Family Member</Text>
            </TouchableOpacity>

            <Modal visible={showAddModal} animationType="slide" transparent onRequestClose={closeModal}>
                <View style={styles.modalOverlay}>
                    <View style={styles.modalContent}>
                        <ScrollView keyboardShouldPersistTaps="handled">
                            <Text style={styles.modalTitle}>Add Family Member</Text>

                            <TouchableOpacity style={styles.photoPickerBox} onPress={pickFromGallery}>
                                {imageUri ? (
                                    <Image source={{ uri: imageUri }} style={styles.photoPreview} />
                                ) : (
                                    <View style={styles.photoPickerPlaceholder}>
                                        <Text style={{ fontSize: 36, marginBottom: 4 }}>📷</Text>
                                        <Text style={styles.photoPickerText}>Tap to select photo</Text>
                                    </View>
                                )}
                            </TouchableOpacity>

                            <View style={styles.photoButtons}>
                                <TouchableOpacity style={styles.photoBtn} onPress={pickFromGallery}>
                                    <Text style={styles.photoBtnText}>📁 Gallery</Text>
                                </TouchableOpacity>
                                <TouchableOpacity style={styles.photoBtn} onPress={takePhoto}>
                                    <Text style={styles.photoBtnText}>📷 Camera</Text>
                                </TouchableOpacity>
                            </View>

                            <TextInput
                                style={styles.input}
                                placeholder="Full name *"
                                value={name}
                                onChangeText={setName}
                                placeholderTextColor="#999"
                            />
                            <TextInput
                                style={styles.input}
                                placeholder="Relationship (e.g. spouse, child)"
                                value={relationship}
                                onChangeText={setRelationship}
                                placeholderTextColor="#999"
                            />

                            <Text style={styles.tipText}>
                                💡 Use a clear, well-lit face photo for best recognition accuracy.
                            </Text>

                            <View style={styles.modalButtons}>
                                <TouchableOpacity style={[styles.modalBtn, styles.cancelBtn]} onPress={closeModal}>
                                    <Text style={styles.cancelBtnText}>Cancel</Text>
                                </TouchableOpacity>
                                <TouchableOpacity
                                    style={[styles.modalBtn, styles.saveBtn, saving && styles.disabledBtn]}
                                    onPress={handleAdd}
                                    disabled={saving}
                                >
                                    {saving
                                        ? <ActivityIndicator color="#fff" size="small" />
                                        : <Text style={styles.saveBtnText}>Save</Text>
                                    }
                                </TouchableOpacity>
                            </View>
                        </ScrollView>
                    </View>
                </View>
            </Modal>
        </View>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#f5f5f5' },
    header: { backgroundColor: '#1a73e8', padding: 16, paddingTop: 20 },
    headerTitle: { color: '#fff', fontSize: 18, fontWeight: 'bold' },
    headerSub: { color: '#cce0ff', fontSize: 12, marginTop: 3 },
    empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
    emptyIcon: { fontSize: 64, marginBottom: 16 },
    emptyText: { fontSize: 18, fontWeight: 'bold', color: '#333', marginBottom: 8 },
    emptySub: { fontSize: 14, color: '#666', textAlign: 'center', lineHeight: 20 },
    memberCard: {
        flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff',
        borderRadius: 12, padding: 12, marginBottom: 10, elevation: 2,
        shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.1, shadowRadius: 3,
    },
    memberPhoto: { width: 60, height: 60, borderRadius: 30, backgroundColor: '#eee' },
    memberPhotoPlaceholder: { alignItems: 'center', justifyContent: 'center' },
    memberInfo: { flex: 1, marginLeft: 12 },
    memberName: { fontSize: 16, fontWeight: 'bold', color: '#333' },
    memberRelation: { fontSize: 13, color: '#666', marginTop: 2 },
    memberStatus: { fontSize: 12, color: '#34a853', marginTop: 4 },
    deleteBtn: { padding: 8 },
    addButton: {
        position: 'absolute', bottom: 16, left: 16, right: 16,
        backgroundColor: '#1a73e8', borderRadius: 12, paddingVertical: 14, alignItems: 'center',
        elevation: 4, shadowColor: '#1a73e8', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.3, shadowRadius: 4,
    },
    addButtonText: { color: '#fff', fontSize: 16, fontWeight: 'bold' },
    modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
    modalContent: {
        backgroundColor: '#fff', borderTopLeftRadius: 20, borderTopRightRadius: 20,
        padding: 20, maxHeight: '90%',
    },
    modalTitle: { fontSize: 20, fontWeight: 'bold', color: '#333', marginBottom: 16, textAlign: 'center' },
    photoPickerBox: { alignItems: 'center', marginBottom: 12 },
    photoPickerPlaceholder: {
        width: 120, height: 120, borderRadius: 60, backgroundColor: '#f0f0f0',
        borderWidth: 2, borderColor: '#ddd', borderStyle: 'dashed',
        alignItems: 'center', justifyContent: 'center',
    },
    photoPickerText: { fontSize: 12, color: '#666' },
    photoPreview: { width: 120, height: 120, borderRadius: 60 },
    photoButtons: { flexDirection: 'row', gap: 12, marginBottom: 16 },
    photoBtn: { flex: 1, backgroundColor: '#f0f0f0', borderRadius: 8, paddingVertical: 10, alignItems: 'center' },
    photoBtnText: { fontSize: 14, color: '#333' },
    input: {
        borderWidth: 1, borderColor: '#ddd', borderRadius: 8,
        padding: 12, fontSize: 16, marginBottom: 12, backgroundColor: '#fafafa', color: '#333',
    },
    tipText: { fontSize: 13, color: '#888', textAlign: 'center', marginBottom: 16, lineHeight: 18 },
    modalButtons: { flexDirection: 'row', gap: 12, marginTop: 4, marginBottom: 8 },
    modalBtn: { flex: 1, borderRadius: 8, paddingVertical: 14, alignItems: 'center' },
    cancelBtn: { backgroundColor: '#f0f0f0' },
    cancelBtnText: { color: '#333', fontSize: 16, fontWeight: '600' },
    saveBtn: { backgroundColor: '#1a73e8' },
    saveBtnText: { color: '#fff', fontSize: 16, fontWeight: 'bold' },
    disabledBtn: { opacity: 0.6 },
});
