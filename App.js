import React, { useState, useEffect } from 'react';
import { StyleSheet, Text, View, TextInput, Button, Alert, ActivityIndicator } from 'react-native';
import * as Location from 'expo-location';

const BASE_URL = 'https://api.grocereasetv.com';

export default function App() {
  const [phone, setPhone] = useState('9999999999');
  const [password, setPassword] = useState('password123');
  const [rider, setRider] = useState(null);
  const [loading, setLoading] = useState(false);
  
  const handleLogin = async () => {
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
        setRider(data);
      }
    } catch (e) {
      Alert.alert('Network error', e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let locationSubscription = null;
    
    const startTracking = async () => {
      if (!rider) return;
      
      let { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission to access location was denied');
        return;
      }

      // Send location every 5 seconds
      const interval = setInterval(async () => {
        try {
          let location = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
          await fetch(`${BASE_URL}/api/rider/location`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              rider_id: rider.rider_id,
              lat: location.coords.latitude,
              lng: location.coords.longitude
            })
          });
        } catch (err) {
          console.error("Location tracking error:", err);
        }
      }, 5000);
      
      locationSubscription = interval;
    };

    startTracking();
    
    return () => {
      if (locationSubscription) clearInterval(locationSubscription);
    };
  }, [rider]);

  const updateStatus = async (status) => {
    if (!rider || !rider.current_order) return;
    try {
      setLoading(true);
      const response = await fetch(`${BASE_URL}/api/rider/order-status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rider_id: rider.rider_id,
          order_id: rider.current_order.id,
          status: status
        })
      });
      if (response.ok) {
        if (status === 'delivered') {
          setRider({ ...rider, current_order: null });
          Alert.alert('Order Delivered!');
        } else {
          setRider({
            ...rider, 
            current_order: { ...rider.current_order, delivery_status: status }
          });
        }
      } else {
        const data = await response.json();
        Alert.alert('Failed to update status', data.detail);
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
        <Text style={styles.title}>Rider App</Text>
        <TextInput 
          style={styles.input} 
          placeholder="Phone" 
          value={phone} 
          onChangeText={setPhone} 
        />
        <TextInput 
          style={styles.input} 
          placeholder="Password" 
          secureTextEntry 
          value={password} 
          onChangeText={setPassword} 
        />
        <Button title={loading ? "Logging in..." : "Login"} onPress={handleLogin} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Welcome, {rider.name}!</Text>
      <Text style={styles.status}>Status: Online</Text>
      
      <View style={styles.orderContainer}>
        {rider.current_order ? (
          <>
            <Text style={styles.orderTitle}>Current Order: {rider.current_order.id}</Text>
            <Text>Address: {rider.current_order.delivery_address}</Text>
            <Text>Subtotal: ₹{rider.current_order.subtotal}</Text>
            <Text style={styles.statusLabel}>Status: {rider.current_order.delivery_status}</Text>
            
            <View style={styles.buttonGroup}>
              <Button title="Reached Store" onPress={() => updateStatus('reached_store')} color="#f39c12" />
              <Button title="Picked Up" onPress={() => updateStatus('picked_up')} color="#3498db" />
              <Button title="Delivered" onPress={() => updateStatus('delivered')} color="#2ecc71" />
            </View>
          </>
        ) : (
          <Text style={styles.noOrder}>Waiting for orders...</Text>
        )}
      </View>
      
      <Button title="Logout" color="#e74c3c" onPress={() => setRider(null)} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 20,
    backgroundColor: '#ecf0f1',
    justifyContent: 'center',
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 20,
    textAlign: 'center'
  },
  input: {
    height: 40,
    borderColor: '#bdc3c7',
    borderWidth: 1,
    marginBottom: 15,
    paddingHorizontal: 10,
    backgroundColor: '#fff'
  },
  status: {
    fontSize: 16,
    color: '#27ae60',
    textAlign: 'center',
    marginBottom: 20
  },
  orderContainer: {
    padding: 15,
    backgroundColor: '#fff',
    borderRadius: 8,
    marginBottom: 20,
    elevation: 2
  },
  orderTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    marginBottom: 10
  },
  statusLabel: {
    marginTop: 10,
    fontWeight: 'bold',
    color: '#e67e22'
  },
  buttonGroup: {
    marginTop: 15,
    gap: 10
  },
  noOrder: {
    textAlign: 'center',
    fontSize: 16,
    color: '#7f8c8d',
    fontStyle: 'italic'
  }
});
