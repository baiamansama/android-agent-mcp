package dev.androidagent.driver

/**
 * The driver app's entire implementation.
 *
 * `am instrument` rejects a target package whose APK contains no dex ("Instrumentation target has
 * no code"), so this module cannot be a resource-only shell. One unreferenced object is enough to
 * make the APK valid while keeping the app inert: it has no components, nothing exported, and
 * nothing that can be launched.
 *
 * The agent itself lives in `androidTest` — see `dev.androidagent.driver.agent.DeviceAgent`.
 */
internal object Placeholder
