# signalk-services-to-signalk

Signal K server plugin that monitors local `systemd` services and publishes their current state to Signal K. It can optionally raise a standard Signal K notification when a service is not active and clear that notification after recovery.

## Requirements

- Linux with `systemd`
- Signal K server
- Node.js 20 or newer

## Installation

Install the plugin from the Signal K App Store, or from the Signal K configuration directory:

```bash
cd ~/.signalk
npm install signalk-services-to-signalk
sudo systemctl restart signalk
```

Then enable **Services to Signal K** under **Server → Plugin Config**.

## Configuration

Each configured service has these settings:

- **Systemd Service Name:** Unit name passed to `systemctl is-active`, for example `nginx.service`.
- **Signal K Output Path:** Relative path for the state. `{service}` is replaced with a safe identifier derived from the unit name.
- **Enable Notifications:** Raise a notification while the service is not active.
- **Notification Level:** `warn` or `alarm`.

The polling interval is configured in seconds and has a minimum of five seconds.

### Example

For `nginx.service`, the default paths are:

```text
environment.services.nginx.status
notifications.system.services.nginx
```

The status value is the state returned by `systemctl is-active`, such as `active`, `inactive`, `failed`, `activating`, or `unknown`.

Notifications are emitted only when the state changes. When a failed service becomes active again, the notification is cleared with a `null` value as defined by the Signal K notification lifecycle.

Older configurations whose output path starts with `self.` remain supported; the unnecessary prefix is removed before publishing the delta.

## Development

```bash
npm run check
npm test
npm pack --dry-run
```

The test suite uses a fake `systemctl` process and does not change services on the development machine.

## Security

Service names are passed to `systemctl` as arguments without invoking a shell. Names containing whitespace, slashes, shell operators, or other unsupported characters are rejected.

## License

MIT
