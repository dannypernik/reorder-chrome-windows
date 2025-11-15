const ORDER_KEY = 'windowOrder';
const TITLE_OVERRIDES_KEY = 'windowTitleOverrides';

let draggedItem = null;

function showStatus(message, type = 'ok') {
  const statusEl = document.getElementById('status');
  statusEl.textContent = message || '';
  statusEl.className = '';
  if (message) {
    statusEl.classList.add(type);
  }
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

function getTitleOverrides() {
  return new Promise((resolve) => {
    chrome.storage.local.get(TITLE_OVERRIDES_KEY, (data) => {
      resolve(data[TITLE_OVERRIDES_KEY] || {});
    });
  });
}

function setTitleOverrides(overrides) {
  return new Promise((resolve) => {
    const obj = {};
    obj[TITLE_OVERRIDES_KEY] = overrides;
    chrome.storage.local.set(obj, resolve);
  });
}

function getAllNormalWindows() {
  // populate: true so we can access tabs and titles
  return new Promise((resolve) => {
    chrome.windows.getAll({ windowTypes: ['normal'], populate: true }, (windows) => {
      resolve(windows);
    });
  });
}

function getActiveBrowserWindowId() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs && tabs[0]) {
        resolve(tabs[0].windowId);
      } else {
        resolve(null);
      }
    });
  });
}

async function buildEffectiveOrder() {
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
  return { windows, order };
}

function getWindowTitle(win) {
  if (win.tabs && win.tabs.length > 0) {
    const activeTab = win.tabs.find((t) => t.active) || win.tabs[0];
    return activeTab.title || 'Window';
  }
  return 'Window';
}

function clearList() {
  const list = document.getElementById('window-list');
  while (list.firstChild) {
    list.removeChild(list.firstChild);
  }
}

async function handleEditTitle(windowId, originalTitle, li) {
  const key = String(windowId);
  const overrides = await getTitleOverrides();

  const titleSpan = li.querySelector('.window-title');
  const subline = li.querySelector('.window-subline');

  if (!titleSpan) return;

  const currentOverride = overrides[key] || '';
  const initial = currentOverride || originalTitle;

  // Replace title span with input
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'window-title-input';
  input.value = initial;
  input.dataset.original = originalTitle;

  // Replace element
  titleSpan.replaceWith(input);
  input.focus();
  input.select();

  // Save logic
  const commit = async () => {
    const trimmed = input.value.trim();

    if (trimmed && trimmed !== originalTitle) {
      overrides[key] = trimmed;
    } else {
      delete overrides[key];
    }
    await setTitleOverrides(overrides);

    // Rebuild the title span
    const newTitle = document.createElement('span');
    newTitle.className = 'window-title';
    newTitle.textContent = trimmed || originalTitle;

    if (trimmed && trimmed !== originalTitle) {
      newTitle.classList.add('window-title-custom');
    }

    input.replaceWith(newTitle);

    // Update subtitle
    if (trimmed && trimmed !== originalTitle) {
      subline.textContent = originalTitle;
    } else {
      subline.textContent = '\u00A0';
    }

    // Add click handler back to new title (for future editing!)
    newTitle.addEventListener('mousedown', (e) => e.stopPropagation());
  };

  // Cancel logic (Escape)
  const cancel = () => {
    const restored = document.createElement('span');
    restored.className = 'window-title';
    restored.textContent = initial;
    input.replaceWith(restored);
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commit();
    if (e.key === 'Escape') cancel();
  });

  input.addEventListener('blur', commit);
}

