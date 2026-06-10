import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { StatusBar } from 'expo-status-bar';
import { Text, View, TouchableOpacity } from 'react-native';

import MachineListScreen from './src/screens/MachineListScreen';
import AddMachineScreen from './src/screens/AddMachineScreen';
import DashboardScreen from './src/screens/DashboardScreen';
import CameraViewScreen from './src/screens/CameraViewScreen';
import NotificationScreen from './src/screens/NotificationScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import FamilyScreen from './src/screens/FamilyScreen';

const Stack = createNativeStackNavigator();
const Tab = createBottomTabNavigator();

function TabIcon({ label, focused }) {
    const icons = {
        Dashboard: '🏠',
        Camera: '📷',
        Alerts: '🔔',
        Family: '👨‍👩‍👧',
        Settings: '⚙️',
    };
    return (
        <View style={{ alignItems: 'center' }}>
            <Text style={{ fontSize: 22 }}>{icons[label] || '•'}</Text>
            <Text style={{ fontSize: 10, color: focused ? '#1a73e8' : '#888', fontWeight: focused ? 'bold' : 'normal' }}>
                {label}
            </Text>
        </View>
    );
}

function MachineTabs({ route }) {
    const { machineId, machineName } = route.params;
    return (
        <Tab.Navigator
            screenOptions={({ route: tabRoute }) => ({
                tabBarIcon: ({ focused }) => <TabIcon label={tabRoute.name} focused={focused} />,
                tabBarShowLabel: false,
                tabBarStyle: {
                    height: 65,
                    paddingBottom: 8,
                    paddingTop: 8,
                    backgroundColor: '#fff',
                    borderTopWidth: 1,
                    borderTopColor: '#e0e0e0',
                },
                headerStyle: { backgroundColor: '#1a73e8' },
                headerTintColor: '#fff',
                headerTitleStyle: { fontWeight: 'bold' },
            })}
        >
            <Tab.Screen name="Dashboard" options={{ title: machineName || 'Doorlance' }}>
                {(props) => <DashboardScreen {...props} machineId={machineId} machineName={machineName} />}
            </Tab.Screen>
            <Tab.Screen name="Camera" options={{ title: 'Live Camera' }}>
                {(props) => <CameraViewScreen {...props} machineId={machineId} />}
            </Tab.Screen>
            <Tab.Screen name="Alerts" options={{ title: 'Notifications' }}>
                {(props) => <NotificationScreen {...props} machineId={machineId} />}
            </Tab.Screen>
            <Tab.Screen name="Family" options={{ title: 'Family Access' }}>
                {(props) => <FamilyScreen {...props} machineId={machineId} />}
            </Tab.Screen>
            <Tab.Screen name="Settings" options={{ title: 'Auto Response & Replies' }}>
                {(props) => <SettingsScreen {...props} machineId={machineId} />}
            </Tab.Screen>
        </Tab.Navigator>
    );
}

export default function App() {
    return (
        <>
            <StatusBar style="light" />
            <NavigationContainer>
                <Stack.Navigator>
                    <Stack.Screen
                        name="Machines"
                        component={MachineListScreen}
                        options={({ navigation }) => ({
                            title: 'Doorlance',
                            headerStyle: { backgroundColor: '#1a73e8' },
                            headerTintColor: '#fff',
                            headerTitleStyle: { fontWeight: 'bold' },
                            headerRight: () => (
                                <TouchableOpacity onPress={() => navigation.navigate('AddMachine')} style={{ marginRight: 8 }}>
                                    <Text style={{ color: '#fff', fontSize: 28, fontWeight: '300' }}>+</Text>
                                </TouchableOpacity>
                            ),
                        })}
                    />
                    <Stack.Screen
                        name="AddMachine"
                        component={AddMachineScreen}
                        options={{
                            title: 'Add Machine',
                            headerStyle: { backgroundColor: '#1a73e8' },
                            headerTintColor: '#fff',
                            headerTitleStyle: { fontWeight: 'bold' },
                        }}
                    />
                    <Stack.Screen
                        name="MachineTabs"
                        component={MachineTabs}
                        options={{ headerShown: false }}
                    />
                </Stack.Navigator>
            </NavigationContainer>
        </>
    );
}
