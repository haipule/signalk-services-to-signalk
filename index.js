module.exports = function (app) {
  const plugin = {
    id: "signalk-services-to-signalk",
    name: "Services to Signal K",
    description: "Monitor systemd services and publish status to Signal K paths optional signalk-notification",

    schema: {
      type: "object",
      properties: {
        serviceConfigs: {
          type: "array",
          title: "Service Configurations",
          items: {
            type: "object",
            properties: {
              serviceName: {
                type: "string",
                title: "Systemd Service Name",
                description: "e.g. nginx.service",
                default: ""
              },
              outputPath: {
                type: "string",
                title: "Signal K Output Path",
                description: "e.g. environment.nginx.serviceStatus",
                default: "self.environment.{service}.serviceStatus"
              },
              notifyOnError: {
                type: "boolean",
                title: "Enable Notifications",
                default: false
              },
              errorLevel: {
                type: "string",
                title: "Alert Level",
                enum: ["warn", "alarm"],
                default: "warn"
              }
            },
            required: ["serviceName"]
          }
        },
        interval: {
          type: "number",
          title: "Polling Interval (seconds)",
          default: 30,
          minimum: 5
        }
      },
      required: ["serviceConfigs"]
    },

    start: function(options) {
      plugin.config = options || {};
      
      // Migration alter Konfigurationen
      if (plugin.config.services && !plugin.config.serviceConfigs) {
        plugin.config.serviceConfigs = Object.keys(plugin.config.services).map(
          serviceName => ({
            serviceName,
            outputPath: `self.environment.${serviceName.replace('.service','').toLowerCase()}.status`,
            notifyOnError: plugin.config.services[serviceName].notifyOnError,
            errorLevel: plugin.config.services[serviceName].errorLevel
          })
        );
        delete plugin.config.services;
      }

      pollServices();
      this.timer = setInterval(pollServices, (plugin.config.interval || 30) * 1000);
    },

    stop: function() {
      if (this.timer) clearInterval(this.timer);
    }
  };

  function resolveOutputPath(config) {
    try {
      const cleanName = (config.serviceName || 'unknown')
        .replace('.service', '')
        .replace(/[^a-z0-9]/gi, '_')
        .toLowerCase();
      
      return (config.outputPath || 'self.environment.{service}.status')
        .replace('{service}', cleanName);
    } catch (err) {
      app.error("Error resolving output path:", err);
      return "self.environment.error.status";
    }
  }

  async function getStatusOfService(service) {
    const { exec } = require('child_process');
    return new Promise((resolve) => {
      exec(`systemctl is-active ${service}`, (error, stdout) => {
        resolve(error ? 'inactive' : stdout.trim());
      });
    });
  }

  async function pollServices() {
    if (!plugin.config.serviceConfigs || !Array.isArray(plugin.config.serviceConfigs)) {
      app.debug('No service configurations found - skipping poll');
      return;
    }

    app.debug(`Starting poll cycle for ${plugin.config.serviceConfigs.length} services`);
    
    for (const config of plugin.config.serviceConfigs) {
      try {
        const status = await getStatusOfService(config.serviceName);
        const basePath = resolveOutputPath(config);
        
        app.debug(`[${new Date().toISOString()}] Service ${config.serviceName} status: ${status} (updating: ${basePath})`);

        // Hauptstatus senden
        app.handleMessage(plugin.id, {
          updates: [{
            source: { label: plugin.id },
            values: [{ path: basePath, value: status }]
          }]
        });

        if (status !== 'active' && config.notifyOnError) {
          const notificationPath = `${basePath}.notification`;
          app.debug(`Sending ${config.errorLevel} notification for ${config.serviceName}`);
          app.handleMessage(plugin.id, {
            updates: [{
              values: [{
                path: notificationPath,
                value: {
                  level: config.errorLevel,
                  message: `Service ${config.serviceName} is ${status}`,
                  timestamp: new Date().toISOString()
                }
              }]
            }]
          });
        }
      } catch (err) {
        app.error(`Error processing ${config.serviceName}:`, err);
      }
    }
    app.debug('Polling cycle completed');
  }

  return plugin;
};
