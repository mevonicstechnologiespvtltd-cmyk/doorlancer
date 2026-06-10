import React, { useState, useEffect, useRef } from 'react';
import {
    View, Text, TouchableOpacity, StyleSheet, Alert, ActivityIndicator, Image, Platform,
    TextInput, KeyboardAvoidingView, ScrollView
} from 'react-native';
import { Audio } from 'expo-av';
import { captureImage, getStreamUrl, unlockDoor, sendOwnerMessage, sendOwnerAudio, createWebSocket, getSettings } from '../services/api';

export default function CameraViewScreen({ machineId }) {
    const [imageData, setImageData] = useState(null);
    const [streamUrl, setStreamUrl] = useState(null);
    const [loading, setLoading] = useState(true);
    const [capturing, setCapturing] = useState(false);
    const [unlocking, setUnlocking] = useState(false);
    const [liveMode, setLiveMode] = useState(false);
    const [intercomMessage, setIntercomMessage] = useState('');
    const [sendingMessage, setSendingMessage] = useState(false);
    const [intercomStatus, setIntercomStatus] = useState('');
    const [isRecording, setIsRecording] = useState(false);
    const [visitorEvents, setVisitorEvents] = useState([]); // live transcript feed
    const [presets, setPresets] = useState([]);
    const [autoResponse, setAutoResponse] = useState(true);
    const [awaitingOwner, setAwaitingOwner] = useState(null); // {transcript, timestamp} or null
    const recordingRef = useRef(null);

    useEffect(() => {
        init();
        loadSettings();
    }, []);

    async function loadSettings() {
        if (!machineId) return;
        try {
            const s = await getSettings(machineId);
            setAutoResponse(s.autoResponse !== false);
            setPresets(Array.isArray(s.presetReplies) ? s.presetReplies : []);
        } catch (e) { /* ignore */ }
    }

    // Live updates from device mic (visitor speaking) -> WebSocket -> show transcript
    useEffect(() => {
        if (!machineId) return;
        let ws;
        try {
            ws = createWebSocket(machineId, machineId, (data) => {
                if (!data || !data.type) return;

                // Settings changed elsewhere
                if (data.type === 'settings_updated') {
                    if (typeof data.autoResponse === 'boolean') setAutoResponse(data.autoResponse);
                    if (Array.isArray(data.presetReplies)) setPresets(data.presetReplies);
                    return;
                }

                // Visitor needs manual reply
                if (data.type === 'doorbell_awaiting_owner') {
                    setAwaitingOwner({
                        transcript: data.transcript || '',
                        timestamp: data.timestamp || new Date().toISOString(),
                    });
                    setVisitorEvents((prev) => [
                        {
                            id: Date.now() + '-' + Math.random().toString(36).slice(2, 7),
                            transcript: data.transcript || '',
                            response: '',
                            visitorName: null,
                            visitorType: 'unknown',
                            timestamp: data.timestamp || new Date().toISOString(),
                            awaiting: true,
                        },
                        ...prev,
                    ].slice(0, 5));
                    handleCapture(true, machineId);
                    return;
                }

                if (
                    data.type === 'doorbell_voice' ||
                    data.type === 'doorbell_alert' ||
                    data.type === 'doorbell' ||
                    data.type === 'visitor'
                ) {
                    setVisitorEvents((prev) => [
                        {
                            id: Date.now() + '-' + Math.random().toString(36).slice(2, 7),
                            transcript: data.transcript || '',
                            response: data.response || '',
                            visitorName: data.visitorName || null,
                            visitorType: data.visitorType || 'unknown',
                            timestamp: data.timestamp || new Date().toISOString(),
                        },
                        ...prev,
                    ].slice(0, 5));
                    // Auto-refresh snapshot when someone is at the door
                    handleCapture(true, machineId);
                }
            });
        } catch (e) { /* ignore */ }
        return () => { try { ws && ws.close && ws.close(); } catch (e) {} };
    }, [machineId]);

    async function init() {
        try {
            try {
                const urlData = await getStreamUrl(machineId);
                if (urlData.streamUrl) setStreamUrl(urlData.streamUrl);
            } catch (err) {
                console.log('Stream URL not available');
            }

            await handleCapture(false, machineId);
        } catch (err) {
            console.error('Camera init error:', err);
        } finally {
            setLoading(false);
        }
    }

    async function handleCapture(silent = false, mId = null) {
        const id = mId || machineId;
        if (!id) return;

        if (!silent) setCapturing(true);
        try {
            const data = await captureImage(id);
            setImageData(data.image);
        } catch (err) {
            if (!silent) {
                if (Platform.OS === 'web') {
                    window.alert('Camera Error: ' + err.message);
                } else {
                    Alert.alert('Camera Error', err.message);
                }
            }
        } finally {
            if (!silent) setCapturing(false);
        }
    }

    function toggleLive() {
        if (liveMode) {
            setLiveMode(false);
        } else if (streamUrl) {
            setLiveMode(true);
        } else {
            if (Platform.OS === 'web') {
                window.alert('Stream not available. Make sure ESP-CAM is online.');
            } else {
                Alert.alert('Stream Unavailable', 'Make sure ESP-CAM is online.');
            }
        }
    }

    async function handleUnlock() {
        if (!machineId) return;
        setUnlocking(true);
        try {
            await unlockDoor(machineId);
            if (Platform.OS === 'web') {
                window.alert('Door Unlocked');
            } else {
                Alert.alert('Door Unlocked', 'The door has been unlocked');
            }
        } catch (err) {
            if (Platform.OS === 'web') {
                window.alert('Error: ' + err.message);
            } else {
                Alert.alert('Error', err.message);
            }
        } finally {
            setUnlocking(false);
        }
    }

    async function handleSendMessage() {
        if (!intercomMessage.trim() || !machineId) return;
        setSendingMessage(true);
        setIntercomStatus('Sending to door speaker...');
        try {
            await sendOwnerMessage(machineId, intercomMessage.trim());
            setIntercomStatus('Message played on speaker!');
            setIntercomMessage('');
            setAwaitingOwner(null);
            setTimeout(() => setIntercomStatus(''), 3000);
        } catch (err) {
            const msg = err.message || 'Failed to send';
            setIntercomStatus('');
            if (Platform.OS === 'web') {
                window.alert('Intercom Error: ' + msg);
            } else {
                Alert.alert('Intercom Error', msg);
            }
        } finally {
            setSendingMessage(false);
        }
    }

    async function handleSendPreset(preset) {
        if (!preset || !preset.text || !machineId) return;
        setSendingMessage(true);
        setIntercomStatus(`Sending: "${preset.label}"...`);
        try {
            await sendOwnerMessage(machineId, preset.text);
            setIntercomStatus(`✅ "${preset.label}" played on speaker`);
            setAwaitingOwner(null);
            setTimeout(() => setIntercomStatus(''), 3000);
        } catch (err) {
            const msg = err.message || 'Failed to send';
            setIntercomStatus('');
            if (Platform.OS === 'web') {
                window.alert('Intercom Error: ' + msg);
            } else {
                Alert.alert('Intercom Error', msg);
            }
        } finally {
            setSendingMessage(false);
        }
    }

    function handleVoiceInput() {
        if (Platform.OS === 'web') {
            // Web: use Speech Recognition to get text, then send as TTS
            const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
            if (!SpeechRecognition) {
                window.alert('Speech recognition not supported in this browser');
                return;
            }
            const recognition = new SpeechRecognition();
            recognition.lang = 'en-US';
            recognition.interimResults = false;
            setIntercomStatus('Listening...');
            setIsRecording(true);
            recognition.start();
            recognition.onresult = (e) => {
                const text = e.results[0][0].transcript;
                setIntercomMessage(text);
                setIntercomStatus('');
                setIsRecording(false);
            };
            recognition.onerror = () => { setIntercomStatus(''); setIsRecording(false); };
            recognition.onend = () => { setIsRecording(false); };
            return;
        }

        // Native: use expo-av recording
        if (isRecording) {
            stopRecording();
        } else {
            startRecording();
        }
    }

    async function startRecording() {
        try {
            const permission = await Audio.requestPermissionsAsync();
            if (!permission.granted) {
                Alert.alert('Permission Required', 'Microphone access is needed for voice messages.');
                return;
            }

            await Audio.setAudioModeAsync({
                allowsRecordingIOS: true,
                playsInSilentModeIOS: true,
            });

            const { recording } = await Audio.Recording.createAsync(
                Audio.RecordingOptionsPresets.HIGH_QUALITY
            );
            recordingRef.current = recording;
            setIsRecording(true);
            setIntercomStatus('Recording... Tap mic to stop');
        } catch (err) {
            console.error('Failed to start recording:', err);
            setIntercomStatus('');
            Alert.alert('Error', 'Could not start recording');
        }
    }

    async function stopRecording() {
        if (!recordingRef.current) return;

        setIsRecording(false);
        setSendingMessage(true);
        setIntercomStatus('Sending voice to speaker...');

        try {
            await recordingRef.current.stopAndUnloadAsync();
            const uri = recordingRef.current.getURI();
            recordingRef.current = null;

            await Audio.setAudioModeAsync({ allowsRecordingIOS: false });

            await sendOwnerAudio(machineId, uri);
            setIntercomStatus('Voice message played on speaker!');
            setTimeout(() => setIntercomStatus(''), 3000);
        } catch (err) {
            const msg = err.message || 'Failed to send voice';
            setIntercomStatus('');
            if (Platform.OS === 'web') {
                window.alert('Voice Error: ' + msg);
            } else {
                Alert.alert('Voice Error', msg);
            }
        } finally {
            setSendingMessage(false);
        }
    }

    if (loading) {
        return (
            <View style={styles.centered}>
                <ActivityIndicator size="large" color="#1a73e8" />
                <Text style={styles.loadingText}>Connecting to camera...</Text>
            </View>
        );
    }

    return (
        <View style={styles.container}>
            {/* Camera Feed */}
            <View style={styles.cameraContainer}>
                {liveMode && streamUrl ? (
                    Platform.OS === 'web' ? (
                        <img
                            src={streamUrl}
                            alt="Live Stream"
                            style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                        />
                    ) : (
                        <Image
                            source={{ uri: streamUrl }}
                            style={styles.cameraImage}
                            resizeMode="contain"
                        />
                    )
                ) : imageData ? (
                    <Image
                        source={{ uri: imageData }}
                        style={styles.cameraImage}
                        resizeMode="contain"
                    />
                ) : (
                    <View style={styles.noCamera}>
                        <Text style={styles.noCameraIcon}>📷</Text>
                        <Text style={styles.noCameraText}>Camera not available</Text>
                        <Text style={styles.noCameraSubtext}>Make sure ESP-CAM is online</Text>
                    </View>
                )}

                {liveMode && (
                    <View style={styles.liveIndicator}>
                        <View style={styles.liveDot} />
                        <Text style={styles.liveText}>LIVE</Text>
                    </View>
                )}

                {visitorEvents.length > 0 && (
                    <View style={styles.voicePill} pointerEvents="none">
                        <View style={styles.voicePillDot} />
                        <Text style={styles.voicePillText}>
                            {visitorEvents.length} voice {visitorEvents.length === 1 ? 'message' : 'messages'}
                        </Text>
                    </View>
                )}
            </View>

            {/* Visitor Voice Card (below camera) */}
            {visitorEvents.length > 0 && (
                <View style={styles.voiceCard}>
                    <View style={styles.voiceCardHeader}>
                        <View style={styles.voiceCardTitleRow}>
                            <Text style={styles.voiceCardTitle}>🎙️ Visitor Voice</Text>
                            <View style={styles.voiceCardCount}>
                                <Text style={styles.voiceCardCountText}>{visitorEvents.length}</Text>
                            </View>
                        </View>
                        <TouchableOpacity onPress={() => setVisitorEvents([])} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                            <Text style={styles.voiceCardClear}>Clear</Text>
                        </TouchableOpacity>
                    </View>
                    <ScrollView
                        style={styles.voiceCardScroll}
                        contentContainerStyle={{ paddingVertical: 6 }}
                        showsVerticalScrollIndicator={false}
                    >
                        {visitorEvents.map((ev) => (
                            <View key={ev.id} style={styles.voiceMsg}>
                                <View style={styles.voiceMsgMeta}>
                                    <View style={styles.voiceAvatar}>
                                        <Text style={styles.voiceAvatarText}>👤</Text>
                                    </View>
                                    <View style={{ flex: 1 }}>
                                        <Text style={styles.voiceMsgName} numberOfLines={1}>
                                            {ev.visitorName || 'Visitor'}
                                        </Text>
                                        <Text style={styles.voiceMsgTime}>
                                            {new Date(ev.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                        </Text>
                                    </View>
                                    {ev.awaiting && (
                                        <View style={styles.waitingBadge}>
                                            <Text style={styles.waitingBadgeText}>Awaiting reply</Text>
                                        </View>
                                    )}
                                </View>
                                {ev.transcript ? (
                                    <View style={styles.bubbleVisitor}>
                                        <Text style={styles.bubbleVisitorText}>{ev.transcript}</Text>
                                    </View>
                                ) : (
                                    <View style={styles.bubbleVisitor}>
                                        <Text style={styles.bubbleVisitorText}>🔔 Doorbell pressed</Text>
                                    </View>
                                )}
                                {ev.response ? (
                                    <View style={styles.bubbleAi}>
                                        <Text style={styles.bubbleAiLabel}>🤖 AI replied</Text>
                                        <Text style={styles.bubbleAiText}>{ev.response}</Text>
                                    </View>
                                ) : null}
                            </View>
                        ))}
                    </ScrollView>
                </View>
            )}

            {/* Camera Controls */}
            <View style={styles.controls}>
                <View style={styles.controlRow}>
                    <TouchableOpacity
                        style={[styles.btn, styles.captureBtn]}
                        onPress={() => handleCapture(false)}
                        disabled={capturing}
                    >
                        {capturing ? (
                            <ActivityIndicator color="#fff" size="small" />
                        ) : (
                            <Text style={styles.btnText}>📸 Capture</Text>
                        )}
                    </TouchableOpacity>

                    <TouchableOpacity
                        style={[styles.btn, liveMode ? styles.stopBtn : styles.liveBtn]}
                        onPress={toggleLive}
                    >
                        <Text style={styles.btnText}>
                            {liveMode ? '⏹ Stop' : '▶️ Live View'}
                        </Text>
                    </TouchableOpacity>
                </View>

                {/* Unlock Button */}
                <TouchableOpacity
                    style={[styles.unlockButton, unlocking && styles.buttonDisabled]}
                    onPress={handleUnlock}
                    disabled={unlocking}
                >
                    {unlocking ? (
                        <ActivityIndicator color="#fff" />
                    ) : (
                        <>
                            <Text style={styles.unlockIcon}>🔓</Text>
                            <Text style={styles.unlockText}>Unlock Door</Text>
                        </>
                    )}
                </TouchableOpacity>

                {/* Stream URL info */}
                {streamUrl && (
                    <View style={styles.infoBox}>
                        <Text style={styles.infoText}>
                            Direct stream available at: {streamUrl}
                        </Text>
                    </View>
                )}

                {/* Intercom Section */}
                <View style={styles.intercomSection}>
                    <View style={styles.intercomHeaderRow}>
                        <Text style={styles.intercomTitle}>🎙️ Speak to Visitor</Text>
                        <View style={[
                            styles.modeBadge,
                            autoResponse ? styles.modeBadgeAuto : styles.modeBadgeManual,
                        ]}>
                            <Text style={styles.modeBadgeText}>
                                {autoResponse ? '🤖 AUTO' : '👤 MANUAL'}
                            </Text>
                        </View>
                    </View>

                    {/* Awaiting-owner banner */}
                    {awaitingOwner && (
                        <View style={styles.awaitingBanner}>
                            <Text style={styles.awaitingTitle}>⏳ Visitor is waiting for your reply</Text>
                            {awaitingOwner.transcript ? (
                                <Text style={styles.awaitingText}>
                                    They said: "{awaitingOwner.transcript}"
                                </Text>
                            ) : null}
                            <TouchableOpacity onPress={() => setAwaitingOwner(null)}>
                                <Text style={styles.awaitingDismiss}>Dismiss</Text>
                            </TouchableOpacity>
                        </View>
                    )}

                    {/* Quick reply presets */}
                    {presets.length > 0 && (
                        <>
                            <Text style={styles.presetsLabel}>Quick replies</Text>
                            <View style={styles.presetsRow}>
                                {presets.map((p) => (
                                    <TouchableOpacity
                                        key={p.id}
                                        style={[styles.presetChip, sendingMessage && styles.buttonDisabled]}
                                        onPress={() => handleSendPreset(p)}
                                        disabled={sendingMessage}
                                    >
                                        <Text style={styles.presetChipText} numberOfLines={1}>
                                            {p.label}
                                        </Text>
                                    </TouchableOpacity>
                                ))}
                            </View>
                        </>
                    )}

                    {/* Voice Record Button */}
                    <TouchableOpacity
                        style={[styles.voiceBtn, isRecording && styles.voiceBtnRecording]}
                        onPress={handleVoiceInput}
                        disabled={sendingMessage}
                    >
                        {sendingMessage ? (
                            <ActivityIndicator color="#fff" size="small" />
                        ) : (
                            <>
                                <Text style={styles.voiceBtnIcon}>{isRecording ? '⏹' : '🎤'}</Text>
                                <Text style={styles.voiceBtnText}>
                                    {isRecording ? 'Stop & Send' : 'Hold to Speak'}
                                </Text>
                            </>
                        )}
                    </TouchableOpacity>

                    {/* Text Input + Send */}
                    <Text style={styles.orText}>or type a message</Text>
                    <View style={styles.intercomRow}>
                        <TextInput
                            style={styles.intercomInput}
                            placeholder="Type message for visitor..."
                            placeholderTextColor="#888"
                            value={intercomMessage}
                            onChangeText={setIntercomMessage}
                            editable={!sendingMessage}
                            onSubmitEditing={handleSendMessage}
                        />
                        <TouchableOpacity
                            style={[styles.sendBtn, (!intercomMessage.trim() || sendingMessage) && styles.buttonDisabled]}
                            onPress={handleSendMessage}
                            disabled={!intercomMessage.trim() || sendingMessage}
                        >
                            {sendingMessage ? (
                                <ActivityIndicator color="#fff" size="small" />
                            ) : (
                                <Text style={styles.sendBtnText}>Send</Text>
                            )}
                        </TouchableOpacity>
                    </View>
                    {intercomStatus ? (
                        <Text style={styles.intercomStatus}>{intercomStatus}</Text>
                    ) : null}
                </View>
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#000' },
    centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#111' },
    loadingText: { color: '#ccc', marginTop: 10 },
    cameraContainer: {
        flex: 1,
        backgroundColor: '#111',
        justifyContent: 'center',
        alignItems: 'center',
    },
    cameraImage: { width: '100%', height: '100%' },
    noCamera: { alignItems: 'center' },
    noCameraIcon: { fontSize: 60 },
    noCameraText: { color: '#fff', fontSize: 18, marginTop: 10 },
    noCameraSubtext: { color: '#888', fontSize: 13, marginTop: 5 },
    liveIndicator: {
        position: 'absolute',
        top: 16,
        right: 16,
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: 'rgba(244,67,54,0.9)',
        paddingHorizontal: 10,
        paddingVertical: 5,
        borderRadius: 12,
    },
    liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#fff', marginRight: 6 },
    liveText: { color: '#fff', fontSize: 12, fontWeight: 'bold' },

    /* Small pill on camera image when there are unread voice messages */
    voicePill: {
        position: 'absolute',
        top: 16,
        left: 16,
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: 'rgba(26,115,232,0.92)',
        paddingHorizontal: 10,
        paddingVertical: 5,
        borderRadius: 12,
    },
    voicePillDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#fff', marginRight: 6 },
    voicePillText: { color: '#fff', fontSize: 12, fontWeight: '600' },

    /* Visitor Voice card (below camera, above controls) */
    voiceCard: {
        backgroundColor: '#1a1a1a',
        marginHorizontal: 12,
        marginTop: 10,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: 'rgba(26,115,232,0.35)',
        maxHeight: 240,
        overflow: 'hidden',
    },
    voiceCardHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingHorizontal: 14,
        paddingTop: 10,
        paddingBottom: 6,
        borderBottomWidth: 1,
        borderBottomColor: 'rgba(255,255,255,0.06)',
    },
    voiceCardTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    voiceCardTitle: { color: '#fff', fontSize: 14, fontWeight: '700' },
    voiceCardCount: {
        backgroundColor: '#1a73e8',
        minWidth: 22,
        height: 22,
        borderRadius: 11,
        paddingHorizontal: 6,
        alignItems: 'center',
        justifyContent: 'center',
    },
    voiceCardCountText: { color: '#fff', fontSize: 11, fontWeight: '700' },
    voiceCardClear: { color: '#9ec5ff', fontSize: 12, fontWeight: '500' },
    voiceCardScroll: { paddingHorizontal: 12 },

    voiceMsg: { paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.04)' },
    voiceMsgMeta: { flexDirection: 'row', alignItems: 'center', marginBottom: 6 },
    voiceAvatar: {
        width: 28, height: 28, borderRadius: 14,
        backgroundColor: 'rgba(255,255,255,0.08)',
        alignItems: 'center', justifyContent: 'center',
        marginRight: 8,
    },
    voiceAvatarText: { fontSize: 14 },
    voiceMsgName: { color: '#fff', fontSize: 13, fontWeight: '600' },
    voiceMsgTime: { color: '#888', fontSize: 11, marginTop: 1 },
    waitingBadge: {
        backgroundColor: 'rgba(255,152,0,0.2)',
        borderColor: '#ff9800',
        borderWidth: 1,
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: 10,
    },
    waitingBadgeText: { color: '#ffb74d', fontSize: 10, fontWeight: '700' },
    bubbleVisitor: {
        backgroundColor: 'rgba(255,255,255,0.10)',
        borderTopLeftRadius: 4,
        borderTopRightRadius: 14,
        borderBottomRightRadius: 14,
        borderBottomLeftRadius: 14,
        paddingHorizontal: 12,
        paddingVertical: 8,
        alignSelf: 'flex-start',
        maxWidth: '92%',
        marginLeft: 36,
    },
    bubbleVisitorText: { color: '#fff', fontSize: 14, lineHeight: 19 },
    bubbleAi: {
        backgroundColor: 'rgba(26,115,232,0.18)',
        borderTopLeftRadius: 14,
        borderTopRightRadius: 4,
        borderBottomRightRadius: 14,
        borderBottomLeftRadius: 14,
        paddingHorizontal: 12,
        paddingVertical: 8,
        alignSelf: 'flex-end',
        maxWidth: '92%',
        marginTop: 6,
        marginRight: 4,
        borderWidth: 1,
        borderColor: 'rgba(26,115,232,0.4)',
    },
    bubbleAiLabel: { color: '#9ec5ff', fontSize: 10, fontWeight: '700', marginBottom: 2, textTransform: 'uppercase', letterSpacing: 0.5 },
    bubbleAiText: { color: '#fff', fontSize: 14, lineHeight: 19 },
    controls: {
        backgroundColor: '#1a1a1a',
        paddingHorizontal: 16,
        paddingVertical: 16,
        paddingBottom: 30,
    },
    controlRow: { flexDirection: 'row', gap: 12, marginBottom: 12 },
    btn: {
        flex: 1,
        paddingVertical: 14,
        borderRadius: 12,
        alignItems: 'center',
    },
    captureBtn: { backgroundColor: '#1a73e8' },
    liveBtn: { backgroundColor: '#4CAF50' },
    stopBtn: { backgroundColor: '#f44336' },
    btnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
    unlockButton: {
        backgroundColor: '#FF9800',
        borderRadius: 12,
        paddingVertical: 16,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
    },
    buttonDisabled: { opacity: 0.7 },
    unlockIcon: { fontSize: 22 },
    unlockText: { color: '#fff', fontSize: 18, fontWeight: 'bold' },
    infoBox: {
        backgroundColor: 'rgba(255,255,255,0.1)',
        borderRadius: 8,
        padding: 10,
        marginTop: 12,
    },
    infoText: { color: '#aaa', fontSize: 11 },
    intercomSection: {
        marginTop: 16,
        backgroundColor: 'rgba(255,255,255,0.08)',
        borderRadius: 12,
        padding: 12,
    },
    intercomTitle: { color: '#fff', fontSize: 16, fontWeight: '600', marginBottom: 10 },
    intercomHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
    modeBadge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12 },
    modeBadgeAuto: { backgroundColor: 'rgba(76,175,80,0.25)', borderWidth: 1, borderColor: '#4caf50' },
    modeBadgeManual: { backgroundColor: 'rgba(255,152,0,0.25)', borderWidth: 1, borderColor: '#ff9800' },
    modeBadgeText: { color: '#fff', fontSize: 11, fontWeight: 'bold' },
    awaitingBanner: {
        backgroundColor: 'rgba(255,152,0,0.18)',
        borderColor: '#ff9800',
        borderWidth: 1,
        borderRadius: 10,
        padding: 10,
        marginBottom: 12,
    },
    awaitingTitle: { color: '#ffb74d', fontWeight: 'bold', fontSize: 13 },
    awaitingText: { color: '#fff', fontSize: 13, marginTop: 4, fontStyle: 'italic' },
    awaitingDismiss: { color: '#1a73e8', fontSize: 12, marginTop: 6, alignSelf: 'flex-end' },
    presetsLabel: { color: '#bbb', fontSize: 11, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 },
    presetsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 },
    presetChip: {
        backgroundColor: '#1a73e8',
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 18,
        maxWidth: '100%',
    },
    presetChipText: { color: '#fff', fontSize: 13, fontWeight: '500' },
    voiceBtn: {
        backgroundColor: '#9C27B0',
        borderRadius: 14,
        paddingVertical: 16,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        marginBottom: 12,
    },
    voiceBtnRecording: {
        backgroundColor: '#f44336',
    },
    voiceBtnIcon: { fontSize: 24 },
    voiceBtnText: { color: '#fff', fontSize: 17, fontWeight: '700' },
    orText: { color: '#888', fontSize: 12, textAlign: 'center', marginBottom: 8 },
    intercomRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    intercomInput: {
        flex: 1,
        backgroundColor: '#333',
        color: '#fff',
        borderRadius: 10,
        paddingHorizontal: 14,
        paddingVertical: 10,
        fontSize: 15,
    },
    sendBtn: {
        backgroundColor: '#1a73e8',
        borderRadius: 10,
        paddingHorizontal: 18,
        paddingVertical: 10,
        alignItems: 'center',
        justifyContent: 'center',
    },
    sendBtnText: { color: '#fff', fontSize: 15, fontWeight: '600' },
    intercomStatus: { color: '#4CAF50', fontSize: 13, marginTop: 8 },
});
