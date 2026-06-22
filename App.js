import React, { useState, useEffect } from 'react';
import { StyleSheet, Text, View, TextInput, Button, Alert, ActivityIndicator } from 'react-native';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import * as SecureStore from 'expo-secure-store';

const LOCATION_TASK = 'rider-location-upload';

// Must be defined at module level — TaskManager requires this to be outside any component.
// Uses raw fetch (not api()) because this runs in a background context with no access
// to the component's clearSession binding. Token is read fresh from SecureStore each tick.
TaskManager.defineTask(LOCATION_TASK, async ({ data, error }) => {
  if (error) { console.warn('Background location error:', error.message); return; }
  if (!data) return;
  const { locations } = data;
  const loc = locations[0];
  if (!loc) return;
  try {
    const savedToken = await SecureStore.getItemAsync('rider_token');
    if (!savedToken) return;
    await fetch(`${BASE_URL}/api/rider/location`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${savedToken}` },
      body: JSON.stringify({ lat: loc.coords.latitude, lng: loc.coords.longitude })
    });
  } catch (e) {
    console.warn('Background location upload failed:', e.message);
  }
});

const RENDER_FALLBACK = 'https://grocerease-backend-0uip.onrender.com';
const _configured = process.env.EXPO_PUBLIC_API_BASE_URL || process.env.API_BASE_URL;
if (_configured === 'https://api.grocereasetv.com') {
  console.warn('EXPO_PUBLIC_API_BASE_URL points to the dead domain api.grocereasetv.com — falling back to Render pilot URL');
}
const BASE_URL = (_configured && _configured !== 'https://api.grocereasetv.com')
  ? _configured
  : RENDER_FALLBACK;

// Temporary diagnostic: stores the last fetch error so callers can surface it.
let _lastFetchError = null;

// Central fetch wrapper — handles network failures and 401s in one place.
// skipAuthRedirect: true for login, where 401 means wrong credentials not expired session.
async function apiFetch(url, options, onUnauthorized, { skipAuthRedirect = false } = {}) {
  console.log('[apiFetch] →', url);  // DIAG: confirm exact URL
  let response;
  try {
    response = await fetch(url, options);
  } catch (e) {
    _lastFetchError = `${e.name}: ${e.message}`;
    console.warn('[apiFetch] fetch threw:', e.name, e.message, '\nURL:', url);
    return null;
  }
  if (response.status === 401) {
    if (!skipAuthRedirect) {
      await SecureStore.deleteItemAsync('rider_token');
      await SecureStore.deleteItemAsync('rider_session');
      onUnauthorized();
    }
    return null;
  }
  _lastFetchError = null;
  return response;
}

export default function App() {
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [rider, setRider] = useState(null);
  const [token, setToken] = useState(null);
  const [loading, setLoading] = useState(false);
  const [restoring, setRestoring] = useState(true);
  const [healthStatus, setHealthStatus] = useState('checking…');  // DIAG

  const clearSession = () => { setRider(null); setToken(null); };

  // Bind onUnauthorized once; every API call uses this instead of raw fetch
  const api = (url, options, flags) => apiFetch(url, options, clearSession, flags);

  const authHeaders = (tok) => ({
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${tok}`
  });

  // Restore session from secure storage on launch
  useEffect(() => {
    (async () => {
      try {
        const savedToken = await SecureStore.getItemAsync('rider_token');
        const savedRider = await SecureStore.getItemAsync('rider_session');
        if (savedToken && savedRider) {
          setToken(savedToken);
          setRider(JSON.parse(savedRider));
        }
      } catch (e) {
        console.warn('Session restore failed:', e.message);
      } finally {
        setRestoring(false);
      }
    })();
  }, []);

  // DIAG: probe health endpoint on mount to confirm basic reachability
  useEffect(() => {
    (async () => {
      const url = `${BASE_URL}/health`;
      try {
        const r = await fetch(url, { method: 'GET' });
        const text = await r.text();
        setHealthStatus(`HTTP ${r.status}: ${text.slice(0, 80)}`);
      } catch (e) {
        setHealthStatus(`${e.name}: ${e.message}`);
      }
    })();
  }, []);

  const handleLogin = async () => {
    if (!phone.trim() || !password.trim()) {
      Alert.alert('Required', 'Enter phone and password');
      return;
    }
    setLoading(true);
    try {
      const response = await api(`${BASE_URL}/api/rider/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, password })
      }, { skipAuthRedirect: true });
      if (!response) {
        const loginUrl = `${BASE_URL}/api/rider/login`;
        Alert.alert('Network error', `URL: ${loginUrl}\n\n${_lastFetchError || 'unknown error'}`);  // DIAG
        return;
      }
      const data = await response.json();
      if (!response.ok) {
        Alert.alert('Login failed', `HTTP ${response.status}: ${data.detail || 'Unknown error'}`);
      } else {
        setToken(data.token);
        setRider(data);
        await SecureStore.setItemAsync('rider_token', data.token);
        await SecureStore.setItemAsync('rider_session', JSON.stringify(data));
      }
    } catch (e) {
      Alert.alert('Network error', e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!rider || !token) return;

    const startTracking = async () => {
      const { status: fg } = await Location.requestForegroundPermissionsAsync();
      if (fg !== 'granted') { Alert.alert('Location permission denied'); return; }

      const { status: bg } = await Location.requestBackgroundPermissionsAsync();
      if (bg !== 'granted') {
        Alert.alert('Background location denied', 'Location will only update while the app is open.');
      }

      const already = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false);
      if (!already) {
        await Location.startLocationUpdatesAsync(LOCATION_TASK, {
          accuracy: Location.Accuracy.Balanced,
          timeInterval: 5000,
          distanceInterval: 0,
          showsBackgroundLocationIndicator: true,
          foregroundService: {
            notificationTitle: 'GrocerEase Rider',
            notificationBody: 'Tracking your location for active delivery',
          },
        });
      }
    };

    startTracking();
    return () => {
      Location.hasStartedLocationUpdatesAsync(LOCATION_TASK)
        .then(started => { if (started) Location.stopLocationUpdatesAsync(LOCATION_TASK); })
        .catch(() => {});
    };
  }, [rider, token]);

  const updateStatus = async (status) => {
    if (!rider?.current_order || !token) return;
    setLoading(true);
    try {
      const response = await api(`${BASE_URL}/api/rider/order-status`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({
          order_id: rider.current_order.id,
          status
        })
      });
      if (!response) { Alert.alert('Network error', "Couldn't reach server, try again"); return; }
      if (response.ok) {
        if (status === 'delivered') {
          setRider({ ...rider, current_order: null });
          Alert.alert('Order Delivered!', 'Great job!');
        } else {
          setRider({ ...rider, current_order: { ...rider.current_order, delivery_status: status } });
        }
      } else {
        const data = await response.json();
        Alert.alert('Failed to update status', data.detail || 'Unknown error');
      }
    } catch (e) {
      Alert.alert('Network error', e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = async () => {
    const started = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false);
    if (started) await Location.stopLocationUpdatesAsync(LOCATION_TASK);
    await SecureStore.deleteItemAsync('rider_token');
    await SecureStore.deleteItemAsync('rider_session');
    clearSession();
  };

  if (restoring) {
    return (
      <View style={styles.container}>
        <ActivityIndicator size="large" color="#2D8B47" />
      </View>
    );
  }

  if (!rider) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>🛵 GrocerEase Rider</Text>
        <TextInput
          style={styles.input}
          placeholder="Phone (+91XXXXXXXXXX)"
          value={phone}
          onChangeText={setPhone}
          keyboardType="phone-pad"
          autoCapitalize="none"
        />
        <TextInput
          style={styles.input}
          placeholder="Password"
          secureTextEntry
          value={password}
          onChangeText={setPassword}
        />
        {loading
          ? <ActivityIndicator size="large" color="#2D8B47" />
          : <Button title="Login" onPress={handleLogin} color="#2D8B47" />
        }
        {/* DIAG: visible on-screen diagnostics — remove before release */}
        <Text style={styles.diagText}>API: {BASE_URL}</Text>
        <Text style={styles.diagText}>health: {healthStatus}</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Welcome, {rider.name}!</Text>
      <Text style={styles.status}>🟢 Online</Text>

      <View style={styles.orderContainer}>
        {rider.current_order ? (
          <>
            <Text style={styles.orderTitle}>Order #{rider.current_order.id?.slice(0,8).toUpperCase()}</Text>
            <Text>📍 {rider.current_order.delivery_address}</Text>
            <Text>💰 ₹{rider.current_order.subtotal}</Text>
            <Text style={styles.statusLabel}>Status: {rider.current_order.delivery_status}</Text>

            {loading
              ? <ActivityIndicator color="#2D8B47" style={{ marginTop: 16 }} />
              : (
                <View style={styles.buttonGroup}>
                  <Button title="Reached Store" onPress={() => updateStatus('reached_store')} color="#f39c12" />
                  <Button title="Picked Up" onPress={() => updateStatus('picked_up')} color="#3498db" />
                  <Button title="Out for Delivery" onPress={() => updateStatus('out_for_delivery')} color="#9b59b6" />
                  <Button title="Delivered ✅" onPress={() => updateStatus('delivered')} color="#2ecc71" />
                </View>
              )
            }
          </>
        ) : (
          <Text style={styles.noOrder}>⏳ Waiting for orders...</Text>
        )}
      </View>

      <Button title="Logout" color="#e74c3c" onPress={handleLogout} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, backgroundColor: '#ecf0f1', justifyContent: 'center' },
  title: { fontSize: 24, fontWeight: 'bold', marginBottom: 20, textAlign: 'center', color: '#2D8B47' },
  input: { height: 44, borderColor: '#bdc3c7', borderWidth: 1, marginBottom: 14, paddingHorizontal: 12, backgroundColor: '#fff', borderRadius: 8 },
  status: { fontSize: 16, color: '#27ae60', textAlign: 'center', marginBottom: 20 },
  orderContainer: { padding: 16, backgroundColor: '#fff', borderRadius: 12, marginBottom: 20, elevation: 3 },
  orderTitle: { fontSize: 18, fontWeight: 'bold', marginBottom: 8, color: '#111' },
  statusLabel: { marginTop: 10, fontWeight: 'bold', color: '#e67e22', fontSize: 14 },
  buttonGroup: { marginTop: 16, gap: 10 },
  noOrder: { textAlign: 'center', fontSize: 16, color: '#7f8c8d', fontStyle: 'italic', padding: 20 },
  diagText: { marginTop: 8, fontSize: 11, color: '#e74c3c', textAlign: 'center', fontFamily: 'monospace' }
});
