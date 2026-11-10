/**
 * CoverArtPicker
 * ──────────────
 * Reusable cover art upload component for indie authors.
 * Shows either a real cover or an elegant "Add Cover" placeholder.
 * Handles image picking (mobile: expo-image-picker, web: file input),
 * uploads to Cloudinary via the backend, and reports the resulting URL.
 */

import React, { useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../context/ThemeContext';
import apiService from '../services/api';

interface Props {
  coverUrl: string | null;
  onCoverChange: (url: string | null) => void;
  /** Square size of the picker widget (default 140) */
  size?: number;
}

const CoverArtPicker: React.FC<Props> = ({ coverUrl, onCoverChange, size = 140 }) => {
  const { theme } = useTheme();
  const [uploading, setUploading] = useState(false);
  const webInputRef = useRef<HTMLInputElement | null>(null);

  const pickAndUpload = async () => {
    if (uploading) return;

    if (Platform.OS === 'web') {
      // Web: native file input
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/jpeg,image/png,image/webp';
      input.onchange = async (e: Event) => {
        const target = e.target as HTMLInputElement;
        const file = target.files?.[0];
        if (!file) return;
        if (file.size > 5 * 1024 * 1024) {
          alert('Image is too large. Maximum size is 5 MB.');
          return;
        }
        const objectUrl = URL.createObjectURL(file);
        await doUpload({ uri: objectUrl, name: file.name, type: file.type });
      };
      input.click();
    } else {
      // Mobile: expo-image-picker
      try {
        const ImagePicker = require('expo-image-picker');
        const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (status !== 'granted') {
          Alert.alert(
            'Permission needed',
            'Allow access to your photo library to pick a cover image.'
          );
          return;
        }
        const result = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ['images'],
          allowsEditing: true,
          aspect: [1, 1],
          quality: 0.85,
        });
        if (result.canceled || !result.assets?.[0]) return;
        const asset = result.assets[0];
        const ext = asset.uri.split('.').pop() ?? 'jpg';
        await doUpload({
          uri: asset.uri,
          name: `cover.${ext}`,
          type: asset.mimeType ?? 'image/jpeg',
        });
      } catch (err) {
        Alert.alert('Error', 'Could not open image picker. Please try again.');
      }
    }
  };

  const doUpload = async (file: { uri: string; name: string; type: string }) => {
    setUploading(true);
    try {
      const url = await apiService.uploadCoverArt(file);
      onCoverChange(url);
    } catch {
      if (Platform.OS === 'web') {
        alert('Failed to upload cover art. Please try again.');
      } else {
        Alert.alert('Upload failed', 'Could not upload cover art. Please try again.');
      }
    } finally {
      setUploading(false);
    }
  };

  const handleRemove = () => {
    onCoverChange(null);
  };

  const s = size;

  return (
    <View style={[styles.wrapper, { width: s, alignItems: 'center' }]}>
      <TouchableOpacity
        onPress={pickAndUpload}
        activeOpacity={0.8}
        disabled={uploading}
        accessibilityRole="button"
        accessibilityLabel={coverUrl ? 'Change cover art' : 'Add cover art'}
        accessibilityHint="Opens your photo library to pick an image"
        accessibilityState={{ disabled: uploading, busy: uploading }}
        style={[
          styles.square,
          {
            width: s,
            height: s,
            borderRadius: 12,
            borderColor: coverUrl ? 'transparent' : theme.primary + '50',
            backgroundColor: coverUrl ? 'transparent' : theme.primaryLight,
          },
        ]}
      >
        {uploading ? (
          <ActivityIndicator size="large" color={theme.primary} />
        ) : coverUrl ? (
          <>
            <Image
              source={{ uri: coverUrl }}
              style={[styles.image, { width: s, height: s, borderRadius: 12 }]}
              resizeMode="cover"
            />
            {/* Edit overlay */}
            <View style={[styles.editOverlay, { borderRadius: 12 }]}>
              <View style={styles.editBadge}>
                <Ionicons name="camera" size={14} color="#fff" />
                <Text style={styles.editBadgeText}>Change</Text>
              </View>
            </View>
          </>
        ) : (
          <View style={styles.placeholder}>
            <View style={[styles.iconRing, { borderColor: theme.primary + '40' }]}>
              <Ionicons name="image-outline" size={28} color={theme.primary} />
            </View>
            <Text style={[styles.addLabel, { color: theme.primary }]}>Add Cover</Text>
            <Text style={[styles.addHint, { color: theme.textSecondary }]}>JPG · PNG · WebP</Text>
          </View>
        )}
      </TouchableOpacity>

      {coverUrl && !uploading && (
        <TouchableOpacity onPress={handleRemove} style={styles.removeBtn} accessibilityRole="button" accessibilityLabel="Remove cover art">
          <Ionicons name="close-circle" size={18} color={theme.textSecondary} />
          <Text style={[styles.removeTxt, { color: theme.textSecondary }]}>Remove</Text>
        </TouchableOpacity>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  wrapper: {
    alignItems: 'center',
  },
  square: {
    borderWidth: 1.5,
    borderStyle: 'dashed',
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  image: {
    position: 'absolute',
    top: 0,
    left: 0,
  },
  editOverlay: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 36,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  editBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  editBadgeText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
  },
  placeholder: {
    alignItems: 'center',
    gap: 6,
  },
  iconRing: {
    width: 56,
    height: 56,
    borderRadius: 28,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addLabel: {
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  addHint: {
    fontSize: 11,
    opacity: 0.7,
  },
  removeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 8,
  },
  removeTxt: {
    fontSize: 12,
  },
});

export default CoverArtPicker;
