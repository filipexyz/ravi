import 'package:flutter/material.dart';

import 'config/gateway_settings.dart';
import 'state/desk_controller.dart';
import 'theme.dart';
import 'ui/desk_app.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final controller = DeskController(store: PrefsSettingsStore());
  await controller.start();
  runApp(RaviDeskApp(controller: controller));
}

class RaviDeskApp extends StatelessWidget {
  const RaviDeskApp({super.key, required this.controller});

  final DeskController controller;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Ravi Desk',
      debugShowCheckedModeBanner: false,
      theme: buildDeskTheme(),
      home: DeskShell(controller: controller),
    );
  }
}
