// The NetworkTables topics the robot's battery voltage is read from, in order of preference.
//
// The list that matters is the one in `src-tauri/src/nt.rs`, which does the reading. This copy is
// only so Settings can tell someone what their robot code needs to publish, and a test keeps the two
// the same. They are the three Catalyst Console's battery reads, in the same order.

export const BATTERY_TOPICS = [
  "/Catalyst/Status/BatteryVolts",
  "/Catalyst/Brownout/MeasuredVoltage",
  "/Catalyst/Systemcore/BatteryVolts",
];
