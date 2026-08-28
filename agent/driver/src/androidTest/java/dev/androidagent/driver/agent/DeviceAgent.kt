package dev.androidagent.driver.agent

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.util.Base64
import android.view.InputDevice
import android.view.MotionEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Test
import org.junit.runner.RunWith
import java.io.BufferedReader
import java.io.ByteArrayOutputStream
import java.io.InputStreamReader
import java.io.PrintWriter
import java.net.InetAddress
import java.net.ServerSocket

/**
 * In-process device agent for `android-agent-mcp`.
 *
 * Runs as instrumentation and serves newline-delimited JSON over a loopback socket, which the host
 * reaches through `adb forward`. It exists to recover what a host-side `uiautomator dump`
 * structurally cannot provide:
 *
 *  1. **Visibility.** The XML dump reports every node's bounds in screen coordinates whether or not
 *     something covers it, so an element behind the soft keyboard looks perfectly tappable and the
 *     tap silently lands on a key. [AccessibilityNodeInfo.isVisibleToUser] is the real signal, and
 *     is this agent's equivalent of XCTest's `isHittable`.
 *  2. **Coordinate-free actions.** `ACTION_CLICK` is dispatched to the node itself, so occlusion,
 *     scroll offsets and relayout stop mattering. Nothing here computes a tap point.
 *  3. **Unicode text entry.** Text is written into the field directly and needs no keyboard
 *     installed. `adb shell input text` maps characters onto key events and throws outside ASCII,
 *     which makes Arabic, Cyrillic and Uzbek `ʻ` untypeable from the host.
 *  4. **Window truth.** Every element carries the package of the window it came from, and
 *     [OP_WINDOWS] reports the whole stack. A host-side dump can silently return the launcher's
 *     tree while the app is mid-transition, with nothing in the payload to reveal it.
 *  5. **On-device screenshot scaling.** [OP_SCREENSHOT] scales and JPEG-encodes before the wire,
 *     and always reports the native `deviceWidth`/`deviceHeight` beside the returned image size,
 *     so the payload is tens of kilobytes and no caller ever has to infer a scale factor.
 *
 * ## Why this driver targets itself
 *
 * The instrumentation's `targetPackage` is this driver's own (empty) stub app, not the app under
 * test. That is deliberate and is what makes the agent general:
 *
 *  - `am instrument` restarts its target's process. Targeting the app under test means starting
 *    the agent destroys the state you were about to inspect, so the host can only ever start it at
 *    moments where that is survivable. Targeting an empty stub makes starting the agent free.
 *  - `UiAutomation` grants system-wide accessibility access, so the tree, gestures and screenshots
 *    reach every app on the device regardless of what the instrumentation targets. Nothing here
 *    reads the app under test's classloader or memory.
 *
 * The one thing that genuinely changes is text entry — see [setText].
 *
 * Start it with:
 * ```
 * adb shell am instrument -w \
 *   -e class dev.androidagent.driver.agent.DeviceAgent \
 *   dev.androidagent.driver.test/androidx.test.runner.AndroidJUnitRunner
 * adb forward tcp:8299 tcp:8299
 * ```
 *
 * This is developer tooling; it is never part of a shipped APK. It binds loopback only, so it is
 * reachable solely through the adb port forward.
 */
@RunWith(AndroidJUnit4::class)
class DeviceAgent {

  @Test
  fun serve() {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val device = UiDevice.getInstance(instrumentation)

    ServerSocket(PORT, BACKLOG, InetAddress.getByName("127.0.0.1")).use { server ->
      // The host scrapes this line to know the agent is ready.
      println("ANDROID_AGENT_READY port=$PORT protocol=$PROTOCOL")
      System.out.flush()

      while (true) {
        server.accept().use { socket ->
          val reader = BufferedReader(InputStreamReader(socket.getInputStream(), Charsets.UTF_8))
          val writer = PrintWriter(socket.getOutputStream().writer(Charsets.UTF_8), true)

          while (true) {
            val line = reader.readLine() ?: break
            if (line.isBlank()) continue

            val response = try {
              handle(JSONObject(line), device)
            } catch (error: Throwable) {
              fail(error.message ?: error.toString())
            }

            if (response.optString("op") == OP_SHUTDOWN) {
              writer.println(response)
              return
            }
            writer.println(response)
          }
        }
      }
    }
  }

  private fun handle(request: JSONObject, device: UiDevice): JSONObject = when (request.optString("op")) {
    OP_PING -> ok()
      .put("device", device.productName)
      .put("protocol", PROTOCOL)

    OP_CAPABILITIES -> capabilities()

    OP_DUMP -> ok()
      .put("elements", dump(request.optBoolean("allWindows", true)))
      .put("foreground", foregroundPackage() ?: JSONObject.NULL)

    OP_WINDOWS -> ok()
      .put("windows", windowSummaries())
      .put("foreground", foregroundPackage() ?: JSONObject.NULL)

    OP_CLICK -> act(request, device, AccessibilityNodeInfo.ACTION_CLICK)
    OP_LONG_CLICK -> act(request, device, AccessibilityNodeInfo.ACTION_LONG_CLICK)
    OP_SET_TEXT -> setText(request)
    OP_SCROLL_INTO_VIEW -> scrollIntoView(request)
    OP_SCREENSHOT -> screenshot(request)
    OP_GESTURE -> gesture(request)
    OP_PINCH -> pinch(request)
    OP_DOUBLE_TAP -> doubleTap(request)

    OP_WAIT_IDLE -> {
      device.waitForIdle(request.optLong("timeoutMs", DEFAULT_TIMEOUT_MS))
      ok()
    }

    OP_WAIT_STABLE -> waitStable(request)
    OP_WAIT_FOR_PACKAGE -> waitForPackage(request)

    OP_SHUTDOWN -> ok().put("op", OP_SHUTDOWN)
    else -> fail("Unknown op \"${request.optString("op")}\"")
  }

