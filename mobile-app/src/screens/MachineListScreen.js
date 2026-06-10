import React, { useState, useCallback } from 'react';
import {
    View, Text, TouchableOpacity, StyleSheet, FlatList, Alert
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFocusEffect } from '@react-navigation/native';

export default function MachineListScreen({ navigation }) {
    const [machines, setMachines] = useState([]);

    useFocusEffect(
        useCallback(() => {
            loadMachines();
        }, [])
    );

    async function loadMachines() {
        try {
            const stored = await AsyncStorage.getItem('machines');
            const list = stored ? JSON.parse(stored) : [];
            setMachines(list);
        } catch (err) {
            console.error('Load machines error:', err);
        }
    }

    function handleRemove(machine) {
        Alert.alert(
            'Remove Machine',
            `Remove "${machine.name}"? You can add it again later.`,
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Remove',
                    style: 'destructive',
                    onPress: async () => {
                        const updated = machines.filter(m => m.id !== machine.id);
                        await AsyncStorage.setItem('machines', JSON.stringify(updated));
                        setMachines(updated);
                    }
                }
            ]
        );
    }

    function renderMachine({ item }) {
        const initial = (item.name || item.id).charAt(0).toUpperCase();
        return (
            <TouchableOpacity
                style={styles.machineItem}
                onPress={() => navigation.navigate('MachineTabs', { machineId: item.id, machineName: item.name })}
                onLongPress={() => handleRemove(item)}
            >
                <View style={[styles.avatar, { backgroundColor: item.color || '#1a73e8' }]}>
                    <Text style={styles.avatarText}>{initial}</Text>
                </View>
                <View style={styles.machineInfo}>
                    <Text style={styles.machineName}>{item.name}</Text>
                    <Text style={styles.machineId}>ID: {item.id}</Text>
                </View>
                <Text style={styles.arrow}>›</Text>
            </TouchableOpacity>
        );
    }

    return (
        <View style={styles.container}>
            {machines.length === 0 ? (
                <View style={styles.emptyState}>
                    <Text style={styles.emptyIcon}>🚪</Text>
                    <Text style={styles.emptyTitle}>No Machines Added</Text>
                    <Text style={styles.emptyText}>
                        Add your Doorlance machine using its ID and password to get started
                    </Text>
                    <TouchableOpacity
                        style={styles.emptyAddBtn}
                        onPress={() => navigation.navigate('AddMachine')}
                    >
                        <Text style={styles.emptyAddText}>+ Add Machine</Text>
                    </TouchableOpacity>
                </View>
            ) : (
                <>
                    <FlatList
                        data={machines}
                        renderItem={renderMachine}
                        keyExtractor={(item) => item.id}
                        contentContainerStyle={styles.list}
                        ItemSeparatorComponent={() => <View style={styles.separator} />}
                    />
                    <Text style={styles.hint}>Long press to remove a machine</Text>
                </>
            )}
        </View>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#fff' },
    list: { paddingTop: 4 },
    machineItem: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 14,
    },
    avatar: {
        width: 52,
        height: 52,
        borderRadius: 26,
        alignItems: 'center',
        justifyContent: 'center',
    },
    avatarText: { color: '#fff', fontSize: 22, fontWeight: 'bold' },
    machineInfo: { flex: 1, marginLeft: 14 },
    machineName: { fontSize: 17, fontWeight: '600', color: '#111' },
    machineId: { fontSize: 13, color: '#888', marginTop: 2 },
    arrow: { fontSize: 28, color: '#ccc', paddingLeft: 8 },
    separator: { height: 1, backgroundColor: '#f0f0f0', marginLeft: 82 },
    hint: { textAlign: 'center', color: '#bbb', fontSize: 12, paddingVertical: 12 },
    emptyState: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 40 },
    emptyIcon: { fontSize: 70 },
    emptyTitle: { fontSize: 22, fontWeight: 'bold', color: '#333', marginTop: 20 },
    emptyText: { fontSize: 15, color: '#888', textAlign: 'center', marginTop: 10, lineHeight: 22 },
    emptyAddBtn: {
        marginTop: 28,
        backgroundColor: '#1a73e8',
        paddingHorizontal: 32,
        paddingVertical: 14,
        borderRadius: 12,
    },
    emptyAddText: { color: '#fff', fontSize: 16, fontWeight: 'bold' },
});
