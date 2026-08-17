'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const createPlugin = require('../index')

function nextTurn() {
  return new Promise(resolve => setImmediate(resolve))
}

async function settle() {
  await nextTurn()
  await nextTurn()
}

function createHarness(statuses = []) {
  const commands = []
  const messages = []
  const errors = []
  const scheduled = []
  const cancelled = []

  const app = {
    debug() {},
    error(message) {
      errors.push(message)
    },
    handleMessage(pluginId, delta) {
      messages.push({ pluginId, delta })
    }
  }

  const execFile = (file, args, options, callback) => {
    commands.push({ file, args, options })
    const status = statuses.shift() || 'active'
    const error = status === 'active' ? null : Object.assign(new Error(status), { code: 3 })
    setImmediate(() => callback(error, `${status}\n`, ''))
  }

  const setTimeout = (callback, delay) => {
    const handle = { callback, delay }
    scheduled.push(handle)
    return handle
  }

  const clearTimeout = handle => {
    cancelled.push(handle)
  }

  return {
    plugin: createPlugin(app, { execFile, setTimeout, clearTimeout }),
    commands,
    messages,
    errors,
    scheduled,
    cancelled
  }
}

function valuesFrom(message) {
  return message.delta.updates[0].values
}

test('runs systemctl without a shell and publishes a relative Signal K path', async () => {
  const harness = createHarness(['active'])

  harness.plugin.start({
    interval: 10,
    serviceConfigs: [{
      serviceName: 'nginx.service',
      outputPath: 'self.environment.services.{service}.status'
    }]
  })
  await settle()

  assert.deepEqual(harness.commands[0].args, ['is-active', '--', 'nginx.service'])
  assert.equal(harness.commands[0].file, 'systemctl')
  assert.equal(harness.commands[0].options.timeout, 10000)
  assert.deepEqual(valuesFrom(harness.messages[0]), [{
    path: 'environment.services.nginx.status',
    value: 'active'
  }])
  assert.equal(harness.scheduled[0].delay, 10000)

  harness.plugin.stop()
})

test('rejects unsafe service names before invoking systemctl', async () => {
  const harness = createHarness()

  harness.plugin.start({
    serviceConfigs: [{ serviceName: 'nginx.service; touch /tmp/unsafe' }]
  })
  await settle()

  assert.equal(harness.commands.length, 0)
  assert.equal(harness.messages.length, 0)
  assert.match(harness.errors[0], /Invalid systemd service name/)

  harness.plugin.stop()
})

test('raises once on failure and clears the notification after recovery', async () => {
  const harness = createHarness(['failed', 'active'])

  harness.plugin.start({
    serviceConfigs: [{
      serviceName: 'node-red.service',
      notifyOnError: true,
      errorLevel: 'alarm'
    }]
  })
  await settle()

  const raised = valuesFrom(harness.messages[1])[0]
  assert.equal(raised.path, 'notifications.system.services.node_red')
  assert.deepEqual(raised.value, {
    state: 'alarm',
    method: ['visual', 'sound'],
    message: 'Service node-red.service is failed'
  })

  harness.scheduled[0].callback()
  await settle()

  const cleared = valuesFrom(harness.messages[3])[0]
  assert.deepEqual(cleared, {
    path: 'notifications.system.services.node_red',
    value: null
  })

  harness.plugin.stop()
})

test('does not repeat an unchanged failure notification', async () => {
  const harness = createHarness(['inactive', 'inactive'])

  harness.plugin.start({
    serviceConfigs: [{
      serviceName: 'grafana.service',
      notifyOnError: true,
      errorLevel: 'warn'
    }]
  })
  await settle()
  harness.scheduled[0].callback()
  await settle()

  const notificationUpdates = harness.messages
    .flatMap(valuesFrom)
    .filter(value => value.path.startsWith('notifications.'))

  assert.equal(notificationUpdates.length, 1)
  assert.equal(notificationUpdates[0].value.state, 'warn')

  harness.plugin.stop()
})

test('stop cancels the scheduled poll', async () => {
  const harness = createHarness(['active'])

  harness.plugin.start({
    serviceConfigs: [{ serviceName: 'influxdb.service' }]
  })
  await settle()

  const scheduledHandle = harness.scheduled[0]
  harness.plugin.stop()

  assert.deepEqual(harness.cancelled, [scheduledHandle])
})

test('starts and stops cleanly without configured services', async () => {
  const harness = createHarness()

  harness.plugin.start({})
  await settle()

  assert.equal(harness.commands.length, 0)
  assert.equal(harness.messages.length, 0)
  assert.equal(harness.scheduled.length, 1)

  harness.plugin.stop()
})