  // ---------------------------------------------------------------------------
  // Capabilities
  // ---------------------------------------------------------------------------

  /**
   * What this device actually lets the agent do, measured rather than assumed.
   *
   * The host uses `clipboard` to decide whether the paste path in [setText] is worth attempting,
   * and surfaces the result in its status tool so a text-entry failure reads as a known device
   * restriction rather than a mystery. Probing costs one clipboard round trip and is cheap enough
   * to answer live.
   */
  private fun capabilities(): JSONObject = ok()
    .put("protocol", PROTOCOL)
    .put("sdkInt", Build.VERSION.SDK_INT)
    .put("clipboard", clipboardWritable())
    .put("shellIdentity", Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1)

  /**
   * Whether this process can actually put something on the clipboard.
   *
   * Android 10+ denies `setPrimaryClip` to an app that is neither focused nor the default IME, and
   * the denial is **silent** — the call returns normally and the clip is unchanged. The only honest
   * test is to write a sentinel and read it back.
   */
  private fun clipboardWritable(): Boolean = try {
    val sentinel = "android-agent-probe-${SystemClock.uptimeMillis()}"
    writeClipboard(sentinel)
    readClipboard() == sentinel
  } catch (_: Throwable) {
    false
  }

  private fun clipboardManager(): ClipboardManager =
    InstrumentationRegistry.getInstrumentation().targetContext
      .getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager

