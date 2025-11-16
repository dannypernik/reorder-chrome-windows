// background.js

const ORDER_KEY = 'windowOrder';

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
    chrome.windows.getCurrent(resolve);
  });
}

// ---------- Focus-cycling logic ----------

async function focusWindowByOffset(offset) {
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
  if (moveInProgress) return;
  moveInProgress = true;

  try {
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

    // Small delay to let Chrome settle its internal state (helps with races)
    await new Promise((r) => setTimeout(r, 30));

    // Highlight all moved tabs, then restore active tab
    await highlightTabs(targetWinId, newIndices);
    chrome.tabs.update(activeSelectedTabId, { active: true });
  } finally {
    moveInProgress = false;
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
  }
});
