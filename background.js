// background.js

const ORDER_KEY = 'windowOrder';
// ---------- Throttling / pacing (Pause for OS desktop switching) ----------

const MIN_ACTION_INTERVAL_MS = 250;   // spacing between queued operations
const POST_FOCUS_SETTLE_MS = 200;     // extra time after focus confirmed
let lastActionAt = 0;
const rangeAnchorByWindow = new Map(); // windowId -> anchorIndex
let rangeSelectInProgress = false;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Ensures we don't run actions faster than macOS Spaces can visually keep up.
async function paceActions(minIntervalMs = MIN_ACTION_INTERVAL_MS) {
  const now = Date.now();
  const elapsed = now - lastActionAt;
  if (elapsed < minIntervalMs) {
    await sleep(minIntervalMs - elapsed);
  }
  lastActionAt = Date.now();
}

// ---------- Helper functions ----------

function getAllNormalWindows() {
  return new Promise((resolve) => {
    chrome.windows.getAll({ windowTypes: ['normal'] }, resolve);
  });
}

function getStoredOrder() {
  return new Promise((resolve) => {
    chrome.storage.local.get(ORDER_KEY, (data) => {
      resolve(data[ORDER_KEY] || null);
    });
  });
}

function setStoredOrder(order) {
  return new Promise((resolve) => {
    const obj = {};
    obj[ORDER_KEY] = order;
    chrome.storage.local.set(obj, resolve);
  });
}

// Ensure our order is valid & synced with current windows
async function getEffectiveOrder() {
  const [windows, storedOrder] = await Promise.all([getAllNormalWindows(), getStoredOrder()]);

  const currentIds = windows.map((w) => w.id);
  let order = storedOrder;

  if (!order || !Array.isArray(order) || order.length === 0) {
    order = currentIds;
  } else {
    const setCurrent = new Set(currentIds);
    // keep only existing windows
    order = order.filter((id) => setCurrent.has(id));

    const setOrder = new Set(order);
    const newOnes = currentIds.filter((id) => !setOrder.has(id));
    order = order.concat(newOnes);

    if (order.length === 0) {
      order = currentIds;
    }
  }

  await setStoredOrder(order);
  return order;
}

function getCurrentWindow() {
  return new Promise((resolve) => {
    chrome.windows.getLastFocused({ populate: false }, resolve);
  });
}

// ---------- Focus-cycling logic ----------

async function focusWindowByOffset(offset) {
  await paceActions();
  const [order, currentWin] = await Promise.all([getEffectiveOrder(), getCurrentWindow()]);

  if (!currentWin || !currentWin.id) return;
  if (order.length === 0) return;

  let idx = order.indexOf(currentWin.id);
  if (idx === -1) {
    // Not in order yet; rebuild & retry once
    const newOrder = await getEffectiveOrder();
    idx = newOrder.indexOf(currentWin.id);
    if (idx === -1 || newOrder.length === 0) return;
    const nextIdx = (idx + offset + newOrder.length) % newOrder.length;
    await chrome.windows.update(newOrder[nextIdx], { focused: true });
    return;
  }

  const nextIdx = (idx + offset + order.length) % order.length;
  await chrome.windows.update(order[nextIdx], { focused: true });
}

// ---------- Tab-moving logic ----------

function getSelectedTabs(windowId) {
  return new Promise((resolve) => {
    chrome.tabs.query({ windowId, highlighted: true }, (tabs) => {
      resolve(tabs || []);
    });
  });
}

function getActiveTab(windowId) {
  return new Promise((resolve) => {
    chrome.tabs.query({ windowId, active: true }, (tabs) => {
      resolve(tabs && tabs[0] ? tabs[0] : null);
    });
  });
}

function getTabsInWindow(windowId) {
  return new Promise((resolve) => {
    chrome.tabs.query({ windowId }, (tabs) => {
      resolve(tabs || []);
    });
  });
}

function moveTabs(tabIds, targetWindowId, index) {
  return new Promise((resolve, reject) => {
    chrome.tabs.move(tabIds, { windowId: targetWindowId, index }, (result) => {
      if (chrome.runtime.lastError) {
        console.error('moveTabs error:', chrome.runtime.lastError);
        reject(chrome.runtime.lastError);
      } else {
        resolve(result);
      }
    });
  });
}


let moveInProgress = false;
let moveQueue = [];

function focusWindow(windowId) {
  return new Promise((resolve) => {
    chrome.windows.update(windowId, { focused: true }, () => {
      // ignore lastError here; just resolve
      resolve();
    });
  });
}

