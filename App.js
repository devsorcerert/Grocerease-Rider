import React, { useState, useEffect } from 'react';
import { StyleSheet, Text, View, TextInput, Button, Alert, ActivityIndicator } from 'react-native';
import * as Location from 'expo-location';

const RENDER_FALLBACK = 'https://grocerease-backend-0uip.onrender.com';
const _configured = process.env.EXPO_PUBLIC_API_BASE_URL || process.env.API_BASE_URL;
if (_configured === 'https://api.grocereasetv.com') {
  throw new Error('BASE_URL points to the dead domain api.grocereasetv.com — set a valid EXPO_PUBLIC_API_BASE_URL');
}
const BASE_URL = _configured || RENDER_FALLBACK;

export default function App() {
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [rider, setRider] = useState(null);
  const [token, setToken] = useState(null);
  const [loading, setLoading] = useState(false);

  const authHeaders = (tok) => ({
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${tok}`
  });

  const handleLogin = async () => {
    if (!phone.trim() || !password.trim()) {
      Alert.alert('Required', 'Enter phone and password');
      return;
    }
    setLoading(true);
    try {
      const response = await fetch(`${BASE_URL}/api/rider/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, password })
      });
      const data = await response.json();
      if (!response.ok) {
        Alert.alert('Login failed', data.detail || 'Unknown error');
      } else {
        setToken(data.token);
        setRider(data);
      }
    } catch (e) {
      Alert.alert('Network error', e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!rider || !token) return;
    let locationInterval = null;

    const startTracking = async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Location permission denied');
        return;
      }

      locationInterval = setInterval(async () => {
        try {
          const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
          await fetch(`${BASE_URL}/api/rider/location`, {
            method: 'POST',
            headers: authHeaders(token),
            body: JSON.stringify({ lat: loc.coords.latitude, lng: loc.coords.longitude })
          });
        } catch (err) {
          console.error('Location tracking error:', err);
        }
      }, 5000);
    };

    startTracking();
    return () => { if (locationInterval) clearInterval(locationInterval); };
  }, [rider, token]);

  const updateStatus = async (status) => {
    if (!rider?.current_order || !token) return;
    setLoading(true);
    try {
      const response = await fetch(`${BASE_URL}/api/rider/order-status`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({
          order_id: rider.current_order.id,
          status
        })
      });
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

      <Button title="Logout" color="#e74c3c" onPress={() => { setRider(null); setToken(null); }} />
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
  noOrder: { textAlign: 'center', fontSize: 16, color: '#7f8c8d', fontStyle: 'italic', padding: 20 }
});