  /**
   * Write the clipboard, escalating to shell permission identity when the platform offers it.
   *
   * `adoptShellPermissionIdentity` lends the instrumentation the shell UID's permission set for the
   * duration of the call, which is the documented way for a test to reach operations its own uid
   * cannot. It is not a guarantee — the clipboard's focus check is not purely permission-based —
   * so the caller still verifies with [readClipboard].
   */
  private fun writeClipboard(value: String) {
    val automation = uiAutomation()
    val clip = ClipData.newPlainText("android-agent", value)
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O_MR1) {
      clipboardManager().setPrimaryClip(clip)
      return
    }
    automation.adoptShellPermissionIdentity()
    try {
      clipboardManager().setPrimaryClip(clip)
    } finally {
      automation.dropShellPermissionIdentity()
    }
  }

  private fun readClipboard(): String? {
    val automation = uiAutomation()
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O_MR1) {
      return clipboardManager().primaryClip?.getItemAt(0)?.text?.toString()
    }
    automation.adoptShellPermissionIdentity()
    return try {
      clipboardManager().primaryClip?.getItemAt(0)?.text?.toString()
    } finally {
      automation.dropShellPermissionIdentity()
    }
  }

  // ---------------------------------------------------------------------------
  // Windows
  // ---------------------------------------------------------------------------

  private fun uiAutomation() = InstrumentationRegistry.getInstrumentation().uiAutomation

  /**
   * Application windows, topmost first.
   *
   * Ordered by layer descending so index 0 is what the user is actually looking at. System
   * decorations (status bar, navigation bar) are dropped: they are never the subject of a query and
   * including them makes "which window am I on" ambiguous.
   */
  private fun appWindows(): List<AccessibilityWindowInfo> =
    uiAutomation().windows
      .filter { window ->
        window.type == AccessibilityWindowInfo.TYPE_APPLICATION ||
          window.type == AccessibilityWindowInfo.TYPE_INPUT_METHOD
      }
      .sortedByDescending { it.layer }

  /**
   * The package the topmost application window belongs to.
   *
   * This is the single fact a host-side XML dump cannot report, and the reason a caller could
   * otherwise receive the launcher's tree believing it was the app's.
   */
  private fun foregroundPackage(): String? {
    val active = uiAutomation().windows.firstOrNull { it.isActive && it.type == AccessibilityWindowInfo.TYPE_APPLICATION }
      ?: appWindows().firstOrNull { it.type == AccessibilityWindowInfo.TYPE_APPLICATION }
    return active?.root?.packageName?.toString()
  }

  private fun windowSummaries(): JSONArray {
    val windows = JSONArray()
    appWindows().forEachIndexed { index, window ->
      val bounds = Rect().also { window.getBoundsInScreen(it) }
      windows.put(
        JSONObject()
          .put("index", index)
          .put("package", window.root?.packageName?.toString() ?: JSONObject.NULL)
          .put("title", window.title?.toString() ?: JSONObject.NULL)
          .put("type", windowTypeName(window.type))
          .put("active", window.isActive)
          .put("focused", window.isFocused)
          .put("layer", window.layer)
          .put("x", bounds.left)
          .put("y", bounds.top)
          .put("width", bounds.width())
          .put("height", bounds.height()),
      )
    }
    return windows
  }

  private fun windowTypeName(type: Int): String = when (type) {
    AccessibilityWindowInfo.TYPE_APPLICATION -> "application"
    AccessibilityWindowInfo.TYPE_INPUT_METHOD -> "inputMethod"
    AccessibilityWindowInfo.TYPE_SYSTEM -> "system"
    AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY -> "accessibilityOverlay"
    AccessibilityWindowInfo.TYPE_SPLIT_SCREEN_DIVIDER -> "splitScreenDivider"
    else -> "unknown"
  }

  // ---------------------------------------------------------------------------
  // Tree
  // ---------------------------------------------------------------------------

  /**
   * Every describable node, tagged with the window it came from.
   *
   * [allWindows] false restricts the walk to the topmost application window, which is what a caller
   * wants when a dialog or IME is up and it only cares about the app beneath. The default includes
   * every application and IME window, because an element the caller is hunting for is routinely in
   * a popup that `rootInActiveWindow` alone would miss.
   */
  private fun dump(allWindows: Boolean): JSONArray {
    val elements = JSONArray()
    val windows = if (allWindows) appWindows() else appWindows().take(1)
    if (windows.isEmpty()) {
      // No accessible application window — fall back to the active root so a caller mid-transition
      // still gets something rather than an unexplained empty list.
      uiAutomation().rootInActiveWindow?.let { root ->
        collect(root, elements, windowIndex = 0, windowPackage = root.packageName?.toString())
      }
      return elements
    }
    windows.forEachIndexed { index, window ->
      val root = window.root ?: return@forEachIndexed
      collect(root, elements, index, root.packageName?.toString())
    }
    return elements
  }

  private fun collect(
    root: AccessibilityNodeInfo,
    into: JSONArray,
    windowIndex: Int,
    windowPackage: String?,
  ) {
    walk(root) { node ->
      if (describes(node)) {
        into.put(describe(node).put("window", windowIndex).put("package", windowPackage ?: JSONObject.NULL))
      }
    }
  }

  private fun describes(node: AccessibilityNodeInfo): Boolean =
    node.viewIdResourceName != null ||
      !node.text.isNullOrEmpty() ||
      !node.contentDescription.isNullOrEmpty() ||
      node.isClickable

  /**
   * Depth-first walk with hard caps.
   *
   * A Compose tree with a long lazy list can run to thousands of nodes, and an unbounded walk here
   * becomes the slowest part of every call. The caps are generous enough that no real screen hits
   * them, and they turn a pathological tree into a truncated answer rather than a hang.
   */
  private fun walk(node: AccessibilityNodeInfo, visit: (AccessibilityNodeInfo) -> Unit) {
    var visited = 0
    fun descend(current: AccessibilityNodeInfo, depth: Int) {
      if (visited >= MAX_NODES || depth > MAX_DEPTH) return
      visited++
      visit(current)
      for (index in 0 until current.childCount) {
        val child = current.getChild(index) ?: continue
        descend(child, depth + 1)
      }
    }
    descend(node, 0)
  }

  private fun describe(node: AccessibilityNodeInfo): JSONObject {
    val bounds = Rect().also { node.getBoundsInScreen(it) }
    return JSONObject()
      .put("id", node.viewIdResourceName ?: JSONObject.NULL)
      .put("text", node.text?.toString() ?: JSONObject.NULL)
      .put("desc", node.contentDescription?.toString() ?: JSONObject.NULL)
      .put("className", node.className?.toString() ?: JSONObject.NULL)
      .put("clickable", node.isClickable)
      .put("enabled", node.isEnabled)
      .put("focused", node.isFocused)
      .put("editable", node.isEditable)
      .put("scrollable", node.isScrollable)
      // The whole reason this agent exists: the host-side XML dump cannot tell you this.
      .put("visible", node.isVisibleToUser)
      .put("x", bounds.left)
      .put("y", bounds.top)
      .put("width", bounds.width())
      .put("height", bounds.height())
  }

  // ---------------------------------------------------------------------------
  // Selection
  // ---------------------------------------------------------------------------

  /**
   * Resolve a selector to a single node, preferring what the user can actually see.
   *
   * Visibility ranks rather than filters: a caller may legitimately want to know that the thing it
   * asked for exists but is currently covered, which is more useful than "not found". But when both
   * a visible and a hidden match exist — routine with a lazy list that keeps offscreen items
   * attached — acting on the hidden one is always wrong.
   *
   * IME windows are excluded unless the request opts in with `includeIme:true`. Gboard publishes
   * every key as a labelled, clickable, visible node, so a text selector like "a" with the keyboard
   * open would otherwise resolve to the key — and visible-first ranking would *prefer* it over the
   * app's own occluded content. Acting on the keyboard is never what a selector means.
   */
  private fun find(request: JSONObject): AccessibilityNodeInfo? {
    val id = request.optString("id").takeIf { it.isNotEmpty() }
    val idPrefix = request.optString("idPrefix").takeIf { it.isNotEmpty() }
    val text = request.optString("text").takeIf { it.isNotEmpty() }
    val pkg = request.optString("package").takeIf { it.isNotEmpty() }
    val includeIme = request.optBoolean("includeIme", false)

    val matches = mutableListOf<AccessibilityNodeInfo>()
    val windows = appWindows()
      .filter { includeIme || it.type != AccessibilityWindowInfo.TYPE_INPUT_METHOD }
    val roots = if (windows.isEmpty()) {
      listOfNotNull(uiAutomation().rootInActiveWindow)
    } else {
      windows.mapNotNull { it.root }
    }

    for (root in roots) {
      if (pkg != null && root.packageName?.toString() != pkg) continue
      walk(root) { node ->
        val hit = when {
          id != null -> node.viewIdResourceName == id
          idPrefix != null -> node.viewIdResourceName?.startsWith(idPrefix) == true
          text != null -> {
            val haystack = listOfNotNull(node.text?.toString(), node.contentDescription?.toString())
            haystack.any { it.contains(text, ignoreCase = true) }
          }
          // No selector means "whatever the user is typing into", which lets a caller replace the
          // host's `adb shell input text` — ASCII-only — without having to name the field first.
          else -> node.isFocused && node.isEditable
        }
        if (hit) matches += node
      }
    }
    return matches.firstOrNull { it.isVisibleToUser } ?: matches.firstOrNull()
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  /**
   * Act on the node, then confirm something actually happened.
   *
   * Walks up to an actionable ancestor when the match is inert, which is routine on Compose
   * surfaces where the label sits in a child of the node carrying the handler.
   *
   * The verification is not defensive padding. Measured on Android 16 / One UI with Compose UI
   * 1.12.0-beta01: every Compose clickable in the app under test accepted `ACTION_CLICK` and
   * returned true while the handler's effect never landed — dock, icon buttons, M3 buttons, plain
   * cards alike. Invoking the node's Compose `OnClick` semantics lambda directly, in-process on
   * the main thread, behaved identically, so the loss is below the accessibility layer rather than
   * inside it. Only real MotionEvents worked, and the same dispatch drives View-based apps
   * correctly. So the action is followed by a structural re-read, and when the tree is untouched
   * the node's centre is tapped as a real gesture instead.
   *
   * [describe]'s `method` field reports which path ran, so a caller is never guessing. Pass
   * `gestureFallback:false` to suppress the retry for a control whose click is genuinely expected
   * to change nothing on screen.
   */
  private fun act(request: JSONObject, device: UiDevice, action: Int): JSONObject {
    val node = find(request) ?: return noMatch()

    var target: AccessibilityNodeInfo? = node
    while (target != null && !target.isClickable) {
      target = target.parent
    }
    val actionable = target ?: node
    val allowGesture = request.optBoolean("gestureFallback", true)

    val before = fingerprint()
    val performed = actionable.performAction(action)
    if (performed && awaitChange(before)) {
      return ok().put("target", describe(actionable)).put("method", METHOD_NODE)
    }

    if (!allowGesture) {
      return JSONObject()
        .put("ok", performed)
        .put("target", describe(actionable))
        .put("method", METHOD_NODE)
        .put("changed", false)
        .apply { if (!performed) put("error", "Node rejected the action") }
    }

    val bounds = Rect().also { actionable.getBoundsInScreen(it) }
    if (bounds.isEmpty) {
      return fail("Node has no on-screen bounds to tap")
    }
    when (action) {
      // A held pointer stream, not UiDevice.swipe: 60 swipe steps ~ 300ms, which is UNDER the
      // platform's 400ms long-press threshold, so the fallback could fire as a plain tap.
      AccessibilityNodeInfo.ACTION_LONG_CLICK ->
        injectPointerStream(
          listOf(listOf(
            PathPoint(bounds.exactCenterX(), bounds.exactCenterY(), 0L),
            PathPoint(bounds.exactCenterX(), bounds.exactCenterY(), LONG_PRESS_HOLD_MS),
          )),
          holdMs = 0L,
        )
      else -> device.click(bounds.centerX(), bounds.centerY())
    }

    return ok()
      .put("target", describe(actionable))
      .put("method", METHOD_GESTURE)
      .put("changed", awaitChange(before))
  }

  /**
   * Wait for the tree to differ from [before], up to [ACTION_SETTLE_MS].
   *
   * Polling rather than sleeping a fixed budget matters twice over: a click that works is
   * confirmed as soon as the frame lands instead of always costing the worst case, and a click
   * that does nothing reaches its fallback sooner. Both are on the hot path of every tap.
   */
  private fun awaitChange(before: Int): Boolean {
    val deadline = SystemClock.uptimeMillis() + ACTION_SETTLE_MS
    do {
      SystemClock.sleep(CHANGE_POLL_MS)
      if (fingerprint() != before) return true
    } while (SystemClock.uptimeMillis() < deadline)
    return false
  }

  /**
   * Write a field's contents, then prove the write held.
   *
   * Two mechanisms exist and neither is universally correct, so the agent tries them in order and
   * reports which one carried:
   *
   *  1. **`ACTION_SET_TEXT`** — the documented path. Correct for View-based fields and most Compose
   *     fields, needs no clipboard, and is unaffected by which process the agent runs in. It is a
   *     trap on *controlled* Compose fields: the node's reported text reflects the write for a
   *     while — long enough to pass any immediate verification — and then reverts, because the
   *     app's own state never changed and no `onValueChange` ever fired.
   *  2. **Clipboard + `ACTION_PASTE`** — the way a person's text arrives. Paste is executed by the
   *     field's real editing pipeline, which updates the app's state and fires the same listeners
   *     typing does, so it survives the controlled-Compose case that defeats `ACTION_SET_TEXT`.
   *
   * The order is not arbitrary. This driver runs in its **own** process, so the clipboard it writes
   * is not the app's, and Android 10+ denies `setPrimaryClip` to a process that is neither focused
   * nor the default IME — silently, leaving the previous clip in place. [clipboardWritable] probes
   * that rather than assuming it, and [OP_CAPABILITIES] reports the answer so a caller can see the
   * restriction instead of inferring it from a failed write. Cheap-and-usually-right first, then
   * escalate only when the tree proves the write did not hold.
   *
   * Verification runs at two delays in both cases, because the failure mode is an optimistic value
   * that only reverts later.
   *
   * `mode:"append"` keeps the field's current contents and writes at the end — the semantics of
   * *typing* into a focused field, matching what `adb shell input text` does at the cursor. The
   * default replaces, which is the semantics of *setting* a field. The host maps type-keys onto
   * append and set-text onto replace so both transports agree.
   */
  private fun setText(request: JSONObject): JSONObject {
    val node = find(request) ?: return noMatch()

    var target: AccessibilityNodeInfo? = node
    while (target != null && !target.isEditable) {
      target = target.parent
    }
    val field = target ?: return fail("Matched node is not editable")

    val value = request.optString("value")
    val append = request.optString("mode", "replace") == "append"
    val prior = if (append) fieldText(field) else ""
    val expected = prior + value

    // Clearing has no paste equivalent — there is no empty clipboard — so it is always SET_TEXT.
    if (value.isEmpty()) {
      if (append) {
        // Appending nothing is a no-op, not a clear.
        return ok().put("target", describe(field)).put("method", METHOD_SET_TEXT)
      }
      val arguments = Bundle().apply {
        putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, "")
      }
      val performed = field.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, arguments)
      val held = verifyWrite(field, expected)
      return writeResult(field, performed && held, METHOD_SET_TEXT, expected)
    }

    focusField(field)

    // 1. ACTION_SET_TEXT.
    val setArguments = Bundle().apply {
      putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, expected)
    }
    val setPerformed = field.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, setArguments)
    if (setPerformed && verifyWrite(field, expected)) {
      return writeResult(field, true, METHOD_SET_TEXT, expected)
    }

    // 2. Clipboard + ACTION_PASTE, only if this process can actually own the clipboard.
    if (!clipboardWritable()) {
      return writeResult(field, false, METHOD_SET_TEXT, expected)
        .put(
          "error",
          "ACTION_SET_TEXT did not hold (the field is probably a controlled Compose field) and the " +
            "paste fallback is unavailable: this device denies clipboard writes to a process that " +
            "is not focused. Field text is \"${fieldText(field)}\", expected \"$expected\".",
        )
    }

    writeClipboard(value)
    val existing = if (field.isShowingHintText) 0 else field.text?.length ?: 0
    if (existing > 0) {
      // Replace selects everything so the paste swaps the contents; append parks the cursor at
      // the end so the paste extends them.
      val start = if (append) existing else 0
      val selection = Bundle().apply {
        putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, start)
        putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, existing)
      }
      field.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, selection)
    }
    val pastePerformed = field.performAction(AccessibilityNodeInfo.ACTION_PASTE)
    val pasteHeld = verifyWrite(field, expected)
    return writeResult(field, pastePerformed && pasteHeld, METHOD_PASTE, expected)
  }

  /**
   * Two-stage verification: once after a beat, and again after a recomposition's worth of time,
   * because the failure mode is an optimistic value that only reverts later.
   */
  private fun verifyWrite(field: AccessibilityNodeInfo, expected: String): Boolean {
    SystemClock.sleep(FIELD_FOCUS_SETTLE_MS)
    field.refresh()
    if (!writeLanded(field, expected)) return false
    SystemClock.sleep(WRITE_RECHECK_MS)
    field.refresh()
    return writeLanded(field, expected)
  }

  private fun writeResult(
    field: AccessibilityNodeInfo,
    succeeded: Boolean,
    method: String,
    expected: String,
  ): JSONObject = JSONObject()
    .put("ok", succeeded)
    .put("target", describe(field))
    .put("method", method)
    .apply {
      if (!succeeded) {
        put("error", "Field text after write is \"${fieldText(field)}\", expected \"$expected\"")
      }
    }

  /**
   * Focus a field the way a finger does. The click action can be a phantom on Compose chrome, so
   * focus is verified and a real injected tap is the fallback.
   */
  private fun focusField(field: AccessibilityNodeInfo) {
    field.refresh()
    if (field.isFocused) return
    field.performAction(AccessibilityNodeInfo.ACTION_CLICK)
    SystemClock.sleep(FIELD_FOCUS_SETTLE_MS)
    field.refresh()
    if (field.isFocused) return
    val bounds = Rect().also { field.getBoundsInScreen(it) }
    if (bounds.isEmpty) return
    injectPointerStream(
      listOf(listOf(
        PathPoint(bounds.exactCenterX(), bounds.exactCenterY(), 0L),
        PathPoint(bounds.exactCenterX(), bounds.exactCenterY(), TAP_HOLD_MS),
      )),
      holdMs = 0L,
    )
    SystemClock.sleep(FIELD_FOCUS_SETTLE_MS)
    field.refresh()
  }

  /** The field's real contents: empty when only the placeholder is showing. */
  private fun fieldText(field: AccessibilityNodeInfo): String =
    if (field.isShowingHintText) "" else field.text?.toString() ?: ""

  /** Bidi isolates and marks are presentation the app may add around input; fold before comparing. */
  private fun writeLanded(field: AccessibilityNodeInfo, expected: String): Boolean {
    val strip = Regex("[\\u200E\\u200F\\u061C\\u2066-\\u2069\\u202A-\\u202E]")
    return fieldText(field).replace(strip, "") == expected.replace(strip, "")
  }

  /**
   * Bring a node on screen by scrolling its nearest scrollable ancestor.
   *
   * Replaces blind swipe-and-screenshot loops: the platform knows how far it moved, and stops when
   * the container reports it can no longer scroll.
   */
  private fun scrollIntoView(request: JSONObject): JSONObject {
    val maxScrolls = request.optInt("maxScrolls", DEFAULT_MAX_SCROLLS)
    repeat(maxScrolls) { attempt ->
      val node = find(request)
      if (node != null && node.isVisibleToUser) {
        return ok().put("target", describe(node)).put("scrolls", attempt)
      }
      // Prefer the target's own scrollable ancestor. Picking the first scrollable in tree order
      // instead reliably grabs a horizontal carousel on a screen whose real container is the
      // vertical column beneath it, and scrolling that axis moves the target no closer.
      val scrollable = node?.let(::scrollableAncestor) ?: largestScrollable()
        ?: return fail("No scrollable container on screen")
      if (!scrollable.performAction(AccessibilityNodeInfo.ACTION_SCROLL_FORWARD)) {
        // The container may already be showing the target's region; re-check before giving up so a
        // screen that needs no scrolling is a success rather than an error.
        val settled = find(request)
        return if (settled != null && settled.isVisibleToUser) {
          ok().put("target", describe(settled)).put("scrolls", attempt)
        } else {
          fail("Reached the end of the scrollable container without finding the target")
        }
      }
      Thread.sleep(SCROLL_SETTLE_MS)
    }
    return fail("Target did not become visible within $maxScrolls scrolls")
  }

  private fun scrollableAncestor(node: AccessibilityNodeInfo): AccessibilityNodeInfo? {
    var current: AccessibilityNodeInfo? = node.parent
    while (current != null) {
      if (current.isScrollable) return current
      current = current.parent
    }
    return null
  }

  /**
   * The biggest visible scrollable, which on a real screen is the main content container rather
   * than a carousel embedded inside it.
   */
  private fun largestScrollable(): AccessibilityNodeInfo? {
    val roots = appWindows().mapNotNull { it.root }
      .ifEmpty { listOfNotNull(uiAutomation().rootInActiveWindow) }
    var best: AccessibilityNodeInfo? = null
    var bestArea = 0
    for (root in roots) {
      walk(root) { node ->
        if (!node.isScrollable || !node.isVisibleToUser) return@walk
        val bounds = Rect().also { node.getBoundsInScreen(it) }
        val area = bounds.width() * bounds.height()
        if (area > bestArea) {
          bestArea = area
          best = node
        }
      }
    }
    return best
  }

  // ---------------------------------------------------------------------------
  // Waiting
  // ---------------------------------------------------------------------------

  /**
   * Block until the accessibility tree stops changing.
   *
   * Samples a cheap structural fingerprint rather than a full dump, and requires several identical
   * consecutive samples so a mid-animation pause does not read as settled. Returns rather than
   * throws on timeout: some surfaces animate forever, and that is a fact the caller should receive,
   * not an error it has to catch.
   */
  private fun waitStable(request: JSONObject): JSONObject {
    val timeoutMs = request.optLong("timeoutMs", DEFAULT_TIMEOUT_MS)
    val settleSamples = request.optInt("settleSamples", DEFAULT_SETTLE_SAMPLES)
    val deadline = System.currentTimeMillis() + timeoutMs

    var previous: Int? = null
    var identical = 0
    while (System.currentTimeMillis() < deadline) {
      val current = fingerprint()
      if (current == previous) {
        identical++
        if (identical >= settleSamples) {
          return ok().put("stable", true).put("fingerprint", current)
        }
      } else {
        identical = 0
        previous = current
      }
      Thread.sleep(SAMPLE_INTERVAL_MS)
    }
    return ok().put("stable", false).put("fingerprint", previous ?: 0)
  }

  /** Structural hash over node identity, text and geometry — a few ms per sample. */
  private fun fingerprint(): Int {
    var hash = 7
    for (window in appWindows()) {
      val root = window.root ?: continue
      walk(root) { node ->
        val bounds = Rect().also { node.getBoundsInScreen(it) }
        hash = hash * 31 + (node.viewIdResourceName?.hashCode() ?: 0)
        hash = hash * 31 + (node.text?.toString()?.hashCode() ?: 0)
        hash = hash * 31 + bounds.hashCode()
      }
    }
    return hash
  }

  /**
   * Block until the given package owns the topmost application window.
   *
   * The direct answer to the failure this agent was extended for: a caller that launches or
   * navigates can wait for the app to actually be in front instead of sleeping and hoping.
   */
  private fun waitForPackage(request: JSONObject): JSONObject {
    val expected = request.optString("package").takeIf { it.isNotEmpty() }
      ?: return fail("waitForPackage needs a package")
    val timeoutMs = request.optLong("timeoutMs", DEFAULT_TIMEOUT_MS)
    val deadline = System.currentTimeMillis() + timeoutMs

    while (System.currentTimeMillis() < deadline) {
      val foreground = foregroundPackage()
      if (foreground == expected) return ok().put("foreground", foreground)
      Thread.sleep(SAMPLE_INTERVAL_MS)
    }
    return ok()
      .put("visible", false)
      .put("foreground", foregroundPackage() ?: JSONObject.NULL)
      .put("expected", expected)
  }

  // ---------------------------------------------------------------------------
  // Raw touch injection
  //
  // `adb shell input` can express a tap and a straight-line swipe, and nothing else — no curved
  // path, no drag that starts with a hold, and structurally no second finger. These ops inject
  // real MotionEvent streams through UiAutomation, which is the same entry point the platform's
  // own test tooling uses, so anything a finger can do becomes expressible.
  // ---------------------------------------------------------------------------

  private data class PathPoint(val x: Float, val y: Float, val dtMs: Long)

  /**
   * Single-finger timed path: down at the first point, move through the rest, lift at the last.
   *
   * `holdMs` waits between the down and the first move, which is how long-press-then-drag works —
   * the hold is what flips a list row into drag mode before the finger travels.
   */
  private fun gesture(request: JSONObject): JSONObject {
    val points = pathPoints(request.optJSONArray("points"))
      ?: return fail("gesture needs points: [{x, y, dtMs?}, ...] with at least 2 entries")
    val holdMs = request.optLong("holdMs", 0L)

    injectPointerStream(listOf(points), holdMs)
    return ok().put("points", points.size).put("changed", true)
  }

  /**
   * Two-finger symmetric pinch about a centre point, optionally rotated.
   *
   * Expressed as spreads (finger-to-finger distance) rather than raw paths because that is how a
   * caller thinks about it: "open from 200px apart to 800px apart over 400ms".
   */
  private fun pinch(request: JSONObject): JSONObject {
    val centerX = request.optDouble("centerX", Double.NaN)
    val centerY = request.optDouble("centerY", Double.NaN)
    if (centerX.isNaN() || centerY.isNaN()) {
      return fail("pinch needs centerX and centerY in device pixels")
    }
    val startSpread = request.optDouble("startSpread", Double.NaN)
    val endSpread = request.optDouble("endSpread", Double.NaN)
    if (startSpread.isNaN() || endSpread.isNaN() || startSpread < 0 || endSpread < 0) {
      return fail("pinch needs startSpread and endSpread (finger distance in pixels, >= 0)")
    }
    val durationMs = request.optLong("durationMs", DEFAULT_PINCH_DURATION_MS)
      .coerceIn(MIN_GESTURE_DURATION_MS, MAX_GESTURE_DURATION_MS)
    val angleRad = Math.toRadians(request.optDouble("angleDeg", 0.0))
    val steps = (durationMs / GESTURE_FRAME_MS).toInt().coerceAtLeast(2)

    val dx = Math.cos(angleRad)
    val dy = Math.sin(angleRad)
    fun finger(sign: Int): List<PathPoint> = (0..steps).map { step ->
      val t = step.toDouble() / steps
      val half = (startSpread + (endSpread - startSpread) * t) / 2.0
      PathPoint(
        (centerX + sign * dx * half).toFloat(),
        (centerY + sign * dy * half).toFloat(),
        if (step == 0) 0L else GESTURE_FRAME_MS,
      )
    }

    injectPointerStream(listOf(finger(+1), finger(-1)), holdMs = 0L)
    return ok().put("steps", steps).put("changed", true)
  }

  /**
   * Two precise taps inside the platform's double-tap window.
   *
   * The adb path cannot express this: each `input tap` spawns its own device-side process, so two
   * of them land 400-600ms apart — over the ~300ms double-tap timeout — and register as two singles.
   * Injected streams put the gap where it belongs.
   */
  private fun doubleTap(request: JSONObject): JSONObject {
    val x = request.optDouble("x", Double.NaN)
    val y = request.optDouble("y", Double.NaN)
    if (x.isNaN() || y.isNaN()) {
      return fail("doubleTap needs x and y in device pixels")
    }
    repeat(2) { index ->
      injectPointerStream(
        listOf(listOf(
          PathPoint(x.toFloat(), y.toFloat(), 0L),
          PathPoint(x.toFloat(), y.toFloat(), TAP_HOLD_MS),
        )),
        holdMs = 0L,
      )
      if (index == 0) SystemClock.sleep(DOUBLE_TAP_GAP_MS)
    }
    return ok().put("changed", true)
  }

  private fun pathPoints(array: JSONArray?): List<PathPoint>? {
    if (array == null || array.length() < 2) return null
    val points = ArrayList<PathPoint>(array.length())
    for (index in 0 until array.length()) {
      val entry = array.optJSONObject(index) ?: return null
      val x = entry.optDouble("x", Double.NaN)
      val y = entry.optDouble("y", Double.NaN)
      if (x.isNaN() || y.isNaN()) return null
      val dt = if (index == 0) 0L else entry.optLong("dtMs", GESTURE_FRAME_MS)
      points += PathPoint(x.toFloat(), y.toFloat(), dt.coerceIn(1L, MAX_GESTURE_DURATION_MS))
    }
    return points
  }

  /**
   * Drive one or more fingers through their paths as a single MotionEvent stream.
   *
   * All fingers share a clock: each stream step advances to the next point of every path that
   * still has one; a finger whose path is exhausted holds its last position until the shared
   * lift at the end. Events are injected synchronously so the stream cannot outrun the app's
   * input queue, and every event is recycled — this loop can run thousands of times per session.
   */
  private fun injectPointerStream(paths: List<List<PathPoint>>, holdMs: Long) {
    require(paths.isNotEmpty() && paths.all { it.isNotEmpty() })
    val automation = uiAutomation()
    val downTime = SystemClock.uptimeMillis()

    val properties = paths.indices.map { id ->
      MotionEvent.PointerProperties().apply {
        this.id = id
        toolType = MotionEvent.TOOL_TYPE_FINGER
      }
    }
    fun coords(positions: List<PathPoint>): Array<MotionEvent.PointerCoords> =
      positions.map { point ->
        MotionEvent.PointerCoords().apply {
          x = point.x
          y = point.y
          pressure = 1f
          size = 1f
        }
      }.toTypedArray()

    fun inject(action: Int, activePointers: Int, positions: List<PathPoint>) {
      val event = MotionEvent.obtain(
        downTime, SystemClock.uptimeMillis(), action, activePointers,
        properties.take(activePointers).toTypedArray(), coords(positions),
        0, 0, 1f, 1f, 0, 0, InputDevice.SOURCE_TOUCHSCREEN, 0,
      )
      try {
        automation.injectInputEvent(event, true)
      } finally {
        event.recycle()
      }
    }

    // Fingers down: primary first, then secondary pointers with their index encoded in the action.
    val starts = paths.map { it.first() }
    inject(MotionEvent.ACTION_DOWN, 1, starts.take(1))
    for (pointer in 1 until paths.size) {
      inject(
        MotionEvent.ACTION_POINTER_DOWN or (pointer shl MotionEvent.ACTION_POINTER_INDEX_SHIFT),
        pointer + 1,
        starts.take(pointer + 1),
      )
    }
    if (holdMs > 0) SystemClock.sleep(holdMs)

    // Shared-clock walk. `positions` always holds every finger's current location so each MOVE
    // event carries all pointers, which is what a real multi-touch stream looks like.
    val cursors = IntArray(paths.size) { 0 }
    val positions = starts.toMutableList()
    val maxSteps = paths.maxOf { it.size - 1 }
    for (step in 1..maxSteps) {
      var dt = 0L
      for (pointer in paths.indices) {
        if (cursors[pointer] < paths[pointer].size - 1) {
          cursors[pointer]++
          val point = paths[pointer][cursors[pointer]]
          positions[pointer] = point
          dt = maxOf(dt, point.dtMs)
        }
      }
      if (dt > 0) SystemClock.sleep(dt)
      inject(MotionEvent.ACTION_MOVE, paths.size, positions)
    }

    // Fingers up, secondary pointers first so the stream stays well formed.
    for (pointer in paths.size - 1 downTo 1) {
      inject(
        MotionEvent.ACTION_POINTER_UP or (pointer shl MotionEvent.ACTION_POINTER_INDEX_SHIFT),
        pointer + 1,
        positions.take(pointer + 1),
      )
    }
    inject(MotionEvent.ACTION_UP, 1, positions.take(1))
  }

  // ---------------------------------------------------------------------------
  // Screenshot
  // ---------------------------------------------------------------------------

  /**
   * Screenshot, scaled and encoded on-device.
   *
   * The naive shape — native-resolution PNG, base64'd through a JSON line — makes the host decode a
   * multi-megabyte string, then shell out to sips/ImageMagick with temp files to produce the small
   * JPEG it actually wanted. Scaling and JPEG-encoding here turns the wire payload into ~20-40KB
   * and deletes the host's image-tooling dependency for this path entirely.
   *
   * `deviceWidth`/`deviceHeight` always report the native pixel space every element's bounds are
   * expressed in; `width`/`height` describe the returned image, so the host can state the exact
   * factor instead of leaving a caller to infer one. No `maxWidth` means native resolution.
   */
  private fun screenshot(request: JSONObject): JSONObject {
    val raw = uiAutomation().takeScreenshot() ?: return fail("Screenshot returned nothing")
    // takeScreenshot can hand back a HARDWARE-config bitmap, which createScaledBitmap/compress
    // cannot read pixels from; copy it into software memory first.
    val source = if (raw.config == Bitmap.Config.HARDWARE) {
      raw.copy(Bitmap.Config.ARGB_8888, false).also { raw.recycle() }
        ?: return fail("Could not copy hardware bitmap")
    } else {
      raw
    }
    try {
      val maxWidth = request.optInt("maxWidth", 0)
      val scaled = if (maxWidth in 1 until source.width) {
        val height = Math.round(source.height.toFloat() * maxWidth / source.width)
        Bitmap.createScaledBitmap(source, maxWidth, height.coerceAtLeast(1), true)
      } else {
        source
      }
      try {
        val format = request.optString("format", "jpeg")
        val png = format == "png"
        val quality = request.optInt("quality", DEFAULT_JPEG_QUALITY).coerceIn(30, 100)
        val stream = ByteArrayOutputStream()
        scaled.compress(if (png) Bitmap.CompressFormat.PNG else Bitmap.CompressFormat.JPEG, quality, stream)
        return ok()
          .put("width", scaled.width)
          .put("height", scaled.height)
          .put("deviceWidth", source.width)
          .put("deviceHeight", source.height)
          .put("format", if (png) "png" else "jpeg")
          .put("data", Base64.encodeToString(stream.toByteArray(), Base64.NO_WRAP))
      } finally {
        if (scaled !== source) scaled.recycle()
      }
    } finally {
      source.recycle()
    }
  }

  // ---------------------------------------------------------------------------

  private fun ok(): JSONObject = JSONObject().put("ok", true)

  private fun fail(message: String): JSONObject = JSONObject().put("ok", false).put("error", message)

  private fun noMatch(): JSONObject = JSONObject()
    .put("ok", false)
    .put("error", "No node matched")
    // Naming the foreground app turns the most common cause — the target app is not in front —
    // from a guess into a fact the caller can act on.
    .put("foreground", foregroundPackage() ?: JSONObject.NULL)

  private companion object {
    const val PORT = 8299
    const val BACKLOG = 4

    /** Bumped whenever an op's request or response shape changes, so the host can refuse a stale pair. */
    const val PROTOCOL = 6

    const val OP_PING = "ping"
    const val OP_CAPABILITIES = "capabilities"
    const val OP_DUMP = "dump"
    const val OP_WINDOWS = "windows"
    const val OP_CLICK = "click"
    const val OP_LONG_CLICK = "longClick"
    const val OP_SET_TEXT = "setText"
    const val OP_SCROLL_INTO_VIEW = "scrollIntoView"
    const val OP_SCREENSHOT = "screenshot"
    const val OP_GESTURE = "gesture"
    const val OP_PINCH = "pinch"
    const val OP_DOUBLE_TAP = "doubleTap"
    const val OP_WAIT_IDLE = "waitIdle"
    const val OP_WAIT_STABLE = "waitStable"
    const val OP_WAIT_FOR_PACKAGE = "waitForPackage"
    const val OP_SHUTDOWN = "shutdown"

    const val DEFAULT_TIMEOUT_MS = 10_000L
    const val DEFAULT_SETTLE_SAMPLES = 2
    const val DEFAULT_MAX_SCROLLS = 12
    const val DEFAULT_JPEG_QUALITY = 75
    const val SAMPLE_INTERVAL_MS = 120L
    const val SCROLL_SETTLE_MS = 250L
    const val ACTION_SETTLE_MS = 350L

    /** How often [awaitChange] re-reads the tree. One fingerprint costs a few ms. */
    const val CHANGE_POLL_MS = 40L

    /** Above the platform's 400ms long-press threshold, with margin for a slow frame. */
    const val LONG_PRESS_HOLD_MS = 600L
    const val DOUBLE_TAP_GAP_MS = 100L

    const val METHOD_NODE = "node"
    const val METHOD_GESTURE = "gesture"
    const val METHOD_SET_TEXT = "setText"
    const val METHOD_PASTE = "paste"
    const val FIELD_FOCUS_SETTLE_MS = 150L
    const val WRITE_RECHECK_MS = 350L
    const val TAP_HOLD_MS = 40L

    const val GESTURE_FRAME_MS = 12L
    const val DEFAULT_PINCH_DURATION_MS = 400L
    const val MIN_GESTURE_DURATION_MS = 50L
    const val MAX_GESTURE_DURATION_MS = 60_000L

    /** Generous enough that no real screen reaches them; a hang becomes a truncated answer. */
    const val MAX_NODES = 4_000
    const val MAX_DEPTH = 120
  }
}