function highlightTabs(windowId, indices) {
  return new Promise((resolve) => {
    if (!indices || indices.length === 0) {
      resolve();
      return;
    }

    chrome.tabs.highlight({ windowId, tabs: indices }, () => {
      if (chrome.runtime.lastError) {
        console.warn('highlight error:', chrome.runtime.lastError);
      }
      resolve();
    });
  });
}


async function moveSelectedTabsByOffset(offset) {

  if (moveInProgress) {
    // Queue the request
    moveQueue.push(offset);
    return;
  }
  moveInProgress = true;

  try {
    await paceActions();

    const currentWin = await getCurrentWindow();
    if (!currentWin || !currentWin.id) return;

    // Get the current effective order
    let order = await getEffectiveOrder();
    if (!order || order.length < 2) return;

    const currentWinId = currentWin.id;
    let idx = order.indexOf(currentWinId);

    if (idx === -1) {
      // Rebuild once if the current window isn't in the order
      order = await getEffectiveOrder();
      idx = order.indexOf(currentWinId);
      if (idx === -1 || order.length < 2) return;
    }

    const targetIdx = (idx + offset + order.length) % order.length;
    const targetWinId = order[targetIdx];
    if (targetWinId === currentWinId) return;

    // Get selected tabs; if none, fall back to active tab
    let selectedTabs = await getSelectedTabs(currentWinId);
    if (!selectedTabs || selectedTabs.length === 0) {
      const activeTab = await getActiveTab(currentWinId);
      if (activeTab) {
        selectedTabs = [activeTab];
      } else {
        return;
      }
    }

    // Sort by index to preserve left-to-right order
    selectedTabs.sort((a, b) => a.index - b.index);
    const tabIds = selectedTabs.map((t) => t.id);

    // Remember which selected tab was active
    const activeSelected = selectedTabs.find((t) => t.active) || selectedTabs[0];
    const activeSelectedTabId = activeSelected.id;

    // Insert at end of target window
    const targetTabsBefore = await getTabsInWindow(targetWinId);
    const insertIndex = targetTabsBefore.length;

    let movedTabs;
    try {
      movedTabs = await moveTabs(tabIds, targetWinId, insertIndex);
    } catch (e) {
      console.error('Error moving tabs:', e);
      return;
    }

    const movedArray = Array.isArray(movedTabs) ? movedTabs : [movedTabs];
    const movedIdsSet = new Set(tabIds);
    const finalMoved = movedArray.filter((t) => movedIdsSet.has(t.id));

    if (finalMoved.length === 0) return;

    const newIndices = finalMoved.map((t) => t.index).sort((a, b) => a - b);

    // Focus target window first
    await focusWindow(targetWinId);

    // Wait until the target window is actually focused (polling)
    const maxWait = 1000; // ms
    const pollInterval = 30; // ms
    let waited = 0;
    while (waited < maxWait) {
      const lastFocused = await new Promise((resolve) => {
        chrome.windows.getLastFocused({ populate: false }, resolve);
      });
      if (lastFocused && lastFocused.id === targetWinId) break;
      await new Promise((r) => setTimeout(r, pollInterval));
      waited += pollInterval;
    }

    // Give macOS Spaces a beat to catch up visually
    await sleep(POST_FOCUS_SETTLE_MS);

    // Make the intended moved tab active AND highlight all moved tabs in one step
    const activeMoved = finalMoved.find((t) => t.id === activeSelectedTabId);
    const activeIndex = activeMoved ? activeMoved.index : newIndices[0];

    // Put activeIndex first so tabs.highlight activates it
    const ordered = [activeIndex, ...newIndices.filter((i) => i !== activeIndex)];

    await highlightTabs(targetWinId, ordered);

    // Optional: macOS/Chrome sometimes drops multi-select briefly; re-assert once
    await new Promise((r) => setTimeout(r, 30));
    await highlightTabs(targetWinId, ordered);
  } finally {
    moveInProgress = false;
    if (moveQueue.length > 0) {
      const nextOffset = moveQueue.shift();
      await paceActions();
      moveSelectedTabsByOffset(nextOffset);
    }
  }
}

// ---------- Multi-select stepping (left/right) ----------

