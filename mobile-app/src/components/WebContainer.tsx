import React from 'react';
import { View, StyleSheet, Platform } from 'react-native';

interface WebContainerProps {
  children: React.ReactNode;
  maxWidth?: number;
}

const WebContainer: React.FC<WebContainerProps> = ({
  children,
  maxWidth = 480
}) => {
  // On native platforms, just return children directly
  if (Platform.OS !== 'web') {
    return <>{children}</>;
  }

  // On web, wrap with centering container
  return (
    <View style={styles.webWrapper}>
      <View style={[styles.webContent, { maxWidth }]}>
        {children}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  webWrapper: {
    flex: 1,
    alignItems: 'center',
    backgroundColor: '#f8fafc', // Light background for side areas
  },
  webContent: {
    flex: 1,
    width: '100%',
    backgroundColor: '#ffffff',
    // Add subtle shadow on web for app-like feel
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.1,
    shadowRadius: 10,
  },
});

export default WebContainer;
