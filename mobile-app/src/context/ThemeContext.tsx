import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { StatusBar } from 'expo-status-bar';

/**
 * Design system — "App Store mockup" direction (2026-06 redesign).
 * Dark is the hero experience (deep navy chrome + indigo/purple accents +
 * duotone gradient book cards); light is the same language on a bright canvas.
 * New tokens added for the redesign: `accent`, `elevated`, `cardGradients`.
 * Existing token names are preserved so screens keep compiling while we
 * convert them screen-by-screen.
 */
export interface Theme {
  background: string;      // app canvas
  surface: string;         // app chrome / screen background sections
  elevated: string;        // raised surfaces (modals, sheets, headers)
  text: string;
  textSecondary: string;
  primary: string;         // brand indigo
  primaryLight: string;    // tinted indigo background (chips, selected rows)
  accent: string;          // lighter purple for active tabs / links
  border: string;
  card: string;
  error: string;
  errorLight: string;
  success: string;
  successLight: string;
  warning: string;
  warningLight: string;
  gradient: string[];           // brand gradient (buttons, headers)
  cardGradients: string[][];    // rotating duotone gradients for book cards
  statusBar: 'light' | 'dark';
}

// Signature duotone gradients for audiobook cards (from the App Store mockups).
const CARD_GRADIENTS: string[][] = [
  ['#1e3a5f', '#2d6a4f'], // navy → green
  ['#7c2d12', '#b45309'], // rust → amber
  ['#312e81', '#6366f1'], // indigo → blue
  ['#134e4a', '#0f766e'], // deep teal
  ['#4a1272', '#6f2da8'], // violet
  ['#0d3b5e', '#11998e'], // ocean → teal
];

export const lightTheme: Theme = {
  background: '#f6f6fb',
  surface: '#ffffff',
  elevated: '#ffffff',
  text: '#16162a',
  textSecondary: '#6b6b85',
  primary: '#6366f1',
  primaryLight: '#ede9fe',
  accent: '#7c3aed',
  border: '#e9e9f2',
  card: '#ffffff',
  error: '#ef4444',
  errorLight: '#fee2e2',
  success: '#10b981',
  successLight: '#d1fae5',
  warning: '#f59e0b',
  warningLight: '#fef3c7',
  gradient: ['#6366f1', '#8b5cf6'],
  cardGradients: CARD_GRADIENTS,
  statusBar: 'dark',
};

export const darkTheme: Theme = {
  background: '#0f0f1a',
  surface: '#16162a',
  elevated: '#1f1f38',
  text: '#f5f5fa',
  textSecondary: '#9a9ab4',
  primary: '#6366f1',
  primaryLight: '#2a2655',
  accent: '#a78bfa',
  border: 'rgba(255,255,255,0.08)',
  card: '#1a1a2e',
  error: '#f87171',
  errorLight: '#4c1d1d',
  success: '#34d399',
  successLight: '#0c3a2e',
  warning: '#fbbf24',
  warningLight: '#3f2d0a',
  gradient: ['#6366f1', '#8b5cf6'],
  cardGradients: CARD_GRADIENTS,
  statusBar: 'light',
};

interface ThemeContextType {
  theme: Theme;
  isDarkMode: boolean;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

const THEME_STORAGE_KEY = '@theme_mode';

export const ThemeProvider = ({ children }: { children: ReactNode }) => {
  // Dark is the hero of the redesign — default to it, fall back to a saved pref.
  const [isDarkMode, setIsDarkMode] = useState(true);

  useEffect(() => {
    loadThemePreference();
  }, []);

  const loadThemePreference = async () => {
    try {
      const savedTheme = await AsyncStorage.getItem(THEME_STORAGE_KEY);
      if (savedTheme !== null) {
        setIsDarkMode(savedTheme === 'dark');
      }
    } catch (error) {
      console.error('Error loading theme preference:', error);
    }
  };

  const toggleTheme = async () => {
    const newMode = !isDarkMode;
    setIsDarkMode(newMode);
    try {
      await AsyncStorage.setItem(THEME_STORAGE_KEY, newMode ? 'dark' : 'light');
    } catch (error) {
      console.error('Error saving theme preference:', error);
    }
  };

  const theme = isDarkMode ? darkTheme : lightTheme;

  return (
    <ThemeContext.Provider value={{ theme, isDarkMode, toggleTheme }}>
      <StatusBar style={theme.statusBar} />
      {children}
    </ThemeContext.Provider>
  );
};

export const useTheme = () => {
  const context = useContext(ThemeContext);
  if (context === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
};