async function multiSelectTabs(direction /* -1 or +1 */) {
  const currentWin = await getCurrentWindow();
  if (!currentWin || !currentWin.id) return;

  const windowId = currentWin.id;

  const activeTab = await getActiveTab(windowId);
  if (!activeTab) return;

  const allTabs = await getTabsInWindow(windowId);
  if (!allTabs || allTabs.length === 0) return;

  const caretIndex = activeTab.index;
  const nextIndex = caretIndex + direction;

  // Clamp (no wrap)
  if (nextIndex < 0 || nextIndex >= allTabs.length) return;

  // Initialize anchor once per "selection session"
  let anchor = rangeAnchorByWindow.get(windowId);
  if (!Number.isInteger(anchor) || anchor < 0 || anchor >= allTabs.length) {
    anchor = caretIndex;
    rangeAnchorByWindow.set(windowId, anchor);
  }

  // Build contiguous range [min(anchor, nextIndex) .. max(anchor, nextIndex)]
  const lo = Math.min(anchor, nextIndex);
  const hi = Math.max(anchor, nextIndex);

  const range = [];
  for (let i = lo; i <= hi; i++) range.push(i);

  // Put nextIndex first so tabs.highlight activates it
  const ordered = [nextIndex, ...range.filter((i) => i !== nextIndex)];

  // IMPORTANT: set flag BEFORE highlight (highlight triggers onActivated)
  rangeSelectInProgress = true;
  try {
    await highlightTabs(windowId, ordered);

    // Optional re-assert
    await new Promise((r) => setTimeout(r, 30));
    await highlightTabs(windowId, ordered);
  } finally {
    // Give the onActivated event time to fire before clearing the flag
    setTimeout(() => { rangeSelectInProgress = false; }, 100);
  }
}


// ---------- Window order maintenance ----------

chrome.windows.onCreated.addListener(async (win) => {
  if (win.type !== 'normal') return;
  const order = await getEffectiveOrder();
  if (!order.includes(win.id)) {
    order.push(win.id);
    await setStoredOrder(order);
  }
});

chrome.windows.onRemoved.addListener(async (winId) => {
  const order = await getStoredOrder();
  if (!order) return;
  const newOrder = order.filter((id) => id !== winId);
  await setStoredOrder(newOrder);
});

// ---------- Command handler ----------

chrome.commands.onCommand.addListener((command) => {
  if (command === 'focus-next-window') {
    focusWindowByOffset(1);
  } else if (command === 'focus-previous-window') {
    focusWindowByOffset(-1);
  } else if (command === 'move-tabs-next-window') {
    moveSelectedTabsByOffset(1);
  } else if (command === 'move-tabs-previous-window') {
    moveSelectedTabsByOffset(-1);
  } else if (command === 'multi-select-tab-left') {
    multiSelectTabs(-1);
  } else if (command === 'multi-select-tab-right') {
    multiSelectTabs(1);
  }
});

// ---------- Diagnostic / early-init IIFE ----------
// Purpose: log when the service worker initializes and confirm command registration.
(async function serviceWorkerInitDiagnostics() {
  try {
    console.log('[reorder] service worker init - starting diagnostics');

    // Force an early load of stored order (touches chrome.storage and windows APIs)
    try {
      await getEffectiveOrder();
      console.log('[reorder] getEffectiveOrder() completed');
    } catch (e) {
      console.warn('[reorder] getEffectiveOrder() failed', e);
    }

    // Log available commands to ensure Chrome has registered them
    if (chrome.commands && chrome.commands.getAll) {
      chrome.commands.getAll((cmds) => {
        console.log('[reorder] chrome.commands.getAll ->', cmds);
      });
    } else {
      console.warn('[reorder] chrome.commands API unavailable');
    }

    // Lightweight runtime call that tends to wake the worker early
    if (chrome.runtime && chrome.runtime.getPlatformInfo) {
      chrome.runtime.getPlatformInfo((info) => {
        console.log('[reorder] platform info:', info && info.os);
      });
    }

    console.log('[reorder] service worker init - diagnostics complete');
  } catch (err) {
    console.error('[reorder] service worker init diagnostics error', err);
  }
})();

// ---------- Service worker initialization ----------
// Ensure the service worker wakes up and registers listeners on install/update
chrome.runtime.onInstalled.addListener(async () => {
  console.log('Extension installed/updated - listeners registered');
  // Initialize the order to ensure storage is ready
  await getEffectiveOrder();
});

// Wake up on browser startup to ensure listeners are active
chrome.runtime.onStartup.addListener(async () => {
  console.log('Browser started - listeners registered');
  // Initialize the order to ensure everything is ready
  await getEffectiveOrder();
});

// ---------- Reset range anchor on tab/window activation ----------
chrome.tabs.onActivated.addListener(({ windowId }) => {
  if (rangeSelectInProgress) return; // activation caused by our shortcut
  rangeAnchorByWindow.delete(windowId); // user clicked / other activation => reset anchor
});