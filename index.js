'use strict'

const { execFile: nodeExecFile } = require('node:child_process')

const DEFAULT_INTERVAL_SECONDS = 30
const MIN_INTERVAL_SECONDS = 5
const SYSTEMCTL_TIMEOUT_MS = 10000
const VALID_SERVICE_NAME = /^[A-Za-z0-9_.@:-]+$/
const VALID_PATH = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/

module.exports = function createPlugin(app, dependencies = {}) {
  const execFile = dependencies.execFile || nodeExecFile
  const schedule = dependencies.setTimeout || setTimeout
  const cancel = dependencies.clearTimeout || clearTimeout

  let timer = null
  let stopped = true
  let generation = 0
  let config = { serviceConfigs: [], interval: DEFAULT_INTERVAL_SECONDS }
  const previousStatuses = new Map()

  const plugin = {
    id: 'signalk-services-to-signalk',
    name: 'Services to Signal K',
    description: 'Monitor systemd services and publish their status to Signal K with optional notifications',

    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        serviceConfigs: {
          type: 'array',
          title: 'Service Configurations',
          default: [],
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              serviceName: {
                type: 'string',
                title: 'Systemd Service Name',
                description: 'For example: nginx.service',
                minLength: 1,
                pattern: '^[A-Za-z0-9_.@:-]+$',
                default: ''
              },
              outputPath: {
                type: 'string',
                title: 'Signal K Output Path',
                description: 'The {service} placeholder is replaced with a safe service identifier.',
                default: 'environment.services.{service}.status'
              },
              notifyOnError: {
                type: 'boolean',
                title: 'Enable Notifications',
                default: false
              },
              errorLevel: {
                type: 'string',
                title: 'Notification Level',
                enum: ['warn', 'alarm'],
                default: 'warn'
              }
            },
            required: ['serviceName']
          }
        },
        interval: {
          type: 'integer',
          title: 'Polling Interval (seconds)',
          default: DEFAULT_INTERVAL_SECONDS,
          minimum: MIN_INTERVAL_SECONDS
        }
      },
      required: ['serviceConfigs']
    },

    start(options) {
      stopPolling()
      config = normalizeConfig(options)
      previousStatuses.clear()
      stopped = false
      generation += 1
      void runPollCycle(generation)
    },

    stop() {
      stopPolling()
    }
  }

  function logError(message, error) {
    if (typeof app.error === 'function') {
      app.error(`${message}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  function normalizeConfig(options) {
    const next = { ...(options || {}) }

    if (next.services && !next.serviceConfigs) {
      next.serviceConfigs = Object.keys(next.services).map(serviceName => ({
        serviceName,
        outputPath: `environment.services.${serviceIdentifier(serviceName)}.status`,
        notifyOnError: Boolean(next.services[serviceName].notifyOnError),
        errorLevel: next.services[serviceName].errorLevel
      }))
    }

    return {
      serviceConfigs: Array.isArray(next.serviceConfigs) ? next.serviceConfigs : [],
      interval: validInterval(next.interval)
    }
  }

  function validInterval(value) {
    const interval = Number(value)
    return Number.isFinite(interval) && interval >= MIN_INTERVAL_SECONDS
      ? interval
      : DEFAULT_INTERVAL_SECONDS
  }

  function serviceIdentifier(serviceName) {
    return String(serviceName || 'unknown')
      .replace(/\.service$/i, '')
      .replace(/[^a-z0-9]+/gi, '_')
      .replace(/^_+|_+$/g, '')
      .toLowerCase() || 'unknown'
  }

  function validateServiceName(serviceName) {
    const value = String(serviceName || '').trim()
    if (!value || !VALID_SERVICE_NAME.test(value)) {
      throw new Error(`Invalid systemd service name: ${value || '(empty)'}`)
    }
    return value
  }

  function resolveOutputPath(serviceConfig) {
    const identifier = serviceIdentifier(serviceConfig.serviceName)
    const configuredPath = String(
      serviceConfig.outputPath || 'environment.services.{service}.status'
    )
      .replace(/^self\./, '')
      .replaceAll('{service}', identifier)

    if (!VALID_PATH.test(configuredPath)) {
      throw new Error(`Invalid Signal K output path: ${configuredPath}`)
    }

    return configuredPath
  }

  function notificationPath(serviceName) {
    return `notifications.system.services.${serviceIdentifier(serviceName)}`
  }

  function getStatusOfService(serviceName) {
    const service = validateServiceName(serviceName)

    return new Promise(resolve => {
      execFile(
        'systemctl',
        ['is-active', '--', service],
        { timeout: SYSTEMCTL_TIMEOUT_MS },
        (error, stdout) => {
          const status = String(stdout || '').trim()
          if (status) {
            resolve(status)
            return
          }
          resolve(error && error.killed ? 'timeout' : 'unknown')
        }
      )
    })
  }

  function sendValues(values) {
    app.handleMessage(plugin.id, {
      updates: [{
        source: { label: plugin.id },
        timestamp: new Date().toISOString(),
        values
      }]
    })
  }

  function notificationValue(serviceConfig, status) {
    return {
      state: serviceConfig.errorLevel === 'alarm' ? 'alarm' : 'warn',
      method: ['visual', 'sound'],
      message: `Service ${serviceConfig.serviceName} is ${status}`
    }
  }

  async function pollService(serviceConfig) {
    const serviceName = validateServiceName(serviceConfig.serviceName)
    const status = await getStatusOfService(serviceName)
    const outputPath = resolveOutputPath(serviceConfig)
    const previousStatus = previousStatuses.get(serviceName)

    sendValues([{ path: outputPath, value: status }])

    if (serviceConfig.notifyOnError && status !== previousStatus) {
      const path = notificationPath(serviceName)
      if (status === 'active') {
        if (previousStatus && previousStatus !== 'active') {
          sendValues([{ path, value: null }])
        }
      } else {
        sendValues([{ path, value: notificationValue(serviceConfig, status) }])
      }
    }

    previousStatuses.set(serviceName, status)

    if (typeof app.debug === 'function') {
      app.debug(`Service ${serviceName} is ${status}; updated ${outputPath}`)
    }
  }

  async function pollServices() {
    if (config.serviceConfigs.length === 0) {
      if (typeof app.debug === 'function') {
        app.debug('No service configurations found; skipping poll')
      }
      return
    }

    await Promise.all(config.serviceConfigs.map(async serviceConfig => {
      try {
        await pollService(serviceConfig)
      } catch (error) {
        logError(`Error processing ${serviceConfig.serviceName || '(unnamed service)'}`, error)
      }
    }))
  }

  async function runPollCycle(currentGeneration) {
    try {
      await pollServices()
    } finally {
      if (!stopped && currentGeneration === generation) {
        timer = schedule(
          () => void runPollCycle(currentGeneration),
          config.interval * 1000
        )
      }
    }
  }

  function stopPolling() {
    stopped = true
    generation += 1
    if (timer !== null) {
      cancel(timer)
      timer = null
    }
  }

  return plugin
}
