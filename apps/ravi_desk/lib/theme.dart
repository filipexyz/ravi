import 'package:flutter/material.dart';

class DeskColors {
  static const canvas = Color(0xFF0B0D11);
  static const sidebar = Color(0xFF12151B);
  static const sidebarElevated = Color(0xFF181C23);
  static const hover = Color(0xFF1C212A);
  static const selected = Color(0xFF1A2A24);
  static const border = Color(0xFF262B34);
  static const accent = Color(0xFF3DDB8A);
  static const accentMuted = Color(0xFF1F8A55);
  static const unread = Color(0xFF3DDB8A);
  static const text = Color(0xFFF4F6F8);
  static const textSecondary = Color(0xFF9AA3B2);
  static const textMuted = Color(0xFF6B7380);
  static const userBubble = Color(0xFF1B3A2F);
  static const assistantBubble = Color(0xFF1C2128);
  static const composer = Color(0xFF171B22);
  static const danger = Color(0xFFE35D6A);
}

ThemeData buildDeskTheme() {
  const scheme = ColorScheme.dark(
    surface: DeskColors.canvas,
    primary: DeskColors.accent,
    onPrimary: Color(0xFF062113),
    secondary: DeskColors.accentMuted,
    error: DeskColors.danger,
    onSurface: DeskColors.text,
    outline: DeskColors.border,
  );
  return ThemeData(
    useMaterial3: true,
    brightness: Brightness.dark,
    colorScheme: scheme,
    scaffoldBackgroundColor: DeskColors.canvas,
    textTheme: const TextTheme(
      titleLarge: TextStyle(fontWeight: FontWeight.w600, letterSpacing: -0.3),
      titleMedium: TextStyle(fontWeight: FontWeight.w600, letterSpacing: -0.2),
      bodyMedium: TextStyle(height: 1.4),
    ),
    dividerColor: DeskColors.border,
  );
}
