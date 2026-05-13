# signalk-services-to-signalk

Signal K server plugin to monitor local `systemd` services and publish their status to Signal K paths.

The plugin can optionally create Signal K notifications when a monitored service is not running.

## Features

- Monitors local Linux `systemd` services
- Publishes service status to Signal K
- Optional Signal K notifications
- Useful for watchdog-style monitoring of services such as:
  - Signal K
  - Node-RED
  - InfluxDB
  - Grafana
  - custom boat services

## Requirements

- Signal K server
- Linux system with `systemd`
- Node.js environment used by Signal K

## Installation

### From npm

```bash
cd ~/.signalk
npm install signalk-services-to-signalk
sudo systemctl restart signalk
````
### Activation

After installation:

Open Signal K Admin UI
Go to Server → Plugin Config
Enable signalk-services-to-signalk
Configure the services you want to monitor
Restart Signal K if required
Signal K output

The plugin publishes service information to Signal K paths.

Example structure:

custom.services.<serviceName>.status
custom.services.<serviceName>.active
custom.services.<serviceName>.timestamp

Exact paths depend on the plugin configuration.

### Notifications

If enabled, the plugin can create Signal K notifications when a monitored service is inactive or failed.

Example use case:

notifications.system.services.<serviceName>