function createListItem(win, isActive, overrides) {
  const li = document.createElement('li');
  li.className = 'window-item';
  li.draggable = true;
  li.dataset.windowId = String(win.id);

  const originalTitle = getWindowTitle(win);
  li.dataset.originalTitle = originalTitle;

  const key = String(win.id);
  const override = (overrides[key] || '').trim();
  const mainTitle = override || originalTitle;

  const main = document.createElement('div');
  main.className = 'window-main';

  const titleLine = document.createElement('div');
  titleLine.className = 'window-title-line';

  //
  // EDIT ICON (left)
  //
  const editIcon = document.createElement('span');
  editIcon.className = 'window-edit-icon';
  editIcon.title = 'Rename this window';
  editIcon.textContent = '✎';
  editIcon.style.marginTop = '-3px'; // because ✎ points downward

  editIcon.addEventListener('mousedown', (e) => e.stopPropagation());
  editIcon.addEventListener('click', (e) => {
    e.stopPropagation();
    handleEditTitle(win.id, originalTitle, li);
  });

  //
  // TITLE BLOCK (column: title row + subline)
  //
  const titleBlock = document.createElement('div');
  titleBlock.style.display = 'flex';
  titleBlock.style.flexDirection = 'column';
  titleBlock.style.flex = '1';
  titleBlock.style.minWidth = '0';

  //
  // TITLE ROW
  //
  const titleRow = document.createElement('div');
  titleRow.style.display = 'flex';
  titleRow.style.alignItems = 'center';
  titleRow.style.gap = '6px';
  titleRow.style.minWidth = '0';

  const titleSpan = document.createElement('span');
  titleSpan.className = 'window-title';
  titleSpan.textContent = mainTitle;

  if (override && override !== originalTitle) {
    titleSpan.classList.add('window-title-custom');
  }

  const tabsCountSpan = document.createElement('span');
  tabsCountSpan.className = 'window-tabs-count';
  const tabCount = win.tabs ? win.tabs.length : 0;
  tabsCountSpan.textContent = `(${tabCount} tab${tabCount === 1 ? '' : 's'})`;

  let activeIndicator = null;
  if (isActive) {
    activeIndicator = document.createElement('span');
    // activeIndicator.className = 'window-active-indicator';
    activeIndicator.title = 'Active window';
    li.classList.add('active-window');
  }

  titleRow.appendChild(titleSpan);
  if (activeIndicator) titleRow.appendChild(activeIndicator);
  titleRow.appendChild(tabsCountSpan);

  //
  // SUBTITLE
  //
  const subline = document.createElement('div');
  subline.className = 'window-subline';

  if (override && override !== originalTitle) {
    subline.textContent = originalTitle;
  } else {
    subline.textContent = '\u00A0'; // blank but keeps height unchanged
  }

  //
  // Assemble
  //
  titleBlock.appendChild(titleRow);
  titleBlock.appendChild(subline);

  titleLine.appendChild(editIcon);
  titleLine.appendChild(titleBlock);

  main.appendChild(titleLine);
  li.appendChild(main);

  //
  // Drag events on entire row
  //
  li.addEventListener('dragstart', handleDragStart);
  li.addEventListener('dragover', handleDragOver);
  li.addEventListener('dragleave', handleDragLeave);
  li.addEventListener('drop', handleDrop);
  li.addEventListener('dragend', handleDragEnd);

  return li;
}

function handleDragStart(e) {
  draggedItem = this;
  this.classList.add('dragging');
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', this.dataset.windowId || '');
  }
}

function handleDragOver(e) {
  e.preventDefault(); // necessary to allow a drop
  this.classList.add('over');
  if (e.dataTransfer) {
    e.dataTransfer.dropEffect = 'move';
  }
}

function handleDragLeave(_e) {
  this.classList.remove('over');
}

function handleDrop(e) {
  e.preventDefault();
  this.classList.remove('over');

  const list = this.parentNode;
  if (!draggedItem || draggedItem === this) return;

  const children = Array.from(list.children);
  const draggedIndex = children.indexOf(draggedItem);
  const targetIndex = children.indexOf(this);

  if (draggedIndex < 0 || targetIndex < 0) return;

  if (draggedIndex < targetIndex) {
    list.insertBefore(draggedItem, this.nextSibling);
  } else {
    list.insertBefore(draggedItem, this);
  }
}

async function handleDragEnd(_e) {
  this.classList.remove('dragging');
  draggedItem = null;

  document.querySelectorAll('#window-list .over').forEach((el) => el.classList.remove('over'));

  // autosave new order based on current DOM
  await saveOrderFromDom(false);
}

async function loadWindowsIntoList() {
  showStatus('Loading windows...');
  try {
    const [activeWindowId, { windows, order }, overrides] = await Promise.all([getActiveBrowserWindowId(), buildEffectiveOrder(), getTitleOverrides()]);

    const list = document.getElementById('window-list');
    clearList();

    const winById = new Map();
    windows.forEach((w) => winById.set(w.id, w));

    let addedCount = 0;

    order.forEach((id) => {
      const win = winById.get(id);
      if (win) {
        const isActive = activeWindowId != null && id === activeWindowId;
        const li = createListItem(win, isActive, overrides);
        list.appendChild(li);
        addedCount++;
      }
    });

    if (addedCount === 0) {
      showStatus('No Chrome windows found.', 'error');
    } else {
      // clear status on success
      showStatus('');
    }
  } catch (err) {
    console.error(err);
    showStatus('Error loading windows.', 'error');
  }
}

async function saveOrderFromList() {
  const list = document.getElementById('window-list');
  const items = Array.from(list.children);
  const order = items.map((li) => Number(li.dataset.windowId));

  if (order.length === 0) {
    showStatus('Nothing to save.', 'error');
    return;
  }

  try {
    await setStoredOrder(order);
    showStatus('Order saved.', 'ok');
  } catch (err) {
    console.error(err);
    showStatus('Error saving order.', 'error');
  }
}

async function saveOrderFromDom(showMessage = false) {
  const list = document.getElementById('window-list');
  if (!list) return;

  const items = Array.from(list.children);
  const order = items.map((li) => Number(li.dataset.windowId)).filter((id) => !Number.isNaN(id));

  if (order.length === 0) return;

  try {
    await setStoredOrder(order);
    if (showMessage) {
      showStatus('Order saved.', 'ok');
      // optional: clear message after a moment
      setTimeout(() => showStatus(''), 800);
    }
  } catch (err) {
    console.error(err);
    showStatus('Error saving order.', 'error');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  loadWindowsIntoList();
});
